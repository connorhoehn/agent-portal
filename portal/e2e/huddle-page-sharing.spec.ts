import { loginAs } from './realSession';
import { type Browser, type Page } from '@playwright/test';
import { test, expect } from './cdpTest';

test.use({ viewport: { width: 1440, height: 900 }, ...(process.env.PARITY_BASE_URL ? { baseURL: process.env.PARITY_BASE_URL } : {}) });
test.describe.configure({ mode: 'serial' });

// The BFF, authentication, gateway, call membership and page persistence are
// real. Only unavailable platform media-session receipts are substituted.
// These contracts establish signalling/navigation/sharing, never live media.
async function person(browser: Browser, baseURL: string | undefined, userId: string) {
  const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 } });
  const mediaRequests: string[] = [];
  await context.route('**/api/session/realtime-token', async route => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: { ...body, platformApiUrl: 'http://media-session.test', videoUrl: null } });
  });
  await context.route('http://media-session.test/**', async route => {
    const path = new URL(route.request().url()).pathname;
    mediaRequests.push(path);
    await route.fulfill({ status: 200, contentType: 'application/json', json: path.endsWith('/join')
      ? { participantId: `participant-${userId}`, token: null }
      : path.endsWith('/end') ? { ok: true } : { sessionId: 'signalling-only-session' } });
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await loginAs(context, userId, baseURL, true);
  await page.goto('/iq/projects/p-auth-migration');
  await expect(page.getByTestId('initiative-header')).toBeVisible();
  await expect(page.getByTestId('initiative-start-call')).toBeEnabled({ timeout: 15_000 });
  return { context, page, errors, mediaRequests };
}

async function connect(sender: Page, recipient: Page) {
  await sender.getByTestId('initiative-start-call').click();
  await recipient.getByRole('button', { name: 'Accept', exact: true }).click({ timeout: 15_000 });
  await expect(sender.getByTestId('shell-call-dock')).toBeVisible();
  await expect(recipient.getByTestId('shell-call-dock')).toBeVisible();
}

async function sharingMenu(page: Page) {
  const trigger = page.getByTestId('call-page-sharing-trigger');
  if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click();
  await expect(page.getByTestId('call-page-sharing-popover')).toBeVisible();
}

async function readPin(page: Page, callId: string) {
  const response = await page.request.get(`/api/calls/${encodeURIComponent(callId)}/page`);
  expect(response.status()).toBe(200);
  return response.json();
}

async function leave(page: Page) {
  const dock = page.getByTestId('shell-call-dock');
  if (await dock.count()) {
    const button = dock.getByRole('button', { name: /Leave|Hang up/ }).first();
    if (await button.count()) await button.click();
  }
}

test('a pinned page reaches joined peers, survives shell navigation, and changes only through explicit actions', async ({ browser, baseURL }) => {
  test.setTimeout(90_000);
  const rachel = await person(browser, baseURL, 'u-rachel');
  const vera = await person(browser, baseURL, 'u-vera');
  const nora = await person(browser, baseURL, 'u-nora');
  try {
    await connect(rachel.page, vera.page);
    await sharingMenu(rachel.page);
    await expect(rachel.page.getByTestId('call-page-sharing-share')).toBeEnabled({ timeout: 15_000 });
    const saved = rachel.page.waitForResponse(response => /\/api\/calls\/[^/]+\/page$/.test(response.url()) && response.request().method() === 'PUT');
    await rachel.page.getByTestId('call-page-sharing-share').click();
    const response = await saved;
    expect(response.status()).toBe(200);
    const pin = await response.json();
    expect(pin.page).toMatchObject({ kind: 'initiative', id: 'p-auth-migration', presenter: { userId: 'u-rachel' } });
    await sharingMenu(vera.page);
    await expect(vera.page.getByTestId('call-page-sharing-title')).toHaveText('Auth Migration');
    // An unanswered invite cannot read the call's page despite its Org grant.
    expect((await nora.page.request.get(`/api/calls/${pin.callId}/page`)).status()).toBe(403);

    await rachel.page.getByTestId('call-page-sharing-trigger').click();
    await rachel.page.getByRole('link', { name: 'Settings', exact: true }).click();
    await expect(rachel.page).toHaveURL(/\/settings$/);
    await expect(rachel.page.getByTestId('shell-call-dock')).toBeVisible();
    expect(await readPin(rachel.page, pin.callId)).toMatchObject({ revision: pin.revision, page: { id: 'p-auth-migration' } });
    expect(rachel.mediaRequests.filter(path => path === '/api/video/sessions')).toHaveLength(1);
    expect(rachel.mediaRequests.filter(path => path.endsWith('/end'))).toHaveLength(0);

    await rachel.page.goBack();
    await expect(rachel.page.getByTestId('initiative-header')).toBeVisible();
    await rachel.page.getByText('Logout leaves the legacy shim cookie alive', { exact: true }).first().click();
    await expect(rachel.page).toHaveURL(/item=wi-auth-e2-b3/);
    expect((await readPin(rachel.page, pin.callId)).page.kind).toBe('initiative');
    await sharingMenu(rachel.page);
    await rachel.page.getByTestId('call-page-sharing-share').click();
    await expect(vera.page.getByTestId('call-page-sharing-title')).toHaveText('Logout leaves the legacy shim cookie alive');
    await vera.page.getByTestId('call-page-sharing-open').click();
    await expect(vera.page).toHaveURL(/tab=work&item=wi-auth-e2-b3/);
    await expect(vera.page.getByTestId('work-item-detail')).toBeVisible();
    await rachel.page.getByTestId('call-page-sharing-stop').click();
    await sharingMenu(vera.page);
    await expect(vera.page.getByTestId('call-page-sharing-title')).toHaveCount(0);
    expect(await readPin(vera.page, pin.callId)).toMatchObject({ revision: pin.revision + 2, page: null });
    expect(rachel.errors).toEqual([]); expect(vera.errors).toEqual([]); expect(nora.errors).toEqual([]);
  } finally {
    await leave(rachel.page);
    await Promise.all([rachel.context.close(), vera.context.close(), nora.context.close()]);
  }
});

test('rejected replacement retains the pin and concurrent writers cannot overwrite the same revision', async ({ browser, baseURL }) => {
  test.setTimeout(90_000);
  const rachel = await person(browser, baseURL, 'u-rachel');
  const vera = await person(browser, baseURL, 'u-vera');
  try {
    await connect(rachel.page, vera.page);
    await sharingMenu(rachel.page);
    await expect(rachel.page.getByTestId('call-page-sharing-share')).toBeEnabled({ timeout: 15_000 });
    const saved = rachel.page.waitForResponse(response => /\/api\/calls\/[^/]+\/page$/.test(response.url()) && response.request().method() === 'PUT');
    await rachel.page.getByTestId('call-page-sharing-share').click();
    const pin = await (await saved).json();
    await rachel.page.getByTestId('call-page-sharing-trigger').click();
    await rachel.page.getByText('Logout leaves the legacy shim cookie alive', { exact: true }).first().click();
    await rachel.page.route('**/api/calls/*/page', async route => {
      if (route.request().method() === 'PUT') await route.fulfill({ status: 503, json: { error: 'Page store unavailable' } });
      else await route.continue();
    });
    await sharingMenu(rachel.page);
    await rachel.page.getByTestId('call-page-sharing-share').click();
    await expect(rachel.page.getByTestId('call-page-sharing-error')).toContainText('Page store unavailable');
    await expect(rachel.page.getByTestId('call-page-sharing-title')).toHaveText('Auth Migration');
    expect((await readPin(vera.page, pin.callId)).revision).toBe(pin.revision);
    await rachel.page.unroute('**/api/calls/*/page');

    const path = `/api/calls/${pin.callId}/page`;
    const results = await Promise.all([
      rachel.page.request.put(path, { data: { expectedRevision: pin.revision, page: { kind: 'work-item', id: 'wi-auth-e2-b3' } } }),
      vera.page.request.put(path, { data: { expectedRevision: pin.revision, page: { kind: 'initiative', id: 'p-auth-migration' } } }),
    ]);
    expect(results.map(result => result.status()).sort()).toEqual([200, 409]);
    const winner = await results.find(result => result.status() === 200)!.json();
    const conflict = await results.find(result => result.status() === 409)!.json();
    expect(conflict.snapshot).toEqual(winner);
    expect(await readPin(vera.page, pin.callId)).toEqual(winner);
    expect(rachel.errors).toEqual([]); expect(vera.errors).toEqual([]);
  } finally {
    await leave(rachel.page);
    await Promise.all([rachel.context.close(), vera.context.close()]);
  }
});
