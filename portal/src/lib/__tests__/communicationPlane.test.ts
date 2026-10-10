// The Communication plane (lib/communicationPlane.ts): who gets the Social
// plane, what the pane opens on, and that every nav surface — the shell rail
// (Layout.tsx NAV_ITEMS), the palette (portalCommands.ts) and the trail
// (breadcrumbResolve.ts) — says Communication where it used to say Calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  COMMUNICATION_PATHS, communicationAccess, communicationPath, communicationUnreadCount, createCountStore, legacyCallsTarget,
  withCommunicationCount,
} from '../communicationPlane.ts';
import { SOCIAL_TENANT_PLANE, embeddedPlane } from '../../pages/social/socialPlane.ts';
import { channelHref, dmHref } from '../../pages/social/socialChat.ts';
import { resolveBreadcrumbs } from '../../components/shell/breadcrumbResolve.ts';

const params = (query: string) => new URLSearchParams(query);
// The seeded cast (schema/identity_schema.sql): u-theo is an orgiq member who
// holds social participant; u-eli is an orgiq SME with no social grant;
// u-operator is admin everywhere, social included.
const theo = { sub: 'u-theo', grants: { orgiq: ['member'], social: ['participant'] } };
const eli = { sub: 'u-eli', grants: { orgiq: ['sme'] } };
const operator = { sub: 'u-operator', grants: { orgiq: ['admin'], assessment: ['admin'], social: ['admin'], pipelines: ['admin'] } };

test('role matrix: a Social grant decides the plane; its absence is the denied state, never the plane', () => {
  assert.equal(communicationAccess(theo, true), 'social');
  assert.equal(communicationAccess(operator, true), 'social');
  assert.equal(communicationAccess(eli, true), 'no-grant');
  // An empty grant list is no grant (a revoked one reads the same).
  assert.equal(communicationAccess({ sub: 'u-x', grants: { orgiq: ['member'], social: [] } }, true), 'no-grant');
  assert.equal(communicationAccess(theo, false), 'social-disabled');
  assert.equal(communicationAccess(null, true), 'signed-out');
  assert.equal(communicationAccess({ sub: 'unknown', grants: {} }, true), 'signed-out');
});

test('one workspace, two mounts: the Social tenant and the embedded plane differ only in API prefix and route base', () => {
  assert.deepEqual(SOCIAL_TENANT_PLANE, { api: '/api/social', route: '/social', embedded: false });
  assert.deepEqual(embeddedPlane('/iq/communication'), { api: '/api/social/plane', route: '/iq/communication', embedded: true });
  assert.equal(channelHref('general'), '/social/channels/general');
  assert.equal(channelHref('general', '/iq/communication'), '/iq/communication/channels/general');
  assert.equal(dmHref('social:dm:u-mira:u-vera', '/assessment/communication'), '/assessment/communication/dms/social%3Adm%3Au-mira%3Au-vera');
  // No Social read or write in the workspace or its panes is spelled with a fixed prefix
  // (the grant-gated /dms and /dms/read are the same route in both mounts).
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../pages/social');
  for (const f of ['SocialChatWorkspace.tsx', 'RecordingsPane.tsx', 'CallLogPane.tsx', 'SocialRoomsSection.tsx', 'socialTeamPreferences.ts']) {
    const src = readFileSync(path.join(dir, f), 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    const fixed = [...src.matchAll(/['`]\/api\/social(\/[\w/-]*)?/g)].map((m) => m[1] ?? '').filter((p) => p !== '' && p !== '/dms' && p !== '/dms/read'); // '' = a default prefix value
    assert.deepEqual(fixed, [], `${f} spells a fixed /api/social path`);
    assert.ok(!/navigate\(['`]\/social\//.test(src), `${f} navigates to a fixed /social/ path`);
  }
});

test('the rail door counts DMs with new messages, on the active tenant’s Communication door only', () => {
  assert.equal(communicationUnreadCount([{ unreadCount: 3 }, { unreadCount: 0 }, {}, { unreadCount: 1 }]), 2);
  assert.deepEqual(withCommunicationCount({ '/iq/projects': 1 }, 'orgiq', 2), { '/iq/projects': 1, '/iq/communication': 2 });
  assert.deepEqual(withCommunicationCount({}, 'social', 2), {}, 'Social has no Communication door');
  assert.deepEqual(withCommunicationCount({}, 'orgiq', 0), {});
  const store = createCountStore(); let heard = 0;
  const off = store.subscribe(() => { heard += 1; });
  store.set(2); store.set(2); store.set(-1); off(); store.set(5);
  assert.equal(heard, 2); assert.equal(store.get(), 5);
});

test('paths: one per non-Social tenant, and every former Calls page lands on the Calls shelf', () => {
  assert.deepEqual(COMMUNICATION_PATHS, { orgiq: '/iq/communication', assessment: '/assessment/communication', pipelines: '/pipelines/communication' });
  assert.equal(communicationPath('social'), null);
  assert.equal(legacyCallsTarget('orgiq'), '/iq/communication/calls');
  const app = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../App.tsx'), 'utf8');
  for (const tenant of ['orgiq', 'assessment', 'pipelines'] as const) {
    assert.ok(app.includes(`<Navigate to="${legacyCallsTarget(tenant)}" replace />`), `App.tsx redirects ${tenant}'s calls to ${legacyCallsTarget(tenant)}`);
  }
});

test('nav model: rail, palette and trail say Communication; Social keeps Meet › Calls', () => {
  const shell = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../components/shell');
  const layout = readFileSync(path.join(shell, 'Layout.tsx'), 'utf8');
  const palette = readFileSync(path.join(shell, 'portalCommands.ts'), 'utf8');
  const expected: Array<[string, string, string]> = [
    ['/iq/communication', 'orgiq', 'Engage'], ['/assessment/communication', 'assessment', 'Assess'], ['/pipelines/communication', 'pipelines', 'Runs'],
  ];
  for (const [p, tenant, group] of expected) {
    assert.match(layout, new RegExp(`path: '${p}',\\s*label: 'Communication',\\s*tenant: '${tenant}',\\s*group: '${group}'`), `rail row ${p}`);
    assert.match(palette, new RegExp(`label: 'Communication',[^\\n]*path: '${p}', tenant: '${tenant}', group: '${group}'`), `palette row ${p}`);
    assert.deepEqual(resolveBreadcrumbs(p).map((c) => c.label), [group, 'Communication']);
  }
  for (const gone of ['/iq/calls', '/assessment/calls', '/pipelines/calls']) {
    assert.ok(!layout.includes(`'${gone}'`), `rail no longer lists ${gone}`);
    assert.ok(!palette.includes(`'${gone}'`), `palette no longer lists ${gone}`);
  }
  assert.match(layout, /path: '\/social\/calls',\s*label: 'Calls',\s*tenant: 'social',\s*group: 'Meet'/);
  assert.deepEqual(resolveBreadcrumbs('/social/calls').map((c) => c.label), ['Meet', 'Calls']);
});
