/**
 * SNES BG layer renderer.
 *
 * Each BG channel is split into two sub-layer roots:
 *   rootLo — tiles with bit13=0 (low priority)
 *   rootHi — tiles with bit13=1 (high priority)
 *
 * Both roots are direct children of the viewport and get individual z-indices,
 * allowing correct interleaving with sprite priority bands.  There is no
 * transform on the root divs, so no forced stacking context is created that
 * would prevent cross-layer z-index competition.  Instead, scroll is applied
 * by setting left/top directly on each quadrant div.
 *
 * Tilemap entry (16-bit VRAM word):
 *   bits  0-9  : tile number
 *   bits 10-12 : palette (0-7)
 *   bit     13 : BG priority (1=high)
 *   bit     14 : x-flip
 *   bit     15 : y-flip
 */

/**
 * Compute a CSS clip-path string that clips the layer to the visible (unmasked)
 * pixels according to the SNES window registers.
 *
 * Returns '' (no clip) when the layer is fully visible.
 * Returns 'inset(0 0 0 256px)' when fully hidden.
 */
function computeClipPath(win, win1L, win1R, win2L, win2R) {
  if (!win.mainEnabled) return '';

  // Build per-column visibility (1=show, 0=masked)
  const vis = new Uint8Array(256).fill(1);
  for (let x = 0; x < 256; x++) {
    let w1 = win.w1Enabled && x >= win1L && x <= win1R;
    if (win.w1Inversed) w1 = !w1;
    let w2 = win.w2Enabled && x >= win2L && x <= win2R;
    if (win.w2Inversed) w2 = !w2;

    let masked = false;
    if (win.w1Enabled && win.w2Enabled) {
      switch (win.maskLogic) {
        case 0: masked = w1 || w2;  break;  // OR
        case 1: masked = w1 && w2;  break;  // AND
        case 2: masked = w1 !== w2; break;  // XOR
        case 3: masked = w1 === w2; break;  // XNOR
      }
    } else if (win.w1Enabled) { masked = w1; }
    else if (win.w2Enabled)   { masked = w2; }
    if (masked) vis[x] = 0;
  }

  // Collect contiguous visible runs
  const runs = [];
  let start = -1;
  for (let x = 0; x <= 256; x++) {
    if (x < 256 && vis[x]) { if (start < 0) start = x; }
    else                    { if (start >= 0) { runs.push([start, x - 1]); start = -1; } }
  }

  if (runs.length === 0) return 'inset(0 0 0 256px)';
  if (runs.length === 1) {
    const [lo, hi] = runs[0];
    if (lo === 0 && hi === 255) return '';
    return `inset(0 ${255 - hi}px 0 ${lo}px)`;
  }
  // Multiple runs: polygon covering full 224px height per strip
  const pts = [];
  for (const [lo, hi] of runs) {
    pts.push(`${lo}px 0, ${hi + 1}px 0, ${hi + 1}px 224px, ${lo}px 224px`);
  }
  return `polygon(evenodd, ${pts.join(', ')})`;
}

export class BGLayer {
  /**
   * @param {Element} container  - the SNES viewport element
   * @param {number}  layerIdx   - 0-3 (BG1-BG4)
   */
  constructor(container, layerIdx) {
    this.container  = container;
    this.layerIdx   = layerIdx;
    this._l         = layerIdx;
    this._setClass  = '';
    this._prevClip  = null;
    this._bigTiles  = false;

    // Two sub-layer roots: low-priority (bit13=0) and high-priority (bit13=1)
    this.rootLo = this._createRoot('lo');
    this.rootHi = this._createRoot('hi');

    // 4 quadrant divs per root, 1024 tile divs each
    this._quadsLo    = [];
    this._quadsHi    = [];
    this._tileDivsLo = [];  // [q][slot]
    this._tileDivsHi = [];  // [q][slot]
    this._prevEntry  = [];  // [q][slot] — single dirty array (entry encodes bit13)

    for (let q = 0; q < 4; q++) {
      const [qLo, divsLo] = this._createQuadrant(q, this.rootLo);
      const [qHi, divsHi] = this._createQuadrant(q, this.rootHi);
      this._quadsLo.push(qLo);
      this._quadsHi.push(qHi);
      this._tileDivsLo.push(divsLo);
      this._tileDivsHi.push(divsHi);
      this._prevEntry.push(new Int32Array(1024).fill(-1));
    }
  }

