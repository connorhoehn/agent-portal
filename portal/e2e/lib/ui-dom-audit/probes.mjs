/**
 * Read-only interaction probes. A state's `enter(page, { probes })` calls one
 * and returns its result; the runner hands that result to `measureDOM` as
 * `probe`, where the `record-popout` and `selection-shift` rules judge it.
 *
 * Every probe blocks each non-GET/HEAD/OPTIONS request while it runs and
 * reports what it stopped (`blockedWrites`): activating a row or toggling a
 * selection must never change business state.
 */
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
const INTERACTIVE = 'a[href], button, input, select, textarea, label, [role="button"], [role="checkbox"], [role="link"], [role="menuitem"], [contenteditable="true"], [tabindex]:not([tabindex="-1"])';

async function readOnly(page, run) {
  const blockedWrites = [];
  const guard = route => {
    const request = route.request();
    if (SAFE.has(request.method())) return route.fallback();
    blockedWrites.push(`${request.method()} ${new URL(request.url()).pathname}`);
    return route.abort('blockedbyclient');
  };
  await page.route('**/*', guard);
  try { return { ...(await run()), blockedWrites }; }
  finally { await page.unroute('**/*', guard); }
}

/** Wait (bounded) for the URL to change or a dialog-like surface to appear. */
async function settle(page, beforeUrl, timeout) {
  await page.waitForFunction(before => location.href !== before
    || [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], dialog[open], [data-ui-dialog]')].some(el => el.getBoundingClientRect().width > 0),
  beforeUrl, { timeout }).catch(() => undefined);
  // Leave the pointer off the activated row so a hover preview cannot pose as a popout.
  await page.mouse.move(1, 1);
}

/**
 * Activate a visible body row of the first matching collection table:
 * a focusable row is clicked on a cell that holds no control of its own (never
 * a selection checkbox or row action); a row that is not focusable but carries a
 * link is opened through that link. `via: 'enter'` focuses the row and presses Enter.
 */
