import { describe, expect, it } from 'vitest';
import { fitMode7Homography, MAX_FIT_ERROR_PX, solveHomography } from '../../src/mode7-homography.js';

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
