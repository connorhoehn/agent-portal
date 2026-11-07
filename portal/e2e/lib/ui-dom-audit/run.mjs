import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { measureDOM } from './measure.mjs';
import { probes } from './probes.mjs';
const PLACEHOLDER = /^(?:todo|tbd|n\/?a|none|null|undefined|exempt|not applicable|coming soon|[-?.…]+)[.!?]*$/i;
const hash = x => crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0, 16);

export function validateContract(contract) {
  if (contract.version !== 1 || !Array.isArray(contract.rules) || !contract.rules.length) throw new Error('Contract requires version: 1 and nonempty rules');
  const ids = new Set(), kinds = new Set(['breadcrumb', 'style', 'text', 'box', 'count', 'viewport', 'align', 'within', 'columns', 'table', 'composer', 'composer-presence', 'record-popout', 'row-activatable', 'selection-shift', 'gutter', 'row-start', 'title-count', 'contained', 'sparse-row', 'in-viewport', 'dock-clearance', 'popover-fit', 'surface-distinct', 'text-cramped', 'text-overlap', 'text-clipped', 'placeholder-squeezed', 'panel-inset', 'panel-empty', 'composer-last', 'section-empty', 'fingerprint', 'blank-band', 'table-first', 'narrow-block', 'alignment-grid', 'baseline', 'icon-center', 'scroll-owner', 'content-share', 'content-honesty', 'a11y-names', 'contrast', 'heading-order', 'landmarks', 'composer-readonly', 'layer', 'focus-walk', 'tab-stability', 'data-state', 'geometry-snapshot', 'text-fragmented', 'leading-separator', 'selection-column', 'column-hog', 'marker-first-line']);
  for (const rule of contract.rules) {
    if (!rule.id || ids.has(rule.id) || !kinds.has(rule.kind)) throw new Error('Invalid/duplicate rule: ' + rule.id);
    ids.add(rule.id);
    if ((rule.exclude ?? []).some(e => !e.reason || !e.selector)) throw new Error(`Undocumented exclusion: ${rule.id}`);
    if (rule.deep !== undefined && typeof rule.deep !== 'boolean') throw new Error(`deep must be boolean: ${rule.id}`);
  }
}
export function summarize(cases) {
  const groups = new Map();
  for (const item of cases) for (const issue of item.issues) {
    const key = hash([issue.rule, issue.property, issue.expected, issue.actual]);
    if (!groups.has(key)) groups.set(key, { id: key, rule: issue.rule, owner: issue.owner, property: issue.property, expected: issue.expected, actual: issue.actual, occurrences: 0, routes: new Set(), tenants: new Set(), example: issue.selector });
    const group = groups.get(key); group.occurrences++; group.routes.add(item.route); group.tenants.add(item.tenant);
  }
  return [...groups.values()].map(g => ({ ...g, routes: [...g.routes].sort(), tenants: [...g.tenants].sort() })).sort((a, b) => b.routes.length - a.routes.length || b.occurrences - a.occurrences || a.id.localeCompare(b.id));
}
/** Read and validate a contract file (the shipped work-ui contract when no path is given). */
export function loadContract(file) {
  const contract = JSON.parse(fs.readFileSync(file ?? fileURLToPath(new URL('./work-ui.contract.json', import.meta.url)), 'utf8'));
  validateContract(contract);
  return contract;
}
/** A rule that belongs to the deep audit (contract `deep: true`), judged apart from the resting-state gate. */
export const isDeepRule = (contract, id) => id.startsWith('consistency.') || id === 'theme.parity' ? true : !!contract.rules.find(r => r.id === id)?.deep;
/**
 * Measure the current page once, the way the runner does: pause motion, wait
 * for fonts and two frames, measure twice and report what moved between the
 * two passes. Returns the second measurement plus `stable` and, when unstable,
 * a `coverage.stability` issue naming the moving nodes.
 */
