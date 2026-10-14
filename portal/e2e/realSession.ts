import { expect, request as playwrightRequest, test, type APIRequestContext, type Browser, type BrowserContext, type BrowserContextOptions, type Page } from '@playwright/test';
import { seedPreJoin, type PreJoinMode } from './preJoin';

// THE way a spec signs in (audit 2026-10-07 T1): every spec reaches a session
// through this file, never by POSTing /api/session/login itself — the
// component-discipline judge refuses a spec that does. Real picker logins
// against the BFF, no mocked session.
//
//   loginAs(context, user)          a context as `user`, reusing a still-valid cookie of this worker's
//   signIn(pageOrContext, user, o)  a FRESH login on that context's cookie jar, then optional tenant/role switch
//   demoSession(pageOrContext, o)   the cookie-less demo persona, switched into a tenant/role
//   openAs(browser, user, o)        a fresh context per identity: page, page errors, /api/social requests
//   openAsClone(browser, persona, o) openAs as a fresh dev:mock CLONE of a seed persona (own session epoch)
//   withMockScope(context, scenario) this context alone sees a scoped dev:mock world (never the shared one)
//
// Browser contexts remain isolated. Cookies stay in worker memory and out of
// acceptance artifacts. A tenant or role switch bumps the user's session epoch
// (it revokes that user's other cookies within 120s), so a switched session is
// never cached for reuse.
const sessions = new Map<string, Awaited<ReturnType<BrowserContext['cookies']>>>();

export type Principal = { sub: string; tenant: string; role: string; grants?: Record<string, string[]> };
type Target = Page | BrowserContext;
const requestOf = (t: Target): APIRequestContext => t.request;
const contextOf = (t: Target): BrowserContext => ('context' in t && typeof t.context === 'function' ? (t as Page).context() : t as BrowserContext);

/**
 * POST /api/session/login with the throttle's bounded retry (429 names its
 * Retry-After, ≤60s, and the test's timeout grows by that much) and two more
 * attempts when the BFF is mid-restart (`tsx watch` rebuilding after an edit).
 */
async function postLogin(request: APIRequestContext, userId: string) {
  let response = await request.post('/api/session/login', { data: { userId } });
  for (let attempt = 1; attempt <= 2 && response.status() !== 200; attempt++) {
    let delay: number;
    if (response.status() === 429) {
      const seconds = Number(response.headers()['retry-after']);
      expect(seconds, 'login throttle must supply its bounded retry interval').toBeGreaterThan(0);
      expect(seconds).toBeLessThanOrEqual(60);
      delay = seconds * 1_000 + 100;
    } else delay = 5_000 * attempt;
    test.info().setTimeout(test.info().timeout + delay + 1_000);
    await new Promise((resolve) => setTimeout(resolve, delay));
    response = await request.post('/api/session/login', { data: { userId } });
  }
  expect(response.status(), `real picker login as ${userId}`).toBe(200);
}

async function me(request: APIRequestContext): Promise<Principal> {
  const principal = await request.get('/api/session/me');
  expect(principal.status()).toBe(200);
  return principal.json() as Promise<Principal>;
}

async function switchTo(request: APIRequestContext, kind: 'tenant' | 'role', value: string) {
  const response = await request.post(`/api/session/${kind}`, { data: { [kind]: value } });
  expect(response.status(), `switch ${kind} to ${value}`).toBe(200);
}

export async function loginAs(context: BrowserContext, userId: string, baseURL?: string, fresh = false, preJoin: PreJoinMode = 'remembered') {
  await seedPreJoin(context, preJoin);
  const key = `${baseURL ?? ''}:${userId}`, cookies = sessions.get(key);
  if (!fresh && cookies) {
    await context.addCookies(cookies);
    const response = await context.request.get('/api/session/me');
    if (response.ok()) {
      const principal = await response.json();
      if (principal.sub === userId && principal.tenant === 'orgiq') return;
    }
  }
  await postLogin(context.request, userId);
  expect((await me(context.request)).sub).toBe(userId);
  sessions.set(key, await context.cookies());
}

export interface SignInOptions {
  /** Switch into this tenant after login (a session-epoch bump). */
  tenant?: string;
  /** Switch to this role after login (a session-epoch bump). */
  role?: string;
  /** Assert the landing tenant without switching (a user's home tenant). */
  expectTenant?: string;
  /** Assert the landing role without switching. */
  expectRole?: string;
}

