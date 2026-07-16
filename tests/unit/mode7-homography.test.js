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
