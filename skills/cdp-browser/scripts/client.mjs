import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const localHost = hostname => ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
export function appURL(baseURL, path = '/') {
  const base = new URL(baseURL);
  if (!['http:', 'https:'].includes(base.protocol) || !localHost(base.hostname)) throw new Error('This local-audit client needs a localhost app URL.');
  const url = new URL(path, base);
  if (url.origin !== base.origin) throw new Error(`Navigation left the authorized app origin: ${url.origin}`);
  return url.href;
}

function playwrightAt(packageRoot) {
  const require = createRequire(resolve(packageRoot, 'package.json'));
  try { return require('playwright'); }
  catch { return require('@playwright/test'); }
}

export class CdpAudit {
  constructor(browser, { baseURL, timeoutMs = 5_000 }) {
    this.browser = browser;
    this.baseURL = appURL(baseURL);
    this.timeoutMs = timeoutMs;
    this.actors = new Map();
    this.closed = false;
  }
  static async connect({ endpoint, baseURL, packageRoot = process.cwd(), timeoutMs = 5_000, chromium }) {
    appURL(baseURL);
    const target = new URL(endpoint);
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(target.protocol) || !localHost(target.hostname)) throw new Error('Use an explicitly authorized local CDP endpoint.');
    const driver = chromium ?? playwrightAt(packageRoot).chromium;
    try {
      const browser = await driver.connectOverCDP(endpoint, { timeout: timeoutMs, noDefaults: true });
      return new CdpAudit(browser, { baseURL, timeoutMs });
    } catch (error) {
      throw new Error(`CDP transport unavailable at ${target.origin}: ${error.message}`, { cause: error });
    }
  }
  async actor(name, { viewport = { width: 1440, height: 900 } } = {}) {
    if (this.closed) throw new Error('This audit connection is closed.');
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(name)) throw new Error('Use a short actor ID with letters, digits and hyphens.');
    if (this.actors.has(name)) return this.actors.get(name);
    const context = await this.browser.newContext({ baseURL: this.baseURL, viewport, acceptDownloads: true });
    try {
      context.setDefaultTimeout(this.timeoutMs);
      context.setDefaultNavigationTimeout(this.timeoutMs);
      const page = await context.newPage();
      const actor = new AuditActor(this, name, context, page);
      this.actors.set(name, actor);
      return actor;
    } catch (error) { await context.close(); throw error; }
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    const results = await Promise.allSettled([...this.actors.values()].map(actor => actor.close()));
    this.actors.clear();
    // For an attached Browser, Playwright closes this connection and its
    // created contexts; it does not send a raw CDP Browser.close command.
    await this.browser.close();
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
  }
}

export class AuditActor {
  constructor(audit, name, context, page) {
    this.audit = audit; this.name = name; this.context = context; this.page = page;
    this.errors = []; this.closed = false;
    page.on('pageerror', error => this.errors.push({ kind: 'page', message: error.message }));
    page.on('console', message => { if (message.type() === 'error') this.errors.push({ kind: 'console', message: message.text() }); });
    page.on('response', response => { if (response.status() >= 500) this.errors.push({ kind: 'http', status: response.status(), path: new URL(response.url()).pathname }); });
  }
  assertOrigin() { appURL(this.audit.baseURL, this.page.url()); }
  async goto(path) {
    await this.page.goto(appURL(this.audit.baseURL, path), { waitUntil: 'domcontentloaded' });
    this.assertOrigin();
  }
  locator({ testId, role, name, label }) {
    this.assertOrigin();
    if (testId) return this.page.getByTestId(testId);
    if (role && name) return this.page.getByRole(role, { name, exact: true });
    if (label) return this.page.getByLabel(label, { exact: true });
    throw new Error('Choose an observed testId, role/name pair or label.');
  }
  async click(target) { await this.locator(target).click(); this.assertOrigin(); }
  async fill(target, value) { await this.locator(target).fill(value); }
  async press(target, key) { await this.locator(target).press(key); }
  async snapshot({ limit = 120 } = {}) {
    this.assertOrigin();
    const session = await this.context.newCDPSession(this.page);
    let accessibility;
    try {
      const { nodes } = await session.send('Accessibility.getFullAXTree');
      accessibility = nodes.filter(node => !node.ignored && node.role?.value !== 'generic').slice(0, limit).map(node => ({
        role: node.role?.value, name: node.name?.value,
        ...(node.properties?.length ? { state: Object.fromEntries(node.properties.filter(p => ['disabled', 'expanded', 'selected', 'checked'].includes(p.name)).map(p => [p.name, p.value?.value])) } : {}),
      }));
    } finally { await session.detach(); }
    const elements = await this.page.evaluate(max => [...document.querySelectorAll('button,a[href],input,textarea,select,[contenteditable="true"],[role="tab"],[role="splitter"]')]
      .filter(element => { const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== 'hidden'; })
      .slice(0, max).map(element => {
        const rect = element.getBoundingClientRect();
        return { tag: element.tagName.toLowerCase(), role: element.getAttribute('role'), name: element.getAttribute('aria-label') || element.textContent?.trim().slice(0, 120) || element.getAttribute('placeholder'),
          testId: element.getAttribute('data-testid'), disabled: element.matches(':disabled,[aria-disabled="true"]'),
          rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) } };
      }), limit);
    return { actor: this.name, url: this.page.url(), title: await this.page.title(), accessibility, elements, errors: [...this.errors] };
  }
  async capture(path) {
    this.assertOrigin();
    const output = resolve(path);
    await mkdir(dirname(output), { recursive: true });
    await this.page.screenshot({ path: output, fullPage: false });
    const snapshot = await this.snapshot();
    await writeFile(`${output}.json`, JSON.stringify(snapshot, null, 2) + '\n');
    return { image: output, snapshot: `${output}.json` };
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.context.close();
  }
}
