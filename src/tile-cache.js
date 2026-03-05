/**
 * Decodes SNES VRAM tiles and generates CSS spritesheet images.
 *
 * Normal tiles: 128×128 PNG, 16 columns × 16 rows of 8×8 px cells.
 * BigTiles:     256×256 PNG, 16 columns × 16 rows of 16×16 px cells
 *               (each cell is a composite of four 8×8 sub-tiles).
 *
 * Tile decoding from VRAM (pipu.js logic):
 *   - 2bpp: 8 words/tile, 1 plane-pair group
 *   - 4bpp: 16 words/tile, 2 plane-pair groups
 *   - 8bpp: 32 words/tile, 4 plane-pair groups
 *   Each 16-bit word holds one row of two bitplanes:
 *     low byte  = plane 2g   row y
 *     high byte = plane 2g+1 row y
 */
export class TileCache {
  constructor() {
    this.styleEl = document.createElement('style');
    this.styleEl.id = 'tile-cache-styles';
    document.head.appendChild(this.styleEl);

    // Map of set-key → { id, canvases[nPal], urls[nPal], vramHash, bigTiles }
    this._bgSets = new Map();
    this._sprSets = [null, null]; // index 0 = sprAdr1, index 1 = sprAdr1+sprAdr2
    this._bgSetSeq = 1;
    this._frameSeq = 0;

    this.updatedSets = new Set();
  }

  /**
   * Update tile cache from current PPU state.
   * Returns true if any spritesheet was regenerated.
   */
  update(ppuState) {
    this._frameSeq++;
    this.updatedSets.clear();

    const { vram, cgRgb, bgLayers, sprAdr1, sprAdr2, objSize } = ppuState;

    // Update BG layer sheets
    for (let l = 0; l < 4; l++) {
      const layer = bgLayers[l];
      if (!layer || !layer.enabled) continue;
      this._updateBgLayer(l, layer, vram, cgRgb);
    }

    // Update sprite sheets
    this._updateSpriteSheets(vram, cgRgb, sprAdr1, sprAdr2, objSize);

    // Rebuild stylesheet once if any sheets changed (not per-layer)
    if (this.updatedSets.size > 0) this._rebuildStylesheet();
  }

  /**
   * Get CSS background-position string for tile index (0-255).
   * @param {number}  tileIdx
   * @param {boolean} bigTiles - if true, 16×16 cells in a 256×256 sheet
   */
  getTilePosition(tileIdx, bigTiles = false) {
    if (bigTiles) {
      const col = tileIdx & 15;
      const row = (tileIdx >> 4) & 15;
      return `-${col * 16}px -${row * 16}px`;
    }
    const col = tileIdx & 15;
    const row = (tileIdx >> 4) & 15;
    return `-${col * 8}px -${row * 8}px`;
  }

  /**
   * Get the CSS class token for a BG layer's active sheet set.
   */
  getBgSetClass(layerIdx) {
    const key = `bg${layerIdx}`;
    const set = this._bgSets.get(key);
    return set ? `bg${layerIdx}-set-${set.id}` : '';
  }

  /**
   * Check if a BG palette sheet was updated this frame.
   */
  bgSheetUpdated(layerIdx, palGroup) {
    return this.updatedSets.has(`bg${layerIdx}-${palGroup}`);
  }

  /**
   * Check if a sprite palette sheet was updated this frame.
   * If only one argument is provided, checks both name tables for that palette.
   * If two args are provided, checks a specific name table (0 or 1).
   */
  sprSheetUpdated(nameTableOrPalGroup, palGroup) {
    if (typeof palGroup === 'number') {
      return this.updatedSets.has(`spr${nameTableOrPalGroup}-${palGroup}`);
    }
    const pal = nameTableOrPalGroup;
    return this.updatedSets.has(`spr0-${pal}`) || this.updatedSets.has(`spr1-${pal}`);
  }

  // --- Private ---

