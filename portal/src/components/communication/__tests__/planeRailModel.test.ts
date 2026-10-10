// The Communication plane's org-context rail sections (planeRailModel.ts) and
// its per-viewer people data (planeSharingModel.ts): readers stay defensive,
// rows say what the server said, and nothing invents a binding or a status.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GROUP_SECTION_LABEL, groupBindingContext, groupDiscussionChannel, groupRowPreview, MINE_KIND, mineGroups, mineGroupsUrl, mineOrgTeams, orgTeamPeople, orgTeamRowPreview,
  parseGroupRef, planeView, planeViewHref, readMineGroups, readPersonLink, unreadFor,
} from '../planeRailModel.ts';
import { activeQuery, enrichActive, liveLobbies, readPlaneActive, readSharing, sharedWorkSnapshot, stoppableGrants } from '../planeSharingModel.ts';

test('each host tenant names its groups section and discussion family', () => {
  assert.equal(GROUP_SECTION_LABEL.orgiq, 'My initiatives');
  assert.equal(GROUP_SECTION_LABEL.assessment, 'My teams');
  assert.equal(GROUP_SECTION_LABEL.pipelines, 'My pipelines');
  assert.equal(groupDiscussionChannel({ kind: 'initiative', id: 'p-auth-migration' }), 'orgiq:initiative:p-auth-migration');
  assert.equal(groupDiscussionChannel({ kind: 'team', id: 'TEAM-001' }), 'assessment:team:TEAM-001');
  assert.equal(groupDiscussionChannel({ kind: 'definition', id: 'd1' }), 'pipelines:def:d1');
  assert.equal(groupBindingContext({ kind: 'initiative', id: 'p-x' }), 'initiative:p-x');
  assert.equal(groupBindingContext({ kind: 'team', id: 'TEAM-001' }), 'assessment-team:TEAM-001');
  assert.equal(groupBindingContext({ kind: 'definition', id: 'bot:b1' }), 'pipeline:bot:b1');
  // One wire shape for every kind (GET /api/me/groups?kind=): the row's family follows the item's kind.
  assert.equal(mineGroupsUrl(MINE_KIND.assessment), '/api/me/groups?kind=assessment-team');
  assert.equal(mineGroupsUrl(MINE_KIND.pipelines), '/api/me/groups?kind=pipeline');
  const reply = readMineGroups({ viewer: { userId: 'u-asha', personId: null }, items: [
    { kind: 'assessment-team', id: 'TEAM-001', name: 'Northstar', role: null, membership: 'contributor', counts: { members: 1 }, members: [{ userId: 'u-asha', personId: null, name: 'Asha Nair' }] },
    { kind: 'pipeline', id: 'bot:b1', name: 'Nightly', role: 'paused', membership: 'owner' },
    { kind: 'assessment-team', id: '', name: 'x', membership: 'member' }, null, { kind: 'nope', id: 'a', name: 'b', membership: 'member' },
  ], limits: [] });
  assert.deepEqual(mineGroups(reply), [{ kind: 'team', id: 'TEAM-001', name: 'Northstar' }, { kind: 'definition', id: 'bot:b1', name: 'Nightly' }]);
  assert.deepEqual(reply?.items[0]?.members, [{ userId: 'u-asha', personId: null, name: 'Asha Nair' }]);
  assert.deepEqual(mineGroups(null), []);
  assert.equal(readMineGroups({ teams: [] }), null);
});

test('readers drop malformed rows and keep the server’s facts', () => {
  const initiatives = readMineGroups({ viewer: { userId: 'u-vera', personId: 'p-002' }, items: [
    { kind: 'initiative', id: 'p-auth-migration', name: 'Auth Migration', role: 'owner', membership: 'owner' },
    { kind: 'initiative', id: '', name: 'x', membership: 'owner' }, null, { kind: 'initiative', id: 'bad id!', name: 'y', membership: 'owner' },
  ], limits: [] });
  assert.deepEqual(mineGroups(initiatives), [{ kind: 'initiative', id: 'p-auth-migration', name: 'Auth Migration' }]);
  assert.deepEqual(mineGroups(readMineGroups({ not: 'a reply' })), []);
  assert.deepEqual(readPersonLink({ linked: false, personId: null }), { linked: false, personId: null });
  assert.equal(readPersonLink({}), null);
  const teams = mineOrgTeams(readMineGroups({ viewer: { userId: 'u-vera', personId: 'p-002' }, items: [{ kind: 'org-team', id: 't-platform', name: 'Platform Engineering', role: 'Principal Engineer', membership: 'member',
    counts: { members: 3 }, members: [{ personId: 'p-001', name: 'Theo Chang', userId: 'u-theo' }, { personId: 'p-003', name: 'Marcus', userId: null }, { name: 'no id' }] }], limits: [] }));
  assert.equal(teams?.personId, 'p-002');
  assert.equal(teams?.teams[0]?.members.length, 2);
  assert.equal(teams?.teams[0]?.members[1]?.userId, null);
  assert.deepEqual(mineOrgTeams(readMineGroups({ viewer: { userId: 'u-hr', personId: null }, items: [], limits: ['Link your account'] })), { personId: null, teams: [] });
  assert.equal(mineOrgTeams(null), null);
});

