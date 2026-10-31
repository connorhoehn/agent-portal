// node --test scripts/journeys/tests/ — the social family's profile, the cookie-less demo identity and
// read-only presence peers (docs/journeys.md "Journey maps", docs/social-journeys/PROTOCOL.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateMap, composeLog, claimFields, mapFiles, loadMaps, PROFILES } from '../maps.mjs';

const surface = (over = {}) => ({
  family: 'social', log: 'moderator/channels', kind: 'surface', scenario: 'shared',
  persona: { user: 'u-lena', name: 'Lena Brandt', tenant: 'social', role: 'moderator' },
  goal: 'Read #general', fields: { surface: 'channels', pages: 'portal/src/pages/social/ChannelsPage.tsx' },
  steps: [
    { do: 'navigate', url: '/social/channels/general', name: 'Open #general' },
    { do: 'tab-walk', name: 'Tab through', proves: 'keyboard' },
    { do: 'navigate', url: '/social/channels/no-such-channel', name: 'Unknown channel', state: 'not-found', proves: 'empty-state' },
    { do: 'navigate', url: '/social/channels/general', name: 'Create a channel offered', proves: 'role-gating' },
    { do: 'wait', target: { text: 'Sana Iqbal' }, name: 'Sana appears under Active now', proves: 'realtime' },
  ],
  ...over,
});

test('the social profile carries the PROTOCOL fields validate-social-tenant.sh greps', () => {
  assert.deepEqual(claimFields('social', 'surface'), ['keyboard', 'empty-state', 'realtime', 'role-gating']);
  assert.deepEqual(claimFields('social', 'isolation-inbound'), ['social-grant', 'social-tile-visible', 'social-nav-visible', 'direct-route-result', 'api-status', 'activity-leak', 'forged-subscribe']);
  assert.deepEqual(claimFields('social', 'isolation-outbound'), ['orgiq-nav-visible', 'orgiq-route-result', 'orgiq-api-status', 'assessment-nav-visible', 'assessment-route-result', 'assessment-api-status']);
  for (const kind of Object.keys(PROFILES.social)) for (const f of ['verdict', 'console errors', 'screenshot', 'pages']) assert.ok(PROFILES.social[kind].includes(f), `${kind} has ${f}`);
});

test('a social surface map must prove realtime; n/a is a claim value, still proven by a step', () => {
  assert.deepEqual(validateMap(surface()), []);
  assert.match(validateMap(surface({ steps: surface().steps.filter((s) => s.proves !== 'realtime') })).join('\n'), /no step proves realtime/);
});

test('a composed social log satisfies the judge: realtime n/a and empty-state n/a lines', () => {
  const m = surface({ claims: { realtime: 'n/a — nothing on it is live' } });
  const steps = m.steps.map((s, i) => ({ index: i + 1, do: s.do, name: s.name, proves: s.proves, url: s.url, landed: '/social/channels/general', status: 'pass', failures: [], unexpectedConsole: [], expectedConsole: [],
    ...(s.do === 'tab-walk' ? { keyboard: { total: 20, visited: 18, lost: 0, invisible: 0 } } : { audit: { findings: 0, rules: {}, recorded: 0, recordedRules: {}, unclassified: 0 }, facts: { scrollWidth: 1680, innerWidth: 1680, innerHeight: 940, h1Count: 1, h1: null, trail: null, rows: null, composer: null, firstRowTop: null } }) }));
  const { text, verdict } = composeLog({ map: m, mapFile: 'x.ts', viewport: { width: 1680, height: 940 }, startedAt: '2026-10-29T10:00:00Z', endedAt: '2026-10-29T10:01:00Z', scenario: 'shared', screenshot: 'channels.jpg', screenshotStep: 1, steps });
  assert.equal(verdict, 'pass');
  for (const re of [/^verdict: pass$/m, /^console errors: 0$/m, /^layout: pass/m, /^keyboard: pass/m, /^empty-state: pass/m, /^realtime: n\/a — nothing on it is live — Sana appears/m, /^pages: \S+/m, /^screenshot: channels\.jpg/m])
    assert.match(text, re);
});

