# css-snes

A CSS DOM renderer for the SNES. Instead of drawing pixels to a canvas, the emulator's PPU state is read each frame and translated into positioned `<div>` elements styled with CSS — tile spritesheets as `background-image`, scroll as `left`/`top`, palette as class selectors, and priority as `z-index`.

Developed against F-Zero as the target game (Mode 7 showcase).

## How it works

Every frame:

1. **SnesJs** runs the emulated SNES and updates its internal PPU state (`ppu.vram`, `ppu.oam`, `ppu.cgram`, registers).
2. **PPUStateExtractor** reads those fields and produces a clean snapshot: BG layer configs, sprite list, color math, window registers, etc.
3. **TileCache** decodes VRAM tiles into PNG spritesheets (one per BG palette), injecting them as data-URL `background-image` rules into a `<style>` element. Sheets are only regenerated when VRAM or palette data changes.
4. **BGLayer** (×4) maintains a grid of `<div>` tiles. Each BG channel has two sub-layer roots — one for low-priority tiles (tilemap bit 13 = 0) and one for high-priority tiles (bit 13 = 1). Their z-indices are set from a per-mode table so priority bands interleave correctly with sprites. Scroll is applied directly as `left`/`top` on each quadrant div.
5. **SpriteLayer** positions 128 pre-created sprite divs. Multi-tile sprites are built from 8×8 sub-divs.
6. **Mode7Layer** renders BG1 in mode 7 using a canvas painted from the PPU's pixel output and a CSS 3D perspective transform.

### Priority

SNES priority is per-tile and per-sprite, not per-layer. The z-index scheme:

| Mode 1 (normal) | z |
|---|---|
| Sprite priority 3 | 10 |
| BG1 hi | 9 |
| BG2 hi | 8 |
| Sprite priority 2 | 7 |
| BG1 lo | 6 |
| BG2 lo | 5 |
| Sprite priority 1 | 4 |
| BG3 hi | 3 |
| Sprite priority 0 | 2 |
| BG3 lo | 1 |

Mode 0 uses a 12-level table; mode 1 + layer3Prio promotes BG3-hi to the top.

## Structure

```
src/
  app.js                 Game loop, ROM loading, input, UI wiring
  ppu-state-extractor.js Reads snes.ppu.*, produces PPU state snapshot
  css-renderer.js        Orchestrates all layers; holds z-index tables
  bg-layer.js            Dual-root BG layer (lo/hi priority bands)
  sprite-layer.js        128 sprite divs with per-priority z-index
  mode7-layer.js         Mode 7 canvas + CSS perspective
  tile-cache.js          VRAM → PNG spritesheets (128×128 or 256×256 for bigTiles)
styles/
  snes-layers.css        Viewport, layer, tile, sprite, debug CSS
packages/
  snesjs/                Vendored SnesJs (angelo-wf/SnesJs), wrapped as ES module
tests/
  e2e/fzero.spec.js      Playwright pixel-diff test against F-Zero
```

## Getting started

```sh
npm install
npm run dev        # Vite dev server at http://localhost:5174
```

Open the page, click **Load ROM**, and select an `.sfc` or `.smc` file. The HiROM button toggles addressing mode (most games are LoROM).

### Keyboard controls

| Key | SNES button |
|-----|-------------|
| Arrow keys | D-pad |
| Z | B |
| X | A |
| A | Y |
| S | X |
| Enter | Start |
| Right Shift | Select |
| D | L |
| C | R |

Layer visibility toggles: `1`–`4` for BG1–BG4, `S` for sprites.
Debug overlays: `G` tile grid, `B` sprite boxes, `7` Mode 7 wireframe.

### Canvas comparison mode

Click **Canvas Mode** to overlay the SnesJs pixel-perfect canvas output. This is useful for comparing CSS fidelity against the reference renderer.

## Building

```sh
npm run build      # Vite production build → dist/
```

## Tests

```sh
npm run test:e2e   # Playwright E2E test (boots F-Zero, pixel-diffs key frames)
```

The test boots F-Zero for 300+ frames, presses Start to reach the car selection screen, and asserts that the CSS output is within 80% pixel difference of the reference canvas. The car selection screen currently achieves ~4% difference.

Requires the ROM at `roms/F-ZERO (E).smc`.

## Known limitations

- **Mode 7** — approximate CSS perspective; no full `matrix3d` transform.
- **Window clipping** — computed per-frame as CSS `clip-path`; complex multi-window interactions may not be pixel-perfect.
- **Color math** — approximated as CSS `brightness()` / `opacity`; sub-screen blending is not modelled.
- **BG tile vs sprite sub-priority** — priority interleaving is correct per mode table but not per individual pixel.
