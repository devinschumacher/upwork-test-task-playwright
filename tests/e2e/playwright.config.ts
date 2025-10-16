import { defineConfig, devices } from '@playwright/test';

const isCI = !!process.env.CI;

/**
 * Playwright test harness for the SERP Downloader companion stack.
 * Extension automation requires a persistent Chromium context with the unpacked build.
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  timeout: 10 * 60 * 1000,
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: './artifacts/html-report' }],
  ],
  expect: {
    timeout: 30 * 1000,
  },
  use: {
    headless: isCI,
    viewport: { width: 1280, height: 720 },
    ignoreHTTPSErrors: true,
    baseURL: 'https://www.skool.com',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium-extension',
      use: {
        ...devices['Desktop Chrome'],
        channel: 'chrome',
        headless: isCI,
      },
    },
  ],
  outputDir: './artifacts/test-results',
});
