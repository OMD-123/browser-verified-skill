import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  timeout: 30_000,
  use: {
    baseURL: process.env['BV_FIXTURE_ORIGIN'] ?? 'http://127.0.0.1:3000',
    headless: true,
  },
});