export async function measureCase(page, { contract, selectors, required = [], composerExpectation, probe } = {}) {
  await page.addStyleTag({ content: '*,*::before,*::after { animation-play-state: paused !important; transition-duration: 0s !important; caret-color: transparent !important; }' });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    // A transition already in flight (or a layered !important duration) can
    // survive the style override. Measure its endpoint, as we do with reduced
    // motion, instead of fingerprinting a button's fading background twice.
    // Only CSS transitions finish here; recurring script-driven movement must
    // still fail the two measurements below.
    for (const animation of document.getAnimations()) {
      if (animation instanceof CSSTransition && Number.isFinite(animation.effect?.getComputedTiming().endTime)) animation.finish();
    }
    await new Promise(r => requestAnimationFrame(r));
  });
  const payload = { contract, selectors, required, composerExpectation, probe };
  const first = await page.evaluate(measureDOM, payload);
  // Repeat the same DOM measurement to expose unstable geometry instead
  // of blessing whichever frame happened to pass.
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  const second = await page.evaluate(measureDOM, payload);
  if (hash(first.samples) === hash(second.samples)) return { ...second, stable: true };
  // Name what moved, so an unstable case points at its moving node instead of a bare hash.
  const key = x => `${x.rule}|${x.selector}|${x.property}`, before = new Map(first.samples.map(x => [key(x), JSON.stringify(x.actual)]));
  const after = new Set(second.samples.map(key));
  const fingerprintKey = x => `${x.family}|${x.selector}|${x.key}`;
  const fingerprintsBefore = new Map(first.fingerprints.map(x => [fingerprintKey(x), x]));
  const fingerprintsAfter = new Map(second.fingerprints.map(x => [fingerprintKey(x), x]));
  const movedFingerprints = [...new Set([...fingerprintsBefore.keys(), ...fingerprintsAfter.keys()])].flatMap(k => {
    const a = fingerprintsBefore.get(k), b = fingerprintsAfter.get(k);
    return a?.value === b?.value ? [] : [{ rule: 'consistency.fingerprint', selector: (b ?? a).selector,
      property: `${(b ?? a).family} fingerprint`, first: a ? JSON.parse(a.value) : 'absent', second: b ? JSON.parse(b.value) : 'absent' }];
  });
  const moved = [
    ...second.samples.filter(x => before.get(key(x)) !== JSON.stringify(x.actual)).map(x => ({ rule: x.rule, selector: x.selector, property: x.property, first: before.has(key(x)) ? JSON.parse(before.get(key(x))) : 'absent', second: x.actual })),
    ...first.samples.filter(x => !after.has(key(x))).map(x => ({ rule: x.rule, selector: x.selector, property: x.property, first: x.actual, second: 'absent' })),
    ...movedFingerprints,
  ].slice(0, 6);
  return { ...second, stable: false, issues: [...second.issues, { rule: 'coverage.stability', category: 'coverage', selector: 'document', property: 'measurement hash', expected: hash(first.samples), actual: hash(second.samples), moved }] };
}
const measuredCase = c => c.samples?.length > 0 && !c.issues.some(i => ['coverage', 'runtime'].includes(i.category));
/**
 * Consistency outliers (deep-audit family 1): every `fingerprint` family value
 * seen on each route's resting state, grouped by family, key and width. A value
 * shown by at most `maxShare` of the routes while the majority value is shown
 * by at least `minMajority` routes is an outlier, reported on the deviating
 * routes. `families` lists every family's distinct values for the report.
 */
export function consistencyOutliers(cases, { minRoutes = 4, minMajority = 3, maxShare = 0.2, owner = 'shared UI contract' } = {}) {
  const groups = new Map();
  for (const c of cases) {
    if (c.state !== 'default' || !c.fingerprints?.length || !measuredCase(c)) continue;
    for (const f of c.fingerprints) {
      const key = `${f.family}|${f.key}|${c.width}`;
      if (!groups.has(key)) groups.set(key, { family: f.family, key: f.key, width: c.width, values: new Map() });
      const values = groups.get(key).values;
      if (!values.has(f.value)) values.set(f.value, { routes: new Map() });
      const routes = values.get(f.value).routes;
      if (!routes.has(c.route)) routes.set(c.route, { case: c, selector: f.selector });
    }
  }
  const issues = [], families = [];
  for (const g of groups.values()) {
    const all = new Set([...g.values.values()].flatMap(v => [...v.routes.keys()]));
    const ranked = [...g.values.entries()].map(([value, v]) => ({ value, routes: v.routes })).sort((a, b) => b.routes.size - a.routes.size || a.value.localeCompare(b.value));
    families.push({ family: g.family, key: g.key, width: g.width, routes: all.size, values: ranked.map(r => ({ value: JSON.parse(r.value), routes: r.routes.size, examples: [...r.routes.keys()].slice(0, 5) })) });
    const major = ranked[0];
    if (all.size < minRoutes || ranked.length < 2 || major.routes.size < minMajority) continue;
    for (const minor of ranked.slice(1)) {
      if (minor.routes.size / all.size > maxShare) continue;
      for (const [route, hit] of minor.routes) issues.push({ case: hit.case, issue: {
        rule: `consistency.${g.family}`, category: 'consistency', owner, selector: hit.selector,
        property: `${g.family}${g.key === '*' ? '' : ` (${g.key})`} at ${g.width}px`,
        expected: `${major.value} (${major.routes.size}/${all.size} routes)`, actual: `${minor.value} (${minor.routes.size}/${all.size} routes)`, route } });
    }
  }
  families.sort((a, b) => b.values.length - a.values.length || b.routes - a.routes);
  return { issues, families };
}
/**
 * Theme parity (deep-audit family 9): the same route/state/width measured in
 * light and dark draws the same boxes, and a border visible in one theme is
 * visible in the other. Reported on the second theme's case.
 */
