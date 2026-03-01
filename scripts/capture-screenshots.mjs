/**
 * Captures screenshots of F-Zero at key moments for the README.
 * Run: node scripts/capture-screenshots.mjs
 */
import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ROM_PATH = path.join(ROOT, 'roms', 'F-ZERO (E).smc');
const OUT_DIR = path.join(ROOT, 'screenshots');

mkdirSync(OUT_DIR, { recursive: true });

const vite = await createServer({
  root: ROOT,
  server: { port: 5199, strictPort: true },
  logLevel: 'silent',
});
await vite.listen();

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });

await page.goto('http://localhost:5199/tests/e2e/test-harness.html');
await page.waitForFunction(() => window.testHarness?.isReady !== undefined);

const romBytes = [...readFileSync(ROM_PATH)];
const loaded = await page.evaluate((bytes) => window.testHarness.loadROM(bytes, false), romBytes);
if (!loaded) { console.error('ROM load failed'); process.exit(1); }

async function capture(name) {
  const el = await page.$('#viewport-wrapper');
  await el.screenshot({ path: path.join(OUT_DIR, `${name}.png`) });
  const summary = await page.evaluate(() => window.testHarness.getPPUSummary());
  console.log(`  ${name}.png — mode=${summary?.mode} m7=${summary?.hasMode7Scanlines} sprites=${summary?.visibleSprites}`);
}

async function pressStart() {
  await page.evaluate(() => window.testHarness.buttonDown(3));
  await page.evaluate((n) => window.testHarness.stepFrames(n), 3);
  await page.evaluate(() => window.testHarness.buttonUp(3));
}

console.log('Capturing screenshots...');

// 1. Title screen (frame ~180)
await page.evaluate((n) => window.testHarness.stepFrames(n), 180);
await capture('01-title');

// 2. Press Start → car selection (frame ~360)
await pressStart();
await page.evaluate((n) => window.testHarness.stepFrames(n), 180);
await capture('02-car-select');

// 3. Press Start → car stats / confirmation
await pressStart();
await page.evaluate((n) => window.testHarness.stepFrames(n), 180);
await capture('03-car-stats');

// 4. Navigate through remaining menus to reach Mode 7 race track
// (YES/NO confirm → class select → track select → countdown → race)
await page.evaluate((n) => window.testHarness.stepFrames(n), 300);
for (let i = 0; i < 5; i++) {
  await pressStart();
  await page.evaluate((n) => window.testHarness.stepFrames(n), 120);
}
// Wait for countdown + first seconds of racing
await page.evaluate((n) => window.testHarness.stepFrames(n), 360);
await capture('04-race');

// 5. App UI screenshot (CRT frame, empty state)
const mainPage = await browser.newPage({ viewport: { width: 1200, height: 960 } });
await mainPage.goto('http://localhost:5199/index.html');
await mainPage.waitForSelector('.crt-frame');
await mainPage.waitForTimeout(600);
await mainPage.screenshot({ path: path.join(OUT_DIR, 'app-ui.png'), fullPage: true });
console.log('  app-ui.png — main app interface');
await mainPage.close();

console.log('Done!');
await browser.close();
await vite.close();
