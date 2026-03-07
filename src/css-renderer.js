/**
 * Orchestrates all CSS rendering layers for the SNES.
 *
 * Z-index layering is mode-dependent and matches SNES priority rules.
 * BG layers each have lo/hi priority bands (bit13 from tilemap entry).
 * Sprite z-indices come from sprZTable[priority], where priority 3=front.
 *
 * Mode 1 normal (10 levels, front→back):
 *   Spr3(10) > BG1hi(9) > BG2hi(8) > Spr2(7) > BG1lo(6) > BG2lo(5)
 *   > Spr1(4) > BG3hi(3) > Spr0(2) > BG3lo(1)
 *
 * Mode 0 (12 levels), Mode 1+layer3Prio, and a default for other modes.
 */
import { TileCache } from './tile-cache.js';
import { BGLayer } from './bg-layer.js';
import { BGCanvasRenderer } from './bg-canvas-renderer.js';
import { Mode7Layer } from './mode7-layer.js';
import { SpriteLayer } from './sprite-layer.js';
import { hasHdmaScroll } from './ppu-state-extractor.js';
import { ScanlineCompositor, hasMode7Scanlines } from './scanline-compositor.js';
import { Mode7VRAMCache } from './mode7-vram-cache.js';
import { PerfStats } from './perf-stats.js';

// Per-mode BG z-index tables: [bg0lo, bg0hi, bg1lo, bg1hi, bg2lo, bg2hi, bg3lo, bg3hi]
// -1 means layer absent in this mode.
const BG_Z_TABLE = {
  0:       [8, 11,  7, 10,  2,  5,  1,  4],
  1:       [6,  9,  5,  8,  1,  3, -1, -1],
  '1l3p':  [5,  8,  4,  7,  2, 10, -1, -1],
  default: [6,  9,  5,  8,  1,  3, -1, -1],
};

// Per-mode sprite z-index tables: [z_for_prio0, z_for_prio1, z_for_prio2, z_for_prio3]
// SNES OAM priority 3 = frontmost, 0 = backmost.
const SPR_Z_TABLE = {
  0:       [3,  6,  9, 12],
  1:       [2,  4,  7, 10],
  '1l3p':  [1,  3,  6,  9],
  default: [2,  4,  7, 10],
};

/**
 * Approximate a layer's color math effect as a CSS filter / opacity.
 * @param {object} cm         - ppuState.colorMath
 * @param {number} layerIdx   - 0-3 for BG layers, 4 for sprites
 */
function colorMathFilter(cm, layerIdx) {
  if (!cm.mathEnabled[layerIdx]) return { filter: '', opacity: '' };
  if (!cm.addSub && cm.halfColors) {
    // Darken by fixed color then halve — approximate as scaled brightness
    const fc  = cm.fixedColor;
    const avg = (fc.r + fc.g + fc.b) / 3;
    return { filter: `brightness(${((avg / 31 + 1) * 0.5).toFixed(3)})`, opacity: '' };
  }
  if (cm.addSub && cm.halfColors) {
    // Blend with sub-screen ≈ 50% opacity
    return { filter: '', opacity: '0.5' };
  }
  return { filter: '', opacity: '' };
}

function clipPathForScanlineMask(scanlineData, keepRow) {
  if (!scanlineData) return '';

  const runs = [];
  let start = -1;
  for (let y = 0; y <= 224; y++) {
    const keep = y < 224 && keepRow(scanlineData[y], y);
    if (keep) {
      if (start < 0) start = y;
    } else if (start >= 0) {
      runs.push([start, y - 1]);
      start = -1;
    }
  }

  if (runs.length === 0) return 'inset(0 0 0 256px)';
  if (runs.length === 1) {
    const [top, bot] = runs[0];
    if (top === 0 && bot === 223) return '';
    return `inset(${top}px 0 ${223 - bot}px 0)`;
  }

  const polys = [];
  for (const [top, bot] of runs) {
    polys.push(`0px ${top}px`, `256px ${top}px`, `256px ${bot + 1}px`, `0px ${bot + 1}px`);
  }
  return `polygon(evenodd, ${polys.join(', ')})`;
}

