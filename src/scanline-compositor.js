/**
 * Scanline compositor: renders each scanline using the mode that was
 * actually active when the PPU rendered it (captured by instrumentSnes).
 *
 * Handles mid-frame mode switches (e.g. F-Zero: mode 1 HUD + mode 7 road).
 * Renders all BG layers to a single 256×224 canvas; CSS sprites overlay on top.
 *
 * BG rendering (non-mode-7 scanlines):
 *   Pixels are resolved by per-tile priority bit13 against mode z tables.
 *   Each layer uses per-scanline bgHoff/bgVoff from scanlineData.
 *   Tile decoding mirrors tile-cache.js / pipu.js bitplane format.
 *
 * Mode 7 rendering (mode-7 scanlines):
 *   Mirrors pipu.js generateMode7Coords / getMode7Pixel exactly.
 *   Per-scanline mode7A/B/C/D/X/Y/Hoff/Voff from scanlineData.
 */

// bits-per-pixel per BG layer per mode (mirrors ppu-state-extractor.js)
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

// Per-mode BG z-index tables: [bg0lo, bg0hi, bg1lo, bg1hi, bg2lo, bg2hi, bg3lo, bg3hi]
const BG_Z_TABLE = {
  0:       [8, 11,  7, 10,  2,  5,  1,  4],
  1:       [6,  9,  5,  8,  1,  3, -1, -1],
  '1l3p':  [5,  8,  4,  7,  2, 10, -1, -1],
  default: [6,  9,  5,  8,  1,  3, -1, -1],
};

export class ScanlineCompositor {
  constructor(container) {
    this._canvas = document.createElement('canvas');
    this._canvas.width  = 256;
    this._canvas.height = 224;
    this._canvas.style.cssText =
      'position:absolute;top:0;left:0;image-rendering:pixelated;z-index:1;display:none;';
    container.appendChild(this._canvas);
    this._ctx = this._canvas.getContext('2d');
    this._imgData = this._ctx.createImageData(256, 224);
    this._prevClip = '';
  }

  hide() { this._canvas.style.display = 'none'; }
  show() { this._canvas.style.display = ''; }
  setClipPath(clip) {
    const next = clip || '';
    if (next === this._prevClip) return;
    this._canvas.style.clipPath = next;
    this._prevClip = next;
  }

  /**
   * Render all scanlines to the compositor canvas.
   * @param {object} ppuState - full PPU state with scanlineData
   */
  update(ppuState, options = {}) {
    const { vram, bgLayers, mode7, scanlineData, palR, palG, palB } = ppuState;
    const layerVisible = options.layerVisible ?? null;
    const layer3Prio = !!ppuState.layer3Prio;

    const imgData = this._imgData;
    const data    = imgData.data;

    // Fill backdrop using Uint32Array (4× fewer writes)
    const u32 = new Uint32Array(data.buffer);
    const bdPixel = (255 << 24) | (palB[0] << 16) | (palG[0] << 8) | palR[0];
    u32.fill(bdPixel);

    const m7 = mode7; // frame-end mode7 (fallback when no per-scanline data)
    const zBuf = new Int16Array(256);

    for (let y = 0; y < 224; y++) {
      const sd        = scanlineData?.[y];
      const lineMode  = sd?.mode ?? ppuState.mode;

      if (lineMode === 7) {
        if (!layerVisible || layerVisible.bg0 !== false) {
          _renderMode7Row(y, sd, m7, vram, palR, palG, palB, data);
        }
      } else {
        zBuf.fill(0);
        const bgZ = _bgZTableForMode(lineMode, layer3Prio);
        _renderBGRow(y, lineMode, sd, bgLayers, vram, palR, palG, palB, data, layerVisible, bgZ, zBuf);
      }
    }

    this._ctx.putImageData(imgData, 0, 0);
  }
}

/**
 * Returns true if any visible scanline was rendered in mode 7.
 * Used to decide whether to invoke the compositor.
 */
