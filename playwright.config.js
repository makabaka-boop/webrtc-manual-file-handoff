import { defineConfig } from '@playwright/test';
import { launchEnv, launchArgs } from './tests/page/browser-env.js';

export default defineConfig({
  testDir: './tests/page',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    browserName: 'chromium',
    headless: true,
    actionTimeout: 15_000,
    launchOptions: {
      env: launchEnv(),
      args: launchArgs,
    },
  },
});
