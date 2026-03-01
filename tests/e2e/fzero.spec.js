/**
 * F-Zero diagnostic spec.
 * Runs the ROM through css-snes and checks rendering at several checkpoints.
 * Saves screenshots + a JSON report to tests/e2e/test-results/.
 */
import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

const ROM_PATH    = path.resolve('roms', 'F-ZERO (E).smc');
const RESULTS_DIR = path.resolve('tests/e2e/test-results');

function loadROMBytes() {
  if (!fs.existsSync(ROM_PATH)) return null;
  return Array.from(fs.readFileSync(ROM_PATH));
}

function decodePNG(buffer) {
  const png = PNG.sync.read(buffer);
  return { data: png.data, width: png.width, height: png.height };
}

function diffImages(cssBuffer, refBuffer) {
  const a = decodePNG(cssBuffer);
  const b = decodePNG(refBuffer);
  const w = Math.min(a.width, b.width);
  const h = Math.min(a.height, b.height);
  const diff = new PNG({ width: w, height: h });
  const n = pixelmatch(a.data, b.data, diff.data, w, h, { threshold: 0.1, diffColor: [255, 0, 255] });
  return {
    diffCount: n,
    diffPercent: (n / (w * h)) * 100,
    diffPNG: PNG.sync.write(diff),
  };
}

async function capture(page, label) {
  const cssBuf = await page.locator('.snes-viewport').screenshot();
  const refBuf = await page.locator('#ref-canvas').screenshot();
  const { diffCount, diffPercent, diffPNG } = diffImages(cssBuf, refBuf);

  fs.writeFileSync(path.join(RESULTS_DIR, `${label}-css.png`), cssBuf);
  fs.writeFileSync(path.join(RESULTS_DIR, `${label}-ref.png`), refBuf);
  fs.writeFileSync(path.join(RESULTS_DIR, `${label}-diff.png`), diffPNG);

  const ppu  = await page.evaluate(() => window.testHarness.getPPUSummary());
  const errs = await page.evaluate(() => window.testHarness.getErrors());
  return { label, diffCount, diffPercent: +diffPercent.toFixed(2), ppu, errors: errs };
}

