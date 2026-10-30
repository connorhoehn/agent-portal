// node --test scripts/journeys/tests/ — the assessment family profile (docs/assessment-journeys/PROTOCOL.md):
// a map of each kind validates, and the log the runner composes from a passing walk carries every line
// scripts/validate-assessment-tenant.sh greps for, while a failed proving step fails the field honestly.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { validateMap, composeLog, claimFields, PROFILES, ROOT } from '../maps.mjs';

const nav = (url, name, proves) => ({ do: 'navigate', url, name, ...(proves ? { proves } : {}) });
const maps = {
  surface: {
    family: 'assessment', log: 'assessor/reports', kind: 'surface', scenario: 'shared',
    persona: { user: 'u-asha', name: 'Asha Nair', tenant: 'assessment', role: 'assessor' },
    goal: 'Asha reads the portfolio', fields: { surface: 'reports' }, claims: { 'empty-state': 'n/a' },
    steps: [nav('/assessment/reports', 'Open the portfolio'), { do: 'tab-walk', name: 'Tab through', proves: 'keyboard' },
      nav('/assessment/reports', 'Every team has data: no empty state to show', 'empty-state'), nav('/assessment/reports', 'No Publish for an assessor', 'role-gating')],
  },
  'isolation-inbound': {
    family: 'assessment', log: 'isolation/member', kind: 'isolation-inbound', scenario: 'shared',
    persona: { user: 'u-theo', tenant: 'orgiq', role: 'member' }, goal: 'Theo meets no assessment door',
    claims: { 'assessment-tile-visible': 'no', 'assessment-nav-visible': 'no', 'direct-route-result': 'redirect', 'api-status': '403' },
    steps: [nav('/select', 'No Assessment tile', 'assessment-tile-visible'), nav('/iq/projects', 'No rail link', 'assessment-nav-visible'),
      nav('/assessment/teams', 'Sent away', 'direct-route-result'), { do: 'api', url: '/api/assessment/teams', name: 'GET answers 403', proves: 'api-status', expect: { status: 403 } }],
  },
  'isolation-outbound': {
    family: 'assessment', log: 'isolation/assessor-outbound', kind: 'isolation-outbound', scenario: 'shared',
    persona: { user: 'u-asha', tenant: 'assessment', role: 'assessor' }, goal: 'Asha meets no orgiq door',
    claims: { 'orgiq-nav-visible': 'no', 'orgiq-route-result': 'redirect', 'orgiq-api-status': '403' },
    steps: [nav('/assessment/teams', 'No orgiq link', 'orgiq-nav-visible'), nav('/iq/projects', 'Sent away', 'orgiq-route-result'),
      { do: 'api', url: '/api/bots', name: 'GET answers 403', proves: 'orgiq-api-status', expect: { status: 403 } }],
  },
};

// The validator's own greps, per kind (scripts/validate-assessment-tenant.sh sections 4 and 4b).
const JUDGE = {
  surface: ['^verdict: *pass', '^console errors: *0', '^layout: *pass', '^keyboard: *pass', '^empty-state: *(pass|n/a)', '^screenshot: *\\S+'],
  'isolation-inbound': ['^assessment-tile-visible: *no', '^assessment-nav-visible: *no', '^direct-route-result: *(not-found|redirect)', '^api-status: *403', '^verdict: *pass', '^screenshot: *\\S+'],
  'isolation-outbound': ['^orgiq-nav-visible: *no', '^orgiq-route-result: *(not-found|redirect)', '^orgiq-api-status: *403', '^verdict: *pass'],
};

const walked = (map, over = {}) => ({
  map, mapFile: `docs/journeys/maps/assessment/${map.log}.ts`, viewport: { width: 1680, height: 940 },
  startedAt: '2026-10-29T10:00:00.000Z', endedAt: '2026-10-29T10:01:00.000Z', scenario: 'scenario: shared', stack: 'dev:mock',
  session: { sub: `${map.persona.user}-clone-1`, tenant: map.persona.tenant, role: map.persona.role }, clone: `${map.persona.user}-clone-1`,
  screenshot: `${path.basename(map.log)}.jpg`, screenshotStep: 1, contract: 'Work 0123',
  steps: map.steps.map((s, i) => ({
    index: i + 1, do: s.do, name: s.name, proves: s.proves, url: s.url, landed: s.url, status: 'pass', failures: [], unexpectedConsole: [], expectedConsole: [],
    ...(s.do === 'api' ? { api: { method: 'GET', url: s.url, status: 403 } } : s.do === 'tab-walk' ? { keyboard: { total: 30, visited: 22, lost: 0, invisible: 0 } }
      : { audit: { findings: 0, rules: {}, recorded: 0, recordedRules: {}, unclassified: 0 }, facts: { scrollWidth: 1680, innerWidth: 1680, innerHeight: 940, h1Count: 1, h1: null, trail: null, rows: null, composer: null, firstRowTop: null } }),
    ...(over[i + 1] ?? {}),
  })),
});

test('the assessment profile: its kinds and the claim fields each must prove', () => {
  assert.deepEqual(Object.keys(PROFILES.assessment).sort(), ['isolation-inbound', 'isolation-outbound', 'surface']);
  assert.deepEqual(claimFields('assessment', 'surface'), ['keyboard', 'empty-state', 'role-gating']);
  assert.deepEqual(claimFields('assessment', 'isolation-inbound'), ['assessment-tile-visible', 'assessment-nav-visible', 'direct-route-result', 'api-status']);
  assert.deepEqual(claimFields('assessment', 'isolation-outbound'), ['orgiq-nav-visible', 'orgiq-route-result', 'orgiq-api-status']);
});

test('the profile names every field the judge greps for', () => {
  const judge = fs.readFileSync(path.join(ROOT, 'scripts/validate-assessment-tenant.sh'), 'utf8');
  for (const [kind, res] of Object.entries(JUDGE)) for (const re of res) {
    const field = re.match(/^\^([a-z -]+):/)[1];
    assert.ok(PROFILES.assessment[kind].includes(field), `${kind} carries ${field}`);
    assert.ok(judge.includes(re.replace(/\\\\/g, '\\')), `the judge still greps ${re}`);
  }
});

for (const [kind, map] of Object.entries(maps)) {
  test(`a ${kind} map validates, and its passing log satisfies the judge`, () => {
    assert.deepEqual(validateMap(map), []);
    const { text, verdict } = composeLog(walked(map));
    assert.equal(verdict, 'pass');
    for (const re of JUDGE[kind]) assert.match(text, new RegExp(re, 'mi'), re);
    assert.doesNotMatch(text, /\b(TODO|unverified|placeholder)\b/i);
  });
}

test('a claim whose proving step failed reads fail, and the judge does not count it', () => {
  const map = maps['isolation-inbound'];
  const { text, verdict } = composeLog(walked(map, { 4: { status: 'fail', failures: ['status 200 (expected 403)'], api: { method: 'GET', url: '/api/assessment/teams', status: 200 } } }));
  assert.equal(verdict, 'fail');
  assert.match(text, /^api-status: fail — step 4/m);
  assert.doesNotMatch(text, /^api-status: *403/m);
  assert.doesNotMatch(text, /^verdict: *pass/m);
});

test('a surface map that proves no empty-state is refused', () => {
  const map = maps.surface;
  const p = validateMap({ ...map, steps: map.steps.filter((s) => s.proves !== 'empty-state') });
  assert.match(p.join('\n'), /no step proves empty-state/);
});
