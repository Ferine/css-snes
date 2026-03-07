/**
 * E2E test harness for css-snes.
 * Loads a ROM, steps frames, renders CSS + canvas reference.
 * Exposes window.testHarness for Playwright to drive.
 */
import { Snes, instrumentSnes } from 'snesjs';
import { PPUStateExtractor } from '../../src/ppu-state-extractor.js';
import { CSSRenderer } from '../../src/css-renderer.js';

const wrapperEl = document.getElementById('viewport-wrapper');
const refCanvas = document.getElementById('ref-canvas');
const refCtx    = refCanvas.getContext('2d');

let snes          = null;
let extractor     = null;
let renderer      = null;
let latestState   = null;
let frameCount    = 0;
let ready         = false;
const errors      = [];

function beginScanlineCapture(snesInstance) {
  if (!snesInstance) return null;
  if (typeof snesInstance.beginScanlineCapture === 'function') {
    return snesInstance.beginScanlineCapture();
  }
  const buffer = snesInstance._scanlineCaptureBuffer ?? new Array(224);
  snesInstance._scanlineCaptureBuffer = buffer;
  snesInstance._scanlineData = buffer;
  return buffer;
}

// Capture unhandled errors
window.addEventListener('error', (e) => errors.push({ type: 'error', msg: e.message, stack: e.error?.stack }));
window.addEventListener('unhandledrejection', (e) => errors.push({ type: 'unhandledrejection', msg: String(e.reason) }));

/**
 * Render a 256×224 reference image from pixelOutput.
 * pixelOutput layout: Uint16Array(512 * 3 * 240).
 * Each logical SNES pixel i at row y → buffer at (y*512 + i*2) * 3.
 */
function renderCanvasFrame(ppuState) {
  const po = ppuState.pixelOutput;
  const imgData = refCtx.createImageData(256, 224);
  const data = imgData.data;
  for (let y = 0; y < 224; y++) {
    for (let x = 0; x < 256; x++) {
      const src = (y * 512 + x * 2) * 3;
      const dst = (y * 256 + x) * 4;
      data[dst]     = po[src]     & 0xff;
      data[dst + 1] = po[src + 1] & 0xff;
      data[dst + 2] = po[src + 2] & 0xff;
      data[dst + 3] = 255;
    }
  }
  refCtx.putImageData(imgData, 0, 0);
}

window.testHarness = {
  /**
   * Load a ROM from a byte array (plain number[] — Playwright can't transfer Uint8Array).
   * isHirom defaults to false (LoROM) which is correct for F-Zero.
   */
  loadROM(romBytes, isHirom = false) {
    errors.length = 0;
    const bytes = new Uint8Array(romBytes);

    snes = new Snes();
    const ok = snes.loadRom(bytes, isHirom);
    if (ok === false) {
      errors.push({ type: 'loadRom', msg: 'loadRom() returned false — check LoROM/HiROM' });
      return false;
    }
    snes.reset(true);
    instrumentSnes(snes);

    extractor = new PPUStateExtractor(snes);
    renderer  = new CSSRenderer(wrapperEl);
    latestState = null;
    frameCount  = 0;
    ready = true;
    return true;
  },

  /** Step N frames, rendering both CSS and canvas each frame. */
  async stepFrames(n) {
    const CHUNK = 60;
    let remaining = n;
    while (remaining > 0) {
      const batch = Math.min(remaining, CHUNK);
      for (let i = 0; i < batch; i++) {
        beginScanlineCapture(snes);
        snes.runFrame();
        latestState = extractor.extract();
        renderer.renderFrame(latestState);
        renderCanvasFrame(latestState);
        frameCount++;
      }
      remaining -= batch;
      if (remaining > 0) await new Promise((r) => setTimeout(r, 0));
    }
    await renderer.flush();
  },

  /** Button press (SNES bit numbers: 0=B 1=Y 2=Sel 3=Start 4=Up 5=Down 6=Left 7=Right 8=A 9=X 10=L 11=R) */
  buttonDown(btn) { if (snes) snes.setPad1ButtonPressed(btn); },
  buttonUp(btn)   { if (snes) snes.setPad1ButtonReleased(btn); },
  setMode7CssOnly(on) { if (renderer) renderer.setMode7CssOnly(!!on); },
  setLayerVisibility(vis) {
    if (!renderer) return;
    for (const k of ['bg0', 'bg1', 'bg2', 'bg3', 'sprites']) {
      if (Object.prototype.hasOwnProperty.call(vis, k)) {
        renderer.layerVisible[k] = !!vis[k];
      }
    }
    if (latestState) {
      renderer.renderFrame(latestState);
    } else {
      renderer.applyLayerVisibility();
    }
  },

  isReady() { return ready; },
  getFrameCount() { return frameCount; },
  getErrors() { return errors.slice(); },

  /** Snapshot of the most recent PPU state (serializable subset). */
  getPPUSummary() {
    if (!latestState) return null;
    const s = latestState;
    return {
      frame: frameCount,
      mode:  s.mode,
      forcedBlank: s.forcedBlank,
      brightness:  s.brightness,
      bgLayers: s.bgLayers.map((l) =>
        l ? { enabled: l.enabled, bpp: l.bpp, tilemapAdr: l.tilemapAdr, tileAdr: l.tileAdr,
               tilemapWidth: l.tilemapWidth, tilemapHeight: l.tilemapHeight,
               scrollX: l.scrollX, scrollY: l.scrollY } : null
      ),
      mode7: {
        a: s.mode7.a, b: s.mode7.b, c: s.mode7.c, d: s.mode7.d,
        x: s.mode7.x, y: s.mode7.y, hoff: s.mode7.hoff, voff: s.mode7.voff,
      },
      objSize: s.objSize,
      sprAdr1: s.sprAdr1, sprAdr2: s.sprAdr2,
      visibleSprites: s.sprites.filter((sp) =>
        sp.x < 256 && sp.x + sp.sizePx > 0 && sp.y < 224 && sp.y + sp.sizePx > 0
      ).length,
      cgRgb0: s.cgRgb[0],
      // True if any visible scanline was rendered in mode 7 (mid-frame mode switch support)
      hasMode7Scanlines: !!s.scanlineData?.some((sd) => sd?.mode === 7),
    };
  },

  /** Sample a few raw VRAM words for debugging tile data. */
  getVramSample(startWord, count) {
    if (!latestState) return null;
    const out = [];
    for (let i = 0; i < count; i++) {
      out.push(latestState.vram[(startWord + i) & 0x7fff]);
    }
    return out;
  },

  /** Sample raw CGRAM (palette) words. */
  getCgramSample(start, count) {
    if (!latestState) return null;
    const out = [];
    for (let i = 0; i < count; i++) {
      out.push(latestState.cgram[(start + i) & 0xff]);
    }
    return out;
  },
};