  /** Set z-indices for the lo/hi priority bands. */
  setZIndices(loZ, hiZ) {
    this.rootLo.style.zIndex = loZ;
    this.rootHi.style.zIndex = hiZ;
  }

  /** Apply CSS filter / opacity for color math approximation. */
  setColorMath(filter, opacity) {
    this.rootLo.style.filter  = filter;
    this.rootHi.style.filter  = filter;
    this.rootLo.style.opacity = opacity;
    this.rootHi.style.opacity = opacity;
  }

  /**
   * Update this BG layer for the current frame.
   * @param {object}     layer    - bgLayers[layerIdx] from PPU state
   * @param {object}     tileCache
   * @param {Uint16Array} vram
   * @param {object}     ppuState - full PPU state (for window coords)
   */
  update(layer, tileCache, vram, ppuState) {
    if (!layer || !layer.enabled) {
      this.hide();
      return;
    }
    this.rootLo.style.display = '';
    this.rootHi.style.display = '';

    const { tilemapAdr, tilemapWidth, tilemapHeight, scrollX, scrollY } = layer;
    const l        = this._l;
    const bigTiles = layer.bigTiles;
    const tileSize = bigTiles ? 16 : 8;

    // Update BG set class from tile cache
    const setClass = tileCache.getBgSetClass(l);
    if (setClass !== this._setClass) {
      if (this._setClass) {
        this.rootLo.classList.remove(this._setClass);
        this.rootHi.classList.remove(this._setClass);
      }
      if (setClass) {
        this.rootLo.classList.add(setClass);
        this.rootHi.classList.add(setClass);
      }
      this._setClass = setClass;
    }

    // Update quadrant grid sizing when bigTiles flag changes
    if (bigTiles !== this._bigTiles) {
      this._bigTiles = bigTiles;
      const cls = bigTiles ? 'bg-quadrant big-tiles' : 'bg-quadrant';
      for (let q = 0; q < 4; q++) {
        this._quadsLo[q].className = cls;
        this._quadsHi[q].className = cls;
      }
    }

    const hasRight  = tilemapWidth  > 32;
    const hasBottom = tilemapHeight > 32;

    for (let q = 0; q < 4; q++) {
      const qColOffset = (q & 1) ? 32 : 0;
      const qRowOffset = (q >> 1) ? 32 : 0;
      const qPresent   = (qColOffset === 0 || hasRight) && (qRowOffset === 0 || hasBottom);

      const showQ = qPresent ? '' : 'none';
      this._quadsLo[q].style.display = showQ;
      this._quadsHi[q].style.display = showQ;
      if (!qPresent) continue;

      this._updateQuadrant(q, vram, tilemapAdr, tilemapWidth, tilemapHeight,
                           qColOffset, qRowOffset, l, tileCache, bigTiles);
    }

    this._applyScroll(scrollX, scrollY, tilemapWidth, tilemapHeight, tileSize);

    // Window clipping
    if (ppuState && layer.window) {
      const clip = computeClipPath(layer.window,
                                   ppuState.win1Left, ppuState.win1Right,
                                   ppuState.win2Left, ppuState.win2Right);
      if (clip !== this._prevClip) {
        this.rootLo.style.clipPath = clip;
        this.rootHi.style.clipPath = clip;
        this._prevClip = clip;
      }
    }
  }

  hide() {
    this.rootLo.style.display = 'none';
    this.rootHi.style.display = 'none';
  }

  show() {
    this.rootLo.style.display = '';
    this.rootHi.style.display = '';
  }

  // --- Private ---

