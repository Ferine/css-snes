/**
 * SNES BG layer renderer.
 *
 * Each BG channel is split into two sub-layer roots:
 *   rootLo — tiles with bit13=0 (low priority)
 *   rootHi — tiles with bit13=1 (high priority)
 *
 * Instead of keeping the full tilemap as DOM, this renderer keeps a fixed
 * pool of visible tiles per priority band and remaps them as scroll changes.
 * That cuts the DOM footprint from thousands of nodes per layer down to the
 * viewport-sized working set.
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

  const vis = new Uint8Array(256).fill(1);
  for (let x = 0; x < 256; x++) {
    let w1 = win.w1Enabled && x >= win1L && x <= win1R;
    if (win.w1Inversed) w1 = !w1;
    let w2 = win.w2Enabled && x >= win2L && x <= win2R;
    if (win.w2Inversed) w2 = !w2;

    let masked = false;
    if (win.w1Enabled && win.w2Enabled) {
      switch (win.maskLogic) {
        case 0: masked = w1 || w2;  break;
        case 1: masked = w1 && w2;  break;
        case 2: masked = w1 !== w2; break;
        case 3: masked = w1 === w2; break;
      }
    } else if (win.w1Enabled) {
      masked = w1;
    } else if (win.w2Enabled) {
      masked = w2;
    }
    if (masked) vis[x] = 0;
  }

  const runs = [];
  let start = -1;
  for (let x = 0; x <= 256; x++) {
    if (x < 256 && vis[x]) {
      if (start < 0) start = x;
    } else if (start >= 0) {
      runs.push([start, x - 1]);
      start = -1;
    }
  }

  if (runs.length === 0) return 'inset(0 0 0 256px)';
  if (runs.length === 1) {
    const [lo, hi] = runs[0];
    if (lo === 0 && hi === 255) return '';
    return `inset(0 ${255 - hi}px 0 ${lo}px)`;
  }

  const pts = [];
  for (const [lo, hi] of runs) {
    pts.push(`${lo}px 0, ${hi + 1}px 0, ${hi + 1}px 224px, ${lo}px 224px`);
  }
  return `polygon(evenodd, ${pts.join(', ')})`;
}

const MAX_VISIBLE_COLS_8 = 33;
const MAX_VISIBLE_ROWS_8 = 29;
const MAX_POOL_SIZE = MAX_VISIBLE_COLS_8 * MAX_VISIBLE_ROWS_8;

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
    this._activeSlots = 0;

    this.rootLo = this._createRoot('lo');
    this.rootHi = this._createRoot('hi');
    this._poolLo = this._createTilePool(this.rootLo);
    this._poolHi = this._createTilePool(this.rootHi);
  }

  setZIndices(loZ, hiZ) {
    this.rootLo.style.zIndex = loZ;
    this.rootHi.style.zIndex = hiZ;
  }

  setColorMath(filter, opacity) {
    this.rootLo.style.filter  = filter;
    this.rootHi.style.filter  = filter;
    this.rootLo.style.opacity = opacity;
    this.rootHi.style.opacity = opacity;
  }

  update(layer, tileCache, vram, ppuState) {
    if (!layer || !layer.enabled) {
      this.hide();
      return;
    }
    this.rootLo.style.display = '';
    this.rootHi.style.display = '';

    const { tilemapAdr, tilemapWidth: tmW, tilemapHeight: tmH, scrollX, scrollY } = layer;
    const bigTiles = layer.bigTiles;
    const tileSize = bigTiles ? 16 : 8;
    const tileShift = bigTiles ? 4 : 3;
    const tileMask = tileSize - 1;
    const mapPxW = tmW * tileSize;
    const mapPxH = tmH * tileSize;
    const mapPxWMask = mapPxW - 1;
    const mapPxHMask = mapPxH - 1;
    const visibleCols = Math.ceil(256 / tileSize) + 1;
    const visibleRows = Math.ceil(224 / tileSize) + 1;
    const activeSlots = visibleCols * visibleRows;

    const setClass = tileCache.getBgSetClass(this._l);
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

    if (bigTiles !== this._bigTiles) {
      this._bigTiles = bigTiles;
      this.rootLo.classList.toggle('big-tiles', bigTiles);
      this.rootHi.classList.toggle('big-tiles', bigTiles);
    }

    const sx = scrollX & mapPxWMask;
    const sy = scrollY & mapPxHMask;
    const baseTileX = sx >> tileShift;
    const baseTileY = sy >> tileShift;
    const fineX = sx & tileMask;
    const fineY = sy & tileMask;
    const tileMaskX = tmW - 1;
    const tileMaskY = tmH - 1;

    let slot = 0;
    for (let row = 0; row < visibleRows; row++) {
      const screenY = row * tileSize - fineY;
      const tileY = (baseTileY + row) & tileMaskY;
      const qRowOff = tileY >= 32 ? (tmW > 32 ? 0x800 : 0x400) : 0;
      const localRow = tileY & 31;

      for (let col = 0; col < visibleCols; col++, slot++) {
        const screenX = col * tileSize - fineX;
        const tileX = (baseTileX + col) & tileMaskX;
        const qColOff = tileX >= 32 ? 0x400 : 0;
        const localCol = tileX & 31;
        const adr = (tilemapAdr + qColOff + qRowOff + (localRow << 5) + localCol) & 0x7fff;
        const entry = vram[adr];

        const tileNum = entry & 0x3ff;
        const palette = (entry >> 10) & 0x7;
        const prio13  = (entry >> 13) & 0x1;
        const flipH   = (entry & 0x4000) > 0;
        const flipV   = (entry & 0x8000) > 0;

        const bgPos = tileCache.getTilePosition(tileNum, bigTiles);
        let cls = `bg-tile bg${this._l}-pal-${palette}`;
        if (flipH && flipV) cls += ' flip-hv';
        else if (flipH)     cls += ' flip-h';
        else if (flipV)     cls += ' flip-v';

        const tileLo = this._poolLo.divs[slot];
        const stateLo = this._poolLo.states[slot];
        const tileHi = this._poolHi.divs[slot];
        const stateHi = this._poolHi.states[slot];
        const left = `${screenX}px`;
        const top = `${screenY}px`;

        if (prio13 === 0) {
          this._applyTileState(tileLo, stateLo, cls, bgPos, left, top, true);
          this._applyTileState(tileHi, stateHi, stateHi.className, stateHi.bgPos, stateHi.left, stateHi.top, false);
        } else {
          this._applyTileState(tileHi, stateHi, cls, bgPos, left, top, true);
          this._applyTileState(tileLo, stateLo, stateLo.className, stateLo.bgPos, stateLo.left, stateLo.top, false);
        }
      }
    }

    this._hideInactive(this._poolLo, activeSlots);
    this._hideInactive(this._poolHi, activeSlots);
    this._activeSlots = activeSlots;

    if (ppuState && layer.window) {
      const clip = computeClipPath(
        layer.window,
        ppuState.win1Left,
        ppuState.win1Right,
        ppuState.win2Left,
        ppuState.win2Right,
      );
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

  _createRoot(prio) {
    const div = document.createElement('div');
    div.className = `bg-sublayer bg-sublayer-${this.layerIdx}`;
    div.dataset.layer = `bg${this.layerIdx}`;
    div.dataset.prio  = prio;
    this.container.appendChild(div);
    return div;
  }

  _createTilePool(root) {
    const divs = new Array(MAX_POOL_SIZE);
    const states = new Array(MAX_POOL_SIZE);

    for (let i = 0; i < MAX_POOL_SIZE; i++) {
      const d = document.createElement('div');
      d.className = `bg-tile bg${this._l}-pal-0`;
      d.dataset.type = 'bg-tile';
      d.dataset.layer = this._l;
      d.style.display = 'none';
      root.appendChild(d);
      divs[i] = d;
      states[i] = {
        visible: false,
        className: `bg-tile bg${this._l}-pal-0`,
        bgPos: '',
        left: '',
        top: '',
      };
    }

    return { divs, states };
  }

  _applyTileState(div, state, className, bgPos, left, top, visible) {
    if (state.visible !== visible) {
      div.style.display = visible ? '' : 'none';
      state.visible = visible;
    }
    if (!visible) return;

    if (state.className !== className) {
      div.className = className;
      state.className = className;
    }
    if (state.bgPos !== bgPos) {
      div.style.backgroundPosition = bgPos;
      state.bgPos = bgPos;
    }
    if (state.left !== left) {
      div.style.left = left;
      state.left = left;
    }
    if (state.top !== top) {
      div.style.top = top;
      state.top = top;
    }
  }

  _hideInactive(pool, activeSlots) {
    for (let i = activeSlots; i < this._activeSlots; i++) {
      const state = pool.states[i];
      if (!state.visible) continue;
      pool.divs[i].style.display = 'none';
      state.visible = false;
    }
  }
}
