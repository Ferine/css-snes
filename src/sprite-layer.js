/**
 * SNES sprite (OBJ) layer.
 *
 * Pre-creates 128 sprite divs.  Sprites are always 4bpp, 8 palettes.
 * Four sizes are possible per frame (small and large, from spriteSizes table):
 *   8×8, 16×16, 32×32, 64×64 px.
 *
 * Large sprites (isBig=true) use one of 8 CSS grid child-divs to tile their
 * subtiles.  For simplicity in the initial implementation, sprites larger than
 * 8×8 are composed of multiple 8×8 tile divs.
 *
 * Sprite OAM layout (decoded by PPUStateExtractor):
 *   { x, y, tile, nameTable, palette, priority, flipH, flipV, sizePx, isBig }
 *
 * CGRAM: sprite palettes at indices 128-255 (palette 0 → 128-143, etc.)
 * CSS class: .spr-pal-{0..7}  → matched by tile-cache stylesheet.
 *
 * Priority: SNES OAM priority 3 = frontmost, 0 = backmost.
 * z-indices are passed per-frame from css-renderer (sprZTable[priority]).
 */

export class SpriteLayer {
  constructor(container) {
    this.container = container;

    this.spriteLayer = document.createElement('div');
    this.spriteLayer.className = 'sprite-layer';
    this.spriteLayer.dataset.layer = 'sprites';
    container.appendChild(this.spriteLayer);

    // Pre-create 128 sprite root divs
    this._divs = new Array(128);
    this._subDivs = new Array(128); // array of sub-tile divs per sprite
    this._prevRootState = new Array(128);
    this._activeSubTileCounts = new Uint8Array(128);

    for (let i = 0; i < 128; i++) {
      const div = document.createElement('div');
      div.className = 'sprite';
      div.dataset.type = 'sprite';
      div.dataset.idx = i;
      div.style.display = 'none';
      this._divs[i] = div;
      this._subDivs[i] = [];
      this._prevRootState[i] = {
        visible: false,
        left: '',
        top: '',
        width: '',
        height: '',
        zIndex: '',
        transform: '',
        className: 'sprite',
        backgroundPosition: '',
      };
      this.spriteLayer.appendChild(div);
    }
  }

  /**
   * @param {object}   ppuState
   * @param {object}   tileCache
   * @param {number[]} sprZTable  - sprZTable[priority] → CSS z-index; priority 3=front
   */
  update(ppuState, tileCache, sprZTable) {
    const { sprites } = ppuState;

    for (let i = 0; i < 128; i++) {
      const spr = sprites[i];
      const div = this._divs[i];

      const sizePx = spr.sizePx;
      const sizeTiles = sizePx >> 3;
      const state = this._prevRootState[i];

      // Hide if fully off-screen
      if (spr.x >= 256 || spr.x + sizePx <= 0 || spr.y >= 224 || spr.y + sizePx <= 0) {
        if (state.visible) {
          div.style.display = 'none';
          state.visible = false;
        }
        this._setActiveSubTileCount(i, 0);
        continue;
      }

      if (!state.visible) {
        div.style.display = '';
        state.visible = true;
      }
      const left = `${spr.x}px`;
      if (state.left !== left) {
        div.style.left = left;
        state.left = left;
      }
      const top = `${spr.y}px`;
      if (state.top !== top) {
        div.style.top = top;
        state.top = top;
      }
      const width = `${sizePx}px`;
      if (state.width !== width) {
        div.style.width = width;
        state.width = width;
      }
      const height = `${sizePx}px`;
      if (state.height !== height) {
        div.style.height = height;
        state.height = height;
      }
      const zIndex = String(sprZTable ? (sprZTable[spr.priority] ?? 2) : 2);
      if (state.zIndex !== zIndex) {
        div.style.zIndex = zIndex;
        state.zIndex = zIndex;
      }

      // Flip transform
      const scaleX = spr.flipH ? -1 : 1;
      const scaleY = spr.flipV ? -1 : 1;
      const transform = (scaleX !== 1 || scaleY !== 1)
        ? `scale(${scaleX},${scaleY})`
        : '';
      if (state.transform !== transform) {
        div.style.transform = transform;
        state.transform = transform;
      }

      div.dataset.x        = spr.x;
      div.dataset.y        = spr.y;
      div.dataset.tile     = spr.tile;
      div.dataset.palette  = spr.palette;
      div.dataset.priority = spr.priority;
      div.dataset.sizePx   = sizePx;

      const sprPrefix = spr.nameTable ? 'spr1' : 'spr';

      if (sizeTiles === 1) {
        // 8×8 sprite: single div with background
        const className = `sprite ${sprPrefix}-pal-${spr.palette}`;
        if (state.className !== className) {
          div.className = className;
          state.className = className;
        }
        const backgroundPosition = tileCache.getTilePosition(spr.tile);
        if (state.backgroundPosition !== backgroundPosition) {
          div.style.backgroundPosition = backgroundPosition;
          state.backgroundPosition = backgroundPosition;
        }
        this._setActiveSubTileCount(i, 0);
      } else {
        // Multi-tile sprite: grid of 8×8 sub-tile divs
        if (state.className !== 'sprite sprite-multi') {
          div.className = 'sprite sprite-multi';
          state.className = 'sprite sprite-multi';
        }
        if (state.backgroundPosition !== '') {
          div.style.backgroundPosition = '';
          state.backgroundPosition = '';
        }
        this._buildSubDivs(i, spr, sprPrefix, sizeTiles, tileCache);
      }
    }
  }