  _createRoot(prio) {
    const div = document.createElement('div');
    div.className = `bg-sublayer bg-sublayer-${this.layerIdx}`;
    div.dataset.layer = `bg${this.layerIdx}`;
    div.dataset.prio  = prio;
    this.container.appendChild(div);
    return div;
  }

  _createQuadrant(q, root) {
    const qDiv = document.createElement('div');
    qDiv.className      = 'bg-quadrant';
    qDiv.dataset.quadrant = q;
    root.appendChild(qDiv);

    const divs = new Array(1024);
    const l    = this._l;
    for (let i = 0; i < 1024; i++) {
      const d = document.createElement('div');
      d.className       = `bg-tile bg${l}-pal-0`;
      d.dataset.type    = 'bg-tile';
      d.dataset.layer   = l;
      d.dataset.col     = i & 31;
      d.dataset.row     = i >> 5;
      d.dataset.q       = q;
      qDiv.appendChild(d);
      divs[i] = d;
    }
    return [qDiv, divs];
  }

  _updateQuadrant(q, vram, tilemapAdr, tmW, tmH, qColOff, qRowOff, l, tileCache, bigTiles) {
    const divsLo = this._tileDivsLo[q];
    const divsHi = this._tileDivsHi[q];
    const prev   = this._prevEntry[q];

    const quadrantOffset = (qColOff ? 0x400 : 0) + (qRowOff ? (tmW > 32 ? 0x800 : 0x400) : 0);

    for (let i = 0; i < 1024; i++) {
      const localCol = i & 31;
      const localRow = i >> 5;
      const adr   = (tilemapAdr + quadrantOffset + (localRow << 5) + localCol) & 0x7fff;
      const entry = vram[adr];

      if (entry === prev[i]) continue;
      prev[i] = entry;

      const tileNum = entry & 0x3ff;
      const palette = (entry >> 10) & 0x7;
      const prio13  = (entry >> 13) & 0x1;
      const flipH   = (entry & 0x4000) > 0;
      const flipV   = (entry & 0x8000) > 0;

      const bgPos = tileCache.getTilePosition(tileNum, bigTiles);
      let cls = `bg-tile bg${l}-pal-${palette}`;
      if (flipH && flipV) cls += ' flip-hv';
      else if (flipH)     cls += ' flip-h';
      else if (flipV)     cls += ' flip-v';

      // Update both lo and hi divs; show only the one matching prio13
      const dLo = divsLo[i];
      dLo.style.backgroundPosition = bgPos;
      dLo.className    = cls;
      dLo.style.display = prio13 === 0 ? '' : 'none';

      const dHi = divsHi[i];
      dHi.style.backgroundPosition = bgPos;
      dHi.className    = cls;
      dHi.style.display = prio13 === 1 ? '' : 'none';
    }
  }

  _applyScroll(scrollX, scrollY, tmW, tmH, tileSize) {
    const mapPxW = tmW * tileSize;
    const mapPxH = tmH * tileSize;

    // Wrap scroll into tilemap space
    const sx = ((scrollX % mapPxW) + mapPxW) % mapPxW;
    const sy = ((scrollY % mapPxH) + mapPxH) % mapPxH;

    const quadPxW = 32 * tileSize;
    const quadPxH = 32 * tileSize;

    for (let q = 0; q < 4; q++) {
      const qLo = this._quadsLo[q];
      if (qLo.style.display === 'none') continue;

      const col = q & 1;
      const row = q >> 1;
      let qx = col * quadPxW;
      let qy = row * quadPxH;

      // If this quadrant's right/bottom edge is behind the scroll origin, wrap forward
      if (qx + quadPxW <= sx) qx += mapPxW;
      if (qy + quadPxH <= sy) qy += mapPxH;

      // Final screen position: tilemap position minus scroll offset
      const left = `${qx - sx}px`;
      const top  = `${qy - sy}px`;

      qLo.style.left = left;
      qLo.style.top  = top;
      const qHi = this._quadsHi[q];
      qHi.style.left = left;
      qHi.style.top  = top;
    }
  }
}