/** A fresh login on the target's cookie jar (a page shares its context's), then the asked-for switches. */
export async function signIn(target: Target, userId: string, opts: SignInOptions = {}): Promise<Principal> {
  const request = requestOf(target);
  await postLogin(request, userId);
  if (opts.tenant) await switchTo(request, 'tenant', opts.tenant);
  if (opts.role) await switchTo(request, 'role', opts.role);
  const principal = await me(request);
  expect(principal.sub, 'signed-in principal').toBe(userId);
  const tenant = opts.tenant ?? opts.expectTenant, role = opts.role ?? opts.expectRole;
  if (tenant) expect(principal.tenant, 'signed-in tenant').toBe(tenant);
  if (role) expect(principal.role, 'signed-in role').toBe(role);
  return principal;
}

/** The cookie-less demo persona (never in the picker), switched into a tenant and optionally a role. */
export async function demoSession(target: Target, opts: { tenant: string; role?: string }): Promise<Principal> {
  const request = requestOf(target);
  await switchTo(request, 'tenant', opts.tenant);
  if (opts.role) await switchTo(request, 'role', opts.role);
  const principal = await me(request);
  expect(principal.sub, 'the demo persona').toBe('demo-user');
  return principal;
}

export interface Person {
  context: BrowserContext;
  page: Page;
  /** Uncaught page errors (and console errors with `consoleErrors`). */
  errors: string[];
  /** Pathnames of every /api/social request the page made (with `captureSocial`). */
  social: string[];
  principal: Principal | null;
  close: () => Promise<void>;
}

export interface OpenAsOptions extends SignInOptions {
  baseURL?: string;
  viewport?: { width: number; height: number };
  /** Anything else for browser.newContext (permissions, media flags…). */
  contextOptions?: BrowserContextOptions;
  /** Where the page sits while it signs in (default '/': same-origin, so a spec's in-page fetch works). null stays on about:blank. */
  landing?: string | null;
  /** Opened after sign-in. */
  url?: string;
  /** Seed the remembered pre-join choice ('remembered'), or leave the device check to show ('show', the default here). */
  preJoin?: PreJoinMode;
  consoleErrors?: boolean;
  captureSocial?: boolean;
  /** Runs on the new context before anything loads (routes, init scripts). */
  prepare?: (context: BrowserContext) => Promise<void>;
  /** null: no sign-in — the cookie-less demo persona or an anonymous visitor. */
  demo?: { tenant: string; role?: string };
}

/** A fresh browser context per identity, signed in for real. Closes the context if anything fails. */
export async function openAs(browser: Browser, userId: string | null, opts: OpenAsOptions = {}): Promise<Person> {
  const baseURL = opts.baseURL ?? test.info().project.use.baseURL;
  const context = await browser.newContext({ ...opts.contextOptions, baseURL, ...(opts.viewport ? { viewport: opts.viewport } : {}) });
  try {
    if (opts.preJoin === 'remembered') await seedPreJoin(context, 'remembered');
    await opts.prepare?.(context);
    const page = await context.newPage();
    const errors: string[] = [];
    const social: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    if (opts.consoleErrors) page.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test(m.text())) errors.push(m.text()); });
    if (opts.captureSocial) page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/api/social')) social.push(u.pathname); });
    if (opts.landing !== null) await page.goto(opts.landing ?? '/');
    let principal: Principal | null = null;
    if (userId) principal = await signIn(page, userId, opts);
    else if (opts.demo) principal = await demoSession(page, opts.demo);
    if (opts.url) await page.goto(opts.url);
    return { context, page, errors, social, principal, close: () => context.close() };
  } catch (error) { await context.close(); throw error; }
}

// ── dev:mock isolation (docs/mock-floor.md § Scopes and clones) ─────────────
//
// A clone is a user minted from a seed persona — same grants, person link and
// name, its own id and session epoch — so two runs "as u-vera" never revoke
// each other. A scope is a dev:mock world only one browser context sees
// (`empty`, `error`, `long-text`, `many`, `loading`, …); writes made inside it
// never reach the shared fixtures. Both exist only on a non-production mock
// BFF, and both are removed by `POST /api/__mock/reset`.

const mockControlHeaders = (): Record<string, string> =>
  process.env.MOCK_CONTROL_SECRET ? { 'x-mock-control-auth': process.env.MOCK_CONTROL_SECRET } : {};

