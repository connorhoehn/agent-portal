// Sign-in to the DEPLOYED portal through Cognito's hosted UI, shared by the
// cloud-*.spec.ts checks. Logins come from env as `<email>:<password>`.
import { expect, type Browser, type Page } from '@playwright/test';

export const cloudBase = process.env.CLOUD_PORTAL_URL;

export async function cloudSignIn(browser: Browser, login: string, label: string,
  prepare?: (page: Page) => void | Promise<void>): Promise<Page> {
  const [email, password] = [login.slice(0, login.indexOf(':')), login.slice(login.indexOf(':') + 1)];
  const context = await browser.newContext({ baseURL: cloudBase, permissions: ['camera', 'microphone'], viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();
  await prepare?.(page);
  page.on('response', (r) => { if (r.status() >= 500) console.log(`[${label}] ${r.status()} ${r.request().method()} ${r.url()}`); });
  await page.goto('/api/auth/login');
  await page.locator('input[name="username"]:visible, input[type="email"]:visible').first().fill(email);
  const next = page.getByRole('button', { name: /^(next|continue)$/i });
  if (await next.isVisible().catch(() => false)) await next.click();
  await page.locator('input[type="password"]:visible').first().fill(password);
  // The classic hosted UI renders duplicate hidden forms; submit the visible one.
  await page.locator('input[name="signInSubmitButton"]:visible, button[type="submit"]:visible').first().click();
  await page.waitForURL((u) => u.origin === new URL(cloudBase!).origin && !u.pathname.startsWith('/api/auth'), { timeout: 30000 });
  return page;
}

/** Switch tenant off-page: a live page whose tenant switches underneath it signs out. */
export async function cloudUseTenant(page: Page, tenant: string): Promise<void> {
  const me = await (await page.request.get('/api/session/me')).json();
  if (me.tenant === tenant) return;
  await page.goto('about:blank');
  const switched = await page.request.post('/api/session/tenant', { data: { tenant } });
  expect(switched.status(), await switched.text()).toBe(200);
}
