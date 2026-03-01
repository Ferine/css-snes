/**
 * Mode 7 renderer.
 *
 * When per-scanline state is available (instrumentSnes active), uses a software
 * rasterizer that matches pipu.js's generateMode7Coords/getMode7Pixel exactly,
 * producing a correct 256×224 canvas with per-scanline matrix params.
 *
 * Falls back to a CSS 3D perspective approximation when scanlineData is null,
 * or when forced by the renderer.
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

    // --- CSS fallback: perspective + CSS plane (image source generated offscreen) ---
    this._perspEl = document.createElement('div');
    this._perspEl.className = 'mode7-perspective';
    this._perspEl.style.display = 'none';
    container.appendChild(this._perspEl);

    this._planeEl = document.createElement('div');
    this._planeEl.className = 'mode7-plane';
    this._perspEl.appendChild(this._planeEl);

    this._rowsRoot = document.createElement('div');
    this._rowsRoot.className = 'mode7-rows';
    this._rowsRoot.style.display = 'none';
    this._perspEl.appendChild(this._rowsRoot);
    this._rows = new Array(224);
    for (let y = 0; y < 224; y++) {
      const row = document.createElement('div');
      row.className = 'mode7-row';
      row.style.top = `${y}px`;
      const plane = document.createElement('div');
      plane.className = 'mode7-row-plane';
      row.appendChild(plane);
      this._rowsRoot.appendChild(row);
      this._rows[y] = { row, plane };
    }

    this._tilemapCanvas = document.createElement('canvas');
    this._tilemapCanvas.width  = 1024;
    this._tilemapCanvas.height = 1024;
    this._tilemapCtx = this._tilemapCanvas.getContext('2d');

    this._prevMapHash = -1;
    this._prevPalHash = -1;
    this._prevClip    = '';
    this._enabled     = false;
  }

  /**
   * Update Mode 7 layer from PPU state.
   * @param {object} ppuState
   * @param {object} [options]
   * @param {boolean} [options.forceCss=false] - force CSS approximation path
   */
  update(ppuState, options = {}) {
    const { forceCss = false } = options;
    const { mode, mode7, vram, cgRgb, forcedBlank, scanlineData } = ppuState;
    const hasMode7Rows = _hasMode7Scanlines(scanlineData);

    if (forcedBlank || (mode !== 7 && !hasMode7Rows)) {
      this.hide();
      return;
    }

    this._enabled = true;

    const canUseSoftware = !!scanlineData && hasMode7Rows;
    const hasMode7Hdma = _hasMode7Hdma(scanlineData);
    const useSoftware = canUseSoftware && (!forceCss || hasMode7Hdma);
    if (useSoftware) {
      // Software path: accurate per-scanline rasterizer
      this._perspEl.style.display = 'none';
      this._swCanvas.style.display = '';
      this._renderSoftware(vram, cgRgb, mode7, scanlineData);
    } else {
      // CSS fallback path
      this._swCanvas.style.display = 'none';
      this._perspEl.style.display = '';

      const mapHash = _hashVramRange(vram, 0, 0x4000);
      const palHash = _hashPalette(cgRgb);
      if (mapHash !== this._prevMapHash || palHash !== this._prevPalHash) {
        this._renderTilemap(vram, cgRgb);
        this._prevMapHash = mapHash;
        this._prevPalHash = palHash;
      }

      const useRowMode = !!scanlineData;
      if (useRowMode) {
        this._planeEl.style.display = 'none';
        this._rowsRoot.style.display = '';
        this._renderCssRows(mode7, scanlineData);
        this._perspEl.style.clipPath = '';
        this._prevClip = '';
      } else {
        this._rowsRoot.style.display = 'none';
        this._planeEl.style.display = '';
        this._applyTransform(_resolveTransformState(mode7, scanlineData));
        this._applyScanlineClip(scanlineData);
      }
    }
  }

  hide() {
    this._swCanvas.style.display = 'none';
    this._perspEl.style.display  = 'none';
    this._perspEl.style.clipPath = '';
    this._prevClip = '';
    this._rowsRoot.style.display = 'none';
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
    const bdR = palR[0];
    const bdG = palG[0];
    const bdB = palB[0];

    for (let y = 0; y < 224; y++) {
      const sd = scanlineData?.[y];
      if (sd && sd.mode !== 7) {
        const rowBase = y * 256;
        for (let x = 0; x < 256; x++) {
          data[(rowBase + x) * 4 + 3] = 0;
        }
        continue;
      }
      const m = sd && typeof sd.mode7A === 'number' ? sd : frameMode7AsM7(frameMode7);

      // Mode 7 scanlines are fully resolved against backdrop in this pass.
      const rowBase = y * 256;
      for (let x = 0; x < 256; x++) {
        const dest = (rowBase + x) * 4;
        data[dest]     = bdR;
        data[dest + 1] = bdG;
        data[dest + 2] = bdB;
        data[dest + 3] = 255;
      }

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
        const dest = (rowBase + x) * 4;

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

        if (colorIdx !== 0) {
          data[dest]     = palR[colorIdx];
          data[dest + 1] = palG[colorIdx];
          data[dest + 2] = palB[colorIdx];
          data[dest + 3] = 255;
        }
      }
    }

    this._swCtx.putImageData(imgData, 0, 0);
  }

  // --- CSS fallback ---

  _renderTilemap(vram, cgRgb) {
    const ctx = this._tilemapCtx;
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
          const rowBase = (tileBase + py * 8) & 0x7fff;
          for (let px = 0; px < 8; px++) {
            const ci   = (vram[(rowBase + px) & 0x7fff] >> 8) & 0xff;
            const dest = ((baseY + py) * 1024 + baseX + px) * 4;
            if (ci === 0) {
              data[dest + 3] = 0;
            } else {
              data[dest]     = r[ci];
              data[dest + 1] = g[ci];
              data[dest + 2] = b[ci];
              data[dest + 3] = 255;
            }
          }
        }
      }
    }

    ctx.putImageData(imgData, 0, 0);
    const mapUrl = `url("${this._tilemapCanvas.toDataURL('image/png')}")`;
    this._perspEl.style.setProperty('--m7-map-url', mapUrl);
  }

  _applyTransform(m7) {
    const A = _m7Fixed(m7.a);
    const B = _m7Fixed(m7.b);
    const C = _m7Fixed(m7.c);
    const D = _m7Fixed(m7.d);

    const mapXRaw = ((m7.hoff - m7.x) & 0x7ff) + m7.x;
    const mapYRaw = ((m7.voff - m7.y) & 0x7ff) + m7.y;
    const mapX = ((mapXRaw % 1024) + 1024) % 1024;
    const mapY = ((mapYRaw % 1024) + 1024) % 1024;

    const cx = 128;
    const cy = 112;

    // Use inverse affine matrix so CSS path can capture rotation/shear as well as scale.
    // Clamp aggressively to keep approximation stable when determinant is near-zero.
    const det = A * D - B * C;
    let ia, ib, ic, id;
    if (Math.abs(det) > 0.001) {
      ia = _clamp(D / det, -8, 8);
      ib = _clamp(-C / det, -8, 8);
      ic = _clamp(-B / det, -8, 8);
      id = _clamp(A / det, -8, 8);
    } else {
      ia = A !== 0 ? _clamp(1 / A, -8, 8) : 1;
      ib = 0;
      ic = 0;
      id = D !== 0 ? _clamp(1 / D, -8, 8) : 1;
    }

    const panX = -(mapX - cx);
    const panY = -(mapY - cy);

    const absD = Math.max(Math.abs(D), 0.001);
    const perspDepth = Math.max(80, Math.min(1200, Math.round(200 / absD)));

    this._perspEl.style.perspective       = `${perspDepth}px`;
    this._perspEl.style.perspectiveOrigin = `${cx}px 0px`;

    this._planeEl.style.transform =
      `translate(${panX}px, ${panY}px) matrix(${ia.toFixed(5)}, ${ib.toFixed(5)}, ${ic.toFixed(5)}, ${id.toFixed(5)}, 0, 0)`;
    this._planeEl.style.transformOrigin = `${-panX + cx}px ${-panY}px`;
  }

  _applyScanlineClip(scanlineData) {
    let clip = '';
    if (scanlineData) {
      const runs = [];
      let start = -1;
      for (let y = 0; y <= 224; y++) {
        const isM7 = y < 224 && scanlineData[y]?.mode === 7;
        if (isM7) {
          if (start < 0) start = y;
        } else if (start >= 0) {
          runs.push([start, y - 1]);
          start = -1;
        }
      }

      if (runs.length === 0) {
        clip = 'inset(0 0 0 256px)';
      } else if (runs.length === 1) {
        const [first, last] = runs[0];
        if (first > 0 || last < 223) {
          clip = `inset(${first}px 0 ${223 - last}px 0)`;
        }
      } else {
        const polys = [];
        for (const [top, bot] of runs) {
          polys.push(`0px ${top}px`, `256px ${top}px`, `256px ${bot + 1}px`, `0px ${bot + 1}px`);
        }
        clip = `polygon(evenodd, ${polys.join(', ')})`;
      }
    }
    if (clip !== this._prevClip) {
      this._perspEl.style.clipPath = clip;
      this._prevClip = clip;
    }
  }

  _renderCssRows(frameMode7, scanlineData) {
    const { flipX, flipY } = frameMode7;
    const sy = 0.02;

    for (let y = 0; y < 224; y++) {
      const sd = scanlineData[y];
      const slot = this._rows[y];
      if (!sd || sd.mode !== 7) {
        slot.row.style.display = 'none';
        continue;
      }

      const m = sd.mode7A != null ? sd : frameMode7AsM7(frameMode7);
      const rc = _mode7RowCoords(y, m, flipX, flipY);

      const vx = rc.stepX / 256;
      const vy = rc.stepY / 256;
      const denom = vx * vx + vy * vy;
      if (denom < 1e-8) {
        slot.row.style.display = 'none';
        continue;
      }

      const mx0 = rc.mapX / 256;
      const my0 = rc.mapY / 256;

      const a = _clamp(vx / denom, -8, 8);
      const c = _clamp(vy / denom, -8, 8);
      const b = _clamp((-vy * sy) / denom, -8, 8);
      const d = _clamp((vx * sy) / denom, -8, 8);
      const tx = _clamp(-(a * mx0 + c * my0), -8192, 8192);
      const ty = _clamp(-(b * mx0 + d * my0), -8192, 8192);

      slot.plane.style.transform =
        `matrix(${a.toFixed(6)}, ${b.toFixed(6)}, ${c.toFixed(6)}, ${d.toFixed(6)}, ${tx.toFixed(3)}, ${ty.toFixed(3)})`;
      slot.row.style.display = '';
    }
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

function _resolveTransformState(frameMode7, scanlineData) {
  if (scanlineData) {
    let count = 0;
    let sumA = 0, sumB = 0, sumC = 0, sumD = 0;
    let sumX = 0, sumY = 0, sumH = 0, sumV = 0;
    for (let y = 0; y < 224; y++) {
      const s = scanlineData[y];
      if (!s || s.mode !== 7) continue;
      if (typeof s.mode7A !== 'number') continue;
      sumA += s.mode7A; sumB += s.mode7B; sumC += s.mode7C; sumD += s.mode7D;
      sumX += s.mode7X; sumY += s.mode7Y; sumH += s.mode7Hoff; sumV += s.mode7Voff;
      count++;
    }
    if (count > 0) {
      return {
        a: (sumA / count) | 0,
        b: (sumB / count) | 0,
        c: (sumC / count) | 0,
        d: (sumD / count) | 0,
        x: (sumX / count) | 0,
        y: (sumY / count) | 0,
        hoff: (sumH / count) | 0,
        voff: (sumV / count) | 0,
      };
    }
  }
  return frameMode7;
}

function _hasMode7Scanlines(scanlineData) {
  if (!scanlineData) return false;
  for (let y = 0; y < 224; y++) {
    if (scanlineData[y]?.mode === 7) return true;
  }
  return false;
}

function _hasMode7Hdma(scanlineData) {
  if (!scanlineData) return false;
  let base = null;
  for (let y = 0; y < 224; y++) {
    const s = scanlineData[y];
    if (!s || s.mode !== 7 || typeof s.mode7A !== 'number') continue;
    if (!base) {
      base = s;
      continue;
    }
    if (s.mode7A !== base.mode7A || s.mode7B !== base.mode7B ||
        s.mode7C !== base.mode7C || s.mode7D !== base.mode7D ||
        s.mode7X !== base.mode7X || s.mode7Y !== base.mode7Y ||
        s.mode7Hoff !== base.mode7Hoff || s.mode7Voff !== base.mode7Voff) {
      return true;
    }
  }
  return false;
}

function _hashPalette(cgRgb) {
  let h = 0x811c9dc5;
  for (let i = 0; i < 256; i++) {
    const hex = cgRgb[i];
    for (let j = 0; j < hex.length; j++) {
      h ^= hex.charCodeAt(j);
      h = Math.imul(h, 0x01000193);
    }
  }
  return h >>> 0;
}

function _clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

function _mode7RowCoords(y, m, flipX, flipY) {
  const yPos = y + 1;
  const rY = flipY ? 255 - yPos : yPos;

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

  const mapX = flipX ? lineStartX + 255 * m.mode7A : lineStartX;
  const mapY = flipX ? lineStartY + 255 * m.mode7C : lineStartY;
  const stepX = flipX ? -m.mode7A : m.mode7A;
  const stepY = flipX ? -m.mode7C : m.mode7C;

  return { mapX, mapY, stepX, stepY };
}

function _hashVramRange(vram, start, length) {
  let h = 0x811c9dc5;
  for (let i = 0; i < length; i++) {
    h ^= vram[(start + i) & 0x7fff];
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
