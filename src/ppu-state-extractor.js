/**
 * Extracts a clean PPU state snapshot from SnesJs internals.
 * Reads snes.ppu.vram, cgram, oam, and register values directly.
 *
 * bitPerMode table (from pipu.js) — bits per pixel per layer per mode:
 *   Row i = mode i, cols 0-3 = BG1-BG4. Value 5 = layer absent.
 *   2bpp=4 colors, 4bpp=16 colors, 8bpp=256 colors.
 */

// Mirrors pipu.js bitPerMode exactly.
const BIT_PER_MODE = [
  2, 2, 2, 2,   // mode 0
  4, 4, 2, 5,   // mode 1
  4, 4, 5, 5,   // mode 2
  8, 4, 5, 5,   // mode 3
  8, 2, 5, 5,   // mode 4
  4, 2, 5, 5,   // mode 5
  4, 5, 5, 5,   // mode 6
  8, 5, 5, 5,   // mode 7
];

// spriteSizes table from pipu.js — indexed as [objSize + (big ? 8 : 0)]
// Values are sizes in tiles (multiply by 8 for pixels).
const SPRITE_SIZES = [
  1, 1, 1, 2, 2, 4, 2, 2,
  2, 4, 8, 4, 8, 8, 4, 4,
];

export class PPUStateExtractor {
  constructor(snes) {
    this.snes = snes;
  }

  extract() {
    const ppu = this.snes.ppu;
    const mode = ppu.mode;

    return {
      // Raw VRAM/CGRAM references (not copied — read-only for renderers)
      vram: ppu.vram,
      cgram: ppu.cgram,

      // Decoded CGRAM as #RRGGBB strings (all 256 entries)
      cgRgb: this._decodeCgram(ppu.cgram),

      // BG mode
      mode,

      // BG layer configurations
      bgLayers: this._extractBgLayers(ppu, mode),

      // Mode 7 parameters (only meaningful when mode === 7)
      mode7: this._extractMode7(ppu),

      // Sprites
      sprites: this._extractSprites(ppu),
      sprAdr1: ppu.sprAdr1,
      sprAdr2: ppu.sprAdr2,
      objSize: ppu.objSize,

      // Screen
      forcedBlank: ppu.forcedBlank,
      brightness: ppu.brightness,

      // Layer3 priority flag (mode 1 only — BG3 in front of sprites at prio 0)
      layer3Prio: ppu.layer3Prio,

      // Window positions (global, shared by all layers)
      win1Left:  ppu.window1Left,
      win1Right: ppu.window1Right,
      win2Left:  ppu.window2Left,
      win2Right: ppu.window2Right,

      // Sprite window (index 4 in PPU arrays)
      spriteWindow: {
        w1Enabled:   ppu.window1Enabled[4],
        w1Inversed:  ppu.window1Inversed[4],
        w2Enabled:   ppu.window2Enabled[4],
        w2Inversed:  ppu.window2Inversed[4],
        maskLogic:   ppu.windowMaskLogic[4],
        mainEnabled: ppu.mainScreenWindow[4],
      },

      // Color math state
      colorMath: {
        subtractColors: ppu.subtractColors,
        halfColors: ppu.halfColors,
        mathEnabled: ppu.mathEnabled.slice(),
        fixedColor: { r: ppu.fixedColorR, g: ppu.fixedColorG, b: ppu.fixedColorB },
        addSub: ppu.addSub,
      },

      // SnesJs rendered frame (RGB triplets, 512×240 layout, 3 Uint16 per pixel)
      pixelOutput: ppu.pixelOutput,
    };
  }

  // --- Private helpers ---

  _decodeCgram(cgram) {
    const out = new Array(256);
    for (let i = 0; i < 256; i++) {
      out[i] = _cgwordToRgb(cgram[i]);
    }
    return out;
  }

