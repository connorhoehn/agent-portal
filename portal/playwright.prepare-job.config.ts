import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e', testMatch: ['prepare-job.spec.ts', 'run-draft-refresh.spec.ts'],
  workers: 1, fullyParallel: false, retries: 0, timeout: 60000,
  outputDir: 'test-results/prepare-job',
  reporter: [['list'], ['json', { outputFile: 'test-results/prepare-job.json' }]],
  use: { baseURL: 'http://127.0.0.1:5293', viewport: { width: 1024, height: 900 },
    screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node node_modules/vite/bin/vite.js --config vite.prepare-job.config.ts',
    url: 'http://127.0.0.1:5293', reuseExistingServer: false, timeout: 90000,
    stdout: 'pipe', stderr: 'pipe',
  },
});
