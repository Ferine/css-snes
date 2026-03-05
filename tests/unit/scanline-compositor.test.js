import { describe, expect, it } from 'vitest';
import { hasMode7Scanlines } from '../../src/scanline-compositor.js';

describe('hasMode7Scanlines', () => {
  it('returns false for missing or non-mode7 scanline data', () => {
    expect(hasMode7Scanlines(null)).toBe(false);
    expect(hasMode7Scanlines([])).toBe(false);
    expect(hasMode7Scanlines([{ mode: 1 }, { mode: 0 }, null])).toBe(false);
  });

  it('returns true when any visible scanline is mode 7', () => {
    const lines = new Array(224).fill(null);
    lines[180] = { mode: 7 };
    expect(hasMode7Scanlines(lines)).toBe(true);
  });
});