test('identity demo: the cookie-less demo-user only, never switched, never writing, no peers', () => {
  const demo = { family: 'social', log: 'isolation/demo-user', kind: 'isolation-inbound', scenario: 'shared', identity: 'demo',
    persona: { user: 'demo-user', tenant: 'orgiq', role: 'member' }, goal: 'No grant', fields: { pages: 'portal/src/App.tsx' },
    steps: claimFields('social', 'isolation-inbound').map((f, i) => ({ do: 'navigate', url: '/iq/projects', name: `step ${i}`, proves: f })) };
  assert.deepEqual(validateMap(demo), []);
  assert.match(validateMap({ ...demo, persona: { user: 'u-theo', tenant: 'orgiq', role: 'member' } }).join(' '), /identity: 'demo'/);
  assert.match(validateMap({ ...demo, persona: { ...demo.persona, switchTenant: true } }).join(' '), /identity: 'demo'/);
  assert.match(validateMap({ ...demo, writes: true, scenario: { scope: 'default' } }).join(' '), /identity: 'demo'/);
  assert.match(validateMap({ ...demo, identity: 'nobody' }).join(' '), /identity is 'clone', 'persona' or 'demo'/);
});

test('read-only presence peers may walk the shared mock; a writing peer walk still needs a scope', () => {
  const peer = { peer: { user: 'u-sana', tenant: 'social', role: 'participant' } };
  const m = surface({ peers: peer, steps: [...surface().steps, { do: 'navigate', actor: 'peer', url: '/social/channels/general', name: 'Sana opens #general' }] });
  assert.deepEqual(validateMap(m), []);
  assert.match(validateMap({ ...m, identity: 'persona', identityReason: 'x' }).join(' '), /peer walks require clone identities/);
  assert.match(validateMap({ ...m, writes: true }).join(' '), /scoped scenario/);
  assert.deepEqual(validateMap({ ...m, writes: true, scenario: { scope: 'default' } }), []);
});

test('every social map validates: 36 role × surface maps and 12 isolation maps, the activity maps held', async () => {
  const { maps, problems } = await loadMaps(mapFiles('social'));
  assert.deepEqual(problems, []);
  assert.equal(maps.filter(({ map }) => map.kind === 'surface').length, 36);
  assert.equal(maps.filter(({ map }) => map.kind.startsWith('isolation')).length, 12);
  for (const { map } of maps) {
    if (map.kind === 'isolation-inbound' && map.claims['social-grant'] === 'no') {
      assert.equal(map.claims['forged-subscribe'], 'AUTHZ_CHANNEL_DENIED');
      assert.ok(map.steps.some(s => s.do === 'gateway-refusal' && s.channel === 'social:ch:general' && s.proves === 'forged-subscribe'), `${map.log} proves the gateway refusal`);
    }
    // Only a hangout's call is joined (by a clone peer, on the gateway, signalling-only media); nothing else writes.
    if (map.log.endsWith('/rooms')) assert.deepEqual([map.scenario, map.media, map.identity], [{ realtime: 'meeting' }, 'meeting-fixture', 'clone']);
    else { assert.ok(!map.writes, `${map.log} writes nothing`); assert.equal(map.scenario, 'shared', `${map.log} walks the shared mock read-only`); }
    if (map.log.endsWith('/activity')) assert.ok(map.hold, `${map.log} is held`);
  }
});

test('a peer may sign in as its seed persona (presence a clone cannot show) only with a reason and no writes', () => {
  const peer = { peer: { user: 'u-sana', tenant: 'social', role: 'participant', identity: 'persona' } };
  const m = surface({ peers: peer, steps: [...surface().steps, { do: 'navigate', actor: 'peer', url: '/social/channels/general', name: 'Sana opens #general' }] });
  assert.match(validateMap(m).join(' '), /needs an identityReason/);
  assert.deepEqual(validateMap({ ...m, identityReason: 'the directory holds no clone' }), []);
  assert.match(validateMap({ ...m, identityReason: 'x', writes: true, scenario: { scope: 'default' } }).join(' '), /must not write/);
  assert.match(validateMap({ ...m, identityReason: 'x', peers: { peer: { ...peer.peer, identity: 'robot' } } }).join(' '), /identity is 'clone' or 'persona'/);
});
