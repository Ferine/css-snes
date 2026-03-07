import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Window } from 'happy-dom';
import { BGLayer } from '../../src/bg-layer.js';

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

function createLayerState(overrides = {}) {
  return {
    enabled: true,
    tilemapAdr: 0,
    tilemapWidth: 32,
    tilemapHeight: 32,
    scrollX: 0,
    scrollY: 0,
    bigTiles: false,
    window: {
      w1Enabled: false,
      w1Inversed: false,
      w2Enabled: false,
      w2Inversed: false,
      maskLogic: 0,
      mainEnabled: false,
    },
    ...overrides,
  };
}

function createPpuState() {
  return {
    win1Left: 0,
    win1Right: 255,
    win2Left: 0,
    win2Right: 255,
  };
}

function createTileCache() {
  return {
    getBgSetClass(layerIdx) {
      return `bg${layerIdx}-set-test`;
    },
    getTilePosition(tileNum, bigTiles = false) {
      const scale = bigTiles ? 16 : 8;
      return `-${tileNum * scale}px 0px`;
    },
  };
}

describe('BGLayer', () => {
  it('renders only the visible tile pool and routes priority bands correctly', () => {
    const container = document.createElement('div');
    const layer = new BGLayer(container, 0);
    const vram = new Uint16Array(0x8000);
    const tileCache = createTileCache();

    // Top-left visible tile: tile 3, palette 2, low priority, flipH.
    vram[0] = 3 | (2 << 10) | 0x4000;
    // Tile to the right: tile 5, palette 1, high priority, flipV.
    vram[1] = 5 | (1 << 10) | (1 << 13) | 0x8000;

    layer.update(createLayerState(), tileCache, vram, createPpuState());

    expect(layer.rootLo.classList.contains('bg0-set-test')).toBe(true);
    expect(layer.rootHi.classList.contains('bg0-set-test')).toBe(true);

    const firstLo = layer._poolLo.divs[0];
    expect(firstLo.style.display).toBe('');
    expect(firstLo.className).toContain('bg0-pal-2');
    expect(firstLo.className).toContain('flip-h');
    expect(firstLo.style.left).toBe('0px');
    expect(firstLo.style.top).toBe('0px');
    expect(firstLo.style.backgroundPosition).toBe('-24px 0px');

    const secondHi = layer._poolHi.divs[1];
    expect(secondHi.style.display).toBe('');
    expect(secondHi.className).toContain('bg0-pal-1');
    expect(secondHi.className).toContain('flip-v');
    expect(secondHi.style.left).toBe('8px');
    expect(secondHi.style.top).toBe('0px');
    expect(secondHi.style.backgroundPosition).toBe('-40px 0px');

    expect(layer._activeSlots).toBe(33 * 29);
  });

  it('shrinks active tile count for big-tile layers and hides inactive pooled nodes', () => {
    const container = document.createElement('div');
    const layer = new BGLayer(container, 1);
    const vram = new Uint16Array(0x8000);
    const tileCache = createTileCache();

    layer.update(createLayerState(), tileCache, vram, createPpuState());
    const firstActiveCount = layer._activeSlots;
    expect(firstActiveCount).toBe(33 * 29);

    layer.update(createLayerState({ bigTiles: true }), tileCache, vram, createPpuState());
    expect(layer.rootLo.classList.contains('big-tiles')).toBe(true);
    expect(layer.rootHi.classList.contains('big-tiles')).toBe(true);
    expect(layer._activeSlots).toBe(17 * 15);

    const firstInactive = layer._poolLo.states[layer._activeSlots];
    expect(firstInactive.visible).toBe(false);
  });
});