export function hasMode7Scanlines(scanlineData) {
  if (!scanlineData) return false;
  for (let y = 0; y < 224; y++) {
    if (scanlineData[y]?.mode === 7) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Mode 7 per-scanline rendering
// ---------------------------------------------------------------------------

function _renderMode7Row(y, sd, frameM7, vram, palR, palG, palB, data) {
  // Use per-scanline params if available, fall back to frame-end state
  const m = sd ?? {
    mode7A: frameM7.a, mode7B: frameM7.b, mode7C: frameM7.c, mode7D: frameM7.d,
    mode7X: frameM7.x, mode7Y: frameM7.y, mode7Hoff: frameM7.hoff, mode7Voff: frameM7.voff,
  };

  const { largeField, char0fill, flipX, flipY } = frameM7;

  // SnesJs yPos for this visible row (1-indexed, matching generateMode7Coords)
  const yPos = y + 1;
  const rY   = flipY ? 255 - yPos : yPos;

  // 13-bit sign-extend scroll offsets (mirrors pipu.js lines 2541-2544)
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

  let mapX   = flipX ? lineStartX + 255 * m.mode7A : lineStartX;
  let mapY   = flipX ? lineStartY + 255 * m.mode7C : lineStartY;
  const stepX = flipX ? -m.mode7A : m.mode7A;
  const stepY = flipX ? -m.mode7C : m.mode7C;

  const rowBase = y * 256;

  for (let x = 0; x < 256; x++) {
    const dest = (rowBase + x) * 4;
    let px = mapX >> 8;
    let py = mapY >> 8;
    mapX += stepX;
    mapY += stepY;

    // OOB for largeField
    if (largeField && (px < 0 || px >= 1024 || py < 0 || py >= 1024)) {
      if (char0fill) {
        px &= 0x7;
        py &= 0x7;
      } else {
        data[dest + 3] = 0;
        continue;
      }
    }

    const tileX   = (px & 0x3f8) >> 3;
    const tileY   = (py & 0x3f8) >> 3;
    const tileIdx = vram[(tileY * 128 + tileX) & 0x7fff] & 0xff;
    const pixX    = px & 0x7;
    const pixY    = py & 0x7;
    const ci      = (vram[(tileIdx * 64 + pixY * 8 + pixX) & 0x7fff] >> 8) & 0xff;

    if (ci !== 0) {
      data[dest]     = palR[ci];
      data[dest + 1] = palG[ci];
      data[dest + 2] = palB[ci];
      data[dest + 3] = 255;
    }
    // else: leave backdrop colour already written
  }
}

// ---------------------------------------------------------------------------
// BG per-scanline rendering
// ---------------------------------------------------------------------------

function _renderBGRow(y, mode, sd, bgLayers, vram, palR, palG, palB, data, layerVisible, bgZ, zBuf) {
  const rowBase = y * 256;

  for (let l = 0; l < 4; l++) {
    if (layerVisible && layerVisible[`bg${l}`] === false) continue;
    const layer = bgLayers[l];
    if (!layer || !layer.enabled) continue;

    const bpp = BIT_PER_MODE[mode * 4 + l];
    if (bpp === 5) continue; // layer absent in this mode

    const {
      tilemapAdr, tileAdr, bigTiles,
      tilemapWidth: tmW, tilemapHeight: tmH,
    } = layer;

    const tileSize     = bigTiles ? 16 : 8;
    const wordsPerTile = bpp * 4;
    const planeGroups  = bpp >> 1;
    const mapPxW       = tmW * tileSize;
    const mapPxH       = tmH * tileSize;

    const scrollX = sd ? sd.bgHoff[l] : layer.scrollX;
    const scrollY = sd ? sd.bgVoff[l] : layer.scrollY;

    const mapY    = ((y + scrollY) % mapPxH + mapPxH) % mapPxH;
    const tileRow = (mapY / tileSize) | 0;
    const pixRow  = mapY % tileSize;

    const qRowOff  = tileRow >= 32 ? (tmW > 32 ? 0x800 : 0x400) : 0;
    const localRow = tileRow & 31;

    let prevTileCol = -1;
    let tileNum = 0, palette = 0, flipH = false, flipV = false, cgBase = 0;
    let tileZ = -1;

    for (let x = 0; x < 256; x++) {
      const mapX    = ((x + scrollX) % mapPxW + mapPxW) % mapPxW;
      const tileCol = (mapX / tileSize) | 0;
      const pixCol  = mapX % tileSize;

      if (tileCol !== prevTileCol) {
        prevTileCol = tileCol;
        const qColOff  = tileCol >= 32 ? 0x400 : 0;
        const localCol = tileCol & 31;
        const entry = vram[(tilemapAdr + qColOff + qRowOff + (localRow << 5) + localCol) & 0x7fff];
        tileNum = entry & 0x3ff;
        palette = (entry >> 10) & 0x7;
        const prio13 = (entry >> 13) & 0x1;
        flipH   = (entry & 0x4000) > 0;
        flipV   = (entry & 0x8000) > 0;
        cgBase  = bpp >= 8 ? 0 : palette * (1 << bpp);
        tileZ   = bgZ[l * 2 + prio13];
      }

      if (tileZ < 0) continue;

      const px = flipH ? (tileSize - 1 - pixCol) : pixCol;
      const py = flipV ? (tileSize - 1 - pixRow) : pixRow;

      const subOff = bigTiles ? ((py >= 8 ? 16 : 0) + (px >= 8 ? 1 : 0)) : 0;
      const spx    = px & 7;
      const spy    = py & 7;
      const shift  = 7 - spx;

      let ci = 0;
      for (let g = 0; g < planeGroups; g++) {
        const w = vram[(tileAdr + ((tileNum + subOff) & 0x3ff) * wordsPerTile + spy + g * 8) & 0x7fff];
        ci |= (((w & 0xff) >> shift) & 1) << (g * 2)
           |  ((((w >> 8) & 0xff) >> shift) & 1) << (g * 2 + 1);
      }

      if (ci !== 0) {
        if (tileZ <= zBuf[x]) continue;
        zBuf[x] = tileZ;
        const dest = (rowBase + x) * 4;
        const cgIdx = (cgBase + ci) & 0xff;
        data[dest]     = palR[cgIdx];
        data[dest + 1] = palG[cgIdx];
        data[dest + 2] = palB[cgIdx];
        data[dest + 3] = 255;
      }
    }
  }
}

function _bgZTableForMode(mode, layer3Prio) {
  if (mode === 0) return BG_Z_TABLE[0];
  if (mode === 1) return layer3Prio ? BG_Z_TABLE['1l3p'] : BG_Z_TABLE[1];
  return BG_Z_TABLE.default;
}
