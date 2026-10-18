// node --test scripts/journeys/tests/ — the pure half of the journey-map runner.
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateMap, composeLog, coverageModel, coverageMarkdown, stepRoutes, layoutLine, claimFields, mapFiles, loadMaps } from '../maps.mjs';

const surface = (over = {}) => ({
  family: 'access', log: 'requester/catalog', kind: 'surface', scenario: 'shared',
  persona: { user: 'u-rhea', name: 'Rhea', tenant: 'access', role: 'requester' },
  goal: 'Browse the catalog', fields: { surface: 'catalog' },
  steps: [
    { do: 'navigate', url: '/access/catalog', name: 'Open the catalog' },
    { do: 'tab-walk', name: 'Tab through', proves: 'keyboard' },
    { do: 'fill', target: { role: 'textbox', name: 'Search' }, value: 'zz', name: 'Search for zz', state: 'filtered-empty', proves: 'empty-state' },
    { do: 'navigate', url: '/access/catalog', name: 'No Approvals in the rail', proves: 'role-gating' },
  ],
  ...over,
});

test('a complete map validates', () => assert.deepEqual(validateMap(surface()), []));

test('every claim field of the kind must be proven by a step', () => {
  const m = surface({ steps: surface().steps.filter((s) => s.proves !== 'keyboard') });
  assert.match(validateMap(m).join('\n'), /no step proves keyboard/);
  assert.deepEqual(claimFields('access', 'surface'), ['keyboard', 'empty-state', 'role-gating']);
});

test('a writing step needs writes: true, and writes need a scope', () => {
  const steps = [...surface().steps, { do: 'click', target: { role: 'button', name: 'Save' }, name: 'Save', writes: true }];
  assert.match(validateMap(surface({ steps })).join('\n'), /do not declares? writes|does not declare writes/);
  assert.match(validateMap(surface({ steps, writes: true })).join('\n'), /scoped scenario/);
  assert.deepEqual(validateMap(surface({ steps, writes: true, scenario: { scope: 'default' } })), []);
});

test('a non-GET api call in a read-only map must be a 4xx refusal probe with a reason', () => {
  const probe = { do: 'api', method: 'POST', url: '/api/access/requests', body: {}, name: 'Refused', proves: 'role-gating', expect: { status: 403 } };
  assert.match(validateMap(surface({ steps: [...surface().steps, probe] })).join('\n'), /refusal/);
  assert.deepEqual(validateMap(surface({ steps: [...surface().steps, { ...probe, refusal: 'empty body' }] })), []);
  assert.match(validateMap(surface({ steps: [...surface().steps, { ...probe, refusal: 'x', expect: { status: 200 } }] })).join('\n'), /4xx/);
});

test('banned words never reach a log', () => {
  assert.match(validateMap(surface({ goal: 'TODO later' })).join('\n'), /banned word/);
  assert.match(validateMap(surface({ steps: [{ ...surface().steps[0], name: 'a placeholder page' }, ...surface().steps.slice(1)] })).join('\n'), /banned word/);
});

test('persona identity needs a reason; the first step navigates', () => {
  assert.match(validateMap(surface({ identity: 'persona' })).join('\n'), /identityReason/);
  assert.match(validateMap(surface({ steps: surface().steps.slice(1) })).join('\n'), /first step must navigate/);
});

const audit = (findings = 0, recorded = 0) => ({ findings, rules: findings ? { 'a11y.contrast': findings } : {}, recorded, recordedRules: recorded ? { 'a11y.landmarks': recorded } : {}, unclassified: 0 });
const result = (stepOver = {}) => {
  const m = surface();
  return {
    map: m, mapFile: 'docs/journeys/maps/access/requester/catalog.ts', viewport: { width: 1680, height: 940 },
    startedAt: '2026-10-14T10:00:00.000Z', endedAt: '2026-10-14T10:01:00.000Z', scenario: 'scenario: shared', stack: 'dev:mock',
    session: { sub: 'u-rhea-clone-1', tenant: 'access', role: 'requester', grants: { access: ['requester'] } }, clone: 'u-rhea-clone-1',
    screenshot: 'catalog.jpg', screenshotStep: 1, contract: 'Work 0123',
    steps: m.steps.map((s, i) => ({
      index: i + 1, do: s.do, name: s.name, state: s.state, proves: s.proves, url: s.url, landed: '/access/catalog', status: 'pass', failures: [],
      unexpectedConsole: [], expectedConsole: [],
      ...(s.do === 'tab-walk' ? { keyboard: { total: 20, visited: 14, lost: 0, invisible: 0 } } : { audit: audit(0, 1), facts: { scrollWidth: 1680, innerWidth: 1680, innerHeight: 940, h1Count: 1, h1: { text: 'Catalog', size: 20, weight: 600, left: 224, top: 111 }, trail: { left: 224, top: 68 }, rows: null, composer: null, firstRowTop: 236 } }),
      ...(stepOver[i + 1] ?? {}),
    })),
  };
};

test('a passing walk writes the protocol fields the seal and judges grep for', () => {
  const { text, verdict } = composeLog(result());
  assert.equal(verdict, 'pass');
  for (const re of ['^surface: catalog', '^role: requester', '^user: u-rhea \\(Rhea\\)', '^url: /access/catalog', '^verdict: pass$', '^console errors: 0$', '^layout: pass', '^keyboard: pass — ', '^empty-state: pass — Search for zz', '^role-gating: pass — No Approvals', '^screenshot: catalog.jpg', 'first-row-top: 236px', 'Tab visited 14 distinct'])
    assert.match(text, new RegExp(re, 'm'), re);
  assert.match(text, /owed by docs\/journeys\/audit-burndown\.tsv \(a11y\.landmarks ×3\)/, 'burn-down findings stay visible');
  assert.doesNotMatch(text, /\b(TODO|unverified|placeholder)\b/i);
});