export async function activateRow(page, { rows, via = 'click', attempts = 3, timeout = 4000 }) {
  return readOnly(page, async () => {
    const all = page.locator(rows);
    await all.first().waitFor({ state: 'visible', timeout });
    const beforeUrl = page.url();
    // The first row may already be the open record (a page that preselects
    // one): activating it changes nothing. Try the next rows, at most
    // `attempts`, and report the first activation that did something.
    const count = Math.min(attempts, await all.count());
    let result;
    for (let n = 0; n < count; n++) {
      const row = all.nth(n);
      if (!(await row.isVisible())) continue;
      const target = await row.evaluate((tr, interactive) => {
        const cells = [...tr.children].filter(td => td.matches('td, th'));
        const plain = cells.findIndex(td => !td.querySelector(interactive) && td.textContent.trim());
        const focusable = tr.tabIndex >= 0 || ['link', 'button'].includes(tr.getAttribute('role'));
        if (!focusable && tr.querySelector('td a[href]')) return { mode: 'link' };
        return { mode: focusable ? 'row' : 'inert-row', cell: plain < 0 ? 0 : plain };
      }, INTERACTIVE);
      const text = (await row.innerText()).replace(/\s+/g, ' ').trim().slice(0, 80);
      const urlBefore = page.url();
      if (target.mode === 'link') await row.locator('td a[href]').first().click();
      else if (via === 'enter' && target.mode === 'row') { await row.focus(); await page.keyboard.press('Enter'); }
      else await row.locator(':scope > td, :scope > th').nth(target.cell).click();
      await settle(page, urlBefore, timeout);
      result = { kind: 'row-activation', trigger: 'row', via: target.mode === 'link' ? 'link' : via, row: text, attempt: n + 1, beforeUrl, afterUrl: page.url() };
      const opened = await page.evaluate(() => [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], dialog[open], [data-ui-dialog]')].some(el => el.getBoundingClientRect().width > 0));
      if (page.url() !== beforeUrl || opened) break;
    }
    return result;
  });
}

/**
 * Press a record-detail action (Revision history, Details, History …) inside
 * `scope`. `candidates` (CSS) narrows which buttons qualify — e.g. not a rail's
 * disclosure heading that happens to be named "History".
 */
export async function recordAction(page, { scope = 'body', name, candidates, timeout = 4000 }) {
  return readOnly(page, async () => {
    let match = page.locator(scope).getByRole('button', { name });
    if (candidates) match = match.and(page.locator(candidates));
    const button = match.first();
    await button.waitFor({ state: 'visible', timeout });
    const label = (await button.getAttribute('aria-label')) ?? (await button.innerText()).trim();
    const beforeUrl = page.url();
    await button.click();
    await settle(page, beforeUrl, timeout);
    return { kind: 'row-activation', trigger: 'record-action', label, beforeUrl, afterUrl: page.url() };
  });
}

/**
 * Check, measure, then uncheck the first visible row-selection checkbox and
 * measure again: the table's top edge and its first body row must not move.
 */
export async function toggleSelection(page, { checkbox, timeout = 4000 }) {
  return readOnly(page, async () => {
    const box = page.locator(checkbox).first();
    await box.waitFor({ state: 'visible', timeout });
    const geometry = () => box.evaluate(input => {
      const table = input.closest('table');
      const row = table?.querySelector('tbody > tr');
      if (!table || !row) throw new Error('Selection checkbox is not inside a table body');
      const t = table.getBoundingClientRect(), r = row.getBoundingClientRect();
      const round = v => Math.round(v * 100) / 100;
      return { tableTop: round(t.top), rowTop: round(r.top), rowBottom: round(r.bottom), rowLeft: round(r.left), checked: input.checked ?? input.getAttribute('aria-checked') === 'true' };
    });
    const frames = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    const before = await geometry();
    await box.click(); await frames();
    const during = await geometry();
    await box.click(); await frames();
    const after = await geometry();
    return { kind: 'selection', before, during, after, toggled: during.checked !== before.checked && after.checked === before.checked };
  });
}

// ── Deep-audit probes (references/deep-audit.md) ──────────────────────────
/** Triggers that open a layer: popups first, then disclosures. Never one whose name implies a write or a call. */
export const LAYER_TRIGGERS = '[aria-haspopup]:not([aria-haspopup="false"]):not([disabled]):not([aria-disabled="true"]), button[aria-expanded="false"]:not([disabled]), [role="button"][aria-expanded="false"], summary';
export const UNSAFE_NAME = /\b(call|huddle|join|start|run|send|post|delete|remove|approve|reject|deny|dispatch|archive|leave|invite|publish|submit|sign ?out|log ?out|revoke|grant|merge|deploy|retry|cancel|reset|save|create|new|record|share|upload|pay|buy|switch tenant|masquerade|impersonat)/i;
const LAYERS = '[role="dialog"], [role="alertdialog"], dialog[open], [data-ui-dialog], [role="menu"], [role="listbox"], [role="tooltip"], [data-ui-listbox]';
const frames = page => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));

/** Every visible layer currently open, with a stable index. */
const openLayers = page => page.evaluate(sel => [...document.querySelectorAll(sel)].filter(el => { const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0 && getComputedStyle(el).visibility !== 'hidden'; }).map(el => el.outerHTML.length + ':' + (el.getAttribute('role') ?? el.tagName)), LAYERS);

/**
 * Enumerate what a deep pass can open on this page without writing: layer
 * triggers, tablists, and icon-only buttons that show a tooltip on hover.
 * `global` marks a trigger in shell chrome (header/footer/primary rail), so a
 * runner can audit it once per actor rather than on every route.
 */