export function themeParity(cases, { tolerance = 1, maxPerCase = 6, owner = 'shared UI contract' } = {}) {
  const key = c => JSON.stringify([c.actor, c.tenant, c.route, c.width, c.state]);
  const byKey = new Map();
  for (const c of cases) if (c.geometry?.length && measuredCase(c)) { if (!byKey.has(key(c))) byKey.set(key(c), []); byKey.get(key(c)).push(c); }
  const issues = [];
  for (const group of byKey.values()) {
    if (group.length < 2) continue;
    const [a, b] = group;
    const base = new Map(a.geometry.map(g => [g.selector, g]));
    let n = 0, moved = 0;
    for (const g of b.geometry) {
      const o = base.get(g.selector);
      if (!o) continue;
      // Sizes, not positions: two navigations can differ in live data above an element (a new
      // message, a presence change) and move it without the theme changing anything.
      const delta = g.box.slice(2).map((v, i) => Math.abs(v - o.box[i + 2]));
      if (delta.some(d => d > tolerance)) { moved++; if (n++ < maxPerCase) issues.push({ case: b, issue: { rule: 'theme.parity', category: 'violation', owner, selector: g.selector, property: `size in ${b.theme} vs ${a.theme}`, expected: o.box.slice(2), actual: g.box.slice(2) } }); }
      if (o.border !== g.border && n++ < maxPerCase) issues.push({ case: b, issue: { rule: 'theme.parity', category: 'violation', owner, selector: g.selector, property: 'border visibility', expected: `${o.border ? 'visible' : 'invisible'} as in ${a.theme}`, actual: `${g.border ? 'visible' : 'invisible'} in ${b.theme}` } });
    }
    if (moved > maxPerCase) issues.push({ case: b, issue: { rule: 'theme.parity', category: 'violation', owner, selector: 'document', property: `boxes resized in ${b.theme} vs ${a.theme}`, expected: 0, actual: moved } });
  }
  return issues;
}
/**
 * Deep states (references/deep-audit.md): interaction depth (every layer the
 * page can open without writing, the keyboard focus walk, every tablist's tab
 * switch) and data states rendered through response interception in this
 * context only. Shell-chrome triggers are audited once per actor (`seen`).
 */
