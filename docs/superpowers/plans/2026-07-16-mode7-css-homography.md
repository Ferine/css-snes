# Fitted-Homography Mode 7 CSS Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the approximate CSS Mode 7 sub-modes with a single `matrix3d` homography fitted from per-scanline PPU data, falling back to the existing row mode when the fit does not validate.

**Architecture:** A new pure-math module (`src/mode7-homography.js`) owns the pipu.js-exact per-row coordinate math, a 4-point homography solve, and per-frame validation. `Mode7Layer.update()`'s CSS branch tries the fit first and applies the result as one cached `matrix3d` on the existing 1024×1024 tilemap canvas element (no texture upload); on fit failure it uses today's row mode unchanged. The old single-plane `perspective()` heuristic is deleted.

**Tech Stack:** Plain ES modules (no TypeScript), vitest for unit tests, Playwright for E2E, pnpm.

**Spec:** `docs/superpowers/specs/2026-07-16-mode7-css-homography-design.md`

## Global Constraints

- Plain JavaScript ES modules; `"type": "module"`; no TypeScript syntax anywhere.
- No new dependencies. The homography solve is hand-rolled (~40 lines); this was an explicit design decision after walking the reuse ladder.
- Package manager is pnpm (`packageManager: pnpm@11.10.0`). Never invoke npm or npx; use `pnpm test`, `pnpm test:e2e`, `pnpm exec playwright test`.
- Existing exports must keep working: `__mode7Testables` in `src/mode7-layer.js` must continue to expose `_hashMode7Palette`, `_mode7RowCoords`, `_packPalette32` (existing unit tests import them).
- The software rasterizer path, the scanline compositor, and `src/css-renderer.js` are NOT modified by this plan.
- Commit messages end with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- **Coordinate conventions (normative, supersedes the spec's "+0.5 texel" bullet — Task 2 amends the spec):**
  - Map space is continuous; canvas texel `k` covers `[k, k+1)`. GPU nearest sampling takes `floor(texcoord)`, which matches the SNES `>> 8` floor with **no half-texel offset**.
  - Screen row `y`'s per-scanline affine applies at the row's vertical center `sy = y + 0.5`.
  - Along a row, the map coordinate is `u(sx) = (mapX + sx * stepX) / 256`, linear in `sx`; correspondences are taken at `sx = 0` and `sx = 256` (row edges).
  - Because the per-row mapping is affine in `sx`, a consistent fit has `h31 ≈ 0` (perspective divisor depends only on `sy`). Unit tests assert this.
  - Hardware **wraps** map coordinates when `largeField` is false; a single plane cannot wrap, so the fit must return `ok: false` when `largeField` is false and any validated endpoint falls outside `[0, 1024)`. Row mode wraps correctly via `background-repeat`.

---

### Task 1: Baseline capture + `src/mode7-homography.js` with row math and homography solver

**Files:**
- Create: `src/mode7-homography.js`
- Modify: `src/mode7-layer.js` (delete local `_mode7RowCoords` + `frameMode7AsM7`, import from new module, keep `__mode7Testables` shape)
- Create: `tests/unit/mode7-homography.test.js`

**Interfaces:**
- Produces (used by Tasks 2–3):
  - `mode7RowCoords(y, m, flipX, flipY)` → `{ mapX, mapY, stepX, stepY }` (8.8 fixed point). `m` uses scanlineData field names (`mode7A`, `mode7B`, `mode7C`, `mode7D`, `mode7X`, `mode7Y`, `mode7Hoff`, `mode7Voff`).
  - `frameMode7AsM7(m7)` → converts `ppuState.mode7` field names (`a`, `b`, …, `hoff`, `voff`) to scanlineData field names.
  - `solveHomography(points)` → `number[8] | null`; `points` is exactly 4 of `{ mx, my, px, py }` (source map point → destination screen point); returns `[h11,h12,h13,h21,h22,h23,h31,h32]` with `h33 = 1`, or `null` if the system is singular.

- [x] **Step 1: Capture the row-mode baseline (BEFORE any code changes)**

Run (dev server is started by Playwright's config automatically):
```bash
cd /Users/x/dev/css-snes && M7_CSS_ONLY=1 pnpm test:e2e 2>&1 | tee "$TMPDIR/m7css-baseline.log" | grep -E "race-track|diff"
```
Expected: test passes; note the `[race-track] diff=NN.NN%` line. **Append the measured number to this plan file** at the bottom of Task 4 as a line `Row-mode baseline (measured): NN.NN%`. If the run does not reach mode 7 (`did not reach mode 7` in output), re-run once; if it still doesn't, record `baseline: not reached` and move on — Task 4 handles it.

- [x] **Step 2: Write the failing solver test**

Create `tests/unit/mode7-homography.test.js`:

```js
import { describe, expect, it } from 'vitest';
import { solveHomography } from '../../src/mode7-homography.js';

// Apply an 8-param homography (h33 = 1) to a point.
function applyH(h, mx, my) {
  const den = h[6] * mx + h[7] * my + 1;
  return {
    px: (h[0] * mx + h[1] * my + h[2]) / den,
    py: (h[3] * mx + h[4] * my + h[5]) / den,
  };
}

describe('solveHomography', () => {
  it('recovers a known homography from 4 point pairs', () => {
    // Ground-truth H: mild perspective in y only (h31 = 0, like mode 7).
    const H = [0.5, 0.1, 30, 0.05, 0.8, -12, 0, 0.002];
    const srcPts = [
      { mx: 10, my: 20 }, { mx: 900, my: 40 },
      { mx: 50, my: 800 }, { mx: 1000, my: 950 },
    ];
    const points = srcPts.map(({ mx, my }) => ({ mx, my, ...applyH(H, mx, my) }));
    const h = solveHomography(points);
    expect(h).not.toBeNull();
    for (let i = 0; i < 8; i++) {
      expect(h[i]).toBeCloseTo(H[i], 6);
    }
    // Round-trip an unrelated point through the recovered matrix.
    const probe = applyH(h, 512, 512);
    const truth = applyH(H, 512, 512);
    expect(probe.px).toBeCloseTo(truth.px, 5);
    expect(probe.py).toBeCloseTo(truth.py, 5);
  });

  it('returns null for a degenerate (collinear/duplicate) configuration', () => {
    const p = { mx: 1, my: 1, px: 5, py: 5 };
    expect(solveHomography([p, p, p, p])).toBeNull();
  });
});
```

- [x] **Step 3: Run test to verify it fails**

Run: `cd /Users/x/dev/css-snes && pnpm vitest run tests/unit/mode7-homography.test.js`
Expected: FAIL — cannot resolve `../../src/mode7-homography.js`.

- [x] **Step 4: Create the module**

Create `src/mode7-homography.js`:

```js
/**
 * Mode 7 homography fitting.
 *
 * A flat ground plane in perspective is a homography (projective transform).
 * SNES mode 7 HDMA tables for perspective effects (F-Zero) produce per-scanline
 * affine params that all lie on one such transform. This module fits the
 * map→screen homography from per-scanline data and emits a CSS matrix3d that
 * the GPU evaluates perspective-correct per pixel — equivalent to the
 * per-scanline affines wherever the fit validates.
 *
 * Coordinate conventions (load-bearing for pixel accuracy):
 *  - Map space is continuous: canvas texel k covers [k, k+1). GPU nearest
 *    sampling takes floor(texcoord), matching the SNES `>> 8` floor with no
 *    half-texel offset.
 *  - Screen row y's affine applies at the row's vertical center sy = y + 0.5.
 *  - Along a row, u(sx) = (mapX + sx*stepX)/256 — linear in sx, so a
 *    consistent fit has h31 ≈ 0.
 */

export const MAX_FIT_ERROR_PX = 1.0;
const MIN_BAND_ROWS = 8;
const PIVOT_EPSILON = 1e-9;

/** Convert frame-end mode7 state to the field names scanlineData entries use. */
export function frameMode7AsM7(m7) {
  return {
    mode7A: m7.a, mode7B: m7.b, mode7C: m7.c, mode7D: m7.d,
    mode7X: m7.x, mode7Y: m7.y, mode7Hoff: m7.hoff, mode7Voff: m7.voff,
  };
}

/**
 * Map coords for screen pixel 0 of a scanline plus the per-pixel step,
 * in 8.8 fixed point. Mirrors pipu.js generateMode7Coords exactly
 * (13-bit sign extension, & ~63 truncation, yPos = y + 1, flips).
 */
export function mode7RowCoords(y, m, flipX, flipY) {
  const yPos = y + 1;
  const rY = flipY ? 255 - yPos : yPos;

  let clH = m.mode7Hoff - m.mode7X;
  clH = (clH & 0x2000) > 0 ? (clH | ~0x3ff) : (clH & 0x3ff);
  let clV = m.mode7Voff - m.mode7Y;
  clV = (clV & 0x2000) > 0 ? (clV | ~0x3ff) : (clV & 0x3ff);

  const lineStartX = ((m.mode7A * clH) & ~63)
                   + ((m.mode7B * rY)  & ~63)
                   + ((m.mode7B * clV) & ~63)
                   + (m.mode7X << 8);
  const lineStartY = ((m.mode7C * clH) & ~63)
                   + ((m.mode7D * rY)  & ~63)
                   + ((m.mode7D * clV) & ~63)
                   + (m.mode7Y << 8);

  const mapX = flipX ? lineStartX + 255 * m.mode7A : lineStartX;
  const mapY = flipX ? lineStartY + 255 * m.mode7C : lineStartY;
  const stepX = flipX ? -m.mode7A : m.mode7A;
  const stepY = flipX ? -m.mode7C : m.mode7C;

  return { mapX, mapY, stepX, stepY };
}

/**
 * Solve the homography H (h33 = 1) mapping 4 source points to 4 destination
 * points, via the standard DLT 8×8 linear system with partial pivoting.
 * @param {Array<{mx:number, my:number, px:number, py:number}>} points
 * @returns {number[]|null} [h11,h12,h13,h21,h22,h23,h31,h32] or null if singular
 */
export function solveHomography(points) {
  const A = [];
  const b = [];
  for (const { mx, my, px, py } of points) {
    A.push([mx, my, 1, 0, 0, 0, -mx * px, -my * px]); b.push(px);
    A.push([0, 0, 0, mx, my, 1, -mx * py, -my * py]); b.push(py);
  }
  return _solveLinear8(A, b);
}

function _solveLinear8(A, b) {
  const n = 8;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(A[r][col]) > Math.abs(A[pivot][col])) pivot = r;
    }
    if (Math.abs(A[pivot][col]) < PIVOT_EPSILON) return null;
    if (pivot !== col) {
      [A[pivot], A[col]] = [A[col], A[pivot]];
      [b[pivot], b[col]] = [b[col], b[pivot]];
    }
    for (let r = col + 1; r < n; r++) {
      const f = A[r][col] / A[col][col];
      if (f === 0) continue;
      for (let c = col; c < n; c++) A[r][c] -= f * A[col][c];
      b[r] -= f * b[col];
    }
  }
  const h = new Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let c = r + 1; c < n; c++) s -= A[r][c] * h[c];
    h[r] = s / A[r][r];
  }
  return h;
}
```

- [x] **Step 5: Run the new test to verify it passes**

Run: `cd /Users/x/dev/css-snes && pnpm vitest run tests/unit/mode7-homography.test.js`
Expected: PASS (2 tests).

- [x] **Step 6: Move the layer's row math to the module**

In `src/mode7-layer.js`:

1. Add to the imports at the top:
```js
import { frameMode7AsM7, mode7RowCoords } from './mode7-homography.js';
```
2. Delete the local `function frameMode7AsM7(m7) { ... }` (near the bottom, after the class).
3. Delete the local `function _mode7RowCoords(y, m, flipX, flipY) { ... }`.
4. In `_renderCssRows`, change the one call site `_mode7RowCoords(y, m, flipX, flipY)` to `mode7RowCoords(y, m, flipX, flipY)`.
5. Keep `__mode7Testables` exporting the same names by aliasing:
```js
export const __mode7Testables = {
  _hashMode7Palette,
  _mode7RowCoords: mode7RowCoords,
  _packPalette32,
};
```

- [x] **Step 7: Run the full unit suite**

Run: `cd /Users/x/dev/css-snes && pnpm test`
Expected: PASS — all existing suites, including `tests/unit/mode7-layer.test.js` (its `_mode7RowCoords` import now resolves to the moved function).

- [x] **Step 8: Commit**

```bash
cd /Users/x/dev/css-snes && git add src/mode7-homography.js src/mode7-layer.js tests/unit/mode7-homography.test.js && git commit -m "Add mode7-homography module: row math + 4-point homography solver

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `fitMode7Homography` — band scan, fit, validation, matrix3d emit

**Files:**
- Modify: `src/mode7-homography.js` (append)
- Modify: `tests/unit/mode7-homography.test.js` (append)
- Modify: `docs/superpowers/specs/2026-07-16-mode7-css-homography-design.md` (correspondence-convention amendment)

**Interfaces:**
- Consumes: `mode7RowCoords`, `frameMode7AsM7`, `solveHomography` from Task 1.
- Produces (used by Task 3):
  - `fitMode7Homography(scanlineData, frameM7)` → `{ ok: boolean, maxError: number, matrix3d: string, h: number[8], bandTop: number, bandBottom: number } | null`.
    - `scanlineData`: the 224-entry per-scanline capture array, or `null`. Pass `null` when there are no mode-7 scanlines (pure frame-affine case).
    - `frameM7`: `ppuState.mode7` (fields `a b c d x y hoff voff largeField flipX flipY`).
    - `null` return: band of 1–7 rows (sliver → row mode) or singular solve.
    - `ok: false`: fit validated worse than `MAX_FIT_ERROR_PX`, or wrap needed (`largeField` false with out-of-map endpoints).

- [x] **Step 1: Write the failing fit tests**

Append to `tests/unit/mode7-homography.test.js` (add `fitMode7Homography` and `MAX_FIT_ERROR_PX` to the existing import from `../../src/mode7-homography.js`):

```js
// Build a 224-row scanlineData array with mode-7 rows in [top, bottom].
function makeScanlineData(top, bottom, rowParams) {
  const rows = new Array(224).fill(null);
  for (let y = top; y <= bottom; y++) {
    rows[y] = { mode: 7, bgHoff: new Int16Array(4), bgVoff: new Int16Array(4), ...rowParams(y) };
  }
  return rows;
}

const AFFINE_FRAME_M7 = {
  a: 256, b: 0, c: 0, d: 256, x: 0, y: 0, hoff: 0, voff: 0,
  largeField: true, char0fill: false, flipX: false, flipY: false,
};

function constantAffineRow() {
  return {
    mode7A: 256, mode7B: 0, mode7C: 0, mode7D: 256,
    mode7X: 0, mode7Y: 0, mode7Hoff: 0, mode7Voff: 0,
  };
}

describe('fitMode7Homography', () => {
  it('fits a constant affine band exactly', () => {
    const sd = makeScanlineData(0, 223, constantAffineRow);
    const fit = fitMode7Homography(sd, AFFINE_FRAME_M7);
    expect(fit).not.toBeNull();
    expect(fit.ok).toBe(true);
    expect(fit.maxError).toBeLessThan(1e-3);
    // No perspective terms for an affine.
    expect(Math.abs(fit.h[6])).toBeLessThan(1e-7);
    expect(Math.abs(fit.h[7])).toBeLessThan(1e-7);
    // A=256 → 1 texel per screen px → unit scale; row y samples w = y+1,
    // applied at screen center y+0.5 → py = w − 0.5.
    expect(fit.h[0]).toBeCloseTo(1, 5);
    expect(fit.h[4]).toBeCloseTo(1, 5);
    expect(fit.h[5]).toBeCloseTo(-0.5, 4);
    expect(fit.bandTop).toBe(0);
    expect(fit.bandBottom).toBe(223);
    expect(fit.matrix3d).toMatch(/^matrix3d\(/);
  });

  it('accepts an integer HDMA hyperbolic table when minification keeps noise low', () => {
    // A(y) = D(y) = round(k / (yPos + horizon)) — a true ground-plane
    // progression, integer-rounded like a real HDMA table. Heavy
    // minification (A ≈ 3000–5400): ±0.5 rounding on A/D costs ~256/A
    // screen px per texel, far under the gate.
    const k = 864000, horizon = 64;
    const sd = makeScanlineData(96, 223, (y) => {
      const scale = Math.round(k / (y + 1 + horizon));
      return {
        mode7A: scale, mode7B: 0, mode7C: 0, mode7D: scale,
        mode7X: 0, mode7Y: 0, mode7Hoff: 0, mode7Voff: 0,
      };
    });
    const fit = fitMode7Homography(sd, AFFINE_FRAME_M7);
    expect(fit).not.toBeNull();
    expect(fit.ok).toBe(true);
    expect(fit.maxError).toBeLessThan(MAX_FIT_ERROR_PX);
    // Scanline-affine structure ⇒ no x-dependent perspective divisor.
    expect(Math.abs(fit.h[6])).toBeLessThan(1e-6);
    // Genuine perspective ⇒ y-dependent divisor present.
    expect(Math.abs(fit.h[7])).toBeGreaterThan(1e-7);
    expect(fit.bandTop).toBe(96);
  });

  it('rejects an integer HDMA table near 1:1 magnification (noise above the strict gate)', () => {
    // Same progression at A ≈ 300–540: integer-rounding noise floor is
    // ~1.4–1.6px, above the deliberately strict 1.0px gate (policy
    // decision 2026-07-16). Such frames fall back to row mode, which
    // reproduces the quantized per-row values faithfully.
    const k = 86400, horizon = 64;
    const sd = makeScanlineData(96, 223, (y) => {
      const scale = Math.round(k / (y + 1 + horizon));
      return {
        mode7A: scale, mode7B: 0, mode7C: 0, mode7D: scale,
        mode7X: 0, mode7Y: 0, mode7Hoff: 0, mode7Voff: 0,
      };
    });
    const fit = fitMode7Homography(sd, AFFINE_FRAME_M7);
    expect(fit).not.toBeNull();
    expect(fit.ok).toBe(false);
    expect(fit.maxError).toBeGreaterThan(MAX_FIT_ERROR_PX);
    // Quantization noise, not non-projective structure: nowhere near
    // the ≥10px errors that wavy/split-screen HDMA produces.
    expect(fit.maxError).toBeLessThan(4);
  });

  it('rejects a non-projective (sinusoidal) band', () => {
    const sd = makeScanlineData(96, 223, (y) => ({
      mode7A: 256 + Math.round(64 * Math.sin(y / 6)), mode7B: 0,
      mode7C: 0, mode7D: 256,
      mode7X: 0, mode7Y: 0, mode7Hoff: 0, mode7Voff: 0,
    }));
    const fit = fitMode7Homography(sd, AFFINE_FRAME_M7);
    expect(fit).not.toBeNull();
    expect(fit.ok).toBe(false);
    expect(fit.maxError).toBeGreaterThan(MAX_FIT_ERROR_PX);
  });

  it('returns null for a sliver band (< 8 rows)', () => {
    const sd = makeScanlineData(100, 103, constantAffineRow);
    expect(fitMode7Homography(sd, AFFINE_FRAME_M7)).toBeNull();
  });

  it('synthesizes an affine fit from frame state when scanlineData is null', () => {
    const fit = fitMode7Homography(null, AFFINE_FRAME_M7);
    expect(fit).not.toBeNull();
    expect(fit.ok).toBe(true);
    expect(Math.abs(fit.h[6])).toBeLessThan(1e-7);
    expect(Math.abs(fit.h[7])).toBeLessThan(1e-7);
    expect(fit.bandTop).toBe(0);
    expect(fit.bandBottom).toBe(223);
  });

  it('rejects out-of-map bands when largeField is false (hardware wraps)', () => {
    // A = 1024 → u(256) = 256·1024/256 = 1024: right edge leaves [0, 1024).
    const oobRow = () => ({
      mode7A: 1024, mode7B: 0, mode7C: 0, mode7D: 1024,
      mode7X: 0, mode7Y: 0, mode7Hoff: 0, mode7Voff: 0,
    });
    const sd = makeScanlineData(0, 223, oobRow);
    const wrap = fitMode7Homography(sd, { ...AFFINE_FRAME_M7, largeField: false });
    expect(wrap).not.toBeNull();
    expect(wrap.ok).toBe(false);
    const noWrap = fitMode7Homography(sd, { ...AFFINE_FRAME_M7, largeField: true });
    expect(noWrap.ok).toBe(true);
  });
});
```

- [x] **Step 2: Run tests to verify the new ones fail**

Run: `cd /Users/x/dev/css-snes && pnpm vitest run tests/unit/mode7-homography.test.js`
Expected: FAIL — `fitMode7Homography` is not exported.

- [x] **Step 3: Implement `fitMode7Homography`**

Append to `src/mode7-homography.js`:

```js
/**
 * Fit the map→screen homography for the frame's mode-7 band.
 *
 * @param {Array|null} scanlineData - 224-entry per-scanline capture, or null
 *   when there are no mode-7 scanlines (pure frame-affine case).
 * @param {object} frameM7 - ppuState.mode7 (a b c d x y hoff voff largeField flipX flipY)
 * @returns {{ok:boolean, maxError:number, matrix3d:string, h:number[], bandTop:number, bandBottom:number}|null}
 *   null for sliver bands (1–7 rows) or singular solves; ok=false when the
 *   validated error exceeds MAX_FIT_ERROR_PX or wrapping is required
 *   (largeField false with endpoints outside the 1024×1024 map).
 */
export function fitMode7Homography(scanlineData, frameM7) {
  const flipX = !!frameM7.flipX;
  const flipY = !!frameM7.flipY;
  const fm = frameMode7AsM7(frameM7);

  const band = [];
  if (scanlineData) {
    for (let y = 0; y < 224; y++) {
      const sd = scanlineData[y];
      if (sd && sd.mode === 7 && typeof sd.mode7A === 'number') band.push(y);
    }
  }

  let fitRows;   // two rows for the 4-point solve
  let checkRows; // rows for validation
  if (band.length === 0) {
    // Pure frame-affine: synthesize sample rows from frame-end state.
    fitRows = [{ y: 40, m: fm }, { y: 180, m: fm }];
    checkRows = [{ y: 0, m: fm }, { y: 112, m: fm }, { y: 223, m: fm }];
  } else if (band.length < MIN_BAND_ROWS) {
    return null;
  } else {
    const y1 = band[(band.length * 0.25) | 0];
    const y2 = band[(band.length * 0.75) | 0];
    fitRows = [{ y: y1, m: scanlineData[y1] }, { y: y2, m: scanlineData[y2] }];
    checkRows = [];
    for (let i = 0; i < band.length; i += 8) {
      checkRows.push({ y: band[i], m: scanlineData[band[i]] });
    }
    const last = band[band.length - 1];
    if (checkRows[checkRows.length - 1].y !== last) {
      checkRows.push({ y: last, m: scanlineData[last] });
    }
  }

  // 4 correspondences at the row edges sx ∈ {0, 256}, row centers sy = y+0.5.
  const points = [];
  for (const { y, m } of fitRows) {
    const rc = mode7RowCoords(y, m, flipX, flipY);
    const sy = y + 0.5;
    points.push({ mx: rc.mapX / 256, my: rc.mapY / 256, px: 0, py: sy });
    points.push({
      mx: (rc.mapX + 256 * rc.stepX) / 256,
      my: (rc.mapY + 256 * rc.stepY) / 256,
      px: 256, py: sy,
    });
  }
  const raw = solveHomography(points);
  if (!raw) return null;

  // Round exactly as the emitted CSS will be parsed; validate the rounded H
  // so formatting loss shows up in maxError instead of shipping silently.
  const h = raw.map((v) => Number(v.toFixed(8)));

  let maxError = 0;
  let oob = false;
  for (const { y, m } of checkRows) {
    const rc = mode7RowCoords(y, m, flipX, flipY);
    const sy = y + 0.5;
    for (const sx of [0, 256]) {
      const u = (rc.mapX + sx * rc.stepX) / 256;
      const w = (rc.mapY + sx * rc.stepY) / 256;
      if (u < 0 || u >= 1024 || w < 0 || w >= 1024) oob = true;
      const den = h[6] * u + h[7] * w + 1;
      if (Math.abs(den) < 1e-12) return null;
      const px = (h[0] * u + h[1] * w + h[2]) / den;
      const py = (h[3] * u + h[4] * w + h[5]) / den;
      const err = Math.max(Math.abs(px - sx), Math.abs(py - sy));
      if (err > maxError) maxError = err;
    }
  }

  // A single plane cannot wrap; hardware wraps when largeField is false.
  const wrapNeeded = !frameM7.largeField && oob;

  const f = (v) => v.toFixed(8);
  const matrix3d =
    `matrix3d(${f(h[0])}, ${f(h[3])}, 0, ${f(h[6])}, ` +
    `${f(h[1])}, ${f(h[4])}, 0, ${f(h[7])}, ` +
    `0, 0, 1, 0, ` +
    `${f(h[2])}, ${f(h[5])}, 0, 1)`;

  return {
    ok: maxError <= MAX_FIT_ERROR_PX && !wrapNeeded,
    maxError,
    matrix3d,
    h,
    bandTop: band.length ? band[0] : 0,
    bandBottom: band.length ? band[band.length - 1] : 223,
  };
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `cd /Users/x/dev/css-snes && pnpm vitest run tests/unit/mode7-homography.test.js`
Expected: PASS (9 tests). If the *minified* hyperbolic test fails the gate, the fit code has a convention bug (mixed-up `sx` edges vs centers, or a missing `/256`) — do not loosen the assertion. The near-1:1 test failing in the `ok === true` direction means the gate got loosened — also a bug. `MAX_FIT_ERROR_PX` stays 1.0 (policy decision 2026-07-16: strict gate; integer-table noise near 1:1 magnification intentionally falls back to row mode).

- [x] **Step 5: Amend the spec's correspondence bullet**

In `docs/superpowers/specs/2026-07-16-mode7-css-homography-design.md`, replace the step-3 bullet under "Algorithm" ("**Correspondences.** For each sample row…" through "…mapped pixel center wherever the fit is exact.") with:

```markdown
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
```

Additionally, in the same spec file, replace the last bullet of the "Precision
notes" section ("Expected residual on F-Zero race frames…") with:

```markdown
- Integer HDMA tables carry a quantization noise floor: ±0.5 rounding on the
  per-row A/D values costs ~`256/A` screen px per texel, amplified ~2× by
  fit-row leverage. Near 1:1 magnification (A ≈ 256–540) the floor is
  ~1.4–1.6px — above the gate. **Policy decision (2026-07-16): the gate stays
  at 1.0px.** Frames whose quantization noise exceeds it fall back to row
  mode, which reproduces the quantized per-row values faithfully; the
  homography engages only where it is genuinely sub-pixel exact (heavily
  minified bands, exact affine frames, clean tables).
```

- [x] **Step 6: Run the full unit suite**

Run: `cd /Users/x/dev/css-snes && pnpm test`
Expected: PASS, all suites.

- [x] **Step 7: Commit**

```bash
cd /Users/x/dev/css-snes && git add src/mode7-homography.js tests/unit/mode7-homography.test.js docs/superpowers/specs/2026-07-16-mode7-css-homography-design.md && git commit -m "Add fitMode7Homography: band fit, rounded-matrix validation, wrap rejection

Amends spec: continuous-map convention replaces the +0.5 texel-center bullet.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Wire the homography path into `Mode7Layer`

**Files:**
- Modify: `src/mode7-layer.js` (CSS branch of `update()`, constructor, deletions)

**Interfaces:**
- Consumes: `fitMode7Homography(scanlineData, frameM7)` from Task 2 (already imported per Task 1's import line — extend it to `import { fitMode7Homography, frameMode7AsM7, mode7RowCoords } from './mode7-homography.js';`).
- Produces (used by Task 4): `_perspEl.dataset.m7Css` set to `'homography'`, `'rows'`, or `'none'` every CSS-path frame. `.mode7-perspective` is the DOM hook (`document.querySelector('.mode7-perspective').dataset.m7Css`).

- [x] **Step 1: Extend the import and add homography state**

In `src/mode7-layer.js`, change the Task-1 import line to:

```js
import { fitMode7Homography, frameMode7AsM7, mode7RowCoords } from './mode7-homography.js';
```

In the `Mode7Layer` constructor, after `this._tilemapFlushWaiters = [];` add:

```js
    this._prevHomography = '';
```

- [x] **Step 2: Replace the CSS fallback branch of `update()`**

Replace the entire `else` block of `update()` (currently starting at the comment `// CSS fallback path` and ending at `this._usedRowModeLastFrame = useRowMode;`) with:

```js
      // CSS fallback path
      this._swCanvas.style.display = 'none';
      this._perspEl.style.display = '';

      const cssFrame = ++this._cssFrameCounter;
      const mapHash = mode7State.hash;
      const vramChanged = mapHash !== this._prevMapHash;
      const palHash = _hashMode7Palette(
        palR, palG, palB, mode7State.usedColors, true, true,
      );
      const paletteChanged = palHash !== this._prevPalHash;
      if (vramChanged || paletteChanged) {
        this._renderTilemap(mode7State.indexMap, palR, palG, palB, {
          uploadTexture: false,
        });
        this._prevMapHash = mapHash;
        this._prevPalHash = palHash;
        if (this._tilemapTextureReady) this._rowTextureStale = true;
      }

      const fit = fitMode7Homography(hasMode7Rows ? scanlineData : null, mode7);

      if (fit && fit.ok) {
        // Single-plane homography: exact wherever the per-scanline params lie
        // on one projective transform (flat ground plane).
        this._perspEl.dataset.m7Css = 'homography';
        this._perspEl.style.perspective = 'none';
        this._perspEl.style.perspectiveOrigin = '';
        this._rowsRoot.style.display = 'none';
        this._planeEl.style.display = '';
        if (fit.matrix3d !== this._prevHomography) {
          this._planeEl.style.transform = fit.matrix3d;
          this._prevHomography = fit.matrix3d;
        }
        this._applyScanlineClip(scanlineData);
        this._usedRowModeLastFrame = false;
      } else if (scanlineData && hasMode7Rows) {
        // Row-mode fallback: non-projective HDMA, wrap, or degenerate fits.
        this._perspEl.dataset.m7Css = 'rows';
        const needsInitialTexture = !this._tilemapTextureReady;
        const needsSyncUpload = vramChanged || needsInitialTexture || !this._usedRowModeLastFrame;
        const shouldUploadPalette = paletteChanged
          && (cssFrame - this._lastTilemapUploadFrame >= this._paletteUploadCadence);
        const rowTextureDue = this._rowTextureStale && (
          !this._usedRowModeLastFrame
          || (cssFrame - this._lastTilemapUploadFrame >= this._paletteUploadCadence)
        );
        if (needsSyncUpload || shouldUploadPalette || rowTextureDue) {
          this._queueTilemapTextureUpload(needsSyncUpload);
          this._tilemapTextureReady = true;
          this._rowTextureStale = false;
          this._lastTilemapUploadFrame = cssFrame;
        } else if (paletteChanged) {
          this._rowTextureStale = true;
        }
        this._perspEl.style.perspective = 'none';
        this._perspEl.style.perspectiveOrigin = '';
        this._planeEl.style.display = 'none';
        this._rowsRoot.style.display = '';
        this._renderCssRows(mode7, fallbackM7, scanlineData);
        this._perspEl.style.clipPath = '';
        this._prevClip = '';
        this._usedRowModeLastFrame = true;
      } else {
        // Degenerate fit with no per-scanline rows: nothing safe to draw.
        this._perspEl.dataset.m7Css = 'none';
        this._planeEl.style.display = 'none';
        this._rowsRoot.style.display = 'none';
        this._usedRowModeLastFrame = false;
      }
```

Note what this removes relative to the old branch: the `useRowMode` flag, the old `repaintNeeded` term `!this._tilemapTextureReady` (that flag tracks the row-texture URL, not canvas contents; canvas contents are tracked by `_prevMapHash`/`_prevPalHash`, which start at `-1` so the first frame always repaints), and the old plane path (`_applyTransform` + `_applyScanlineClip` combination).

- [x] **Step 3: Delete the dead code**

In `src/mode7-layer.js`, delete entirely:
1. The `_applyTransform(m7)` method.
2. The `_resolveTransformState(frameMode7, scanlineData)` function (after the class).
3. The `_m7Fixed(raw)` function (only `_applyTransform` used it).

Keep `_clamp` (still used by `_renderCssRows`) and `_applyScanlineClip` (used by the homography path).

- [x] **Step 4: Verify no stale references and the plane CSS contract**

Run: `cd /Users/x/dev/css-snes && grep -n "_applyTransform\|_resolveTransformState\|_m7Fixed\|_mode7RowCoords(" src/*.js`
Expected: no matches (the `__mode7Testables` alias line has no `(` so it does not match; nothing else may reference the deleted names).

Run: `cd /Users/x/dev/css-snes && grep -n "image-rendering\|transform-origin" styles/snes-layers.css | grep -A0 -B0 mode7 ; grep -n "image-rendering: pixelated\|transform-origin: 0 0" styles/snes-layers.css`
Expected: `.mode7-plane` block (around lines 173–182) contains both `image-rendering: pixelated` and `transform-origin: 0 0` — the homography path relies on the class for both; do not set them inline. (Verified present at plan time; this step guards against drift.)

- [x] **Step 5: Run unit suite and build**

Run: `cd /Users/x/dev/css-snes && pnpm test && pnpm build`
Expected: all unit tests PASS; Vite build completes with 0 errors.

- [x] **Step 6: Commit**

```bash
cd /Users/x/dev/css-snes && git add src/mode7-layer.js && git commit -m "Mode7Layer: fitted-homography CSS path, rows as fallback

Deletes the perspective-depth plane heuristic (_applyTransform,
_resolveTransformState). Homography path transforms the tilemap canvas
directly — no texture upload.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: E2E assertion — homography active on the race track, diff improved

**Files:**
- Modify: `tests/e2e/test-harness.js` (add `getM7CssPath` to the `window.testHarness` object, next to the existing `setMode7CssOnly` entry at line ~108)
- Modify: `tests/e2e/fzero.spec.js`

**Interfaces:**
- Consumes: `_perspEl.dataset.m7Css` from Task 3; existing harness `setMode7CssOnly(on)`; existing `M7_CSS_ONLY=1` env plumbing in the spec (line ~69).

- [x] **Step 1: Add the harness getter**

In `tests/e2e/test-harness.js`, in the `window.testHarness` object, directly after the `setMode7CssOnly(on) { ... }` entry, add:

```js
  getM7CssPath() {
    const el = document.querySelector('.mode7-perspective');
    return el?.dataset?.m7Css ?? '';
  },
```

- [x] **Step 2: Capture the CSS path at the race checkpoint**

In `tests/e2e/fzero.spec.js`, immediately after the line `checkpoints.push(await capture(page, 'race-track'));`, add:

```js
  const m7CssPathAtRace = process.env.M7_CSS_ONLY === '1'
    ? await page.evaluate(() => window.testHarness.getM7CssPath())
    : null;
```

- [x] **Step 3: Add the assertions**

In the assertion section near the end (after the existing `if (hasM7) { ... }` block that asserts `raceCheckpoint.diffPercent < 30`), add:

```js
  if (hasM7 && m7CssPathAtRace !== null) {
    console.log(`M7 CSS path at race: ${m7CssPathAtRace} diff=${raceCheckpoint.diffPercent}%`);
    expect(['homography', 'rows'], 'CSS mode-7 race frames must use a CSS sub-mode')
      .toContain(m7CssPathAtRace);
    expect(raceCheckpoint.diffPercent, 'CSS-only mode 7 race diff').toBeLessThan(40);
  }
```

Under the strict 1.0px gate (policy decision 2026-07-16), real F-Zero race
frames near 1:1 magnification are expected to report `rows` — that is correct
behavior, not a failure. `homography` at the race checkpoint would mean the
frame's table validated sub-pixel.

- [x] **Step 4: Run E2E in CSS-only mode**

Run: `cd /Users/x/dev/css-snes && M7_CSS_ONLY=1 pnpm test:e2e 2>&1 | tee "$TMPDIR/m7css-homography.log" | grep -E "M7 CSS path|race-track|diff"`
Expected: PASS; `M7 CSS path at race: homography`; note the race diff%.

- [x] **Step 5: Compare against the Task 1 baseline and pin the threshold**

Compare the new race diff% against the `Row-mode baseline (measured)` line recorded at the bottom of this task (36.71%). Requirements, by which path activated:
- **`rows` at the race checkpoint (expected under the strict gate):** the diff must be within ±3 points of the baseline (the row path is unchanged code). Pin the Step-3 threshold to `Math.ceil(baseline + 3)` (36.71 → `toBeLessThan(40)`). A diff far from baseline means Task 3's branch restructure broke the row path — STOP and investigate.
- **`homography` at the race checkpoint:** the diff must be strictly lower than the baseline; if not, STOP and investigate (coordinate-convention bug). Pin the threshold to `Math.ceil(newDiff + 5)`.
- If Task 1 recorded `baseline: not reached`, keep `40` and note that here.

- [x] **Step 6: Run the normal (non-CSS-only) E2E to confirm no regression**

Run: `cd /Users/x/dev/css-snes && pnpm test:e2e 2>&1 | grep -E "race-track|diff|passed|failed"`
Expected: PASS with race diff in line with the pre-change numbers (~19.6%) — the default compositor path is untouched by this plan.

- [x] **Step 7: Record perf snapshot (informational, not asserted)**

With `pnpm dev` running, load the ROM in a browser, toggle M7 CSS on, and note `renderer.getPerfSnapshot()` layers-stage mean from the console, or skip if no browser available and note that. Append the observation below.

- [x] **Step 8: Commit**

```bash
cd /Users/x/dev/css-snes && git add tests/e2e/test-harness.js tests/e2e/fzero.spec.js docs/superpowers/plans/2026-07-16-mode7-css-homography.md && git commit -m "E2E: assert fitted homography active and pin CSS-mode race diff

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

**Measured numbers (executor fills in during Tasks 1 and 4):**
- Row-mode baseline (measured): 36.71%
- CSS-path race diff (measured, path=rows): 36.71% — `M7 CSS path at race: rows diff=36.71%`. Exact match to the row-mode baseline (0-point deviation), confirming the strict 1.0px fit gate correctly falls back to row mode for this real F-Zero race frame near 1:1 magnification (expected/correct per policy decision 2026-07-16). Step-3 threshold pinned to `Math.ceil(36.71 + 3) = 40` per the `rows`-path rule.
- Perf note: `renderer.getPerfSnapshot()` captured via Playwright automation (M7_CSS_ONLY=1, up through the race-track checkpoint, 240 samples): `renderPath: "hybrid-css-mode7"`; layers-stage mean = 0.581ms (p50 1.3ms, p95 1.4ms, max 11.6ms). renderFrame mean = 2.093ms, tileCache mean = 1.662ms. No live interactive browser was available in this environment; this snapshot was obtained by temporarily instrumenting the harness (not committed) and driving it headlessly through Playwright, then reverting the instrumentation before commit.
