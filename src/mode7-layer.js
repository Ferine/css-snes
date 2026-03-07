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
import { Mode7VRAMCache } from './mode7-vram-cache.js';

export class Mode7Layer {
  constructor(container, mode7VramCache = null) {
    this.container = container;
    this._mode7VramCache = mode7VramCache ?? new Mode7VRAMCache();

    // --- Software rasterizer canvas (256×224, direct screen coords) ---
    this._swCanvas = document.createElement('canvas');
    this._swCanvas.width  = 256;
    this._swCanvas.height = 224;
    this._swCanvas.style.cssText =
      'position:absolute;top:0;left:0;image-rendering:pixelated;z-index:1;display:none;';
    container.appendChild(this._swCanvas);
    this._swCtx = this._swCanvas.getContext('2d');
    this._swImgData = this._swCtx.createImageData(256, 224);
    this._swPixels = new Uint32Array(this._swImgData.data.buffer);

    // --- CSS fallback: perspective + CSS plane (image source generated offscreen) ---
    this._perspEl = document.createElement('div');
    this._perspEl.className = 'mode7-perspective';
    this._perspEl.style.display = 'none';
    container.appendChild(this._perspEl);

    this._tilemapCanvas = document.createElement('canvas');
    this._tilemapCanvas.className = 'mode7-plane';
    this._tilemapCanvas.width  = 1024;
    this._tilemapCanvas.height = 1024;
    this._tilemapCtx = this._tilemapCanvas.getContext('2d');
    this._tilemapImgData = this._tilemapCtx.createImageData(1024, 1024);
    this._tilemapPixels = new Uint32Array(this._tilemapImgData.data.buffer);
    this._rgbaPalette = new Uint32Array(256);
    this._perspEl.appendChild(this._tilemapCanvas);
    this._planeEl = this._tilemapCanvas;

    this._rowsRoot = document.createElement('div');
    this._rowsRoot.className = 'mode7-rows';
    this._rowsRoot.style.display = 'none';
    this._perspEl.appendChild(this._rowsRoot);
    this._rows = new Array(224);
    this._prevRowTransforms = new Array(224).fill('');
    this._prevRowVisible = new Array(224).fill(false);
    this._prevRowTop = new Int16Array(224).fill(-1);
    this._prevRowHeight = new Uint16Array(224);
    this._activeRowSlots = 0;
    for (let y = 0; y < 224; y++) {
      const row = document.createElement('div');
      row.className = 'mode7-row';
      row.style.top = `${y}px`;
      row.style.display = 'none';
      const plane = document.createElement('div');
      plane.className = 'mode7-row-plane';
      row.appendChild(plane);
      this._rowsRoot.appendChild(row);
      this._rows[y] = { row, plane };
    }

    this._prevMapHash = -1;
    this._prevPalHash = -1;
    this._prevClip    = '';
    this._enabled     = false;
    this._tilemapTextureReady = false;
    this._rowTextureStale = false;
    this._usedRowModeLastFrame = false;
    this._cssFrameCounter = 0;
    this._lastTilemapUploadFrame = -0x3fffffff;
    this._paletteUploadCadence = 4;
    this._tilemapBlobUrl = '';
    this._tilemapUploadPending = false;
    this._tilemapUploadDirty = false;
    this._tilemapUploadVersion = 0;
    this._tilemapAppliedVersion = 0;
    this._tilemapFlushWaiters = [];
  }

