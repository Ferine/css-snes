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
      if (sd && sd.mode === 7 && Number.isFinite(sd.mode7A)) band.push(y);
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
      if (!Number.isFinite(err)) return null;
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