/** Mint a clone of a seed persona; returns the clone's user id (e.g. `u-vera-clone-1a2b3c4d`). */
export async function cloneIdentity(request: APIRequestContext, persona: string, label?: string): Promise<string> {
  const response = await request.post('/api/__mock/identity/clone', { data: { from: persona, ...(label ? { label } : {}) }, headers: mockControlHeaders() });
  expect(response.status(), `clone ${persona} (dev:mock only)`).toBe(201);
  return (await response.json()).clone.id as string;
}

export async function deleteClone(request: APIRequestContext, cloneId: string): Promise<void> {
  await request.delete(`/api/__mock/identity/clone/${encodeURIComponent(cloneId)}`, { headers: mockControlHeaders() }).catch(() => undefined);
}

export type MockScopeScenario = 'default' | 'empty' | 'error' | 'large' | 'fresh' | 'long-text' | 'many' | 'loading';
export interface MockScopeRequest {
  scenario?: MockScopeScenario;
  /** Only this fixture takes `scenario`; the rest of the scope stays `default`. */
  fixture?: string;
  /** Several fixtures, each its own scenario, over `scenario` as the base. */
  fixtures?: Record<string, MockScopeScenario>;
  label?: string;
  ttlMs?: number;
  /** Held before every scoped response (`loading` defaults to 2500, the BFF caps at 10000). */
  delayMs?: number;
}
export interface MockScopeHandle { id: string; dispose: () => Promise<void> }

/**
 * Put this context (and only it) in a scoped dev:mock world. The scope id rides
 * the `orgiq.mock-scope` cookie the BFF sets on this context's jar, so every
 * page request carries it; nothing else changes for any other session.
 */
export async function withMockScope(target: Target, scenario: MockScopeScenario | MockScopeRequest): Promise<MockScopeHandle> {
  const context = contextOf(target);
  const body = typeof scenario === 'string' ? { scenario } : scenario;
  const response = await context.request.post('/api/__mock/scope', { data: body, headers: mockControlHeaders() });
  expect(response.status(), `mock scope ${JSON.stringify(body)} (dev:mock only)`).toBe(201);
  const { scope, cookie } = await response.json() as { scope: { id: string }; cookie: { name: string; value: string } };
  // The Set-Cookie above already landed in this jar; adding it again pins it to
  // the context's own origin in case the BFF answered through another host.
  const base = new URL(response.url());
  await context.addCookies([{ name: cookie.name, value: cookie.value, domain: base.hostname, path: '/', httpOnly: true, sameSite: 'Lax' }]);
  return {
    id: scope.id,
    dispose: async () => {
      await context.request.delete(`/api/__mock/scope/${scope.id}`, { headers: mockControlHeaders() }).catch(() => undefined);
      await context.clearCookies({ name: cookie.name }).catch(() => undefined);
    },
  };
}

export interface OpenAsCloneOptions extends OpenAsOptions {
  /** Shown in GET /api/__mock/identity/clones, for whoever wonders whose clone this is. */
  label?: string;
  /** Also put the context in a scoped world before anything loads. */
  scope?: MockScopeScenario | MockScopeRequest;
}

/**
 * `openAs`, but as a fresh clone of `persona`. A tenant/role switch bumps only
 * the clone's epoch, so any number of these run beside each other and beside a
 * real `openAs(persona)`. `close()` deletes the scope and the clone.
 */
export async function openAsClone(browser: Browser, persona: string, opts: OpenAsCloneOptions = {}): Promise<Person & { cloneId: string; scope: MockScopeHandle | null }> {
  const baseURL = opts.baseURL ?? test.info().project.use.baseURL;
  const api = await playwrightRequest.newContext({ baseURL });
  let cloneId: string | null = null;
  try {
    cloneId = await cloneIdentity(api, persona, opts.label);
    const id = cloneId;
    let scope: MockScopeHandle | null = null;
    const person = await openAs(browser, id, {
      ...opts, baseURL,
      prepare: async (context) => {
        if (opts.scope) scope = await withMockScope(context, opts.scope);
        await opts.prepare?.(context);
      },
    });
    return {
      ...person, cloneId: id, scope,
      close: async () => {
        await (scope as MockScopeHandle | null)?.dispose();
        await deleteClone(api, id);
        await person.close();
        await api.dispose();
      },
    };
  } catch (error) {
    if (cloneId) await deleteClone(api, cloneId);
    await api.dispose();
    throw error;
  }
}