export async function discoverDeep(page, { chrome = 'header, footer, [data-shell-nav] > aside, nav[aria-label="Primary"]', maxLayers = 6, maxTablists = 3 } = {}) {
  return page.evaluate(({ TRIG, UNSAFE, chrome, maxLayers, maxTablists }) => {
    const unsafe = new RegExp(UNSAFE.source, UNSAFE.flags);
    const vis = el => { const b = el.getBoundingClientRect(), s = getComputedStyle(el); return b.width > 0 && b.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && b.bottom > 0 && b.top < innerHeight && (typeof el.checkVisibility !== 'function' || el.checkVisibility()); };
    const name = el => (el.getAttribute('aria-label') || el.textContent || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    const all = [...document.querySelectorAll(TRIG)];
    const seen = new Set(), triggers = [];
    for (const [index, el] of all.entries()) {
      if (!vis(el) || el.closest('a[href]') && !el.matches('summary')) continue;
      const n = name(el); if (!n || unsafe.test(n)) continue;
      const key = (el.getAttribute('role') ?? el.tagName) + '|' + n;
      if (seen.has(key)) continue; seen.add(key);
      triggers.push({ index, name: n, popup: el.getAttribute('aria-haspopup') ?? (el.matches('summary') ? 'disclosure' : 'expanded'), global: !!el.closest(chrome) });
    }
    triggers.sort((a, b) => Number(b.popup !== 'expanded' && b.popup !== 'disclosure') - Number(a.popup !== 'expanded' && a.popup !== 'disclosure'));
    const lists = [...document.querySelectorAll('[role="tablist"]')];
    const tablists = lists.map((el, index) => ({ index, name: name(el.getAttribute('aria-label') ? el : (el.closest('[aria-label]') ?? el)) || `tablist ${index + 1}`, tabs: [...el.querySelectorAll('[role="tab"]')].filter(vis).length, global: !!el.closest(chrome), visible: vis(el) })).filter(t => t.visible && t.tabs >= 2).slice(0, maxTablists);
    return { triggers: triggers.slice(0, maxLayers), tablists };
  }, { TRIG: LAYER_TRIGGERS, UNSAFE: { source: UNSAFE_NAME.source, flags: UNSAFE_NAME.flags }, chrome, maxLayers, maxTablists });
}

/**
 * Open one layer trigger (found again by index and name on the fresh page),
 * check focus moves in, Escape closes it and focus returns, then open it again
 * and mark the opened layer `data-audit-layer` for the `layer` rule.
 */
export async function openLayer(page, { index, name, timeout = 3000 }) {
  return readOnly(page, async () => {
    const found = page.locator(LAYER_TRIGGERS);
    let trigger = found.nth(index);
    const label = async t => ((await t.getAttribute('aria-label')) || (await t.textContent()) || (await t.getAttribute('title')) || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!(await trigger.count()) || (await label(trigger)) !== name) {
      const count = await found.count(); trigger = null;
      for (let i = 0; i < count; i++) { const t = found.nth(i); if ((await t.isVisible()) && (await label(t)) === name) { trigger = t; break; } }
      if (!trigger) return { kind: 'layer', trigger: name, opened: false, reason: 'trigger not found on the fresh page' };
    }
    const urlBefore = page.url();
    const before = new Set(await openLayers(page));
    const marker = await trigger.evaluate(el => { el.setAttribute('data-audit-trigger', ''); return el.getAttribute('aria-haspopup'); });
    const open = async () => {
      await trigger.click({ timeout });
      await page.waitForFunction(({ sel, n }) => [...document.querySelectorAll(sel)].filter(el => { const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0; }).length > n || document.querySelector('[data-audit-trigger]')?.getAttribute('aria-expanded') === 'true', { sel: LAYERS, n: before.size }, { timeout }).catch(() => undefined);
      await frames(page);
    };
    await open();
    if (new URL(page.url()).pathname !== new URL(urlBefore).pathname) return { kind: 'layer', trigger: name, opened: false, reason: `navigated to ${new URL(page.url()).pathname}` };
    const find = () => page.evaluate(({ sel, before }) => {
      const els = [...document.querySelectorAll(sel)].filter(el => { const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0 && getComputedStyle(el).visibility !== 'hidden'; });
      const fresh = els.filter(el => !before.includes(el.outerHTML.length + ':' + (el.getAttribute('role') ?? el.tagName)));
      const layer = (fresh.length ? fresh : []).filter(el => !fresh.some(o => o !== el && o.contains(el)))[0] ?? null;
      document.querySelectorAll('[data-audit-layer]').forEach(n => n.removeAttribute('data-audit-layer'));
      if (layer) layer.setAttribute('data-audit-layer', '');
      const trig = document.querySelector('[data-audit-trigger]');
      const disclosure = !layer && (trig?.getAttribute('aria-expanded') === 'true' || (trig?.matches('summary') && trig.parentElement?.open === true));
      const a = document.activeElement;
      const triggerFocus = layer?.getAttribute('data-ui-focus') === 'trigger' && layer.getAttribute('aria-modal') === 'false' && !!layer.id && trig?.getAttribute('aria-controls') === layer.id && (trig?.getAttribute('aria-describedby') ?? '').split(/\s+/).includes(layer.id);
      return { triggerFocus, focusOnTrigger: a === trig || !!trig?.contains(a), found: !!layer, role: layer ? (layer.getAttribute('role') ?? layer.getAttribute('data-ui-dialog') ?? layer.tagName.toLowerCase()) : disclosure ? 'disclosure' : null, focusInside: !!layer && layer.contains(a), focus: a ? (a.getAttribute('aria-label') || a.tagName.toLowerCase()) : 'body' };
    }, { sel: LAYERS, before: [...before] });
    const first = await find();
    if (!first.found) return { kind: 'layer', trigger: name, role: first.role, opened: first.role === 'disclosure', disclosure: first.role === 'disclosure', reason: 'no layer appeared' };
    // A listbox may keep focus on its combobox (aria-activedescendant, the select-only combobox pattern);
    // a dialog or menu takes it.
    const focusExpected = !first.triggerFocus && (/^(dialog|alertdialog|menu)$/.test(first.role) || (/^(dialog|menu|true)$/.test(marker ?? '') && !/^(tooltip|popover|listbox)$/.test(first.role)));
    await page.keyboard.press('Escape'); await frames(page);
    const after = await page.evaluate(() => { const l = document.querySelector('[data-audit-layer]'); const b = l?.getBoundingClientRect(); const a = document.activeElement; return { open: !!l && l.isConnected && b.width > 0 && b.height > 0 && getComputedStyle(l).visibility !== 'hidden', returned: !!a && a !== document.body && (!!a.closest('[data-audit-trigger]') || !!a.querySelector(':scope > [data-audit-trigger]')), focus: a ? (a.getAttribute('aria-label') || a.tagName.toLowerCase()) : 'body' }; });
    if (after.open) await page.mouse.click(2, 2).catch(() => undefined);
    await open();
    const again = await find();
    return { kind: 'layer', trigger: name, role: first.role, opened: again.found, focusExpected, triggerFocus: first.triggerFocus, focusOnTrigger: first.focusOnTrigger && again.focusOnTrigger, focusInside: first.focusInside, focusAfterOpen: first.focus, escapeCloses: !after.open, focusReturned: after.returned, focusAfterEscape: after.focus };
  });
}

/** Hover an element and report whether a role=tooltip appeared (and mark it). */
export async function hoverTooltip(page, { index, name, selector, timeout = 1500 }) {
  return readOnly(page, async () => {
    const el = page.locator(selector).nth(index);
    if (!(await el.count())) return { kind: 'layer', trigger: name, opened: false, reason: 'trigger not found' };
    await el.hover();
    const shown = await page.waitForSelector('[role="tooltip"]', { state: 'visible', timeout }).then(() => true).catch(() => false);
    if (!shown) return { kind: 'layer', trigger: name, role: 'tooltip', opened: false, reason: 'no tooltip on hover' };
    await page.evaluate(() => { const t = [...document.querySelectorAll('[role="tooltip"]')].find(n => n.getBoundingClientRect().width > 0); t?.setAttribute('data-audit-layer', ''); });
    await page.keyboard.press('Escape'); await frames(page);
    const closes = await page.evaluate(() => { const t = document.querySelector('[data-audit-layer]'); return !t || !t.isConnected || t.getBoundingClientRect().width === 0; });
    await page.mouse.move(1, 1); await el.hover();
    await page.waitForSelector('[role="tooltip"]', { state: 'visible', timeout }).catch(() => undefined);
    await page.evaluate(() => { document.querySelectorAll('[data-audit-layer]').forEach(n => n.removeAttribute('data-audit-layer')); const t = [...document.querySelectorAll('[role="tooltip"]')].find(n => n.getBoundingClientRect().width > 0); t?.setAttribute('data-audit-layer', ''); });
    return { kind: 'layer', trigger: name, role: 'tooltip', opened: true, focusExpected: false, escapeCloses: closes };
  });
}

/**
 * Press Tab through the first `count` focusables from the top of the page;
 * for each, record whether it is visible and whether anything about it (or
 * its two nearest ancestors) changes between focused and blurred.
 */
export async function focusWalk(page, { count = 20 } = {}) {
  return readOnly(page, async () => {
    await page.evaluate(() => {
      const previous = document.body.getAttribute('tabindex');
      document.body.tabIndex = -1; document.body.focus();
      if (previous == null) document.body.removeAttribute('tabindex'); else document.body.setAttribute('tabindex', previous);
      window.scrollTo(0, 0);
    });
    const total = await page.evaluate(() => [...document.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]')].filter(el => (el.tabIndex >= 0 || el.matches('[contenteditable="true"]:not([tabindex="-1"])')) && !el.closest('[inert]') && getComputedStyle(el).visibility !== 'hidden' && el.getBoundingClientRect().width > 0).length);
    const steps = [];
    const snap = () => page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body || el === document.documentElement) return null;
      if (!el.hasAttribute('data-audit-focus')) el.setAttribute('data-audit-focus', String(document.querySelectorAll('[data-audit-focus]').length));
      const style = n => { const s = getComputedStyle(n); return [s.outlineStyle, s.outlineWidth, s.outlineColor, s.boxShadow, s.borderColor, s.backgroundColor, s.color, s.textDecorationLine].join('|'); };
      const chain = [el, el.parentElement, el.parentElement?.parentElement].filter(Boolean);
      const b = el.getBoundingClientRect(), s = getComputedStyle(el);
      const visible = b.width > 1 && b.height > 1 && b.bottom > 0 && b.right > 0 && b.top < innerHeight && b.left < innerWidth && s.visibility !== 'hidden' && s.opacity !== '0' && s.clipPath !== 'inset(50%)' && s.clip.replace(/\s/g, '') !== 'rect(0px,0px,0px,0px)';
      const outline = s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0;
      return { id: el.getAttribute('data-audit-focus'), focused: chain.map(style), outline, visible, name: (el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || '').replace(/\s+/g, ' ').trim().slice(0, 40), selector: el.tagName.toLowerCase() + (el.getAttribute('role') ? `[role=${el.getAttribute('role')}]` : '') + (el.getAttribute('data-testid') ? `[data-testid=${el.getAttribute('data-testid')}]` : '') };
    });
    const blurred = id => page.evaluate(id => { const el = document.querySelector(`[data-audit-focus="${id}"]`); if (!el) return null; const style = n => { const s = getComputedStyle(n); return [s.outlineStyle, s.outlineWidth, s.outlineColor, s.boxShadow, s.borderColor, s.backgroundColor, s.color, s.textDecorationLine].join('|'); }; return [el, el.parentElement, el.parentElement?.parentElement].filter(Boolean).map(style); }, id);
    let previous = null;
    for (let i = 1; i <= Math.min(count, total); i++) {
      await page.keyboard.press('Tab'); await frames(page);
      const now = await snap();
      if (previous && !previous.done) { const off = await blurred(previous.id); previous.step.indicator = previous.outline || !off || off.some((v, k) => v !== previous.focused[k]); previous.done = true; }
      if (!now) { steps.push({ step: i, lost: true, after: previous?.step?.name ?? null }); previous = null; continue; }
      const step = { step: i, lost: false, visible: now.visible, name: now.name, selector: now.selector, indicator: null };
      steps.push(step);
      previous = { ...now, step };
    }
    if (previous && !previous.done) { await page.evaluate(() => document.activeElement?.blur?.()); const off = await blurred(previous.id); previous.step.indicator = previous.outline || !off || off.some((v, k) => v !== previous.focused[k]); }
    return { kind: 'focus-walk', total, steps };
  });
}

