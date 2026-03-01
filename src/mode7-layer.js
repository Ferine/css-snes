/**
 * Mode 7 CSS renderer.
 *
 * Renders the Mode 7 background as a pre-decoded canvas that is then
 * projected using CSS 3D transforms to approximate the SNES affine mapping.
 *
 * Mode 7 tilemap: 128×128 tiles × 8×8 px each = 1024×1024 px map.
 * Tilemap data lives at VRAM word 0 (tilemapAdr = 0), one byte per entry
 * (stored in low byte of each VRAM word): tile index 0-255.
 * Tile data: 256 tiles × 8×8 × 8bpp = 256 × 64 bytes, at VRAM words 0+.
 *   Each 8×8 tile row is stored as 4 consecutive 16-bit VRAM words
 *   (8 bytes = 4 words), unlike the layered bitplane format for other modes.
 *   In pipu.js the Mode 7 pixel read does:
 *     mapWord = vram[(m7Hoff_tile * 128 + m7Voff_tile)] & 0xff  → tile number
 *     tileWord = vram[mapWord * 64 + row * 4 + (col >> 1)]
 *     pixel = (col & 1) ? (tileWord >> 8) & 0xff : tileWord & 0xff
 *
 * CSS approach: render the entire 1024×1024 tilemap to a canvas offscreen,
 * then use CSS perspective + rotateX + translate to approximate the
 * Mode 7 projection.  The exact perspective is derived from matrix D (the
 * vertical scaling factor, 13-bit fixed-point with 8 integer bits).
 */
export class Mode7Layer {
  constructor(container) {
    this.container = container;

    // Outer perspective container
    this._perspEl = document.createElement('div');
    this._perspEl.className = 'mode7-perspective';
    container.appendChild(this._perspEl);

    // Flat canvas plane inside the perspective container
    this._canvas = document.createElement('canvas');
    this._canvas.width  = 1024;
    this._canvas.height = 1024;
    this._canvas.className = 'mode7-plane';
    this._perspEl.appendChild(this._canvas);

    this._ctx = this._canvas.getContext('2d');
    this._prevMapHash = -1;
    this._enabled = false;
  }

  /**
   * Update Mode 7 layer from PPU state.
   * @param {object} ppuState
   */
  update(ppuState) {
    const { mode, mode7, vram, cgRgb, forcedBlank } = ppuState;

    if (mode !== 7 || forcedBlank) {
      this._perspEl.style.display = 'none';
      this._enabled = false;
      return;
    }

    this._perspEl.style.display = '';
    this._enabled = true;

    // Check if VRAM changed (tile + map data share address space 0 in mode 7)
    const mapHash = _hashVramRange(vram, 0, 0x4000); // hash first 16KB
    if (mapHash !== this._prevMapHash) {
      this._renderTilemap(vram, cgRgb);
      this._prevMapHash = mapHash;
    }

    this._applyTransform(mode7);
  }

  hide() {
    this._perspEl.style.display = 'none';
    this._enabled = false;
  }

  // --- Private ---

  /**
   * Decode and render the complete 1024×1024 Mode 7 tilemap to canvas.
   */
  _renderTilemap(vram, cgRgb) {
    const ctx = this._ctx;
    const imgData = ctx.createImageData(1024, 1024);
    const data    = imgData.data;

    // Pre-decode full 256-color palette (all CGRAM entries for Mode 7)
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
        // Tilemap entry: low byte of VRAM word at (ty * 128 + tx)
        const mapAddr = (ty * 128 + tx) & 0x7fff;
        const tileNum = vram[mapAddr] & 0xff;

        // Tile pixels: 8bpp, 4 words per row
        //   row y → VRAM words at tileNum*64 + y*4 + 0..3
        //   pixel at col x: if x even → low byte; if x odd → high byte
        const tileBase = tileNum * 64;
        const baseX    = tx * 8;
        const baseY    = ty * 8;

        for (let py = 0; py < 8; py++) {
          const rowBase = (tileBase + py * 4) & 0x7fff;
          for (let px = 0; px < 8; px++) {
            const word  = vram[(rowBase + (px >> 1)) & 0x7fff];
            const ci    = (px & 1) ? (word >> 8) & 0xff : word & 0xff;
            const dest  = ((baseY + py) * 1024 + baseX + px) * 4;
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

  /**
   * Apply CSS 3D perspective transform to approximate Mode 7 projection.
   *
   * Mode 7 matrix (13-bit fixed-point, 8 integer bits, 5 fraction bits):
   *   A = horizontal scaling / cos(angle)
   *   B = horizontal shear  / sin(angle)
   *   C = vertical shear    / -sin(angle)
   *   D = vertical scaling  / cos(angle)
   * Reference centre: (X, Y), scroll: (Hoff, Voff)
   *
   * For F-Zero, B≈C≈0 (no rotation), A≈0x100 (1.0), D varies per scanline.
   * We use D from the end-of-frame PPU state as the vertical scale factor.
   *
   * CSS approximation: tilt the 1024×1024 plane using perspective + rotateX,
   * then translate to position the scroll origin at the centre of screen.
   */
  _applyTransform(m7) {
    // Convert 13.5-bit fixed-point to floats
    // The values are stored as signed 16-bit in SnesJs
    const A = _m7Fixed(m7.a);
    const B = _m7Fixed(m7.b);
    const C = _m7Fixed(m7.c);
    const D = _m7Fixed(m7.d);

    // Scroll origin in tilemap pixel coordinates
    const mapX = ((m7.hoff - m7.x) & 0x7ff) + m7.x;
    const mapY = ((m7.voff - m7.y) & 0x7ff) + m7.y;

    // Centre of SNES screen
    const cx = 128; // 256/2
    const cy = 112; // 224/2

    // Build CSS matrix3d that maps screen coords to tilemap coords.
    // This is an approximation: we apply the inverse Mode 7 transform as a CSS 3D matrix.
    //
    // The SNES Mode 7 maps: tilemap(mx,my) = M * (screen(sx,sy) - center) + scroll
    // Inverse for CSS: screen = M^-1 * (tilemap - scroll) + center
    //
    // For a full CSS matrix3d implementation we need the 4×4 homogeneous matrix.
    // Simplified CSS approach: use scale + rotate on the plane element.
    //
    // For the MVP, use a perspective approximation when A≈D (scaling only):
    const scaleX = A !== 0 ? 1 / A : 1;
    const scaleY = D !== 0 ? 1 / D : 1;

    // Position: the scroll offset determines which part of the 1024×1024 map is visible
    const panX = -(mapX - cx);
    const panY = -(mapY - cy);

    // Apply transforms to the perspective container and plane
    // For a proper perspective effect (F-Zero style road), we tilt the plane.
    // We estimate a perspective depth from D: small D → steep perspective.
    const perspDepth = Math.abs(D) > 0.1 ? Math.round(200 / Math.abs(D)) : 200;

    this._perspEl.style.perspective         = `${perspDepth}px`;
    this._perspEl.style.perspectiveOrigin   = `${cx}px 0px`;

    // The plane is scaled and translated in tilemap space
    this._canvas.style.transform =
      `translate(${panX}px, ${panY}px) scale(${scaleX.toFixed(4)}, ${scaleY.toFixed(4)})`;
    this._canvas.style.transformOrigin = `${-panX + cx}px ${-panY}px`;
  }
}

/** Decode SnesJs 13-bit fixed-point (stored as signed 16-bit) → float */
function _m7Fixed(raw) {
  // SnesJs stores it as a 16-bit value; the SNES format is 1+7+8 (sign+int+frac)
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
