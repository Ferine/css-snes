import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Window } from 'happy-dom';
import { Mode7Layer } from '../../src/mode7-layer.js';

let previousWindow;
let previousDocument;
let previousNode;
let previousHTMLElement;

beforeEach(() => {
  previousWindow = globalThis.window;
  previousDocument = globalThis.document;
  previousNode = globalThis.Node;
  previousHTMLElement = globalThis.HTMLElement;

  const window = new Window();

  // happy-dom does not implement the 2D canvas context. Mode7Layer's
  // constructor calls canvas.getContext('2d') then createImageData(...),
  // and the CSS row path may call toDataURL() synchronously when toBlob
  // is unavailable. Stub minimally before constructing any layer.
  window.HTMLCanvasElement.prototype.getContext = function () {
    return {
      createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
      putImageData: () => {},
    };
  };
  window.HTMLCanvasElement.prototype.toBlob = undefined;
  window.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,stub';

  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.Node = window.Node;
  globalThis.HTMLElement = window.HTMLElement;
});

afterEach(() => {
  globalThis.window = previousWindow;
  globalThis.document = previousDocument;
  globalThis.Node = previousNode;
  globalThis.HTMLElement = previousHTMLElement;
});

function makePpuState(scanlineData) {
  return {
    mode: 1,
    mode7: { a: 256, b: 0, c: 0, d: 256, x: 0, y: 0, hoff: 0, voff: 0, largeField: true, char0fill: false, flipX: false, flipY: false },
    vram: new Uint16Array(0x8000),
    palR: new Uint8Array(256), palG: new Uint8Array(256), palB: new Uint8Array(256),
    forcedBlank: false,
    scanlineData,
  };
}

// Ground-plane HDMA table (rows 96..223): passes the 1.0px fit-validation
// gate (known maxError ~= 0.147, same progression as the "accepts an
// integer HDMA hyperbolic table" case in mode7-homography.test.js).
function makeCleanScanlineData() {
  const rows = new Array(224).fill(null);
  for (let y = 96; y <= 223; y++) {
    const scale = Math.round(864000 / (y + 1 + 64));
    rows[y] = {
      mode: 7,
      mode7A: scale, mode7B: 0, mode7C: 0, mode7D: scale,
      mode7X: 0, mode7Y: 0, mode7Hoff: 0, mode7Voff: 0,
    };
  }
  return rows;
}

// Non-projective (sinusoidal) table: fails the fit-validation gate, same
// progression as the "rejects a non-projective" case in mode7-homography.test.js.
function makeNoisyScanlineData() {
  const rows = new Array(224).fill(null);
  for (let y = 96; y <= 223; y++) {
    rows[y] = {
      mode: 7,
      mode7A: 256 + Math.round(64 * Math.sin(y / 6)), mode7B: 0,
      mode7C: 0, mode7D: 256,
      mode7X: 0, mode7Y: 0, mode7Hoff: 0, mode7Voff: 0,
    };
  }
  return rows;
}

describe('Mode7Layer CSS homography path (DOM)', () => {
  it('activates the homography path for a clean projective band', () => {
    const layer = new Mode7Layer(document.createElement('div'));
    layer.update(makePpuState(makeCleanScanlineData()), { forceCss: true });

    expect(layer._perspEl.dataset.m7Css).toBe('homography');
    expect(layer._planeEl.style.transform.startsWith('matrix3d(')).toBe(true);
    expect(layer._rowsRoot.style.display).toBe('none');
    expect(layer._swCanvas.style.display).toBe('none');
  });

  it('falls back to rows for a non-projective band', () => {
    const layer = new Mode7Layer(document.createElement('div'));
    layer.update(makePpuState(makeNoisyScanlineData()), { forceCss: true });

    expect(layer._perspEl.dataset.m7Css).toBe('rows');
    expect(layer._rowsRoot.style.display).toBe('');
    expect(layer._planeEl.style.display).toBe('none');
  });

  it('recovers homography after a rows frame and caches the matrix', () => {
    const layer = new Mode7Layer(document.createElement('div'));

    layer.update(makePpuState(makeCleanScanlineData()), { forceCss: true });
    const capturedTransform = layer._planeEl.style.transform;

    layer.update(makePpuState(makeNoisyScanlineData()), { forceCss: true });
    expect(layer._perspEl.dataset.m7Css).toBe('rows');

    layer.update(makePpuState(makeCleanScanlineData()), { forceCss: true });

    expect(layer._perspEl.dataset.m7Css).toBe('homography');
    expect(layer._planeEl.style.transform).toBe(capturedTransform);
    expect(layer._usedRowModeLastFrame).toBe(false);
  });
});