  /**
   * Update Mode 7 layer from PPU state.
   * @param {object} ppuState
   * @param {object} [options]
   * @param {boolean} [options.forceCss=false] - force CSS approximation path
   */
  update(ppuState, options = {}) {
    const { forceCss = false, mode7State: sharedMode7State = null } = options;
    const { mode, mode7, vram, palR, palG, palB, forcedBlank, scanlineData } = ppuState;
    const hasMode7Rows = _hasMode7Scanlines(scanlineData);
    const fallbackM7 = frameMode7AsM7(mode7);

    if (forcedBlank || (mode !== 7 && !hasMode7Rows)) {
      this.hide();
      return;
    }

    this._enabled = true;

    const canUseSoftware = !!scanlineData && hasMode7Rows;
    const useSoftware = canUseSoftware && !forceCss;
    const mode7State = sharedMode7State ?? this._mode7VramCache.ensure(vram);
    if (useSoftware) {
      // Software path: accurate per-scanline rasterizer
      this._perspEl.style.display = 'none';
      this._swCanvas.style.display = '';
      this._usedRowModeLastFrame = false;
      this._renderSoftware(mode7State.indexMap, palR, palG, palB, mode7, fallbackM7, scanlineData);
    } else {
      // CSS fallback path
      this._swCanvas.style.display = 'none';
      this._perspEl.style.display = '';

      const useRowMode = !!scanlineData && hasMode7Rows;
      const cssFrame = ++this._cssFrameCounter;
      const mapHash = mode7State.hash;
      const vramChanged = mapHash !== this._prevMapHash;
      const palHash = _hashMode7Palette(
        palR,
        palG,
        palB,
        mode7State.usedColors,
        true,
        true,
      );
      const paletteChanged = palHash !== this._prevPalHash;
      const shouldUploadPalette = paletteChanged
        && (cssFrame - this._lastTilemapUploadFrame >= this._paletteUploadCadence);
      const repaintNeeded = vramChanged || paletteChanged || !this._tilemapTextureReady;
      const rowTextureDue = this._rowTextureStale && (
        !this._usedRowModeLastFrame
        || (cssFrame - this._lastTilemapUploadFrame >= this._paletteUploadCadence)
      );
      if (repaintNeeded) {
        this._renderTilemap(mode7State.indexMap, palR, palG, palB, {
          uploadTexture: false,
        });
        this._prevMapHash = mapHash;
        this._prevPalHash = palHash;
      }

      if (useRowMode) {
        const needsInitialTexture = !this._tilemapTextureReady;
        const needsSyncUpload = vramChanged || needsInitialTexture || !this._usedRowModeLastFrame;
        const shouldUpload = needsSyncUpload || shouldUploadPalette || rowTextureDue;
        if (shouldUpload) {
          this._queueTilemapTextureUpload(needsSyncUpload);
          this._tilemapTextureReady = true;
          this._rowTextureStale = false;
          this._lastTilemapUploadFrame = cssFrame;
        } else if (paletteChanged) {
          this._rowTextureStale = true;
        }
      } else if (repaintNeeded && this._tilemapTextureReady) {
        this._rowTextureStale = true;
      }

      if (useRowMode) {
        this._perspEl.style.perspective = 'none';
        this._perspEl.style.perspectiveOrigin = '';
        this._planeEl.style.display = 'none';
        this._rowsRoot.style.display = '';
        this._renderCssRows(mode7, fallbackM7, scanlineData);
        this._perspEl.style.clipPath = '';
        this._prevClip = '';
      } else {
        this._rowsRoot.style.display = 'none';
        this._planeEl.style.display = '';
        this._applyTransform(_resolveTransformState(mode7, scanlineData));
        this._applyScanlineClip(scanlineData);
      }
      this._usedRowModeLastFrame = useRowMode;
    }
  }

  hide() {
    this._swCanvas.style.display = 'none';
    this._perspEl.style.display  = 'none';
    this._perspEl.style.clipPath = '';
    this._prevClip = '';
    this._rowsRoot.style.display = 'none';
    for (let i = 0; i < this._activeRowSlots; i++) {
      if (!this._prevRowVisible[i]) continue;
      this._rows[i].row.style.display = 'none';
      this._prevRowVisible[i] = false;
    }
    this._activeRowSlots = 0;
    this._enabled = false;
  }

