import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e', testMatch: 'context-transition.spec.ts', workers: 1, retries: 0,
  outputDir: 'test-results/context-transition',
  reporter: [['list'], ['json', { outputFile: 'test-results/context-transition.json' }]],
  use: { baseURL: 'http://127.0.0.1:5293', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node node_modules/vite/bin/vite.js --config vite.prepare-job.config.ts',
    url: 'http://127.0.0.1:5293', reuseExistingServer: false, timeout: 90000,
    stdout: 'pipe', stderr: 'pipe',
  },
});
