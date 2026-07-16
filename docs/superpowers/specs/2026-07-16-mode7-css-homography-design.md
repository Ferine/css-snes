# Mode 7 CSS path: fitted homography — design

**Date:** 2026-07-16
**Status:** Approved (design), pending implementation plan
**Optimization goal:** Accuracy first — minimize pixel diff vs SnesJs in `mode7CssOnly` mode; keep `image-rendering: pixelated`; fall back to row mode whenever the math is not exact.

## Problem

The CSS Mode 7 path (`src/mode7-layer.js`, used when `mode7CssOnly` is enabled and in the
hybrid path) has two sub-modes, both approximate:

- **Single-plane 3D** (`_applyTransform` + `_resolveTransformState`): averages per-scanline
  matrix params into one affine, then guesses a CSS `perspective()` depth from |D|. Not
  derived from the actual per-scanline data; visibly wrong for perspective content.
- **Row mode** (`_renderCssRows`): per-scanline (segmented 1/2/4/8-row) divs with 2D
  `matrix()` transforms. Piecewise-linear approximation with visible seams between
  segments, ~50+ DOM transform writes per frame, and a texture-upload pipeline
  (`toBlob` → PNG → object URL → `--m7-map-url`) with cadence throttling because PNG
  encoding a 1024×1024 canvas on the main thread is expensive.

## Key insight

A flat plane viewed in perspective is a homography (projective transform). F-Zero's
per-scanline A/B/C/D HDMA values are all samples of one such transform. CSS `matrix3d`
natively represents homographies, and the GPU compositor samples the texture
perspective-correct per pixel. Fitting the homography from the per-scanline data and
applying it as a single `matrix3d` is therefore *exactly* equivalent to the per-scanline
affines at every row (up to SNES fixed-point truncation) — higher fidelity than row mode
and cheaper than row mode at the same time.

## Design

### New module: `src/mode7-homography.js`

Pure math, no DOM access, fully unit-testable.

- `_mode7RowCoords(y, m, flipX, flipY)` **moves here** from `mode7-layer.js` (which
  imports it back). It is the single source of truth for the pipu.js-exact per-row map
  coordinates: 13-bit sign extension, `& ~63` truncation, `yPos = y + 1`, flips.
- `fitMode7Homography(scanlineData, frameM7)` returns
  `{ ok, matrix3d, maxError, bandTop, bandBottom }` or `null`.

Algorithm:

1. **Band scan.** Collect rows `y ∈ [0, 224)` where `scanlineData[y].mode === 7` and
   `mode7A` is numeric. Band shorter than 8 rows → return `null` (row mode handles
   slivers). If `scanlineData` is null entirely, synthesize two virtual rows from
   frame-end `frameM7` (an affine is a homography; this replaces the old single-plane
   path for rotation-only games).
2. **Sample rows** at 25% and 75% of band depth — away from the horizon where the map
   scale explodes, for numerical conditioning.
3. **Correspondences.** Map space is continuous — canvas texel `k` covers
   `[k, k+1)` — so GPU nearest sampling (`floor(texcoord)`) matches the SNES
   `>> 8` floor with no half-texel offset. Row `y`'s affine applies at the
   row's vertical center `sy = y + 0.5`; along the row the map coordinate is
   `u(sx) = (mapX + sx·stepX)/256`, sampled at the row edges `sx ∈ {0, 256}`.
   Because each row is affine in `sx`, a consistent fit has `h31 ≈ 0`.
   Additionally: hardware wraps map coordinates when `largeField` is false;
   a single plane cannot wrap, so the fit returns `ok: false` when
   `largeField` is false and any validated endpoint leaves `[0, 1024)`
   (row mode wraps correctly via `background-repeat`).
4. **Solve** the map→screen homography H (h33 = 1, 8 unknowns) from the 4 correspondences
   via an 8×8 Gaussian elimination with partial pivoting (~40 lines, hand-rolled — no
   stdlib/platform/dependency equivalent exists; checked the reuse ladder). Pivot below
   epsilon → return `null`.
5. **Format then validate.** Normalize h33 = 1, format all entries with `toFixed(8)`,
   and validate using the *rounded* matrix (what the browser will actually parse):
   project the endpoints of every 8th band row — always including the first and last band
   rows — through H and compare against expected screen points.
   `ok = maxError <= 1.0` (CSS px). The per-row `& ~63` truncation stays well inside
   this budget; genuinely non-projective HDMA tables (wavy effects, split-screen) fail it.
6. **Emit** `matrix3d(h11,h21,0,h31, h12,h22,0,h32, 0,0,1,0, h13,h23,0,1)` — the 3×3
   homography embedded in a 4×4 with identity z, column-major CSS order, for use with
   `transform-origin: 0 0`.

