// Recording config for the Computer Lab walkthrough.
//
// Separate from playwright.config.ts on purpose. That one is a TEST config —
// no video, failure-only screenshots, whatever viewport the device profile
// says — and the settings a watchable recording needs are the settings that
// make a test suite slow and heavy. Keeping them apart means turning the demo
// into a video never quietly changes how the real specs run.
//
//   cd portal && npx playwright test --config playwright.demo.config.ts
//
// The video lands in e2e-demo/<test>/*.webm. Needs the mock stack up (the Tilt
// stack, or `cd middleware && npm run dev:mock` + `cd portal && npm run dev -- --port 5183`);
// the walkthrough starts the `demo` scenario itself. Script, knobs and the
// presenter's click script: docs/demos/computer-lab-demo.md.
import { defineConfig } from '@playwright/test';

/** Slow every action down so a viewer can follow the pointer. Override with
 *  DEMO_SLOW_MS=0 to get the same walkthrough as a fast correctness check. */
const slowMo = Number(process.env['DEMO_SLOW_MS'] ?? 260);

export default defineConfig({
  testDir: './e2e',
  testMatch: /computer-lab-demo\.spec\.ts/,
  // One worker, no retries: a retried take would record a second video of a
  // half-finished story and leave the reader guessing which file is the demo.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // The walkthrough waits on real dispatches and paced agent runs: at the
  // director's default 4s beat the story alone takes ~3¼ minutes.
  timeout: 8 * 60_000,
  reporter: [['list']],
  use: {
    baseURL: process.env['DEMO_BASE_URL'] ?? 'http://localhost:5183',
    // 1600x900 rather than a laptop's own resolution: the lab puts a rail, a
    // pane tree and a terminal side by side, and below ~1400 the panes stack.
    viewport: { width: 1600, height: 900 },
    video: { mode: 'on', size: { width: 1600, height: 900 } },
    screenshot: 'on',
    trace: 'off',
    launchOptions: { slowMo },
  },
  outputDir: 'e2e-demo',
});