  _updateBgLayer(layerIdx, layer, vram, cgRgb) {
    const { bpp, tileAdr, bigTiles } = layer;
    const nPal = 8;
    const key  = `bg${layerIdx}`;

    let set = this._bgSets.get(key);

    // Recreate set if bigTiles flag changed
    if (!set || set.bigTiles !== !!bigTiles) {
      set = this._createSet(key, nPal, !!bigTiles);
      this._bgSets.set(key, set);
    }

    // Hash the tile data region to detect changes
    const hash = this._hashVramRegion(vram, tileAdr, bpp);
    const tilesDirty = hash !== set.vramHash;
    set.vramHash = hash;

    for (let pal = 0; pal < nPal; pal++) {
      // CGRAM base for this BG palette:
      //   4bpp → palette * 16
      //   2bpp → palette * 4
      //   8bpp → 0 (direct index, all 256 colors)
      const cgBase = bpp >= 8 ? 0 : pal * (1 << bpp);
      const palDirty = this._isPaletteDirty(layerIdx, pal, cgRgb, cgBase, bpp);

      if (!tilesDirty && !palDirty) continue;

      const ctx = set.contexts[pal];
      if (bigTiles) {
        _renderBigTileSheet(ctx, vram, tileAdr, bpp, cgRgb, cgBase);
      } else {
        _renderSheet(ctx, vram, tileAdr, bpp, cgRgb, cgBase);
      }
      set.urls[pal] = set.canvases[pal].toDataURL('image/png');
      this.updatedSets.add(`bg${layerIdx}-${pal}`);
    }

    set.lastFrame = this._frameSeq;
    set.prevCgBase = new Array(nPal).fill(0).map((_, p) =>
      _snapshotPalette(cgRgb, bpp >= 8 ? 0 : p * (1 << bpp), 1 << bpp)
    );
  }

  _updateSpriteSheets(vram, cgRgb, sprAdr1, sprAdr2, objSize) {
    // Sprites are always 4bpp, 8 palettes, CGRAM 128-255.
    // Name table 0 tiles start at sprAdr1; name table 1 tiles start at sprAdr1+sprAdr2.
    this._updateOneSprSheet(0, vram, cgRgb, sprAdr1);
    this._updateOneSprSheet(1, vram, cgRgb, sprAdr1 + sprAdr2);
    this._prevSprCgRgb = cgRgb.slice(128, 256);
  }

  _updateOneSprSheet(nt, vram, cgRgb, tileAdr) {
    const nPal = 8;
    const bpp  = 4;

    let set = this._sprSets[nt];
    if (!set) {
      set = this._createSet(`spr${nt}`, nPal, false);
      this._sprSets[nt] = set;
    }

    const hash = this._hashVramRegion(vram, tileAdr, bpp);
    const tilesDirty = hash !== set.vramHash;
    set.vramHash = hash;

    for (let pal = 0; pal < nPal; pal++) {
      const cgBase = 128 + pal * 16;
      const palDirty = this._isSprPaletteDirty(pal, cgRgb, cgBase);
      if (!tilesDirty && !palDirty) continue;

      _renderSheet(set.contexts[pal], vram, tileAdr, bpp, cgRgb, cgBase);
      set.urls[pal] = set.canvases[pal].toDataURL('image/png');
      this.updatedSets.add(`spr${nt}-${pal}`);
    }

    set.lastFrame = this._frameSeq;
  }

  _createSet(key, nPal, bigTiles) {
    const size     = bigTiles ? 256 : 128;
    const canvases = [];
    const contexts = [];
    for (let i = 0; i < nPal; i++) {
      const c = document.createElement('canvas');
      c.width  = size;
      c.height = size;
      canvases.push(c);
      contexts.push(c.getContext('2d'));
    }
    return {
      id: this._bgSetSeq++,
      key,
      bigTiles,
      canvases,
      contexts,
      urls: new Array(nPal).fill(null),
      vramHash: -1,
      lastFrame: 0,
      prevCgBase: null,
    };
  }