export class CSSRenderer {
  constructor(wrapperEl) {
    this.wrapper = wrapperEl;

    // Create the SNES viewport (256×224 visible area)
    this.viewport = document.createElement('div');
    this.viewport.className = 'snes-viewport';
    this.viewport.dataset.layer = 'viewport';
    this.wrapper.appendChild(this.viewport);

    // Subsystems
    this.tileCache = new TileCache();
    this.bgLayers = [
      new BGLayer(this.viewport, 0),
      new BGLayer(this.viewport, 1),
      new BGLayer(this.viewport, 2),
      new BGLayer(this.viewport, 3),
    ];
    this.bgCanvasLayers = [
      new BGCanvasRenderer(this.viewport, 0),
      new BGCanvasRenderer(this.viewport, 1),
      new BGCanvasRenderer(this.viewport, 2),
      new BGCanvasRenderer(this.viewport, 3),
    ];
    this.mode7VramCache = new Mode7VRAMCache();
    this.mode7Layer  = new Mode7Layer(this.viewport, this.mode7VramCache);
    this.compositor  = new ScanlineCompositor(this.viewport, this.mode7VramCache);
    this.spriteLayer = new SpriteLayer(this.viewport);

    // UI-level layer visibility overrides (independent of PPU enabled flags)
    this.layerVisible = { bg0: true, bg1: true, bg2: true, bg3: true, sprites: true };
    this.mode7CssOnly = false;

    this.frameCount  = 0;
    this._prevModeKey = null;
    this._mode7OffFrames = 0; // hysteresis countdown for recent mixed mode 7 frames
    this._lastRenderPath = 'idle';
    this._perf = new PerfStats([
      'renderFrame',
      'tileCache',
      'layers',
      'colorMath',
      'sprites',
    ]);

    // Apply default z-indices immediately
    this._applyZTables('default');
  }

