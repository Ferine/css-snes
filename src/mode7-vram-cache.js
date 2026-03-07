/**
 * Shared cache for Mode 7's 1024x1024 texel index map.
 * Rebuilds only when the underlying Mode 7 VRAM region changes.
 */
export class Mode7VRAMCache {
  constructor() {
    this.indexMap = new Uint8Array(1024 * 1024);
    this.usedColors = new Uint8Array(256);
    this.hash = -1;
    this.valid = false;
  }

  ensure(vram) {
    const hash = hashMode7Vram(vram);
    const changed = !this.valid || hash !== this.hash;
    if (changed) {
      rebuildMode7IndexMap(this.indexMap, this.usedColors, vram);
      this.hash = hash;
      this.valid = true;
    }
    return {
      indexMap: this.indexMap,
      usedColors: this.usedColors,
      hash: this.hash,
      changed,
    };
  }
}

export function hashMode7Vram(vram) {
  let h = 0x811c9dc5;
  for (let i = 0; i < 0x4000; i++) {
    h ^= vram[i & 0x7fff];
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function rebuildMode7IndexMap(indexMap, usedColors, vram) {
  usedColors.fill(0);

  for (let ty = 0; ty < 128; ty++) {
    const mapRow = ty * 128;
    const destRow = ty * 8 * 1024;
    for (let tx = 0; tx < 128; tx++) {
      const mapAddr = (mapRow + tx) & 0x7fff;
      const tileNum = vram[mapAddr] & 0xff;
      const tileBase = tileNum * 64;
      const baseX = tx * 8;

      for (let py = 0; py < 8; py++) {
        const rowBase = (tileBase + py * 8) & 0x7fff;
        const idxRow = destRow + py * 1024 + baseX;
        for (let px = 0; px < 8; px++) {
          const colorIdx = (vram[(rowBase + px) & 0x7fff] >> 8) & 0xff;
          indexMap[idxRow + px] = colorIdx;
          usedColors[colorIdx] = 1;
        }
      }
    }
  }
}
