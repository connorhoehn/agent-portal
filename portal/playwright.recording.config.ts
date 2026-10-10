import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e', testMatch: ['recording-documents.spec.ts', 'recording-pipeline.spec.ts'],
  workers: 1, fullyParallel: false, retries: 0, timeout: 90000,
  outputDir: 'test-results/recording-pipeline',
  reporter: [['list'], ['json', { outputFile: 'test-results/recording-pipeline.json' }]],
  use: { baseURL: 'http://127.0.0.1:5283', viewport: { width: 1280, height: 900 }, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node node_modules/vite/bin/vite.js --config vite.recording.config.ts',
    url: 'http://127.0.0.1:5283', reuseExistingServer: false, timeout: 90000,
    stdout: 'pipe', stderr: 'pipe',
  },
});
