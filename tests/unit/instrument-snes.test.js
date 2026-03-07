import { describe, expect, it } from 'vitest';
import { instrumentSnes } from '../../packages/snesjs/index.js';

describe('instrumentSnes', () => {
  it('reuses a preallocated scanline buffer across frames', () => {
    const calls = [];
    const ppu = {
      renderLine(line) {
        calls.push(line);
        return line;
      },
      mode: 1,
      bgHoff: [10, 20, 30, 40],
      bgVoff: [11, 21, 31, 41],
      mode7A: 1,
      mode7B: 2,
      mode7C: 3,
      mode7D: 4,
      mode7X: 5,
      mode7Y: 6,
      mode7Hoff: 7,
      mode7Voff: 8,
    };
    const snes = { ppu };

    instrumentSnes(snes);

    const first = snes.beginScanlineCapture();
    const second = snes.beginScanlineCapture();
    expect(second).toBe(first);
    expect(first).toHaveLength(224);
    expect(first[0]).toBe(first[0]);
    expect(first[0].bgHoff).toBeInstanceOf(Int16Array);
    expect(first[0].bgVoff).toBeInstanceOf(Int16Array);

    const row0 = first[0];
    ppu.renderLine(1);

    expect(calls).toEqual([1]);
    expect(first[0]).toBe(row0);
    expect(first[0]).toMatchObject({
      mode: 1,
      mode7A: 1,
      mode7B: 2,
      mode7C: 3,
      mode7D: 4,
      mode7X: 5,
      mode7Y: 6,
      mode7Hoff: 7,
      mode7Voff: 8,
    });
    expect(Array.from(first[0].bgHoff)).toEqual([10, 20, 30, 40]);
    expect(Array.from(first[0].bgVoff)).toEqual([11, 21, 31, 41]);

    ppu.mode = 7;
    ppu.bgHoff[2] = 99;
    ppu.renderLine(1);
    expect(first[0]).toBe(row0);
    expect(first[0].mode).toBe(7);
    expect(first[0].bgHoff[2]).toBe(99);
  });

  it('ignores non-visible scanlines when capture is active', () => {
    const ppu = {
      renderLine(line) {
        return line;
      },
      mode: 1,
      bgHoff: [0, 0, 0, 0],
      bgVoff: [0, 0, 0, 0],
      mode7A: 0,
      mode7B: 0,
      mode7C: 0,
      mode7D: 0,
      mode7X: 0,
      mode7Y: 0,
      mode7Hoff: 0,
      mode7Voff: 0,
    };
    const snes = { ppu };

    instrumentSnes(snes);
    const buffer = snes.beginScanlineCapture();
    const before = buffer[0];

    ppu.renderLine(0);
    ppu.renderLine(225);

    expect(buffer[0]).toBe(before);
    expect(buffer[0].mode).toBe(0);
  });
});
