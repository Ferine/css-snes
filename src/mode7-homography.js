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