/**
 * Click every tab of one tablist in turn (then the first again) and snapshot
 * the geometry of the tablist, its tabs, the blocks before it, its ancestors,
 * the panel's top edge and the shell chrome after each switch.
 */
export async function tabCycle(page, { index, name, chrome = [], panes = 'aside, [role="complementary"], [data-column], [data-column-dock], [data-floating-composer-dock]', settleMs = 400, shoot } = {}) {
  return readOnly(page, async () => {
    const list = page.locator('[role="tablist"]').nth(index);
    if (!(await list.count())) return { kind: 'tabs', tablist: name, snapshots: [], reason: 'tablist not found' };
    await list.evaluate(el => el.setAttribute('data-audit-tablist', ''));
    const snapshot = () => page.evaluate(({ chrome, panes }) => {
      const list = document.querySelector('[data-audit-tablist]');
      const box = (el, withHeight = true) => { const b = el.getBoundingClientRect(); return withHeight ? { top: b.top, left: b.left, width: b.width, height: b.height } : { top: b.top, left: b.left, width: b.width }; };
      const regions = {};
      if (!list) return { regions, tab: null };
      regions.tablist = box(list);
      [...list.querySelectorAll('[role="tab"]')].forEach((t, i) => { const b = t.getBoundingClientRect(); if (b.width > 0) regions[`tab ${i + 1}`] = { top: b.top, height: b.height }; });
      // Blocks before the tablist (and before each ancestor, three levels up).
      for (let n = list, k = 0; n && k < 3; n = n.parentElement, k++) { const prev = n.previousElementSibling; if (prev && prev.getBoundingClientRect().height > 0) regions[`above ${k + 1}`] = box(prev); }
      // Ancestors: always position and width; height only for frames (panes, scrollers, fixed/sticky boxes).
      let depth = 0;
      for (let n = list.parentElement; n && n !== document.body && depth < 12; n = n.parentElement, depth++) {
        const s = getComputedStyle(n);
        const frame = n.matches(panes) || /^(auto|scroll|hidden)$/.test(s.overflowY) || /fixed|sticky/.test(s.position);
        regions[`ancestor ${depth + 1}${frame ? ' (frame)' : ''}`] = box(n, frame);
      }
      // The panel's top edge: the controlled panel of the selected tab, else the tablist's next sibling.
      const sel = list.querySelector('[role="tab"][aria-selected="true"]');
      const panel = (sel?.getAttribute('aria-controls') && document.getElementById(sel.getAttribute('aria-controls'))) || list.nextElementSibling;
      if (panel && panel.getBoundingClientRect().height > 0) regions['panel top'] = { top: panel.getBoundingClientRect().top };
      chrome.forEach(c => { try { document.querySelectorAll(c).forEach((el, i) => { if (el.getBoundingClientRect().height > 0 && !el.contains(list)) regions[`chrome ${c.slice(0, 40)} ${i + 1}`] = box(el); }); } catch {} });
      document.querySelectorAll(panes).forEach((el, i) => { if (el.getBoundingClientRect().height > 0 && !el.contains(list) && !list.contains(el)) regions[`pane ${el.getAttribute('data-testid') ?? el.tagName.toLowerCase()} ${i + 1}`] = box(el); });
      return { regions, tab: (sel?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40) };
    }, { chrome, panes });
    const settle = async () => { await frames(page); await page.waitForFunction(() => !document.querySelector('[aria-busy="true"], [data-testid="loading-state"]'), null, { timeout: 3000 }).catch(() => undefined); await page.waitForTimeout(settleMs); await frames(page); };
    const urlBefore = new URL(page.url()).pathname;
    const shot = async (s, i) => { if (shoot) s.shot = await shoot(String(i)); return s; };
    const snapshots = [await shot(await snapshot(), 0)];
    const tabs = list.locator('[role="tab"]');
    const count = await tabs.count();
    const order = [...Array(count).keys()];
    const selected = await tabs.evaluateAll(els => els.findIndex(el => el.getAttribute('aria-selected') === 'true'));
    for (const i of [...order.filter(i => i !== selected), selected >= 0 ? selected : 0]) {
      const tab = tabs.nth(i);
      if (!(await tab.isVisible()) || await tab.isDisabled().catch(() => false)) continue;
      await tab.click({ timeout: 3000 }).catch(() => undefined);
      await settle();
      if (new URL(page.url()).pathname !== urlBefore) { snapshots.push({ regions: {}, tab: 'navigated away' }); break; }
      const s = await snapshot();
      if (!s.tab) break;
      snapshots.push(await shot(s, snapshots.length));
    }
    return { kind: 'tabs', tablist: name, snapshots };
  });
}

