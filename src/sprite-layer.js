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

    for (let i = 0; i < 128; i++) {
      const div = document.createElement('div');
      div.className = 'sprite';
      div.dataset.type = 'sprite';
      div.dataset.idx = i;
      div.style.display = 'none';
      this._divs[i] = div;
      this._subDivs[i] = [];
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

      // Hide if fully off-screen
      if (spr.x >= 256 || spr.x + sizePx <= 0 || spr.y >= 224 || spr.y + sizePx <= 0) {
        div.style.display = 'none';
        continue;
      }

      div.style.display = '';
      div.style.left    = `${spr.x}px`;
      div.style.top     = `${spr.y}px`;
      div.style.width   = `${sizePx}px`;
      div.style.height  = `${sizePx}px`;
      div.style.zIndex  = sprZTable ? (sprZTable[spr.priority] ?? 2) : 2;

      // Flip transform
      const scaleX = spr.flipH ? -1 : 1;
      const scaleY = spr.flipV ? -1 : 1;
      div.style.transform = (scaleX !== 1 || scaleY !== 1)
        ? `scale(${scaleX},${scaleY})`
        : '';

      div.dataset.x        = spr.x;
      div.dataset.y        = spr.y;
      div.dataset.tile     = spr.tile;
      div.dataset.palette  = spr.palette;
      div.dataset.priority = spr.priority;
      div.dataset.sizePx   = sizePx;

      const sprPrefix = spr.nameTable ? 'spr1' : 'spr';

      if (sizeTiles === 1) {
        // 8×8 sprite: single div with background
        this._clearSubDivs(i);
        div.className = `sprite ${sprPrefix}-pal-${spr.palette}`;
        div.style.backgroundPosition = tileCache.getTilePosition(spr.tile);
      } else {
        // Multi-tile sprite: grid of 8×8 sub-tile divs
        div.className = 'sprite sprite-multi';
        div.style.backgroundImage  = 'none';
        div.style.backgroundPosition = '';
        this._buildSubDivs(i, spr, sprPrefix, sizeTiles, tileCache);
      }
    }
  }

  setColorMath(filter, opacity) {
    this.spriteLayer.style.filter  = filter;
    this.spriteLayer.style.opacity = opacity;
  }

  _clearSubDivs(i) {
    for (const d of this._subDivs[i]) d.remove();
    this._subDivs[i] = [];
  }

  _buildSubDivs(i, spr, sprPrefix, sizeTiles, tileCache) {
    // Resize if needed
    const needed = sizeTiles * sizeTiles;
    const current = this._subDivs[i];
    const div = this._divs[i];

    while (current.length < needed) {
      const d = document.createElement('div');
      d.className = 'sprite-tile';
      div.appendChild(d);
      current.push(d);
    }
    while (current.length > needed) {
      current.pop().remove();
    }

    // spriteTileOffsets from pipu.js: tile index offset for each subtile position
    // For a sizeTiles×sizeTiles sprite, subtile at (col, row) uses tile offset:
    //   col + row * 16   (sprites always step in groups of 16 horizontally)
    for (let row = 0; row < sizeTiles; row++) {
      for (let col = 0; col < sizeTiles; col++) {
        const subtile = row * sizeTiles + col;
        const d       = current[subtile];
        const tileOff = col + row * 16;   // SNES sprite tile stride is 16 tiles
        const t       = (spr.tile + tileOff) & 0xff;

        d.className = `sprite-tile ${sprPrefix}-pal-${spr.palette}`;
        d.style.left = `${col * 8}px`;
        d.style.top  = `${row * 8}px`;
        d.style.backgroundPosition = tileCache.getTilePosition(t);
      }
    }
  }
}
