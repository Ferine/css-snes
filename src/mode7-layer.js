/**
 * Mode 7 renderer.
 *
 * When per-scanline state is available (instrumentSnes active), uses a software
 * rasterizer that matches pipu.js's generateMode7Coords/getMode7Pixel exactly,
 * producing a correct 256×224 canvas with per-scanline matrix params.
 *
 * Falls back to a CSS 3D perspective approximation when scanlineData is null.
 *
 * Mode 7 VRAM layout (tilemap + tile data share the same words):
 *   vram[tileY*128 + tileX] & 0xff         → tile index (low byte)
 *   (vram[tileIdx*64 + py*8 + px] >> 8) & 0xff → pixel color (high byte)
 */
export class Mode7Layer {
  constructor(container) {
    this.container = container;

    // --- Software rasterizer canvas (256×224, direct screen coords) ---
    this._swCanvas = document.createElement('canvas');
    this._swCanvas.width  = 256;
    this._swCanvas.height = 224;
    this._swCanvas.style.cssText =
      'position:absolute;top:0;left:0;image-rendering:pixelated;z-index:1;display:none;';
    container.appendChild(this._swCanvas);
    this._swCtx = this._swCanvas.getContext('2d');

    // --- CSS fallback: perspective + 1024×1024 tilemap canvas ---
    this._perspEl = document.createElement('div');
    this._perspEl.className = 'mode7-perspective';
    this._perspEl.style.display = 'none';
    container.appendChild(this._perspEl);

    this._cssCanvas = document.createElement('canvas');
    this._cssCanvas.width  = 1024;
    this._cssCanvas.height = 1024;
    this._cssCanvas.className = 'mode7-plane';
    this._perspEl.appendChild(this._cssCanvas);
    this._cssCtx = this._cssCanvas.getContext('2d');

    this._prevMapHash   = -1;
    this._enabled       = false;
  }

  /**
   * Update Mode 7 layer from PPU state.
   * @param {object} ppuState
   */
  update(ppuState) {
    const { mode, mode7, vram, cgRgb, forcedBlank, scanlineData } = ppuState;

    if (mode !== 7 || forcedBlank) {
      this.hide();
      return;
    }

    this._enabled = true;

    if (scanlineData) {
      // Software path: accurate per-scanline rasterizer
      this._perspEl.style.display = 'none';
      this._swCanvas.style.display = '';
      this._renderSoftware(vram, cgRgb, mode7, scanlineData);
    } else {
      // CSS fallback path
      this._swCanvas.style.display = 'none';
      this._perspEl.style.display = '';

      const mapHash = _hashVramRange(vram, 0, 0x4000);
      if (mapHash !== this._prevMapHash) {
        this._renderTilemap(vram, cgRgb);
        this._prevMapHash = mapHash;
      }
      this._applyTransform(mode7);
    }
  }

  hide() {
    this._swCanvas.style.display = 'none';
    this._perspEl.style.display  = 'none';
    this._enabled = false;
  }

  // --- Software rasterizer ---

  /**
   * Render 256×224 pixels directly, one scanline at a time, using per-scanline
   * mode 7 matrix parameters. Mirrors pipu.js generateMode7Coords/getMode7Pixel.
   */
  _renderSoftware(vram, cgRgb, frameMode7, scanlineData) {
    const { largeField, char0fill, flipX, flipY } = frameMode7;

    // Pre-decode 256-entry palette to R/G/B
    const palR = new Uint8Array(256);
    const palG = new Uint8Array(256);
    const palB = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
      const c = cgRgb[i];
      palR[i] = parseInt(c.slice(1, 3), 16);
      palG[i] = parseInt(c.slice(3, 5), 16);
      palB[i] = parseInt(c.slice(5, 7), 16);
    }

    const imgData = this._swCtx.createImageData(256, 224);
    const data    = imgData.data;

