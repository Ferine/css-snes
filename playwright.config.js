import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.js',
  outputDir: './tests/e2e/test-results',
  workers: 1,
  timeout: 60_000,
  use: {
    ...devices['Desktop Chrome'],
    deviceScaleFactor: 1,
    viewport: { width: 800, height: 600 },
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
  webServer: {
    command: 'npx vite --port 5174',
    port: 5174,
    reuseExistingServer: !process.env.CI,
  },
});
