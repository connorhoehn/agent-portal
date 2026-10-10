import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', testMatch: ['footer-today.spec.ts', 'social-footer-presentation.spec.ts'], workers: 1, retries: 0, timeout: 60000,
  outputDir: 'test-results/footer-today', reporter: [['list'], ['json', { outputFile: 'test-results/footer-today.json' }]],
  use: { baseURL: 'http://127.0.0.1:5293', viewport: { width: 1440, height: 900 }, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: { command: 'node node_modules/vite/bin/vite.js --config vite.prepare-job.config.ts', url: 'http://127.0.0.1:5293', reuseExistingServer: false, timeout: 90000, stdout: 'pipe', stderr: 'pipe' },
});