  /**
   * Render one frame from extracted PPU state.
   * @param {object} ppuState - from PPUStateExtractor.extract()
   */
  renderFrame(ppuState) {
    const frameStart = performance.now();
    if (ppuState.forcedBlank) {
      this.viewport.style.backgroundColor = '#000';
      this.viewport.style.filter = '';
      for (const bg of this.bgLayers) bg.hide();
      for (const bg of this.bgCanvasLayers) bg.hide();
      this.mode7Layer.hide();
      this.compositor.hide();
      this.spriteLayer.spriteLayer.style.display = 'none';
      this._lastRenderPath = 'forced-blank';
      this.viewport.dataset.renderPath = this._lastRenderPath;
      this._perf.record('renderFrame', performance.now() - frameStart);
      return;
    }

    // 1. Update tile cache (regenerates spritesheets as needed)
    let stageStart = performance.now();
    this.tileCache.update(ppuState);
    this._perf.record('tileCache', performance.now() - stageStart);

    // 2. Set viewport background to CGRAM[0] (backdrop color) and apply brightness
    this.viewport.style.backgroundColor = ppuState.cgRgb[0];
    this.viewport.style.filter = ppuState.brightness < 15
      ? `brightness(${(ppuState.brightness / 15).toFixed(3)})`
      : '';

    // 3. Select z-index tables for the current mode
    const modeKey = ppuState.mode === 0 ? '0'
      : ppuState.mode === 1 && ppuState.layer3Prio ? '1l3p'
      : ppuState.mode === 1 ? '1'
      : 'default';

    if (modeKey !== this._prevModeKey) {
      this._applyZTables(modeKey);
      this._prevModeKey = modeKey;
    }
    const sprZTable = SPR_Z_TABLE[modeKey] ?? SPR_Z_TABLE.default;

    // 4. Update layers based on PPU mode
    // Default path: compositor for any frame touching mode 7 (accurate scanline routing).
    // Optional path: mode7CssOnly routes mode-7 rows through CSS approximation while
    // keeping non-mode7 rows compositor-driven in mixed frames.
    const hasMode7Rows = hasMode7Scanlines(ppuState.scanlineData);
    const mixedMode7Frame = hasMode7Rows && ppuState.mode !== 7;
    const pureMode7Frame = ppuState.mode === 7 && !mixedMode7Frame;
    const frameHasMode7 = mixedMode7Frame || pureMode7Frame;
    const mode7State = frameHasMode7 ? this.mode7VramCache.ensure(ppuState.vram) : null;
    const useHybridCssMode7 = this.mode7CssOnly && mixedMode7Frame;

    // Hysteresis: stay on compositor briefly after mixed mode 7 disappears
    // to avoid single-frame flashes during mid-frame mode transitions.
    if (mixedMode7Frame) {
      this._mode7OffFrames = 3;
    } else if (frameHasMode7) {
      this._mode7OffFrames = 0;
    } else if (this._mode7OffFrames > 0) {
      this._mode7OffFrames--;
    }
    const useScanlineCompositor = (mixedMode7Frame || (!frameHasMode7 && this._mode7OffFrames > 0)) && !this.mode7CssOnly;

    stageStart = performance.now();
    if (useHybridCssMode7) {
      this._lastRenderPath = 'hybrid-css-mode7';
      for (const bg of this.bgLayers) bg.hide();
      for (const bg of this.bgCanvasLayers) bg.hide();
      this.compositor.show();
      const clip = clipPathForScanlineMask(
        ppuState.scanlineData,
        (sd) => !sd || sd.mode !== 7,
      );
      this.compositor.setClipPath(clip);
      this.compositor.update(ppuState, { layerVisible: this.layerVisible, mode7State });
      if (this.layerVisible.bg0) {
        this.mode7Layer.update(ppuState, { forceCss: true, mode7State });
      } else {
        this.mode7Layer.hide();
      }
    } else if (useScanlineCompositor) {
      this._lastRenderPath = 'scanline-compositor';
      for (const bg of this.bgLayers) bg.hide();
      for (const bg of this.bgCanvasLayers) bg.hide();
      this.mode7Layer.hide();
      this.compositor.show();
      this.compositor.setClipPath('');
      this.compositor.update(ppuState, { layerVisible: this.layerVisible, mode7State });
    } else {
      this.compositor.hide();
      this.compositor.setClipPath('');
      const useMode7Layer = ppuState.mode === 7 || hasMode7Rows;

      if (useMode7Layer) {
        this._lastRenderPath = pureMode7Frame
          ? (this.mode7CssOnly ? 'mode7-css' : 'mode7-software')
          : 'mode7-overlay';
        // Pure mode 7 frame: hide normal BG layers (mode 7 plane replaces them).
        if (ppuState.mode === 7) {
          for (const bg of this.bgLayers) bg.hide();
          for (const bg of this.bgCanvasLayers) bg.hide();
        } else {
          // Mixed frame: render normal BG layers as usual, then overlay CSS mode 7
          // clipped to mode-7 scanlines.
          for (let l = 0; l < 4; l++) {
            const layer = ppuState.bgLayers[l];
            if (!layer || !this.layerVisible[`bg${l}`]) {
              this.bgLayers[l].hide();
              this.bgCanvasLayers[l].hide();
            } else if (hasHdmaScroll(ppuState.scanlineData, l)) {
              this.bgLayers[l].hide();
              this.bgCanvasLayers[l].show();
              this.bgCanvasLayers[l].update(layer, ppuState.vram, ppuState.cgRgb, ppuState.scanlineData, ppuState.palR, ppuState.palG, ppuState.palB);
            } else {
              this.bgCanvasLayers[l].hide();
              this.bgLayers[l].update(layer, this.tileCache, ppuState.vram, ppuState);
            }
          }
        }
        if (this.layerVisible.bg0) {
          this.mode7Layer.update(ppuState, { forceCss: this.mode7CssOnly, mode7State });
        } else {
          this.mode7Layer.hide();
        }
      } else {
        this._lastRenderPath = 'bg-css';
        this.mode7Layer.hide();
        for (let l = 0; l < 4; l++) {
          const layer = ppuState.bgLayers[l];
          if (!layer || !this.layerVisible[`bg${l}`]) {
            this.bgLayers[l].hide();
            this.bgCanvasLayers[l].hide();
          } else if (hasHdmaScroll(ppuState.scanlineData, l)) {
            this.bgLayers[l].hide();
            this.bgCanvasLayers[l].show();
            this.bgCanvasLayers[l].update(layer, ppuState.vram, ppuState.cgRgb, ppuState.scanlineData, ppuState.palR, ppuState.palG, ppuState.palB);
          } else {
            this.bgCanvasLayers[l].hide();
            this.bgLayers[l].update(layer, this.tileCache, ppuState.vram, ppuState);
          }
        }
      }
    }
    this._perf.record('layers', performance.now() - stageStart);

    // 5. Apply color math approximations
    stageStart = performance.now();
    const cm = ppuState.colorMath;
    for (let l = 0; l < 4; l++) {
      const { filter, opacity } = colorMathFilter(cm, l);
      this.bgLayers[l].setColorMath(filter, opacity);
      this.bgCanvasLayers[l].setColorMath(filter, opacity);
    }
    const { filter: sf, opacity: so } = colorMathFilter(cm, 4);
    this.spriteLayer.setColorMath(sf, so);
    this._perf.record('colorMath', performance.now() - stageStart);

    // 6. Update sprite layer
    stageStart = performance.now();
    if (this.layerVisible.sprites) {
      this.spriteLayer.spriteLayer.style.display = '';
      this.spriteLayer.update(ppuState, this.tileCache, sprZTable);
    } else {
      this.spriteLayer.spriteLayer.style.display = 'none';
    }
    this._perf.record('sprites', performance.now() - stageStart);

    // 7. Annotate viewport with frame-level metadata for DevTools inspection
    this.viewport.dataset.frame = this.frameCount;
    this.viewport.dataset.mode  = ppuState.mode;
    this.viewport.dataset.renderPath = this._lastRenderPath;

    this.frameCount++;
    this._perf.record('renderFrame', performance.now() - frameStart);
  }