test('a failed step fails its field and the verdict, honestly', () => {
  const { text, verdict } = composeLog(result({ 3: { status: 'fail', failures: ['text not visible: No match'] } }));
  assert.equal(verdict, 'fail');
  assert.match(text, /^verdict: fail — 1 of 4 steps failed; step 3 \(Search for zz\): text not visible: No match$/m);
  assert.match(text, /^empty-state: fail — step 3/m);
  assert.match(text, /^keyboard: pass/m);
});

test('a gating audit finding fails layout and the verdict; an unexpected console error fails it too', () => {
  const a = composeLog(result({ 1: { audit: audit(2) } }));
  assert.equal(a.verdict, 'fail');
  assert.match(a.text, /^layout: fail — 2 ui-dom-audit finding\(s\)/m);
  const c = composeLog(result({ 4: { unexpectedConsole: ['TypeError: x'] } }));
  assert.equal(c.verdict, 'fail');
  assert.match(c.text, /^console errors: 1 — TypeError: x/m);
});

test('layout fails when nothing was measured or the page scrolls sideways', () => {
  const r = result();
  r.steps = r.steps.map((s) => ({ ...s, audit: undefined }));
  assert.equal(layoutLine(r).ok, false);
  assert.equal(layoutLine(result({ 1: { facts: { scrollWidth: 1700, innerWidth: 1680, innerHeight: 940, h1Count: 1 } } })).ok, false);
});

test('coverage: route × role × state, with the gaps', () => {
  const inventory = [{ key: '/access/catalog', tenant: 'access', kind: 'list' }, { key: '/access/audit', tenant: 'access', kind: 'list' }];
  const routeKey = (u) => (u.startsWith('/access/') ? u.split('?')[0] : null);
  assert.deepEqual(stepRoutes(surface(), routeKey).map((x) => x.state), ['default', 'filtered-empty', 'default']);
  const model = coverageModel([{ map: surface() }], { inventory, rolesByTenant: { access: ['requester', 'approver'] }, routeKey });
  assert.equal(model.totals.visited, 1);
  assert.deepEqual(model.unvisited.map((r) => r.key), ['/access/audit']);
  assert.deepEqual(model.rolesNever, [{ tenant: 'access', roles: ['approver'] }]);
  assert.deepEqual(model.statesNever, [{ key: '/access/catalog', kind: 'list', missing: ['row-open'] }]);
  const md = coverageMarkdown(model, { families: ['access'], pending: [{ file: 'x.ts', log: 'access/a/b', goal: 'G', why: 'it writes' }] });
  assert.match(md, /\| `\/access\/catalog` \| default, filtered-empty \|/);
  assert.match(md, /- access: approver/);
  assert.match(md, /x\.ts` → access\/a\/b: G\. Held: it writes\./);
});

test('every map in the tree validates', async () => {
  const { maps, problems } = await loadMaps(mapFiles());
  assert.deepEqual(problems, []);
  assert.ok(maps.length >= 40);
});

test('the work family: its surface kind adds story-facts and tab-stability; new steps validate', () => {
  assert.deepEqual(claimFields('work', 'surface'), ['keyboard', 'empty-state', 'role-gating', 'story-facts', 'tab-stability']);
  assert.ok(claimFields('work', 'refusals').includes('palette-entries'));
  const m = surface({ family: 'work', log: 'member/x', steps: [
    ...surface().steps,
    { do: 'scope', scope: 'empty', url: '/access/catalog', name: 'Empty world', state: 'empty', proves: 'story-facts' },
    { do: 'click', target: { role: 'tab', name: 'Work' }, name: 'Work tab', stable: [{ css: '.shell-header' }], proves: 'tab-stability' },
    { do: 'viewport', width: 900, height: 900, name: 'Narrow' }, { do: 'theme', value: 'dark', name: 'Dark' }, { do: 'reload', name: 'Reload' },
  ] });
  assert.deepEqual(validateMap(m), []);
  const bad = surface({ family: 'work', log: 'member/x', steps: [...m.steps, { do: 'theme', value: 'sepia', name: 'x' }, { do: 'viewport', name: 'y' }, { do: 'click', target: { role: 'tab' }, name: 'z', stable: [] }] });
  const p = validateMap(bad).join('\n');
  assert.match(p, /theme is light or dark/); assert.match(p, /viewport needs width and height/); assert.match(p, /stable lists the targets/);
  assert.deepEqual(stepRoutes(m, (u) => u.split('?')[0]).filter((x) => x.state === 'empty'), [{ key: '/access/catalog', state: 'empty' }]);
});

test('shared meeting walks require cloned peers and the media fixture', () => {
  const m = surface({ identity: 'clone', writes: true, scenario: { realtime: 'meeting' }, media: 'meeting-fixture', peers: { peer: { user: 'u-y', tenant: 'access', role: 'requester' } } });
  assert.deepEqual(validateMap(m), []);
  assert.match(validateMap({ ...m, identity: 'persona' }).join(' '), /meeting scenarios require clone peers/);
  assert.match(validateMap({ ...m, media: undefined }).join(' '), /meeting scenarios require clone peers/);
  assert.match(validateMap({ ...m, steps: [...m.steps, { do: 'navigate', actor: 'missing', url: '/access/catalog', name: 'unknown peer' }] }).join(' '), /unknown peer missing/);
});
