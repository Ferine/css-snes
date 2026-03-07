import { describe, expect, it } from 'vitest';
import { Mode7VRAMCache } from '../../src/mode7-vram-cache.js';

describe('Mode7VRAMCache', () => {
  it('rebuilds the index map from mode 7 tilemap and texels', () => {
    const cache = new Mode7VRAMCache();
    const vram = new Uint16Array(0x8000);

    vram[0] = 2;
    vram[2 * 64] = 0x0700;

    const state = cache.ensure(vram);

    expect(state.changed).toBe(true);
    expect(state.indexMap[0]).toBe(7);
    expect(state.usedColors[7]).toBe(1);
  });

  it('reuses the cached map until mode 7 vram changes', () => {
    const cache = new Mode7VRAMCache();
    const vram = new Uint16Array(0x8000);

    const first = cache.ensure(vram);
    const second = cache.ensure(vram);
    expect(second.changed).toBe(false);
    expect(second.hash).toBe(first.hash);

    vram[5] = 123;
    const third = cache.ensure(vram);
    expect(third.changed).toBe(true);
    expect(third.hash).not.toBe(first.hash);
  });
});
