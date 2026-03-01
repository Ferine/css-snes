/**
 * DebugPanels — Scanline ruler + scroll graph + hover inspector.
 *
 * Ruler:  8×224 canvas (natural) scaled to 24×672 via CSS.
 *         Each row = one scanline, colored by PPU mode.
 * Graph:  32×224 canvas scaled to 96×672 via CSS.
 *         Horizontal traces of BG1 Hoff (green) and Voff (blue).
 * Hover:  mousemove on render-area → highlight band + floating tooltip.
 */

const MODE_COLORS = {
  0: [0x66, 0x66, 0x66],  // grey
  1: [0x44, 0x88, 0xff],  // blue (most frames)
  2: [0x99, 0x44, 0xcc],  // purple
  3: [0x22, 0x44, 0x88],  // dark blue
  4: [0x22, 0xaa, 0xaa],  // teal
  5: [0xee, 0x88, 0x00],  // orange
  6: [0xdd, 0xcc, 0x00],  // yellow
  7: [0xff, 0x44, 0x22],  // red (road)
};

export class DebugPanels {
  constructor(rulerEl, graphEl, viewportEl) {
    this._rulerEl    = rulerEl;
    this._graphEl    = graphEl;
    this._viewportEl = viewportEl;
    this._visible    = false;

    this._scanlineData = null;
    this._frameMode    = 0;

    this._rulerCtx = rulerEl.getContext('2d');
    this._graphCtx = graphEl.getContext('2d');

    this._hoverBand    = document.getElementById('hover-band');
    this._hoverTooltip = document.getElementById('hover-tooltip');
    this._overlayEl    = document.getElementById('hover-overlay');

    this._installHover(viewportEl);
  }

  update(ppuState) {
    if (!this._visible) return;
    this._scanlineData = ppuState.scanlineData;
    this._frameMode    = ppuState.mode;
    this._updateRuler(ppuState.scanlineData, ppuState.mode);
    this._updateGraph(ppuState.scanlineData);
  }

  setVisible(bool) {
    this._visible = bool;
    if (this._overlayEl) {
      this._overlayEl.style.display = bool ? '' : 'none';
    }
    if (!bool) {
      if (this._hoverBand)    this._hoverBand.style.display    = 'none';
      if (this._hoverTooltip) this._hoverTooltip.style.display = 'none';
    }
  }

  _updateRuler(scanlineData, frameMode) {
    const ctx = this._rulerCtx;
    const img = ctx.createImageData(8, 224);
    const d   = img.data;

    for (let y = 0; y < 224; y++) {
      const sd  = scanlineData?.[y];
      const m   = sd ? sd.mode : frameMode;
      const col = MODE_COLORS[m] ?? MODE_COLORS[1];
      const base = y * 8 * 4;
      for (let x = 0; x < 8; x++) {
        const idx = base + x * 4;
        d[idx]     = col[0];
        d[idx + 1] = col[1];
        d[idx + 2] = col[2];
        d[idx + 3] = 255;
      }
    }

    ctx.putImageData(img, 0, 0);
  }

  _updateGraph(scanlineData) {
    const ctx = this._graphCtx;
    const img = ctx.createImageData(32, 224);
    const d   = img.data;

    // Black background (alpha only, RGB stays 0)
    for (let i = 3; i < d.length; i += 4) d[i] = 255;

    if (!scanlineData) {
      ctx.putImageData(img, 0, 0);
      return;
    }

    const hoffVals = new Array(224);
    const voffVals = new Array(224);
    for (let y = 0; y < 224; y++) {
      const sd = scanlineData[y];
      hoffVals[y] = sd ? sd.bgHoff[0] : 0;
      voffVals[y] = sd ? sd.bgVoff[0] : 0;
    }

    const hoffMin = Math.min(...hoffVals), hoffMax = Math.max(...hoffVals);
    const voffMin = Math.min(...voffVals), voffMax = Math.max(...voffVals);

    const drawTrace = (vals, min, max, r, g, b) => {
      if (max - min < 2) return;  // static — not interesting
      const range = max - min;
      for (let y = 0; y < 224; y++) {
        const x   = Math.round((vals[y] - min) / range * 31);
        const idx = (y * 32 + x) * 4;
        d[idx]     = r;
        d[idx + 1] = g;
        d[idx + 2] = b;
        d[idx + 3] = 255;
      }
    };

    drawTrace(hoffVals, hoffMin, hoffMax, 0x44, 0xff, 0x44);  // green = Hoff
    drawTrace(voffVals, voffMin, voffMax, 0x44, 0x88, 0xff);  // blue  = Voff

    ctx.putImageData(img, 0, 0);
  }

  _installHover(viewportEl) {
    viewportEl.addEventListener('mousemove', (e) => {
      if (!this._visible) return;
      const scanlineIdx = Math.floor(e.offsetY / 3);
      if (scanlineIdx < 0 || scanlineIdx >= 224) return;
      this._updateHoverLine(scanlineIdx);
      this._showTooltip(scanlineIdx, this._scanlineData?.[scanlineIdx] ?? null, e.offsetX, e.offsetY);
    });

    viewportEl.addEventListener('mouseleave', () => {
      if (this._hoverBand)    this._hoverBand.style.display    = 'none';
      if (this._hoverTooltip) this._hoverTooltip.style.display = 'none';
    });
  }

  _updateHoverLine(scanlineIdx) {
    if (!this._hoverBand) return;
    this._hoverBand.style.top     = `${scanlineIdx * 3}px`;
    this._hoverBand.style.display = '';
  }

  _showTooltip(scanlineIdx, sd, mouseX, mouseY) {
    const tip = this._hoverTooltip;
    if (!tip) return;

    const mode = sd ? sd.mode : (this._frameMode ?? 0);
    let text = `Scanline ${String(scanlineIdx).padStart(3)}  Mode ${mode}\n`;

    if (sd) {
      text += `BG1 H:${sd.bgHoff[0]} V:${sd.bgVoff[0]}   BG2 H:${sd.bgHoff[1]} V:${sd.bgVoff[1]}\n`;
      if (mode === 7) {
        text += `M7: A=${sd.mode7A} B=${sd.mode7B} C=${sd.mode7C} D=${sd.mode7D}\n`;
        text += `    X=${sd.mode7X}  Y=${sd.mode7Y}  Hoff=${sd.mode7Hoff}  Voff=${sd.mode7Voff}`;
      }
    } else {
      text += '(no scanline data)';
    }

    tip.textContent = text;

    // Flip tooltip left if it would overflow the right edge
    const tipW = 250;
    const x = (mouseX + 16 + tipW > 768) ? mouseX - tipW - 8 : mouseX + 16;
    const y = Math.max(0, mouseY - 10);
    tip.style.left    = `${x}px`;
    tip.style.top     = `${y}px`;
    tip.style.display = '';
  }
}
