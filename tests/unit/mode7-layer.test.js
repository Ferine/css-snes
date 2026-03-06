import { describe, expect, it } from 'vitest';
import { __mode7Testables } from '../../src/mode7-layer.js';

const {
  _hashMode7Palette,
  _mode7RowCoords,
  _packPalette32,
} = __mode7Testables;

describe('mode7-layer helpers', () => {
  it('hashes only used palette entries when usage data is available', () => {
    const palR = new Uint8Array(256);
    const palG = new Uint8Array(256);
    const palB = new Uint8Array(256);
    const used = new Uint8Array(256);

    palR[1] = 10;
    palG[1] = 20;
    palB[1] = 30;
    palR[2] = 40;
    palG[2] = 50;
    palB[2] = 60;
    used[1] = 1;

    const baseHash = _hashMode7Palette(palR, palG, palB, used, true, false);
    palR[2] = 99;
    palG[2] = 88;
    palB[2] = 77;
    expect(_hashMode7Palette(palR, palG, palB, used, true, false)).toBe(baseHash);

    used[2] = 1;
    expect(_hashMode7Palette(palR, palG, palB, used, true, false)).not.toBe(baseHash);
  });

  it('ignores palette index zero when the texture treats color zero as transparent', () => {
    const palR = new Uint8Array(256);
    const palG = new Uint8Array(256);
    const palB = new Uint8Array(256);
    const used = new Uint8Array(256);

    used[0] = 1;
    used[3] = 1;
    palR[3] = 1;
    palG[3] = 2;
    palB[3] = 3;

    const baseHash = _hashMode7Palette(palR, palG, palB, used, true, true);
    palR[0] = 99;
    palG[0] = 88;
    palB[0] = 77;

    expect(_hashMode7Palette(palR, palG, palB, used, true, true)).toBe(baseHash);
  });

  it('packs palette entries with optional transparent color zero', () => {
    const palR = new Uint8Array(256);
    const palG = new Uint8Array(256);
    const palB = new Uint8Array(256);
    const packed = new Uint32Array(256);

    palR[0] = 1;
    palG[0] = 2;
    palB[0] = 3;
    palR[7] = 4;
    palG[7] = 5;
    palB[7] = 6;

    const opaque = _packPalette32(packed, palR, palG, palB, false);
    expect(opaque[0]).toBe(((255 << 24) | (3 << 16) | (2 << 8) | 1) >>> 0);
    expect(opaque[7]).toBe(((255 << 24) | (6 << 16) | (5 << 8) | 4) >>> 0);

    const transparent = _packPalette32(packed, palR, palG, palB, true);
    expect(transparent[0]).toBe(0);
    expect(transparent[7]).toBe(((255 << 24) | (6 << 16) | (5 << 8) | 4) >>> 0);
  });

  it('flips row sampling direction when mode7 flipX is enabled', () => {
    const row = _mode7RowCoords(10, {
      mode7A: 64,
      mode7B: 0,
      mode7C: 32,
      mode7D: 0,
      mode7X: 0,
      mode7Y: 0,
      mode7Hoff: 0,
      mode7Voff: 0,
    }, true, false);

    expect(row.stepX).toBe(-64);
    expect(row.stepY).toBe(-32);
    expect(row.mapX).toBe(row.stepX * -255);
    expect(row.mapY).toBe(row.stepY * -255);
  });
});