    for (let y = 0; y < 224; y++) {
      const m = scanlineData[y] ?? frameMode7AsM7(frameMode7);

      // SnesJs calls generateMode7Coords(yPos) where yPos = y+1 for the first visible row.
      const yPos = y + 1;
      const rY = flipY ? 255 - yPos : yPos;

      // 13-bit sign-extend for scroll offsets (pipu.js lines 2541-2544)
      let clH = m.mode7Hoff - m.mode7X;
      clH = (clH & 0x2000) > 0 ? (clH | ~0x3ff) : (clH & 0x3ff);
      let clV = m.mode7Voff - m.mode7Y;
      clV = (clV & 0x2000) > 0 ? (clV | ~0x3ff) : (clV & 0x3ff);

      // Starting map coords for screen pixel 0 of this scanline (8 frac bits)
      const lineStartX = ((m.mode7A * clH) & ~63)
                       + ((m.mode7B * rY)  & ~63)
                       + ((m.mode7B * clV) & ~63)
                       + (m.mode7X << 8);
      const lineStartY = ((m.mode7C * clH) & ~63)
                       + ((m.mode7D * rY)  & ~63)
                       + ((m.mode7D * clV) & ~63)
                       + (m.mode7Y << 8);

      // Walk across the scanline, incrementing by A (x-component) and C (y-component)
      let mapX = flipX ? lineStartX + 255 * m.mode7A : lineStartX;
      let mapY = flipX ? lineStartY + 255 * m.mode7C : lineStartY;
      const stepX = flipX ? -m.mode7A : m.mode7A;
      const stepY = flipX ? -m.mode7C : m.mode7C;

      for (let x = 0; x < 256; x++) {
        const dest = (y * 256 + x) * 4;

        const px = mapX >> 8;
        const py = mapY >> 8;
        mapX += stepX;
        mapY += stepY;

        // Out-of-bounds handling for largeField
        let tpx = px, tpy = py;
        if (largeField && (px < 0 || px >= 1024 || py < 0 || py >= 1024)) {
          if (char0fill) {
            tpx = px & 0x7;
            tpy = py & 0x7;
          } else {
            data[dest + 3] = 0;
            continue;
          }
        }

        // Tile index from low byte of tilemap word
        const tileX = (tpx & 0x3f8) >> 3;  // 0-127
        const tileY = (tpy & 0x3f8) >> 3;  // 0-127
        const tileIdx = vram[(tileY * 128 + tileX) & 0x7fff] & 0xff;

        // Pixel color from high byte of tile data word (1 pixel per VRAM word)
        const pixX = tpx & 0x7;
        const pixY = tpy & 0x7;
        const colorIdx = (vram[(tileIdx * 64 + pixY * 8 + pixX) & 0x7fff] >> 8) & 0xff;

        if (colorIdx === 0) {
          data[dest + 3] = 0;
        } else {
          data[dest]     = palR[colorIdx];
          data[dest + 1] = palG[colorIdx];
          data[dest + 2] = palB[colorIdx];
          data[dest + 3] = 255;
        }
      }
    }

    this._swCtx.putImageData(imgData, 0, 0);
  }

  // --- CSS fallback (unchanged from original) ---

  _renderTilemap(vram, cgRgb) {
    const ctx = this._cssCtx;
    const imgData = ctx.createImageData(1024, 1024);
    const data    = imgData.data;

    const r = new Uint8Array(256);
    const g = new Uint8Array(256);
    const b = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
      const hex = cgRgb[i];
      r[i] = parseInt(hex.slice(1, 3), 16);
      g[i] = parseInt(hex.slice(3, 5), 16);
      b[i] = parseInt(hex.slice(5, 7), 16);
    }

    for (let ty = 0; ty < 128; ty++) {
      for (let tx = 0; tx < 128; tx++) {
        const mapAddr = (ty * 128 + tx) & 0x7fff;
        const tileNum = vram[mapAddr] & 0xff;
        const tileBase = tileNum * 64;
        const baseX    = tx * 8;
        const baseY    = ty * 8;

        for (let py = 0; py < 8; py++) {
          const rowBase = (tileBase + py * 4) & 0x7fff;
          for (let px = 0; px < 8; px++) {
            const word = vram[(rowBase + (px >> 1)) & 0x7fff];
            const ci   = (px & 1) ? (word >> 8) & 0xff : word & 0xff;
            const dest = ((baseY + py) * 1024 + baseX + px) * 4;
            data[dest]     = r[ci];
            data[dest + 1] = g[ci];
            data[dest + 2] = b[ci];
            data[dest + 3] = 255;
          }
        }
      }
    }

    ctx.putImageData(imgData, 0, 0);
  }

  _applyTransform(m7) {
    const A = _m7Fixed(m7.a);
    const D = _m7Fixed(m7.d);

    const mapX = ((m7.hoff - m7.x) & 0x7ff) + m7.x;
    const mapY = ((m7.voff - m7.y) & 0x7ff) + m7.y;

    const cx = 128;
    const cy = 112;

    const scaleX = A !== 0 ? 1 / A : 1;
    const scaleY = D !== 0 ? 1 / D : 1;

    const panX = -(mapX - cx);
    const panY = -(mapY - cy);

    const perspDepth = Math.abs(D) > 0.1 ? Math.round(200 / Math.abs(D)) : 200;

    this._perspEl.style.perspective       = `${perspDepth}px`;
    this._perspEl.style.perspectiveOrigin = `${cx}px 0px`;

    this._cssCanvas.style.transform =
      `translate(${panX}px, ${panY}px) scale(${scaleX.toFixed(4)}, ${scaleY.toFixed(4)})`;
    this._cssCanvas.style.transformOrigin = `${-panX + cx}px ${-panY}px`;
  }
}

/** Convert frame-end mode7 state to the same field names as scanlineData entries */
function frameMode7AsM7(m7) {
  return {
    mode7A: m7.a, mode7B: m7.b, mode7C: m7.c, mode7D: m7.d,
    mode7X: m7.x, mode7Y: m7.y, mode7Hoff: m7.hoff, mode7Voff: m7.voff,
  };
}

function _m7Fixed(raw) {
  const signed = raw > 0x7fff ? raw - 0x10000 : raw;
  return signed / 256;
}

function _hashVramRange(vram, start, length) {
  let h = 0x811c9dc5;
  for (let i = 0; i < length; i++) {
    h ^= vram[(start + i) & 0x7fff];
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