  setMode7CssOnly(enabled) {
    this.mode7CssOnly = !!enabled;
    this.viewport.dataset.mode7CssOnly = this.mode7CssOnly ? '1' : '0';
  }

  async flush() {
    await this.mode7Layer.flush();
  }

  getPerfSnapshot() {
    return {
      renderPath: this._lastRenderPath,
      metrics: this._perf.snapshot(),
    };
  }

  /**
   * Apply layer visibility without running a full frame (useful when paused).
   */
  applyLayerVisibility() {
    for (let l = 0; l < 4; l++) {
      if (!this.layerVisible[`bg${l}`]) {
        this.bgLayers[l].hide();
        this.bgCanvasLayers[l].hide();
      } else {
        this.bgLayers[l].show();
        // Canvas layer show/hide is managed per-frame by renderFrame based on HDMA detection
      }
    }
    this.spriteLayer.spriteLayer.style.display = this.layerVisible.sprites ? '' : 'none';
  }

  // --- Private ---

  _applyZTables(modeKey) {
    const bgZ = BG_Z_TABLE[modeKey] ?? BG_Z_TABLE.default;
    for (let l = 0; l < 4; l++) {
      const loZ = bgZ[l * 2];
      const hiZ = bgZ[l * 2 + 1];
      this.bgLayers[l].setZIndices(loZ, hiZ);
      this.bgCanvasLayers[l].setZIndices(loZ, hiZ);
    }
  }
}
