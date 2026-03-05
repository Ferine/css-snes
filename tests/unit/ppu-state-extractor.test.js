import { describe, expect, it } from 'vitest';
import { PPUStateExtractor, cgwordToRgb, hasHdmaScroll } from '../../src/ppu-state-extractor.js';

function createMockPpu() {
  return {
    mode: 1,
    vram: new Uint16Array(0x8000),
    cgram: new Uint16Array(256),
    pixelOutput: new Uint16Array(512 * 3 * 240),

    // BG state
    tilemapWider: [false, false, false, false],
    tilemapHigher: [false, false, false, false],
    mainScreenEnabled: [true, true, true, false],
    subScreenEnabled: [false, false, false, false],
    bigTiles: [false, false, false, false],
    tilemapAdr: [0x1000, 0x1800, 0x2000, 0x2800],
    tileAdr: [0x0000, 0x0800, 0x1000, 0x1800],
    bgHoff: [0, 4, 8, 12],
    bgVoff: [0, 16, 32, 48],

    // Mode 7 registers
    mode7A: 0,
    mode7B: 0,
    mode7C: 0,
    mode7D: 0,
    mode7X: 0,
    mode7Y: 0,
    mode7Hoff: 0,
    mode7Voff: 0,
    mode7LargeField: false,
    mode7Char0fill: false,
    mode7FlipX: false,
    mode7FlipY: false,
    mode7ExBg: false,

    // OBJ/OAM
    oam: new Uint16Array(256),
    highOam: new Uint16Array(16),
    sprAdr1: 0,
    sprAdr2: 0,
    objSize: 0,

    // Screen
    forcedBlank: false,
    brightness: 15,
    layer3Prio: false,

    // Windowing
    window1Left: 0,
    window1Right: 255,
    window2Left: 0,
    window2Right: 255,
    window1Enabled: [false, false, false, false, false],
    window1Inversed: [false, false, false, false, false],
    window2Enabled: [false, false, false, false, false],
    window2Inversed: [false, false, false, false, false],
    windowMaskLogic: [0, 0, 0, 0, 0],
    mainScreenWindow: [false, false, false, false, false],

    // Color math
    subtractColors: false,
    halfColors: false,
    mathEnabled: [false, false, false, false, false],
    fixedColorR: 0,
    fixedColorG: 0,
    fixedColorB: 0,
    addSub: false,
  };
}

describe('cgwordToRgb', () => {
  it('decodes canonical SNES colors', () => {
    expect(cgwordToRgb(0x0000)).toBe('#000000');
    expect(cgwordToRgb(0x7fff)).toBe('#ffffff');
    expect(cgwordToRgb(0x001f)).toBe('#ff0000');
    expect(cgwordToRgb(0x03e0)).toBe('#00ff00');
    expect(cgwordToRgb(0x7c00)).toBe('#0000ff');
  });
});

describe('hasHdmaScroll', () => {
  it('returns false for null or unchanged scanline scroll', () => {
    expect(hasHdmaScroll(null, 0)).toBe(false);

    const staticLines = Array.from({ length: 224 }, () => ({
      bgHoff: [10, 20, 30, 40],
      bgVoff: [11, 21, 31, 41],
    }));
    expect(hasHdmaScroll(staticLines, 2)).toBe(false);
  });

  it('returns true when any scanline has different H/V scroll', () => {
    const lines = Array.from({ length: 224 }, () => ({
      bgHoff: [10, 20, 30, 40],
      bgVoff: [11, 21, 31, 41],
    }));
    lines[120] = {
      bgHoff: [10, 20, 999, 40],
      bgVoff: [11, 21, 31, 41],
    };
    expect(hasHdmaScroll(lines, 2)).toBe(true);
  });
});

describe('PPUStateExtractor.extract', () => {
  it('decodes sprite metadata including sign-extended X and big size flag', () => {
    const ppu = createMockPpu();

    // Sprite 0:
    // low X=44, X high bit=1 => 300 => sign-extends to -212
    // Y=20, tile=0x33, name table 1, palette 5, priority 2, flipH=1, flipV=0
    ppu.oam[0] = 44 | (20 << 8);
    const ex = 1 | (5 << 1) | (2 << 4) | 0x40;
    ppu.oam[1] = 0x33 | (ex << 8);
    ppu.highOam[0] = 0b11; // xHigh=1, isBig=1 for sprite index 0

    const snes = { ppu, _scanlineData: null };
    const extractor = new PPUStateExtractor(snes);
    const state = extractor.extract();

    expect(state.bgLayers[3]).toBeNull(); // mode 1 has no BG4
    expect(state.sprites[0]).toMatchObject({
      x: -212,
      y: 20,
      tile: 0x33,
      nameTable: 1,
      palette: 5,
      priority: 2,
      flipH: true,
      flipV: false,
      sizePx: 16,
      isBig: true,
    });
  });
});
