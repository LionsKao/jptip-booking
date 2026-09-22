import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  // Tests now share one real D1 database (teachers/students/hours/bookings
  // are no longer per-browser-context localStorage), and several specs seed
  // the same seeded teacher's weekly hours — running fully in parallel lets
  // one test's clear-then-write race another's and flake. Worth the slower
  // wall-clock time for a deterministic suite.
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:12345',
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:12345',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