  setColorMath(filter, opacity) {
    this.spriteLayer.style.filter  = filter;
    this.spriteLayer.style.opacity = opacity;
  }

  _buildSubDivs(i, spr, sprPrefix, sizeTiles, tileCache) {
    const needed = sizeTiles * sizeTiles;
    const current = this._ensureSubDivPool(i, needed);
    this._setActiveSubTileCount(i, needed);

    // spriteTileOffsets from pipu.js: tile index offset for each subtile position
    // For a sizeTiles×sizeTiles sprite, subtile at (col, row) uses tile offset:
    //   col + row * 16   (sprites always step in groups of 16 horizontally)
    for (let row = 0; row < sizeTiles; row++) {
      for (let col = 0; col < sizeTiles; col++) {
        const subtile = row * sizeTiles + col;
        const d       = current[subtile];
        const tileOff = col + row * 16;   // SNES sprite tile stride is 16 tiles
        const t       = (spr.tile + tileOff) & 0xff;
        const state   = d._spriteState;
        const className = `sprite-tile ${sprPrefix}-pal-${spr.palette}`;
        const left = `${col * 8}px`;
        const top = `${row * 8}px`;
        const backgroundPosition = tileCache.getTilePosition(t);

        if (state.className !== className) {
          d.className = className;
          state.className = className;
        }
        if (state.left !== left) {
          d.style.left = left;
          state.left = left;
        }
        if (state.top !== top) {
          d.style.top = top;
          state.top = top;
        }
        if (state.backgroundPosition !== backgroundPosition) {
          d.style.backgroundPosition = backgroundPosition;
          state.backgroundPosition = backgroundPosition;
        }
        if (!state.visible) {
          d.style.display = '';
          state.visible = true;
        }
      }
    }
  }

  _ensureSubDivPool(i, needed) {
    const current = this._subDivs[i];
    const div = this._divs[i];

    while (current.length < needed) {
      const d = document.createElement('div');
      d.className = 'sprite-tile';
      d.style.display = 'none';
      d._spriteState = {
        visible: false,
        className: 'sprite-tile',
        left: '',
        top: '',
        backgroundPosition: '',
      };
      div.appendChild(d);
      current.push(d);
    }

    return current;
  }

  _setActiveSubTileCount(i, needed) {
    const current = this._subDivs[i];
    const prevCount = this._activeSubTileCounts[i];
    if (prevCount === needed) return;

    if (needed < prevCount) {
      for (let idx = needed; idx < prevCount; idx++) {
        const d = current[idx];
        if (!d) continue;
        const state = d._spriteState;
        if (!state.visible) continue;
        d.style.display = 'none';
        state.visible = false;
      }
    }

    this._activeSubTileCounts[i] = needed;
  }
}