/**
 * Data-state interception in the audit's own browser context (read-only to
 * the shared stack): rewrite GET responses of the app's data API to render
 * the page empty, failing, still loading, with long text, with many rows or
 * with every capability denied.
 */
export async function interceptData(page, { mode, include = '/api/', exclude = [], permissions } = {}) {
  const stats = { intercepted: 0, urls: [], blockedWrites: [] }, held = [];
  const skip = url => exclude.some(x => new RegExp(x).test(url));
  const LONG = 'Extraordinarily-long-name segment that keeps going well past eighty characters to test truncation';
  const longEmail = 'a.really.long.mailbox.name.for.layout.testing@subdomain.example-organisation.com';
  const transform = (value, key = '') => {
    if (Array.isArray(value)) {
      if (mode === 'empty') return [];
      if (mode === 'many' && value.length && typeof value[0] === 'object' && value[0]) return Array.from({ length: 60 }, (_, i) => { const v = value[i % value.length]; if (i < value.length) return transform(v); const copy = transform(JSON.parse(JSON.stringify(v))); for (const k of Object.keys(copy)) if (/^(id|key|slug)$/i.test(k) && typeof copy[k] === 'string') copy[k] = `${copy[k]}-audit${i}`; return copy; });
      return value.map(v => transform(v, key));
    }
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, transform(v, k)]));
    if (mode === 'long' && typeof value === 'string' && /(name|title|label|subject|summary|headline|email)$/i.test(key) && value.length < 80) return /@/.test(value) || /email/i.test(key) ? longEmail : `${value} ${LONG}`.slice(0, 96);
    if (mode === 'denied' && typeof value === 'boolean') return false;
    return value;
  };
  let released = false;
  // A response can arrive after the state is released (the page navigated on); a route settled
  // twice must never throw inside the page's context, so every settle is guarded.
  const handler = async route => { try { await handle(route); } catch { await route.fallback().catch(() => undefined); } };
  const handle = async route => {
    if (released) return route.fallback();
    const request = route.request(), url = request.url();
    const path = new URL(url).pathname;
    // A data state is read-only like every probe: a page reacting to an injected failure or a
    // denied capability (a logout, a tenant switch, a retry that writes) must not reach the server.
    if (!SAFE.has(request.method())) { stats.blockedWrites.push(`${request.method()} ${path}`); return route.abort('blockedbyclient'); }
    // `denied` rewrites only the permissions endpoint (which an ordinary exclusion of session routes would skip).
    const target = mode === 'denied' ? !!permissions && new RegExp(permissions).test(path) : path.includes(include) && !skip(path);
    if (request.method() !== 'GET' || !target || !['fetch', 'xhr'].includes(request.resourceType())) return route.fallback();
    stats.intercepted++; if (stats.urls.length < 20) stats.urls.push(path);
    if (mode === 'error') return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'audit_injected_failure' }) });
    if (mode === 'loading') { held.push(route); return; }
    const response = await route.fetch().catch(() => null);
    if (released) return route.fallback();
    if (!response) return route.abort();
    const type = response.headers()['content-type'] ?? '';
    if (!type.includes('json')) return route.fulfill({ response });
    let body; try { body = await response.json(); } catch { return route.fulfill({ response }); }
    return route.fulfill({ response, contentType: 'application/json', body: JSON.stringify(transform(body)) });
  };
  await page.route('**/*', handler);
  return {
    stats,
    async release() { released = true; await page.unroute('**/*', handler).catch(() => undefined); for (const r of held.splice(0)) await r.abort().catch(() => undefined); },
  };
}

export const probes = { activateRow, recordAction, toggleSelection, openLayer, hoverTooltip, focusWalk, tabCycle, interceptData, discoverDeep };