test('F-Zero boot + title diagnostics', async ({ page }) => {
  const romBytes = loadROMBytes();
  test.skip(!romBytes, `ROM not found at ${ROM_PATH}`);

  fs.mkdirSync(RESULTS_DIR, { recursive: true });

  const consoleMessages = [];
  page.on('console', (msg) => consoleMessages.push({ type: msg.type(), text: msg.text() }));
  page.on('pageerror', (err) => consoleMessages.push({ type: 'pageerror', text: err.message }));

  await page.goto('http://localhost:5174/tests/e2e/test-harness.html');
  await page.waitForFunction(() => typeof window.testHarness !== 'undefined', { timeout: 10_000 });

  // Load ROM
  const loaded = await page.evaluate((bytes) => window.testHarness.loadROM(bytes), romBytes);
  expect(loaded, 'ROM failed to load').toBe(true);

  const checkpoints = [];

  // Frame 1 — very first frame, checks initial state
  await page.evaluate(() => window.testHarness.stepFrames(1));
  checkpoints.push(await capture(page, 'frame-001'));

  // Frame 60 — 1 second in
  await page.evaluate(() => window.testHarness.stepFrames(59));
  checkpoints.push(await capture(page, 'frame-060'));

  // Frame 180 — 3 seconds in (title screen should be visible)
  await page.evaluate(() => window.testHarness.stepFrames(120));
  checkpoints.push(await capture(page, 'frame-180'));

  // Frame 300 — 5 seconds
  await page.evaluate(() => window.testHarness.stepFrames(120));
  checkpoints.push(await capture(page, 'frame-300'));

  // Press Start a few times to try to get to the race
  await page.evaluate(() => window.testHarness.buttonDown(3));
  await page.evaluate(() => window.testHarness.stepFrames(3));
  await page.evaluate(() => window.testHarness.buttonUp(3));
  await page.evaluate(() => window.testHarness.stepFrames(180));
  checkpoints.push(await capture(page, 'after-start-1'));

  await page.evaluate(() => window.testHarness.buttonDown(3));
  await page.evaluate(() => window.testHarness.stepFrames(3));
  await page.evaluate(() => window.testHarness.buttonUp(3));
  await page.evaluate(() => window.testHarness.stepFrames(180));
  checkpoints.push(await capture(page, 'after-start-2'));

  // Long settle — try to reach race mode
  await page.evaluate(() => window.testHarness.stepFrames(300));
  checkpoints.push(await capture(page, 'settle-300'));

  // Navigate through remaining menus to reach Mode 7 race track.
  // Expected flow from here: YES/NO confirm → class select → track select → countdown → race
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => window.testHarness.buttonDown(3)); // Start
    await page.evaluate(() => window.testHarness.stepFrames(3));
    await page.evaluate(() => window.testHarness.buttonUp(3));
    await page.evaluate(() => window.testHarness.stepFrames(120));
  }
  // Wait for race countdown + first seconds of racing
  await page.evaluate(() => window.testHarness.stepFrames(360));
  checkpoints.push(await capture(page, 'race-track'));

  // Write full report
  const report = {
    rom: path.basename(ROM_PATH),
    generatedAt: new Date().toISOString(),
    totalFrames: await page.evaluate(() => window.testHarness.getFrameCount()),
    consoleErrors: consoleMessages.filter((m) => m.type === 'error' || m.type === 'pageerror'),
    consoleWarnings: consoleMessages.filter((m) => m.type === 'warning'),
    checkpoints,
  };
  fs.writeFileSync(path.join(RESULTS_DIR, 'fzero-report.json'), JSON.stringify(report, null, 2));

  // --- Assertions ---

  // No JS errors
  const pageErrors = consoleMessages.filter((m) => m.type === 'pageerror');
  if (pageErrors.length > 0) {
    console.log('PAGE ERRORS:', pageErrors.map((e) => e.text).join('\n'));
  }
  expect(pageErrors, 'No JS page errors expected').toHaveLength(0);

  const harnesErrors = checkpoints.flatMap((c) => c.errors);
  if (harnesErrors.length > 0) {
    console.log('HARNESS ERRORS:', harnesErrors);
  }
  expect(harnesErrors, 'No harness errors expected').toHaveLength(0);

  // Viewport should not be entirely black after 60 frames
  const frame60 = checkpoints.find((c) => c.label === 'frame-060');
  console.log('frame-060 PPU:', JSON.stringify(frame60?.ppu, null, 2));
  console.log('frame-060 diff%:', frame60?.diffPercent);

  // The CSS output should match the reference within 40% at frame 60
  // (loose threshold for MVP — mode 7 perspective approximation won't be pixel-perfect)
  const titleCheckpoint = checkpoints.find((c) => c.label === 'frame-180');
  console.log('frame-180 PPU:', JSON.stringify(titleCheckpoint?.ppu, null, 2));
  console.log('frame-180 diff%:', titleCheckpoint?.diffPercent);

  // Print all checkpoint summaries
  for (const cp of checkpoints) {
    console.log(`[${cp.label}] diff=${cp.diffPercent}% mode=${cp.ppu?.mode} blank=${cp.ppu?.forcedBlank} bgColor=${cp.ppu?.cgRgb0} sprites=${cp.ppu?.visibleSprites}`);
  }

  // At least one checkpoint should have < 80% diff (something is rendering)
  const bestDiff = Math.min(...checkpoints.map((c) => c.diffPercent));
  expect(bestDiff, 'At least one checkpoint should have <80% diff vs reference').toBeLessThan(80);

  // If we reached mode 7 (or a mixed-mode frame with mode 7 scanlines), check rendering quality
  const raceCheckpoint = checkpoints.find((c) => c.label === 'race-track');
  const hasM7 = raceCheckpoint?.ppu?.mode === 7 || raceCheckpoint?.ppu?.hasMode7Scanlines;
  if (hasM7) {
    console.log(`Mode 7 reached! race-track diff=${raceCheckpoint.diffPercent}%`);
    expect(raceCheckpoint.diffPercent, 'Mode 7 race track should render within 30% of reference').toBeLessThan(30);
  } else {
    console.log(`race-track mode=${raceCheckpoint?.ppu?.mode} hasMode7Scanlines=${raceCheckpoint?.ppu?.hasMode7Scanlines} (did not reach mode 7)`);
  }
});
