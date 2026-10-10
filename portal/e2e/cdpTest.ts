import { test as base, type Browser } from '@playwright/test';
import { seedPreJoin, type PreJoinMode } from './preJoin';

// Opt in to an existing local Chrome CDP process. Tests still create isolated
// contexts; closing the connection disconnects without closing Chrome.
const connected = process.env.CDP_ENDPOINT
  ? base.extend<{}, { browser: Browser }>({
    browser: [async ({ playwright }, use) => {
      const browser = await playwright.chromium.connectOverCDP(process.env.CDP_ENDPOINT!);
      try { await use(browser); }
      finally { await browser.close(); }
    }, { scope: 'worker' }],
  })
  : base;

// `preJoin: 'show'` (test.use) leaves the shell's pre-join step in place;
// the default remembers it so call clicks reach the call.
export const test = connected.extend<{ preJoin: PreJoinMode }>({
  preJoin: ['remembered', { option: true }],
  context: async ({ context, preJoin }, use) => { await seedPreJoin(context, preJoin); await use(context); },
});

export { expect } from '@playwright/test';