  flush() {
    if (this._rowTextureStale) {
      this._queueTilemapTextureUpload(true);
      this._rowTextureStale = false;
      this._tilemapTextureReady = true;
    }
    if (!this._tilemapUploadPending && this._tilemapAppliedVersion >= this._tilemapUploadVersion) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this._tilemapFlushWaiters.push(resolve);
    });
  }

  // --- Software rasterizer ---

  /**
   * Render 256×224 pixels directly, one scanline at a time, using per-scanline
   * mode 7 matrix parameters. Mirrors pipu.js generateMode7Coords/getMode7Pixel.
   */
  _renderSoftware(indexMap, palR, palG, palB, frameMode7, fallbackM7, scanlineData) {
    const { largeField, char0fill, flipX, flipY } = frameMode7;

    const imgData = this._swImgData;
    const u32 = this._swPixels;
    const palette32 = _packPalette32(this._rgbaPalette, palR, palG, palB, false);

    const bdPixel    = (255 << 24) | (palB[0] << 16) | (palG[0] << 8) | palR[0];
    const zeroPixel  = 0; // fully transparent

    for (let y = 0; y < 224; y++) {
      const rowBase = y * 256;
      const sd = scanlineData?.[y];
      if (sd && sd.mode !== 7) {
        u32.fill(zeroPixel, rowBase, rowBase + 256);
        continue;
      }
      const m = sd && typeof sd.mode7A === 'number' ? sd : fallbackM7;

      // Mode 7 scanlines are fully resolved against backdrop in this pass.
      u32.fill(bdPixel, rowBase, rowBase + 256);

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

        const colorIdx = indexMap[((tpy & 0x3ff) << 10) | (tpx & 0x3ff)];

        if (colorIdx !== 0) {
          u32[rowBase + x] = palette32[colorIdx];
        }
      }
    }

    this._swCtx.putImageData(imgData, 0, 0);
  }

  // --- CSS fallback ---

  _renderTilemap(indexMap, palR, palG, palB, { uploadTexture = false, syncUpload = false } = {}) {
    const palette32 = _packPalette32(this._rgbaPalette, palR, palG, palB, true);
    const pixels = this._tilemapPixels;

    for (let i = 0; i < indexMap.length; i++) {
      pixels[i] = palette32[indexMap[i]];
    }

    this._tilemapCtx.putImageData(this._tilemapImgData, 0, 0);
    if (!uploadTexture) {
      this._tilemapUploadDirty = false;
      return;
    }

    this._queueTilemapTextureUpload(syncUpload);
  }

  _queueTilemapTextureUpload(syncUpload = false) {
    this._tilemapUploadVersion++;
    if (syncUpload || typeof this._tilemapCanvas.toBlob !== 'function') {
      this._tilemapUploadDirty = false;
      const dataUrl = this._tilemapCanvas.toDataURL();
      this._applyTilemapTextureUrl(dataUrl, false);
      this._tilemapAppliedVersion = this._tilemapUploadVersion;
      this._resolveTilemapFlushWaiters();
      return;
    }

    this._tilemapUploadDirty = true;
    this._startTilemapTextureUpload();
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

  _renderCssRows(frameMode7, fallbackM7, scanlineData) {
    const { flipX, flipY } = frameMode7;
    const rowInfo = new Array(224);
    for (let y = 0; y < 224; y++) {
      const sd = scanlineData[y];
      if (!sd || sd.mode !== 7) continue;
      const m = sd.mode7A != null ? sd : fallbackM7;
      rowInfo[y] = _mode7RowCoords(y, m, flipX, flipY);
    }

    let slotIndex = 0;
    let visibleOffset = 0;

    for (let y = 0; y < 224; ) {
      const start = rowInfo[y];
      if (!start) {
        y++;
        continue;
      }

      let height = 1;
      const maxHeight = _segmentHeightForVisibleOffset(visibleOffset);
      while (height < maxHeight && y + height < 224 && rowInfo[y + height]) {
        height++;
      }

      let sumStepX = 0;
      let sumStepY = 0;
      for (let i = 0; i < height; i++) {
        sumStepX += rowInfo[y + i].stepX;
        sumStepY += rowInfo[y + i].stepY;
      }

      const ux = (sumStepX / height) / 256;
      const uy = (sumStepY / height) / 256;

      let vx;
      let vy;
      if (height > 1) {
        const end = rowInfo[y + height - 1];
        vx = ((end.mapX - start.mapX) / (height - 1)) / 256;
        vy = ((end.mapY - start.mapY) / (height - 1)) / 256;
      } else if (rowInfo[y + 1]) {
        vx = (rowInfo[y + 1].mapX - start.mapX) / 256;
        vy = (rowInfo[y + 1].mapY - start.mapY) / 256;
      } else if (y > 0 && rowInfo[y - 1]) {
        vx = (start.mapX - rowInfo[y - 1].mapX) / 256;
        vy = (start.mapY - rowInfo[y - 1].mapY) / 256;
      } else {
        const len = Math.hypot(ux, uy) || 1;
        vx = -uy / len;
        vy = ux / len;
      }

      let det = ux * vy - uy * vx;
      if (Math.abs(det) < 1e-8) {
        const len = Math.hypot(ux, uy) || 1;
        vx = -uy / len;
        vy = ux / len;
        det = ux * vy - uy * vx;
      }
      if (Math.abs(det) < 1e-8) {
        y += height;
        visibleOffset += height;
        continue;
      }

      const a = _clamp(vy / det, -64, 64);
      const b = _clamp(-uy / det, -64, 64);
      const c = _clamp(-vx / det, -64, 64);
      const d = _clamp(ux / det, -64, 64);

      const mx0 = _wrapMapCoord(start.mapX / 256, 1024);
      const my0 = _wrapMapCoord(start.mapY / 256, 1024);
      const tx = _clamp(-(a * mx0 + c * my0), -65536, 65536);
      const ty = _clamp(-(b * mx0 + d * my0), -65536, 65536);

      const slot = this._rows[slotIndex];
      if (this._prevRowTop[slotIndex] !== y) {
        slot.row.style.top = `${y}px`;
        this._prevRowTop[slotIndex] = y;
      }
      if (this._prevRowHeight[slotIndex] !== height) {
        slot.row.style.height = `${height}px`;
        this._prevRowHeight[slotIndex] = height;
      }

      const xform =
        `matrix(${a.toFixed(5)}, ${b.toFixed(5)}, ${c.toFixed(5)}, ${d.toFixed(5)}, ${tx.toFixed(2)}, ${ty.toFixed(2)})`;
      if (xform !== this._prevRowTransforms[slotIndex]) {
        slot.plane.style.transform = xform;
        this._prevRowTransforms[slotIndex] = xform;
      }
      if (!this._prevRowVisible[slotIndex]) {
        slot.row.style.display = '';
        this._prevRowVisible[slotIndex] = true;
      }

      slotIndex++;
      visibleOffset += height;
      y += height;
    }

    for (let i = slotIndex; i < this._activeRowSlots; i++) {
      if (!this._prevRowVisible[i]) continue;
      this._rows[i].row.style.display = 'none';
      this._prevRowVisible[i] = false;
    }
    this._activeRowSlots = slotIndex;
  }

  _startTilemapTextureUpload() {
    if (this._tilemapUploadPending) return;

    const version = this._tilemapUploadVersion;
    this._tilemapUploadDirty = false;
    this._tilemapUploadPending = true;
    this._tilemapCanvas.toBlob((blob) => {
      this._tilemapUploadPending = false;

      if (version >= this._tilemapAppliedVersion) {
        if (!blob) {
          const dataUrl = this._tilemapCanvas.toDataURL();
          this._applyTilemapTextureUrl(dataUrl, false);
        } else {
          this._applyTilemapTextureUrl(URL.createObjectURL(blob), true);
        }
        this._tilemapAppliedVersion = version;
      }

      if (this._tilemapUploadDirty || this._tilemapAppliedVersion < this._tilemapUploadVersion) {
        this._startTilemapTextureUpload();
      }
      this._resolveTilemapFlushWaiters();
    }, 'image/png');
  }

  _applyTilemapTextureUrl(url, isObjectUrl) {
    const prevBlobUrl = this._tilemapBlobUrl;
    this._perspEl.style.setProperty('--m7-map-url', `url("${url}")`);
    this._tilemapBlobUrl = isObjectUrl ? url : '';
    if (prevBlobUrl) {
      URL.revokeObjectURL(prevBlobUrl);
    }
  }

  _resolveTilemapFlushWaiters() {
    if (this._tilemapUploadPending || this._tilemapAppliedVersion < this._tilemapUploadVersion) {
      return;
    }
    if (this._tilemapFlushWaiters.length === 0) return;
    const waiters = this._tilemapFlushWaiters;
    this._tilemapFlushWaiters = [];
    for (const resolve of waiters) resolve();
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

/**
 * Hash only the palette entries actually used by the current mode7 index map.
 * This avoids full tilemap rebuilds when HUD/sprite palette entries change.
 * If the index map isn't populated yet (first frame), hashes all 256 entries.
 * CSS mode7 treats palette index 0 as transparent, so callers can skip it.
 */
function _hashMode7Palette(palR, palG, palB, usedColors, hasUsage, transparentZero = false) {
  let h = 0x811c9dc5;
  for (let i = 0; i < 256; i++) {
    if (transparentZero && i === 0) continue;
    if (hasUsage && !usedColors[i]) continue;
    h ^= palR[i]; h = Math.imul(h, 0x01000193);
    h ^= palG[i]; h = Math.imul(h, 0x01000193);
    h ^= palB[i]; h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function _packPalette32(target, palR, palG, palB, transparentZero) {
  target[0] = transparentZero ? 0 : ((255 << 24) | (palB[0] << 16) | (palG[0] << 8) | palR[0]);
  for (let i = 1; i < 256; i++) {
    target[i] = (255 << 24) | (palB[i] << 16) | (palG[i] << 8) | palR[i];
  }
  return target;
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

function _wrapMapCoord(value, size) {
  return ((value % size) + size) % size;
}

function _segmentHeightForVisibleOffset(offset) {
  if (offset < 16) return 1;
  if (offset < 40) return 2;
  if (offset < 88) return 4;
  return 8;
}

export const __mode7Testables = {
  _hashMode7Palette,
  _mode7RowCoords,
  _packPalette32,
};
