/**
 * Main app: SnesJs integration, game loop, input handling, ROM loading.
 */
import { Snes, instrumentSnes } from 'snesjs';
import { PPUStateExtractor } from './ppu-state-extractor.js';
import { CSSRenderer } from './css-renderer.js';
import { DebugPanels } from './debug-panels.js';

// --- State ---
let snes = null;
let extractor = null;
let latestPPUState = null;

// --- Renderer Setup ---
const wrapperEl = document.getElementById('viewport-wrapper');
const renderer = new CSSRenderer(wrapperEl);

// --- Debug Panels ---
const debugPanels = new DebugPanels(
  document.getElementById('ruler-canvas'),
  document.getElementById('graph-canvas'),
  document.querySelector('.render-area'),
);

// --- Canvas comparison mode ---
const compareCanvas = document.getElementById('compare-canvas');
const compareCtx = compareCanvas.getContext('2d');
let canvasMode = false;

function renderCanvasFrame(ppuState) {
  // pixelOutput: Uint16Array(512×3×240). Each pixel at (x, y) → index (y*512+x)*3 = R,G,B.
  const po = ppuState.pixelOutput;
  const imgData = compareCtx.createImageData(256, 224);
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
  compareCtx.putImageData(imgData, 0, 0);
}

// --- Game Loop ---
let running = false;
let paused = false;
let lastFrameTime = 0;
let frameCount = 0;
let fpsAccum = 0;
let rafId = null;

const fpsEl    = document.getElementById('fps-counter');
const modeEl   = document.getElementById('mode-counter');
const sprEl    = document.getElementById('spr-counter');
const statusEl = document.getElementById('status-bar');

function cancelGameLoop() {
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}

function gameLoop(timestamp) {
  if (!running || paused) {
    rafId = null;
    return;
  }

  // Throttle to ~60 fps
  const elapsed = timestamp - lastFrameTime;
  if (elapsed < 14) {
    rafId = requestAnimationFrame(gameLoop);
    return;
  }
  lastFrameTime = timestamp;

  // Run one SNES frame (synchronous), then extract PPU state
  snes._scanlineData = new Array(224);
  snes.runFrame();
  latestPPUState = extractor.extract();

  if (canvasMode) {
    renderCanvasFrame(latestPPUState);
  } else {
    renderer.renderFrame(latestPPUState);
  }
  debugPanels.update(latestPPUState);

  // Update status counters
  modeEl.textContent = `M${latestPPUState.mode}`;
  const visSprites = latestPPUState.sprites.filter(s =>
    s.x < 256 && s.x + s.sizePx > 0 && s.y < 224 && s.y + s.sizePx > 0
  ).length;
  sprEl.textContent = `${visSprites} obj`;

  // FPS counter
  frameCount++;
  fpsAccum += elapsed;
  if (fpsAccum >= 1000) {
    fpsEl.textContent = `${Math.round(frameCount * 1000 / fpsAccum)} fps`;
    frameCount = 0;
    fpsAccum = 0;
  }

  rafId = requestAnimationFrame(gameLoop);
}

// --- ROM Loading ---
let hiRom = false;

function loadROM(buffer) {
  // loadRom() handles the 512-byte SMC copier header internally
  const bytes = new Uint8Array(buffer);

  let nextSnes;
  try {
    nextSnes = new Snes();
    const ok = nextSnes.loadRom(bytes, hiRom);
    if (ok === false) {
      statusEl.textContent = 'Error: ROM failed to load (check LoROM/HiROM setting)';
      return;
    }
    nextSnes.reset(true);
    instrumentSnes(nextSnes);
  } catch (e) {
    statusEl.textContent = `Error: ${e.message}`;
    return;
  }

  cancelGameLoop();
  snes = nextSnes;
  extractor = new PPUStateExtractor(snes);
  latestPPUState = null;
  running = true;
  paused = false;
  renderer.viewport.classList.remove('paused');
  document.body.classList.add('rom-loaded');
  updateButtonStates();
  statusEl.textContent = 'Running';
  lastFrameTime = performance.now();
  frameCount = 0;
  fpsAccum = 0;
  rafId = requestAnimationFrame(gameLoop);
}

// File picker
document.getElementById('rom-input').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => loadROM(reader.result);
  reader.readAsArrayBuffer(file);
});

// Drag and drop with visual feedback
let dragCounter = 0;
document.body.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragCounter++;
  document.body.classList.add('dragover');
});
document.body.addEventListener('dragleave', (e) => {
  e.preventDefault();
  dragCounter--;
  if (dragCounter <= 0) {
    dragCounter = 0;
    document.body.classList.remove('dragover');
  }
});
document.body.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});
document.body.addEventListener('drop', (e) => {
  e.preventDefault();
  dragCounter = 0;
  document.body.classList.remove('dragover');
  const file = e.dataTransfer.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => loadROM(reader.result);
  reader.readAsArrayBuffer(file);
});

// --- Toolbar Controls ---
const btnPause        = document.getElementById('btn-pause');
const btnStep         = document.getElementById('btn-step');
const btnToggleCanvas = document.getElementById('btn-toggle-canvas');
const btnHiRom        = document.getElementById('btn-hirom');