async function deepStates(page, spec, adapter, options, seen) {
  const want = new Set((options.deepStates ?? 'layers,tabs,focus,data').split(','));
  const states = [];
  const found = await probes.discoverDeep(page, { maxLayers: options.deepLayers ?? 5, ...(adapter.deep?.chromeTriggers ? { chrome: adapter.deep.chromeTriggers } : {}) });
  const once = key => { if (seen.has(key)) return false; seen.add(key); return true; };
  if (want.has('focus')) states.push({ name: 'deep:focus-walk', enter: (p, { probes: shared }) => shared.focusWalk(p, { count: options.focusSteps ?? 20 }) });
  if (want.has('tabs')) for (const t of found.tablists) {
    if (t.global && !once(`tabs|${t.name}`)) continue;
    states.push({ name: `deep:tabs:${t.name}`, enter: async (p, { probes: shared, evidence }) => {
      // Each tab's snapshot carries a screenshot: before/after evidence for a switch that moved anything outside its panel.
      return shared.tabCycle(p, { index: t.index, name: t.name, chrome: adapter.deep?.chrome ?? [], ...(adapter.deep?.panes ? { panes: adapter.deep.panes } : {}), shoot: evidence ? label => evidence(`tabs-${t.index}-${label}`) : undefined });
    } });
  }
  if (want.has('layers')) for (const tr of found.triggers) {
    if (tr.global && !once(`layer|${tr.name}`)) continue;
    states.push({ name: `deep:layer:${tr.name}`, enter: (p, { probes: shared }) => shared.openLayer(p, tr) });
  }
  if (want.has('data') && adapter.dataApi) {
    const modes = (options.dataModes ?? 'empty,error,loading,long,many,denied').split(',');
    for (const mode of modes) {
      if (mode === 'denied' && !adapter.dataApi.permissions) continue;
      // A data state redefines what the page can show: the list route's required regions (its table)
      // do not bind an empty or failing page, and a page whose data never arrived is not judged on its
      // composer policy (the resting state is).
      states.push({ name: `deep:data:${mode}`, ready: mode === 'loading' ? 'shell' : 'lenient', ownRequired: true, required: [],
        ...(['loading', 'error'].includes(mode) ? { composerExpectation: { mode: 'exempt', reason: `Data state "${mode}": the page's data has not arrived, so its composer policy is judged on the resting state.` } } : {}),
        before: p => probes.interceptData(p, { mode, ...adapter.dataApi }),
        after: handle => handle?.release(),
        enter: async (p, { handle, readyError }) => {
          if (mode === 'loading') await p.waitForTimeout(1500);
          return { kind: 'data-state', mode, intercepted: handle.stats.intercepted, urls: handle.stats.urls, blockedWrites: handle.stats.blockedWrites, ...(readyError ? { readyError } : {}) };
        } });
    }
  }
  return states;
}
/** Adapter owns authentication/routes/read-only UI transitions; runner owns measurements. */
export async function runAudit(browser, adapter, options) {
  if (options.strictCoverage !== undefined && typeof options.strictCoverage !== 'boolean') throw new Error('strictCoverage must be boolean');
  const start = Date.now(), out = path.resolve(options.out); fs.mkdirSync(out, { recursive: true });
  const contract = loadContract(options.contract ?? adapter.contract);
  const matrix = await adapter.cases(options);
  if (!matrix.length) throw new Error('No audit cases selected; an empty sweep is not a pass');
  const report = { version: 1, contract: contract.name, contractHash: hash(contract), revision: await adapter.revision?.() ?? null, cases: [], groups: [], failures: 0, elapsedMs: 0 };
  const themes = options.themes?.split(',') ?? ['light', 'dark'];
  const widths = options.widths?.split(',').map(Number) ?? [1440];
  if (widths.some(w => !Number.isFinite(w) || w < 320)) throw new Error('Invalid viewport width');
  const actors = [...new Set(matrix.map(c => c.actor ?? c.tenant))];
  // Sequential actors: switching tenant can invalidate another session for the same user.
  for (const actor of actors) {
    let actorCases = matrix.filter(c => (c.actor ?? c.tenant) === actor);
    const context = await browser.newContext({ baseURL: adapter.baseURL, reducedMotion: 'reduce' });
    try {
      await adapter.authenticate(context, actorCases[0]);
      if (adapter.resolveCases) actorCases = await adapter.resolveCases(context, actorCases);
      const page = await context.newPage(); page.setDefaultTimeout(options.timeout ?? 5000);
      // Each navigation starts with the actor's original browser preferences.
      // A details/accordion state must not leak into the next default/theme case.
      const origin = new URL(adapter.baseURL).origin;
      const initialStorage = (await context.storageState()).origins.find(o => o.origin === origin)?.localStorage ?? [];
      await page.addInitScript(({ origin, entries }) => {
        if (window === window.top && location.origin === origin) {
          localStorage.clear(); sessionStorage.clear();
          for (const { name, value } of entries) localStorage.setItem(name, value);
        }
      }, { origin, entries: initialStorage });
      const seen = new Set();
      for (const spec of actorCases) for (const theme of themes) for (const width of widths) {
        await page.setViewportSize({ width, height: options.height ?? 900 });
        let states = spec.states ?? [{ name: 'default' }];
        // Deep states run once per route, at the first theme and width.
        const deepHere = options.deep && theme === themes[0] && width === widths[0];
        if ((adapter.discoverStates || deepHere) && options.states !== 'default') {
          try {
            await page.goto(spec.path, { waitUntil: 'domcontentloaded', timeout: options.navigationTimeout ?? 15000 });
            await adapter.ready(page, spec);
            if (adapter.discoverStates) states = [...states, ...await adapter.discoverStates(page, spec)];
            if (deepHere) states = [...states, ...await deepStates(page, spec, adapter, options, seen)];
          } catch (error) { states.push({ name: 'state-discovery', enter: async () => { throw error; } }); }
        }
        for (const state of states) {
          const entry = { actor, tenant: spec.tenant, route: spec.path, theme, width, state: state.name, issues: [], coverage: [], samples: [] };
          const errors = []; const onError = error => errors.push(error.message); page.on('pageerror', onError);
          let handle;
          try {
            // A state may prepare the context before navigating (data-state interception).
            if (state.before) handle = await state.before(page);
            await page.goto(spec.path, { waitUntil: 'domcontentloaded', timeout: options.navigationTimeout ?? 15000 });
            if (adapter.assertRoute) await adapter.assertRoute(page, spec);
            else if (new URL(page.url()).pathname !== new URL(spec.path, adapter.baseURL).pathname) throw new Error(`Unexpected redirect to ${new URL(page.url()).pathname}`);
            await adapter.theme(page, theme);
            // `ready: 'shell'` (a state that never settles, e.g. held responses) waits for the shell only;
            // `ready: 'lenient'` records a readiness failure for the rules instead of aborting the case.
            let readyError;
            if (state.ready === 'shell') { if (adapter.selectors?.header) await page.locator(adapter.selectors.header).first().waitFor({ timeout: 15000 }); }
            else if (state.ready === 'lenient') { try { await adapter.ready(page, spec); } catch (error) { readyError = String(error.message).replace(/\u001b\[[0-9;]*m/g, '').split('\n')[0]; } }
            else await adapter.ready(page, spec);
            const evidence = async label => {
              if (options.screenshots === false) return undefined;
              const file = `evidence/${hash([spec.path, theme, width, state.name, label])}.png`;
              fs.mkdirSync(path.join(out, 'evidence'), { recursive: true });
              await page.screenshot({ path: path.join(out, file) }).catch(() => undefined);
              return file;
            };
            // A state may run a read-only interaction probe and return its result for the rules to judge.
            const entered = state.enter ? await state.enter(page, { probes, handle, readyError, evidence }) : undefined;
            const probe = entered && typeof entered === 'object' && typeof entered.kind === 'string' ? entered : undefined;
            if (probe) entry.probe = probe;
            // A navigating state is classified on the page it reached, not the list it left.
            const reached = new URL(page.url());
            const judged = state.navigates ? { ...spec, path: reached.pathname + reached.search, navigatedFrom: spec.path } : spec;
            if (state.navigates) entry.reached = judged.path;
            if (adapter.describe) entry.view = await adapter.describe(page, judged);
            // The adapter may classify where the page landed before it is judged: outside the app frame
            // (an external sign-in, a raw file), an unreadable record. `{ skip: true, reason }` records
            // the context as coverage without measuring it; anything else is kept on the case.
            const context = await adapter.classifyContext?.(page, judged, state);
            if (context) entry.context = context;
            if (context?.skip) {
              if (!context.reason || PLACEHOLDER.test(String(context.reason).trim())) entry.issues.push({ rule: 'coverage.context', category: 'coverage', selector: 'document', property: 'context reason', expected: 'a documented reason for not judging this page', actual: context.reason ?? '' });
              entry.samples = [{ rule: 'coverage.context', selector: 'document', property: 'context', actual: context.kind ?? 'skipped', expected: 'classified' }];
            } else {
              const composerExpectation = state.composerExpectation ?? await adapter.composerExpectation?.(page, judged) ?? (state.navigates ? undefined : spec.composerExpectation);
              // A state that navigates away (a row opening its record) is judged on the
              // page it reached: the list route's required regions no longer apply.
              const required = state.navigates || state.ownRequired ? [...(state.required ?? [])] : [...(spec.required ?? []), ...(state.required ?? [])];
              const measured = await measureCase(page, { contract, selectors: adapter.selectors, required, composerExpectation, probe });
              const { stable, ...result } = measured;
              Object.assign(entry, result, { issues: [...entry.issues, ...result.issues] });
            }
            for (const message of errors) entry.issues.push({ rule: 'runtime.error', category: 'runtime', selector: 'document', property: 'pageerror', expected: 'none', actual: message });
            if (options.review) {
              // Visual review pass: every case is captured for the reviewer (deep-audit.md).
              entry.review = `review/${hash([spec.path, theme, width, state.name])}.png`;
              fs.mkdirSync(path.join(out, 'review'), { recursive: true });
              await page.screenshot({ path: path.join(out, entry.review) }).catch(() => { delete entry.review; });
            }
          } catch (error) {
            entry.issues.push({ rule: 'coverage.navigation-state', category: 'coverage', selector: 'document', property: 'ready state', expected: 'requested route and state rendered', actual: String(error.message) });
          } finally { page.off('pageerror', onError); await Promise.resolve(state.after?.(handle)).catch(() => undefined); }
          for (const issue of entry.issues) issue.fingerprint = hash([entry.actor, entry.tenant, entry.route, theme, width, state.name, issue.rule, issue.selector, issue.property]);
          if (entry.issues.length && options.screenshots !== false) {
            entry.screenshot = `${hash([spec.path, theme, width, state.name])}.png`;
            await page.screenshot({ path: path.join(out, entry.screenshot) }).catch(() => { delete entry.screenshot; });
          }
          report.cases.push(entry);
          const unclassified = entry.coverage.filter(c => c.status === 'unclassified').length;
          console.log(`${entry.issues.length ? 'FAIL' : unclassified ? 'PARTIAL' : 'PASS'} ${spec.tenant} ${spec.path} ${theme}/${width}/${state.name}: ${entry.issues.length} findings${unclassified ? '; composer policy unclassified' : ''}`);
        }
      }
    } catch (error) {
      report.cases.push({ actor, tenant: actorCases[0].tenant, route: '<actor setup>', theme: '', width: 0, state: 'setup', issues: [{ rule: 'coverage.actor', category: 'coverage', property: 'actor setup', expected: 'authenticated actor and resolved routes', actual: String(error.message), selector: 'document' }], coverage: [], samples: [] });
    } finally { await context.close(); }
  }
  // Cross-route passes: consistency outliers and theme parity are judged on the whole matrix.
  const fingerprintRule = contract.rules.find(r => r.kind === 'fingerprint');
  if (fingerprintRule) {
    const consistency = consistencyOutliers(report.cases, { ...fingerprintRule.outliers, owner: fingerprintRule.owner });
    for (const { case: c, issue } of consistency.issues) c.issues.push(issue);
    report.consistency = consistency.families;
  }
  const parityRule = contract.rules.find(r => r.kind === 'geometry-snapshot');
  if (parityRule) for (const { case: c, issue } of themeParity(report.cases, { tolerance: parityRule.tolerance ?? 1, owner: parityRule.owner })) c.issues.push(issue);
  for (const c of report.cases) { delete c.fingerprints; delete c.geometry; }
  if (options.review) fs.writeFileSync(path.join(out, 'review-index.jsonl'), report.cases.filter(c => c.review).map(c => JSON.stringify({ tenant: c.tenant, route: c.route, reached: c.reached, theme: c.theme, width: c.width, state: c.state, screenshot: c.review, findings: c.issues.map(i => i.rule) })).join('\n') + '\n');
  for (const entry of report.cases) for (const issue of entry.issues) issue.fingerprint ??= hash([entry.actor, entry.tenant, entry.route, entry.theme, entry.width, entry.state, issue.rule, issue.selector, issue.property]);
  report.groups = summarize(report.cases);
  report.failures = report.cases.reduce((n, c) => n + c.issues.length, 0);
  // The resting-state gate (established rules on resting and adapter states) and the deep findings
  // (rules marked deep, and every deep:* state) are counted apart so a consumer can gate on either.
  for (const c of report.cases) for (const i of c.issues) if (c.state?.startsWith('deep:') || isDeepRule(contract, i.rule)) i.deep = true;
  report.gate = { resting: report.cases.reduce((n, c) => n + c.issues.filter(i => !i.deep).length, 0), deep: report.cases.reduce((n, c) => n + c.issues.filter(i => i.deep).length, 0) };
  report.unclassified = report.cases.filter(c => c.coverage.some(item => item.status === 'unclassified')).map(({ tenant, route, theme, width, state }) => ({ tenant, route, theme, width, state }));
  report.strictCoverage = options.strictCoverage ?? false;
  report.exitCode = report.failures || (report.strictCoverage && report.unclassified.length) ? 1 : 0;
  report.elapsedMs = Date.now() - start;
  if (options.previous) {
    const previous = JSON.parse(fs.readFileSync(options.previous, 'utf8'));
    if (previous.contractHash !== report.contractHash) report.comparisonWarning = 'Contract changed; compare rule definitions before interpreting improvement';
    const old = new Set(previous.cases.flatMap(c => c.issues.map(i => i.fingerprint))), current = new Set(report.cases.flatMap(c => c.issues.map(i => i.fingerprint)));
    // A route that failed readiness/coverage/runtime is unverified, not fixed.
    // Missing findings on that route cannot close a previously observed defect.
    const caseKey = c => JSON.stringify([c.actor, c.tenant, c.route, c.theme, c.width, c.state]);
    const measured = c => c.samples?.length > 0 && !c.issues.some(i => ['coverage', 'runtime'].includes(i.category));
    const priorCases = new Map(previous.cases.map(c => [caseKey(c), c]));
    const currentCases = new Map(report.cases.map(c => [caseKey(c), c]));
    const overlapping = [...currentCases.keys()].filter(key => priorCases.has(key));
    const shared = new Set(overlapping.filter(key => measured(priorCases.get(key)) && measured(currentCases.get(key))));
    const unverified = [...priorCases.keys()].filter(key => !shared.has(key) && (currentCases.has(key) || priorCases.get(key).issues.length));
    report.delta = {
      new: report.cases.filter(c => shared.has(caseKey(c))).flatMap(c => c.issues.filter(i => !old.has(i.fingerprint)).map(i => i.fingerprint)),
      resolved: previous.cases.filter(c => shared.has(caseKey(c))).flatMap(c => c.issues.filter(i => !current.has(i.fingerprint)).map(i => i.fingerprint)),
      comparedCases: shared.size,
      overlappingCases: overlapping.length,
      unverifiedFindings: unverified.reduce((count, key) => count + priorCases.get(key).issues.length, 0),
      unverifiedCases: unverified.map(key => {
        const prior = priorCases.get(key), now = currentCases.get(key);
        return { actor: prior.actor, tenant: prior.tenant, route: prior.route, theme: prior.theme, width: prior.width, state: prior.state,
          reason: !now ? 'not visited' : !measured(now) ? 'current case did not complete stable measurement' : 'previous case did not complete stable measurement' };
      }),
    };
  }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  fs.writeFileSync(path.join(out, 'summary.txt'), [`${report.cases.length} cases; ${report.failures} findings (${report.gate.resting} resting-state gate, ${report.gate.deep} deep); ${report.unclassified.length} composer policies unclassified; ${report.strictCoverage ? 'strict coverage' : 'advisory coverage'}; exit ${report.exitCode}; ${(report.elapsedMs / 1000).toFixed(1)}s`, ...report.unclassified.map(c => `UNCLASSIFIED composer policy | ${c.tenant} ${c.route} ${c.theme}/${c.width}/${c.state}`), ...(report.delta ? [`Comparison: ${report.delta.comparedCases} verified cases; ${report.delta.resolved.length} resolved; ${report.delta.unverifiedFindings} prior findings unverified across ${report.delta.unverifiedCases.length} cases`] : []), ...report.groups.map(g => `${g.rule} | ${g.property}: expected ${JSON.stringify(g.expected)}, got ${JSON.stringify(g.actual)} | ${g.routes.length} routes / ${g.occurrences} instances | ${g.owner}`), ...(report.consistency ?? []).filter(f => f.values.length > (fingerprintRule?.outliers?.maxDistinct ?? 3)).map(f => `CONSISTENCY ${f.family}${f.key === '*' ? '' : ` (${f.key})`} at ${f.width}px: ${f.values.length} distinct values over ${f.routes} routes: ${f.values.slice(0, 6).map(v => `${JSON.stringify(v.value)}×${v.routes}`).join('; ')}`)].join('\n') + '\n');
  return report;
}
