/**
 * Software BG canvas renderer with per-scanline scroll.
 *
 * Used as a drop-in replacement for BGLayer when HDMA scroll is detected.
 * Renders a 256×224 canvas directly using per-scanline bgHoff/bgVoff values
 * captured by instrumentSnes().
 *
 * Tile decoding matches tile-cache.js / pipu.js exactly:
 *   wordsPerTile = bpp * 4  (8 for 2bpp, 16 for 4bpp, 32 for 8bpp)
 *   wordAddr = (tileAdr + tileNum * wordsPerTile + row + group * 8) & 0x7fff
 *   colorIdx bit g*2   = (lo >> (7-x)) & 1
 *   colorIdx bit g*2+1 = (hi >> (7-x)) & 1
 *   colorIdx 0 = transparent
 *
 * BigTiles: 16×16 pixel tiles composed of four 8×8 sub-tiles.
 *   sub-tile offsets: TL=+0, TR=+1, BL=+16, BR=+17  (16-column tile grid)
 */
export class BGCanvasRenderer {
  constructor(container, layerIdx) {
    this._layerIdx = layerIdx;

    this._canvas = document.createElement('canvas');
    this._canvas.width  = 256;
    this._canvas.height = 224;
    this._canvas.style.cssText =
      'position:absolute;top:0;left:0;image-rendering:pixelated;display:none;';
    container.appendChild(this._canvas);

    this._ctx = this._canvas.getContext('2d');
    this._imgData = this._ctx.createImageData(256, 224);
  }

  setZIndices(loZ /*, hiZ — canvas renders both priority bands, use loZ */) {
    // Canvas renders both priority bands in a single pass; use the lo z-index
    // so it sits correctly relative to the CSS bg layers.
    this._canvas.style.zIndex = String(loZ);
  }

  setColorMath(filter, opacity) {
    this._canvas.style.filter  = filter  || '';
    this._canvas.style.opacity = opacity || '';
  }

  show() { this._canvas.style.display = ''; }
  hide() { this._canvas.style.display = 'none'; }

  /**
   * Render the BG layer to the canvas using per-scanline scroll.
   * @param {object}     layer       - BG layer config from PPUStateExtractor
   * @param {Uint16Array} vram       - VRAM word array
   * @param {string[]}   cgRgb       - decoded CGRAM colors (#RRGGBB, 256 entries)
   * @param {Array|null} scanlineData - per-scanline capture from instrumentSnes
   */
  update(layer, vram, cgRgb, scanlineData, palR, palG, palB) {
    const {
      layerIdx, bpp, tilemapAdr, tileAdr, bigTiles,
      tilemapWidth: tmW, tilemapHeight: tmH,
      scrollX: frameScrollX, scrollY: frameScrollY,
    } = layer;

    const tileSize     = bigTiles ? 16 : 8;
    const tileShift    = bigTiles ? 4 : 3;
    const tileMask     = tileSize - 1;
    const wordsPerTile = bpp * 4;
    const planeGroups  = bpp >> 1;
    const mapPxW       = tmW * tileSize;
    const mapPxH       = tmH * tileSize;
    const mapPxWMask   = mapPxW - 1;
    const mapPxHMask   = mapPxH - 1;

    const imgData = this._imgData;
    const data    = imgData.data;

    for (let y = 0; y < 224; y++) {
      const rowBase = y * 256;
      const sd = scanlineData?.[y];
      const scrollX = sd ? sd.bgHoff[layerIdx] : frameScrollX;
      const scrollY = sd ? sd.bgVoff[layerIdx] : frameScrollY;

      // Tilemap dimensions are powers of two, so wrapping can use a bitmask.
      const mapY    = (y + scrollY) & mapPxHMask;
      const tileRow = mapY >> tileShift;
      const pixRow  = mapY & tileMask;

      // Tilemap quadrant row offset
      const qRowOff  = tileRow >= 32 ? (tmW > 32 ? 0x800 : 0x400) : 0;
      const localRow = tileRow & 31;

      let prevTileCol = -1;
      let tileNum = 0, palette = 0, flipH = false, flipV = false, cgBase = 0;
      let mapX = scrollX & mapPxWMask;

      for (let x = 0; x < 256; x++) {
        const tileCol = mapX >> tileShift;
        const pixCol  = mapX & tileMask;

        // Re-read tilemap entry when tile column changes
        if (tileCol !== prevTileCol) {
          prevTileCol = tileCol;
          const qColOff  = tileCol >= 32 ? 0x400 : 0;
          const localCol = tileCol & 31;
          const entry = vram[(tilemapAdr + qColOff + qRowOff + (localRow << 5) + localCol) & 0x7fff];
          tileNum = entry & 0x3ff;
          palette = (entry >> 10) & 0x7;
          flipH   = (entry & 0x4000) > 0;
          flipV   = (entry & 0x8000) > 0;
          cgBase  = bpp >= 8 ? 0 : palette * (1 << bpp);
        }

        const px = flipH ? (tileSize - 1 - pixCol) : pixCol;
        const py = flipV ? (tileSize - 1 - pixRow) : pixRow;

        // For bigTiles: which 8×8 sub-tile within the 16×16 composite tile?
        const subOff = bigTiles ? ((py >= 8 ? 16 : 0) + (px >= 8 ? 1 : 0)) : 0;
        const spx = px & 7;
        const spy = py & 7;

        // Decode bitplanes
        let colorIdx = 0;
        const shift  = 7 - spx;
        for (let g = 0; g < planeGroups; g++) {
          const wAddr = (tileAdr + ((tileNum + subOff) & 0x3ff) * wordsPerTile + spy + g * 8) & 0x7fff;
          const w     = vram[wAddr];
          colorIdx |= (((w & 0xff) >> shift) & 1) << (g * 2)
                   |  ((((w >> 8) & 0xff) >> shift) & 1) << (g * 2 + 1);
        }

        const dest = (rowBase + x) * 4;
        if (colorIdx === 0) {
          data[dest + 3] = 0;
        } else {
          const cgIdx   = (cgBase + colorIdx) & 0xff;
          data[dest]     = palR[cgIdx];
          data[dest + 1] = palG[cgIdx];
          data[dest + 2] = palB[cgIdx];
          data[dest + 3] = 255;
        }

        mapX = (mapX + 1) & mapPxWMask;
      }
    }

    this._ctx.putImageData(imgData, 0, 0);
  }
}