  _hashVramRegion(vram, startWord, bpp) {
    const wordsPerTile = bpp * 4;
    const totalWords   = Math.min(256 * wordsPerTile, 0x8000 - startWord);
    let h = 0x811c9dc5;
    for (let i = 0; i < totalWords; i++) {
      h ^= vram[(startWord + i) & 0x7fff];
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  _isPaletteDirty(layerIdx, palGroup, cgRgb, cgBase, bpp) {
    const key = `bg${layerIdx}`;
    const set = this._bgSets.get(key);
    if (!set?.prevCgBase) return true;
    const nColors = 1 << bpp;
    const prev = set.prevCgBase[palGroup];
    if (!prev) return true;
    for (let i = 0; i < nColors; i++) {
      if (cgRgb[(cgBase + i) & 0xff] !== prev[i]) return true;
    }
    return false;
  }

  _isSprPaletteDirty(pal, cgRgb, cgBase) {
    if (!this._prevSprCgRgb) return true;
    for (let i = 0; i < 16; i++) {
      if (cgRgb[cgBase + i] !== this._prevSprCgRgb[pal * 16 + i]) return true;
    }
    return false;
  }

  _rebuildStylesheet() {
    let css = '';

    for (const set of this._bgSets.values()) {
      const m = set.key.match(/^bg(\d+)$/);
      if (!m) continue;
      const l    = m[1];
      const size = set.bigTiles ? 256 : 128;
      for (let pal = 0; pal < set.urls.length; pal++) {
        const url = set.urls[pal];
        if (!url) continue;
        css += `.bg${l}-set-${set.id} .bg${l}-pal-${pal} { background-image: url("${url}"); background-size: ${size}px ${size}px; }\n`;
      }
    }

    const sprPrefixes = ['spr', 'spr1'];
    for (let nt = 0; nt < 2; nt++) {
      const set = this._sprSets[nt];
      if (!set) continue;
      for (let pal = 0; pal < set.urls.length; pal++) {
        const url = set.urls[pal];
        if (!url) continue;
        css += `.${sprPrefixes[nt]}-pal-${pal} { background-image: url("${url}"); }\n`;
      }
    }

    this.styleEl.textContent = css;
  }
}

// --- VRAM tile decoding and spritesheet rendering ---

/**
 * Render 256 normal 8×8 tiles into a 128×128 canvas (16×16 grid).
 */
function _renderSheet(ctx, vram, tileAdr, bpp, cgRgb, cgBase) {
  const wordsPerTile = bpp * 4;
  const planeGroups  = bpp >> 1;
  const imgData = ctx.createImageData(128, 128);
  const data    = imgData.data;

  // Pre-decode palette colors into RGBA components
  const nColors = 1 << bpp;
  const palR = new Uint8Array(nColors);
  const palG = new Uint8Array(nColors);
  const palB = new Uint8Array(nColors);
  for (let ci = 1; ci < nColors; ci++) {
    const hex = cgRgb[(cgBase + ci) & 0xff];
    if (!hex || hex === '#000000') continue;
    palR[ci] = parseInt(hex.slice(1, 3), 16);
    palG[ci] = parseInt(hex.slice(3, 5), 16);
    palB[ci] = parseInt(hex.slice(5, 7), 16);
  }

  const pix = new Uint8Array(64);
  for (let tileIdx = 0; tileIdx < 256; tileIdx++) {
    const tileCol = tileIdx & 15;
    const tileRow = (tileIdx >> 4) & 15;
    const baseX   = tileCol * 8;
    const baseY   = tileRow * 8;

    pix.fill(0);
    for (let y = 0; y < 8; y++) {
      for (let g = 0; g < planeGroups; g++) {
        const wordAddr = (tileAdr + tileIdx * wordsPerTile + y + g * 8) & 0x7fff;
        const word     = vram[wordAddr];
        const lo = word & 0xff;
        const hi = (word >> 8) & 0xff;
        for (let x = 0; x < 8; x++) {
          const shift = 7 - x;
          pix[y * 8 + x] |= (((lo >> shift) & 1) << (g * 2)) | (((hi >> shift) & 1) << (g * 2 + 1));
        }
      }
    }

    for (let py = 0; py < 8; py++) {
      for (let px = 0; px < 8; px++) {
        const ci   = pix[py * 8 + px];
        const dest = ((baseY + py) * 128 + baseX + px) * 4;
        if (ci === 0) {
          data[dest + 3] = 0;
        } else {
          data[dest]     = palR[ci];
          data[dest + 1] = palG[ci];
          data[dest + 2] = palB[ci];
          data[dest + 3] = 255;
        }
      }
    }
  }

  ctx.putImageData(imgData, 0, 0);
}

/**
 * Render 256 composite 16×16 tiles into a 256×256 canvas (16×16 grid).
 * Each composite tile at position (tileNum) is built from four 8×8 sub-tiles:
 *   top-left = tileNum, top-right = tileNum+1,
 *   bottom-left = tileNum+16, bottom-right = tileNum+17
 */
function _renderBigTileSheet(ctx, vram, tileAdr, bpp, cgRgb, cgBase) {
  const wordsPerTile = bpp * 4;
  const planeGroups  = bpp >> 1;
  const imgData = ctx.createImageData(256, 256);
  const data    = imgData.data;

  const nColors = 1 << bpp;
  const palR = new Uint8Array(nColors);
  const palG = new Uint8Array(nColors);
  const palB = new Uint8Array(nColors);
  for (let ci = 1; ci < nColors; ci++) {
    const hex = cgRgb[(cgBase + ci) & 0xff];
    if (!hex || hex === '#000000') continue;
    palR[ci] = parseInt(hex.slice(1, 3), 16);
    palG[ci] = parseInt(hex.slice(3, 5), 16);
    palB[ci] = parseInt(hex.slice(5, 7), 16);
  }

  const pix = new Uint8Array(64);

  // Sub-tile offsets within the 16×16 composite cell: [dx, dy, tileOffset]
  const subTiles = [
    [0, 0,  0],   // top-left
    [8, 0,  1],   // top-right
    [0, 8, 16],   // bottom-left
    [8, 8, 17],   // bottom-right
  ];

  for (let tileNum = 0; tileNum < 256; tileNum++) {
    const cellCol = tileNum & 15;
    const cellRow = (tileNum >> 4) & 15;
    const cellX   = cellCol * 16;
    const cellY   = cellRow * 16;

    for (const [dx, dy, tileOff] of subTiles) {
      const subIdx = (tileNum + tileOff) & 0xff;
      pix.fill(0);

      for (let y = 0; y < 8; y++) {
        for (let g = 0; g < planeGroups; g++) {
          const wordAddr = (tileAdr + subIdx * wordsPerTile + y + g * 8) & 0x7fff;
          const word     = vram[wordAddr];
          const lo = word & 0xff;
          const hi = (word >> 8) & 0xff;
          for (let x = 0; x < 8; x++) {
            const shift = 7 - x;
            pix[y * 8 + x] |= (((lo >> shift) & 1) << (g * 2)) | (((hi >> shift) & 1) << (g * 2 + 1));
          }
        }
      }

      for (let py = 0; py < 8; py++) {
        for (let px = 0; px < 8; px++) {
          const ci   = pix[py * 8 + px];
          const dest = ((cellY + dy + py) * 256 + cellX + dx + px) * 4;
          if (ci === 0) {
            data[dest + 3] = 0;
          } else {
            data[dest]     = palR[ci];
            data[dest + 1] = palG[ci];
            data[dest + 2] = palB[ci];
            data[dest + 3] = 255;
          }
        }
      }
    }
  }

  ctx.putImageData(imgData, 0, 0);
}

function _snapshotPalette(cgRgb, cgBase, nColors) {
  return Array.from({ length: nColors }, (_, i) => cgRgb[(cgBase + i) & 0xff]);
}