function updateButtonStates() {
  btnPause.disabled        = !running;
  btnStep.disabled         = !running || !paused;
  btnToggleCanvas.disabled = !running;

  // Swap pause/play icon + label
  const iconPause = btnPause.querySelector('.icon-pause');
  const iconPlay  = btnPause.querySelector('.icon-play');
  const pauseLabel = btnPause.lastChild;
  if (iconPause && iconPlay) {
    iconPause.style.display = paused ? 'none' : '';
    iconPlay.style.display  = paused ? '' : 'none';
  }
  if (pauseLabel && pauseLabel.nodeType === Node.TEXT_NODE) {
    pauseLabel.textContent = paused ? 'Resume' : 'Pause';
  }

  btnToggleCanvas.textContent = canvasMode ? 'CSS' : 'Canvas';
  btnHiRom.textContent        = hiRom ? 'HiROM' : 'LoROM';
}

btnHiRom.addEventListener('click', () => {
  hiRom = !hiRom;
  updateButtonStates();
});

btnPause.addEventListener('click', () => {
  paused = !paused;
  updateButtonStates();
  renderer.viewport.classList.toggle('paused', paused);
  if (!paused) {
    lastFrameTime = performance.now();
    statusEl.textContent = 'Running';
    cancelGameLoop();
    rafId = requestAnimationFrame(gameLoop);
  } else {
    statusEl.textContent = 'Paused';
    cancelGameLoop();
  }
});

btnStep.addEventListener('click', () => {
  if (!running || !paused) return;
  snes._scanlineData = new Array(224);
  snes.runFrame();
  latestPPUState = extractor.extract();
  if (canvasMode) {
    renderCanvasFrame(latestPPUState);
  } else {
    renderer.renderFrame(latestPPUState);
  }
  debugPanels.update(latestPPUState);
  statusEl.textContent = `Paused — Frame ${renderer.frameCount}`;
});

btnToggleCanvas.addEventListener('click', () => {
  canvasMode = !canvasMode;
  wrapperEl.style.display      = canvasMode ? 'none' : '';
  compareCanvas.classList.toggle('active', canvasMode);
  updateButtonStates();
});

// --- Layer Toggle Buttons ---
function wireLayerBtn(btnId, layerKey) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  btn.addEventListener('click', () => {
    renderer.layerVisible[layerKey] = !renderer.layerVisible[layerKey];
    btn.classList.toggle('active', renderer.layerVisible[layerKey]);
    renderer.applyLayerVisibility();
  });
}
wireLayerBtn('layer-bg0',    'bg0');
wireLayerBtn('layer-bg1',    'bg1');
wireLayerBtn('layer-bg2',    'bg2');
wireLayerBtn('layer-bg3',    'bg3');
wireLayerBtn('layer-sprites','sprites');

// --- Debug Toggles ---
function wireDebugBtn(btnId, cssClass) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  btn.addEventListener('click', () => {
    const on = renderer.viewport.classList.toggle(cssClass);
    btn.classList.toggle('active', on);
  });
}
wireDebugBtn('dbg-tile-grid',    'debug-tile-grid');
wireDebugBtn('dbg-sprite-boxes', 'debug-sprite-boxes');
wireDebugBtn('dbg-mode7',        'debug-mode7');

document.getElementById('toggle-inspector').addEventListener('click', function() {
  this.classList.toggle('active');
  const on = this.classList.contains('active');
  document.getElementById('debug-sidebar').style.display = on ? '' : 'none';
  debugPanels.setVisible(on);
});

// --- SNES Keyboard Input ---
// Button bit numbers for setPad1ButtonPressed/Released(num):
//   0=B  1=Y  2=Select  3=Start  4=Up  5=Down  6=Left  7=Right
//   8=A  9=X  10=L  11=R
function getSnesButton(e) {
  switch (e.key) {
    case 'ArrowUp':    return 4;
    case 'ArrowDown':  return 5;
    case 'ArrowLeft':  return 6;
    case 'ArrowRight': return 7;
    case 'z': case 'Z': return 0;  // B
    case 'x': case 'X': return 8;  // A
    case 'a': case 'A': return 1;  // Y
    case 's': case 'S': return 9;  // X
    case 'Enter':       return 3;  // Start
    case 'd': case 'D': return 10; // L
    case 'c': case 'C': return 11; // R
  }
  if (e.code === 'ShiftRight') return 2; // Select
  return null;
}

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

  if (snes) {
    const btn = getSnesButton(e);
    if (btn !== null) {
      snes.setPad1ButtonPressed(btn);
      e.preventDefault();
      return;
    }
  }

  // UI shortcuts (only for keys that don't conflict with game buttons)
  if (!running) return;
  switch (e.key) {
    case '1': document.getElementById('layer-bg0')?.click(); break;
    case '2': document.getElementById('layer-bg1')?.click(); break;
    case '3': document.getElementById('layer-bg2')?.click(); break;
    case '4': document.getElementById('layer-bg3')?.click(); break;
    case 'o': case 'O': document.getElementById('layer-sprites')?.click(); break;
    case 'g': case 'G': document.getElementById('dbg-tile-grid')?.click(); break;
    case 'b': case 'B': document.getElementById('dbg-sprite-boxes')?.click(); break;
    case '7': document.getElementById('dbg-mode7')?.click(); break;
  }
});

document.addEventListener('keyup', (e) => {
  if (!snes) return;
  const btn = getSnesButton(e);
  if (btn !== null) {
    snes.setPad1ButtonReleased(btn);
    e.preventDefault();
  }
});

// Release all buttons when window loses focus
window.addEventListener('blur', () => {
  if (!snes) return;
  for (let i = 0; i < 12; i++) snes.setPad1ButtonReleased(i);
});

// --- Debug API ---
window.snesDebug = {
  get state()    { return latestPPUState; },
  get snes()     { return snes; },
  get renderer() { return renderer; },
};

updateButtonStates();