  _extractBgLayers(ppu, mode) {
    const layers = [];
    for (let l = 0; l < 4; l++) {
      const bpp = BIT_PER_MODE[mode * 4 + l];
      if (bpp === 5) {
        // Layer not present in this mode
        layers.push(null);
        continue;
      }

      // Tilemap geometry (from tilemapWider/Higher)
      const tmWidth  = ppu.tilemapWider[l]  ? 64 : 32;
      const tmHeight = ppu.tilemapHigher[l] ? 64 : 32;

      layers.push({
        layerIdx: l,
        bpp,
        enabled: ppu.mainScreenEnabled[l],
        subEnabled: ppu.subScreenEnabled[l],
        bigTiles: ppu.bigTiles[l],
        tilemapAdr: ppu.tilemapAdr[l],   // VRAM word address
        tileAdr: ppu.tileAdr[l],          // VRAM word address
        tilemapWidth: tmWidth,
        tilemapHeight: tmHeight,
        scrollX: ppu.bgHoff[l],
        scrollY: ppu.bgVoff[l],
        window: {
          w1Enabled:   ppu.window1Enabled[l],
          w1Inversed:  ppu.window1Inversed[l],
          w2Enabled:   ppu.window2Enabled[l],
          w2Inversed:  ppu.window2Inversed[l],
          maskLogic:   ppu.windowMaskLogic[l],
          mainEnabled: ppu.mainScreenWindow[l],
        },
      });
    }
    return layers;
  }

  _extractMode7(ppu) {
    return {
      a: ppu.mode7A,
      b: ppu.mode7B,
      c: ppu.mode7C,
      d: ppu.mode7D,
      x: ppu.mode7X,
      y: ppu.mode7Y,
      hoff: ppu.mode7Hoff,
      voff: ppu.mode7Voff,
      largeField: ppu.mode7LargeField,
      char0fill: ppu.mode7Char0fill,
      flipX: ppu.mode7FlipX,
      flipY: ppu.mode7FlipY,
      extBg: ppu.mode7ExBg,
    };
  }

  _extractSprites(ppu) {
    const sprites = new Array(128);
    for (let i = 0; i < 128; i++) {
      const wordIdx = i * 2;
      const w0 = ppu.oam[wordIdx];
      const w1 = ppu.oam[wordIdx + 1];

      // highOam: 2 bits per sprite, packed in 16-word array
      // Sprite i → word highOam[i >> 3], bits at position (i & 7) * 2
      const hwWord = ppu.highOam[i >> 3];
      const hwBit  = (i & 7) * 2;
      const xHigh  = (hwWord >> hwBit) & 0x1;
      const isBig  = ((hwWord >> hwBit) & 0x2) > 0;

      let x = (w0 & 0xff) | (xHigh << 8);
      if (x > 255) x = -(512 - x); // sign-extend 9-bit X

      const y    = (w0 >> 8) & 0xff;
      const tile = w1 & 0xff;
      const ex   = (w1 >> 8) & 0xff;

      const nameTable = ex & 0x1;          // 0=sprAdr1, 1=sprAdr1+sprAdr2
      const palette   = (ex >> 1) & 0x7;  // sprite palette 0-7 → CGRAM 128+pal*16
      const priority  = (ex >> 4) & 0x3;  // 0=front .. 3=back
      const flipH     = (ex & 0x40) > 0;
      const flipV     = (ex & 0x80) > 0;

      const sizeTiles = SPRITE_SIZES[ppu.objSize + (isBig ? 8 : 0)];
      const sizePx    = sizeTiles * 8;

      sprites[i] = { x, y, tile, nameTable, palette, priority, flipH, flipV, sizePx, isBig };
    }
    return sprites;
  }
}

/**
 * Decode a 15-bit SNES BGR color word to '#RRGGBB'.
 * Format: bit[4:0]=R, bit[9:5]=G, bit[14:10]=B (each 5-bit, scale to 8-bit).
 */
export function cgwordToRgb(word) {
  return _cgwordToRgb(word);
}

function _cgwordToRgb(word) {
  const r = ((word & 0x1f) * 255 / 31 + 0.5) | 0;
  const g = (((word >> 5) & 0x1f) * 255 / 31 + 0.5) | 0;
  const b = (((word >> 10) & 0x1f) * 255 / 31 + 0.5) | 0;
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}
