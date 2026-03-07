import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Window } from 'happy-dom';
import { SpriteLayer } from '../../src/sprite-layer.js';

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

function createSprites(defaults = {}) {
  return Array.from({ length: 128 }, () => ({
    x: 300,
    y: 0,
    tile: 0,
    nameTable: 0,
    palette: 0,
    priority: 0,
    flipH: false,
    flipV: false,
    sizePx: 8,
    isBig: false,
    ...defaults,
  }));
}

function createTileCache() {
  return {
    getTilePosition(tileNum) {
      return `-${tileNum * 8}px 0px`;
    },
  };
}

describe('SpriteLayer', () => {
  it('reuses pooled subtiles when sprite sizes change', () => {
    const container = document.createElement('div');
    const layer = new SpriteLayer(container);
    const tileCache = createTileCache();
    const sprZTable = [2, 4, 7, 10];

    const sprites = createSprites();
    sprites[0] = {
      x: 10,
      y: 12,
      tile: 4,
      nameTable: 1,
      palette: 3,
      priority: 2,
      flipH: true,
      flipV: false,
      sizePx: 16,
      isBig: true,
    };

    layer.update({ sprites }, tileCache, sprZTable);

    expect(layer._activeSubTileCounts[0]).toBe(4);
    const pooledNodes = [...layer._subDivs[0]];
    expect(pooledNodes).toHaveLength(4);
    expect(pooledNodes.every((node) => node.style.display === '')).toBe(true);
    expect(layer._divs[0].style.transform).toBe('scale(-1,1)');
    expect(layer._divs[0].style.zIndex).toBe('7');

    sprites[0] = {
      ...sprites[0],
      tile: 9,
      nameTable: 0,
      palette: 1,
      flipH: false,
      sizePx: 8,
      isBig: false,
    };
    layer.update({ sprites }, tileCache, sprZTable);

    expect(layer._subDivs[0]).toEqual(pooledNodes);
    expect(layer._activeSubTileCounts[0]).toBe(0);
    expect(pooledNodes.every((node) => node.style.display === 'none')).toBe(true);
    expect(layer._divs[0].className).toBe('sprite spr-pal-1');
    expect(layer._divs[0].style.backgroundPosition).toBe('-72px 0px');
    expect(layer._divs[0].style.transform).toBe('');

    sprites[0] = {
      ...sprites[0],
      tile: 2,
      nameTable: 1,
      palette: 4,
      sizePx: 16,
      isBig: true,
    };
    layer.update({ sprites }, tileCache, sprZTable);

    expect(layer._subDivs[0]).toEqual(pooledNodes);
    expect(layer._activeSubTileCounts[0]).toBe(4);
    expect(pooledNodes.every((node) => node.style.display === '')).toBe(true);
    expect(pooledNodes[0].className).toContain('spr1-pal-4');
  });

  it('hides off-screen sprites and deactivates their pooled subtiles', () => {
    const container = document.createElement('div');
    const layer = new SpriteLayer(container);
    const tileCache = createTileCache();

    const sprites = createSprites();
    sprites[0] = {
      x: 0,
      y: 0,
      tile: 1,
      nameTable: 0,
      palette: 0,
      priority: 0,
      flipH: false,
      flipV: false,
      sizePx: 16,
      isBig: true,
    };

    layer.update({ sprites }, tileCache, null);
    expect(layer._divs[0].style.display).toBe('');
    expect(layer._activeSubTileCounts[0]).toBe(4);

    sprites[0] = { ...sprites[0], x: 300 };
    layer.update({ sprites }, tileCache, null);

    expect(layer._divs[0].style.display).toBe('none');
    expect(layer._activeSubTileCounts[0]).toBe(0);
    expect(layer._subDivs[0].every((node) => node.style.display === 'none')).toBe(true);
  });
});