### Changes to `src/mode7-layer.js`

CSS branch of `update()` becomes:

1. Repaint the 1024×1024 tilemap canvas via existing `_renderTilemap` (putImageData)
   when the VRAM/palette hash changed. No texture upload is queued for the homography
   path.
2. Call `fitMode7Homography`.
   - **Fit ok:** hide `rowsRoot`; show the tilemap canvas element (`_planeEl`) directly;
     `perspective: 'none'` on `_perspEl`; apply the `matrix3d` string inline with
     `transform-origin: 0 0` (cache last-applied string, skip when unchanged); keep the
     existing `_applyScanlineClip` band clip-path on `_perspEl`. Zero texture encoding:
     no `toBlob`, no PNG, no object URLs, no upload cadence.
   - **Fit fails / null:** existing row mode, unchanged, including its upload machinery.
     On a homography→rows transition, mark the row texture stale so row mode uploads a
     fresh texture on entry.
3. **Delete** `_applyTransform`, `_resolveTransformState`, and the perspective-depth
   heuristic. Row mode survives as the fallback for non-projective frames.
4. Debug/test hook: set `data-m7-css="homography"` or `"rows"` on `_perspEl` each frame
   the CSS path renders.
5. `.mode7-plane` keeps `image-rendering: pixelated` (verify present in
   `styles/snes-layers.css`; add if missing). Nearest-neighbor shimmer near the horizon
   matches hardware behavior — accepted per the accuracy-first goal.

### Integration

`src/css-renderer.js` requires **no changes**. Both `mode7CssOnly` and the hybrid path
(`forceCss: true`) flow through `Mode7Layer.update()` and pick up the new path
automatically. The software rasterizer and scanline compositor are untouched.

### Error handling

Nothing in the frame loop throws: NaN/missing params are excluded at band scan;
ill-conditioned solves return `null` via the pivot check; any `null`/`ok: false` result
lands in today's row mode. No behavioral regression is possible on frames where the fit
is rejected.

## Precision notes

- Solve in double precision on raw values (magnitudes ≤ ~1e5); no normalization needed
  for an 8×8 system at these scales.
- `toFixed(8)` keeps ≥4 significant digits on the perspective terms (h31/h32 ~1e-2..1e-5)
  and ~13 on translations; validating with the rounded matrix makes formatting loss
  visible to the `maxError` check rather than silently shipped.
- Integer HDMA tables carry a quantization noise floor: ±0.5 rounding on the
  per-row A/D values costs ~`256/A` screen px per texel, amplified ~2× by
  fit-row leverage. Near 1:1 magnification (A ≈ 256–540) the floor is
  ~1.4–1.6px — above the gate. **Policy decision (2026-07-16): the gate stays
  at 1.0px.** Frames whose quantization noise exceeds it fall back to row
  mode, which reproduces the quantized per-row values faithfully; the
  homography engages only where it is genuinely sub-pixel exact (heavily
  minified bands, exact affine frames, clean tables).

## Out of scope (deliberate)

- **`char0fill` / `largeField` OOB fill** in the CSS path: current CSS sub-modes already
  ignore it; a perspective-tiled underlay is disproportionate. OOB renders transparent,
  as today. The software paths remain authoritative for this.
- **Piecewise homographies** (two-player split-screen): validation correctly rejects such
  frames to row mode. Extension point: segment the band at discontinuities in A(y) and
  fit per segment. Documented, not built.
- **Compositor's inline copy of the row math** (`src/scanline-compositor.js`): later
  cleanup, not touched here.
- Row-mode segmentation improvements: only worth revisiting if a real game exercises the
  fallback heavily.

## Testing

- **Unit** (exported via the existing `__mode7Testables` pattern or direct module import):
  - Synthetic per-row tables *generated from* a known homography → fit recovers it,
    `maxError ≈ 0`, emitted matrix3d matches expected values.
  - Constant-affine table (rotation, no perspective) → `ok: true`, matrix has zero
    perspective terms.
  - Sinusoidal A(y) table → `ok: false`.
  - 1-row band, empty band, and singular correspondences → `null`.
- **E2E** (Playwright, F-Zero): enable the M7 CSS toggle on the race track; assert
  `data-m7-css === "homography"`; capture pixel diff vs `pixelOutput`. First run records
  the current row-mode baseline and the homography number; the committed assertion pins
  the homography diff below the measured row-mode baseline by a real margin. Thresholds
  come from measurement, not invention.
- **Perf** (recorded, not asserted): `getPerfSnapshot()` layers-stage time in CSS mode
  should drop with the upload machinery bypassed.

## Expected outcome

~50+ per-frame DOM transform writes collapse to one cached `matrix3d` string; the PNG
upload pipeline goes idle on the main path; CSS-mode road accuracy approaches the
software rasterizer.