test('a group row names its bound channel, else the page discussion; unread is the server’s', () => {
  const group = { kind: 'initiative' as const, id: 'p-auth-migration', name: 'Auth Migration' };
  assert.equal(groupRowPreview(group, { binding: { channel: 'social:ch:auth-migration', slug: 'auth-migration', name: 'Auth migration' } }), '#auth-migration');
  assert.equal(groupRowPreview(group, { binding: null }), 'Initiative discussion');
  assert.equal(groupRowPreview(group, { bindingUnknown: true }), 'Initiative discussion');
  assert.equal(groupRowPreview({ ...group, kind: 'team' }, { binding: null }), 'Team discussion');
  assert.equal(groupRowPreview({ ...group, kind: 'definition' }, { bindingUnknown: true }), 'Pipeline discussion');
  assert.equal(unreadFor('orgiq:initiative:p-auth-migration', [{ channel: 'orgiq:initiative:p-auth-migration', unreadCount: 3 }]), 3);
});

test('an org team row counts members online by their app user; the roster marks the absent offline', () => {
  const team = { id: 't-1', name: 'Platform', parentId: null, role: null, members: [
    { personId: 'p-1', name: 'Theo', userId: 'u-theo' }, { personId: 'p-2', name: 'Ana', userId: 'u-ana' }, { personId: 'p-3', name: 'Zed', userId: null },
    { personId: 'p-4', name: 'Me', userId: 'u-me' },
  ] };
  assert.equal(orgTeamRowPreview(team, new Set(['u-theo']), null), '4 members · 1 online');
  assert.equal(orgTeamRowPreview(team, new Set(), { channel: 'social:ch:platform', slug: 'platform', name: 'Platform' }), '#platform');
  const people = orgTeamPeople(team, [{ id: 'u-theo' }, { id: 'u-ana', idle: true }], 'u-me');
  assert.deepEqual(people.map((p) => [p.displayName, p.status]), [['Theo', 'online'], ['Ana', 'away'], ['Zed', 'offline']]);
});

test('plane views round-trip through the URL', () => {
  const base = '/iq/communication';
  for (const view of [{ kind: 'group', group: { kind: 'initiative', id: 'p-auth-migration' } }, { kind: 'org-team', teamId: 't-platform' }, { kind: 'person', userId: 'u-mira' }] as const) {
    const href = planeViewHref(base, view);
    assert.deepEqual(planeView(new URL(href, 'http://x').searchParams), view);
  }
  assert.equal(planeView(new URLSearchParams('group=nope:1')), null);
  assert.equal(parseGroupRef('plane-group:team:TEAM-001')?.id, 'TEAM-001');
});

test('Active now enrichment maps the wire onto the library tile and the rail’s live dots', () => {
  const active = readPlaneActive({ people: [
    { userId: 'u-mira', status: 'busy', inCall: { callId: 'c1', lobby: 'social:ch:general', title: '#general' }, activity: 'In a huddle on #general', workSharing: null },
    { userId: 'u-theo', status: 'online', inCall: null, activity: null, workSharing: { state: 'historical', fresh: false } },
    { status: 'online' },
  ] });
  assert.equal(active.size, 2);
  const tiles = enrichActive([
    { userId: 'u-mira', displayName: 'Mira', status: 'online' as const },
    { userId: 'u-theo', displayName: 'Theo', status: 'away' as const },
    { userId: 'u-nia', displayName: 'Nia', status: 'online' as const },
  ], active);
  assert.deepEqual(tiles[0], { userId: 'u-mira', displayName: 'Mira', status: 'busy', inCall: true, activity: 'In a huddle on #general' });
  assert.deepEqual(tiles[1], { userId: 'u-theo', displayName: 'Theo', status: 'away', workSharing: { state: 'historical', fresh: false } });
  assert.deepEqual(tiles[2], { userId: 'u-nia', displayName: 'Nia', status: 'online' });
  assert.deepEqual([...liveLobbies(active)], ['social:ch:general']);
  assert.equal(activeQuery(['u-b', 'u-a', 'u-a', 'bad id']), `?users=${encodeURIComponent('u-a,u-b')}`);
  assert.equal(activeQuery([]), null);
});

test('the shared-work envelope: the hook gets the snapshot, the page the sharing facts', () => {
  const body = { snapshot: { schemaVersion: 1, nodes: [] }, sharing: { viewer: 'owner', provenance: { 'work:a': 'active', 'work:b': 'bogus' },
    grants: [{ id: 'g1', state: 'active', kind: 'current', audience: { kind: 'conversation', id: 'social:ch:general' }, nodeIds: ['work:a'], revision: 2 },
      { id: 'g2', state: 'stopped', audience: { kind: 'team', id: 't' }, nodeIds: [], revision: 1 }], referencedIn: [] } };
  assert.deepEqual(sharedWorkSnapshot(body), { schemaVersion: 1, nodes: [] });
  const sharing = readSharing(body.sharing);
  assert.deepEqual(sharing?.provenance, { 'work:a': 'active' });
  assert.deepEqual(stoppableGrants(sharing).map((g) => g.id), ['g1']);
  assert.equal(readSharing({ viewer: 'someone' }), null);
  assert.deepEqual(stoppableGrants(readSharing({ viewer: 'audience', grants: body.sharing.grants })), []);
});
