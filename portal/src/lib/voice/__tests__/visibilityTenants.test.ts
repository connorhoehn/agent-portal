// V2-14 (docs/voice-tool-inventory.md §5): the two-persona property (G14,
// visibility.test.ts for orgiq) over every tool the other four tenants are
// offered, two roles each with different grants, over that tenant's own
// fixtures. No refused, ambiguous or failed payload names a row the persona's
// own reads did not return, nor anything of the other persona's world. The
// sweep is pinned: every offered tool has variants and produced payloads that
// were checked, and every queue_work kind of the tenant was driven to at
// least one refusal payload.

import test from 'node:test';
import assert from 'node:assert/strict';
import { middlewareVoice } from './voiceHarness.ts';
import { assertPersonaProperty, type World } from './personaProperty.ts';
import { queueWorkKinds } from '../catalogue.ts';

const peer = (name: string, userId: string): World['roster'] => ({ roster: () => [{ userId, name, status: 'online' }], lobby: () => null });

// ── Social: a moderator who posts and manages channels, a participant who only reads ──

const LENA: World = {
  tenant: 'social', role: 'moderator', social: true, socialRequestItemId: null, computers: [], roster: peer('Lena Peer Person', 'u-lena-peer'),
  allow: ['ViewSocial', 'PostMessage', 'StartCall', 'ManageChannels', 'ManageTeams', 'VoiceNavigate'],
  page: { path: '/social/channels', rowsLabel: 'channels', rows: [{ ref: 'channel:lena-general', title: 'Lena General Channel', href: '/social/channels/lena-general' }] },
  reads: {
    '/api/social/search': { results: [{ type: 'channel', id: 'lena-general', title: 'Lena General Channel', href: '/social/channels/lena-general' }], total: 1 },
    '/api/social/channels': { channels: [{ slug: 'lena-general', name: 'Lena General Channel' }, { slug: 'lena-general-two', name: 'Lena General Two' }] },
    '/api/social/teams': { teams: [{ teamId: 't-lena', name: 'Lena Platform Team' }] },
    '/api/social/people': { people: [{ userId: 'u-lena-ada1', displayName: 'Ada Lena-One' }, { userId: 'u-lena-ada2', displayName: 'Ada Lena-Two' }] },
    '/api/social/resolve': { kind: 'person', match: null, candidates: [{ id: 'u-lena-ada1', name: 'Ada Lena-One' }, { id: 'u-lena-ada2', name: 'Ada Lena-Two' }] },
    '/api/access-requests/mine': { items: [] },
  },
};
const PARK: World = {
  tenant: 'social', role: 'participant', social: true, socialRequestItemId: null, computers: [], roster: peer('Park Peer Person', 'u-park-peer'),
  allow: ['ViewSocial', 'VoiceNavigate'],
  page: { path: '/social/teams', rowsLabel: 'teams', rows: [{ ref: 'team:t-park', title: 'Park Reading Team' }] },
  reads: {
    '/api/social/search': { results: [{ type: 'team', id: 't-park', title: 'Park Reading Team', href: '/social/teams' }], total: 1 },
    '/api/social/channels': { channels: [{ slug: 'park-lounge', name: 'Park Lounge Channel' }] },
    '/api/social/resolve': { kind: 'channel', match: null, candidates: [{ id: 'park-lounge', name: 'Park Lounge Channel' }, { id: 'park-lounge-2', name: 'Park Lounge Two' }] },
  },
};
const SOCIAL_VARIANTS: Record<string, unknown[]> = {
  open: [{ page: 'channels' }, { page: 'nowhere' }, { ref: '1' }, { ref: 'channel:not-theirs' }, { kind: 'channel', name: 'General' }, { kind: 'channel', name: 'Nothing Like It' },
    { kind: 'initiative', name: 'x' }, { ref: '5', scope: 'this-page' }],
  search: [{ query: 'general', type: 'channel' }, { query: 'x', type: 'initiative' }],
  list: [{ kind: 'channel', filter: { q: 'nothing like it' } }, { kind: 'not-a-kind' }, { kind: 'person' }, { kind: 'channel', filter: { since: 'soon' } }],
  get: [{ ref: '1' }, { ref: 'channel:nope' }, { ref: 'team:t-x', part: 'members' }, { ref: 'General' }],
  summary: [{ kind: 'live' }, { kind: 'unread', since: 'whenever' }, { kind: 'sweeps' }],
  budget: [{ scope: 'me' }, { scope: 'org' }],
  activity: [{ scope: 'missed-calls' }, { scope: 'online', who: 'nobody' }, { scope: 'work' }, { scope: 'recent', since: 'tomorrow' }],
  message: [{ target: { kind: 'dm', name: 'Ada' }, text: 'hi' }, { target: { kind: 'channel', name: 'nowhere' }, text: 'x' }],
  call: [{ action: 'start', target: { kind: 'dm', name: 'Ada' } }, { action: 'join' }, { action: 'start' }],
  set_status: [{ status: 'away', message: 'out' }],
  queue_work: [{ kind: 'deck', target: 'General' }, { kind: 'summarize', target: 'nowhere' }, { kind: 'diagram', target: 'General' }, { kind: 'doc', target: 'x' }, { kind: 'sweep', target: 'all' }],
  create: [{ kind: 'channel', fields: { name: 'x' } }, { kind: 'team', fields: { name: 't', extra: 'y' } }, { kind: 'room', fields: {} }, { kind: 'work-item', fields: { initiative: 'x', title: 'y' } }],
  update: [{ ref: 'channel:not-theirs', fields: { member: true } }, { ref: 'dm:x', fields: { read: true } }, { ref: '2', fields: { member: true } }, { ref: 'nonsense', fields: { status: 'x' } }],
  access_request_status: [{ scope: 'approvals' }, { query: 'budget' }],
};

// ── Assessment: an assessor with the plane, a member who only reads ──

const ASHA: World = {
  tenant: 'assessment', role: 'assessor', social: true, socialRequestItemId: null, computers: [], roster: peer('Asha Peer Person', 'u-asha-peer'),
  allow: ['ViewAssessment', 'Search', 'RunAssessmentAgent', 'ScoreAssessment', 'ViewSocial', 'VoiceNavigate'],
  page: { path: '/assessment/teams', rowsLabel: 'teams', rows: [{ ref: 'team:t-asha-north', title: 'Asha Northstar Team', href: '/assessment/teams/t-asha-north' }] },
  reads: {
    '/api/assessment/search': { results: [{ type: 'team', id: 't-asha-north', title: 'Asha Northstar Team', href: '/assessment/teams/t-asha-north' }], total: 1 },
    '/api/assessment/teams': { teams: [{ id: 't-asha-north', name: 'Asha Northstar Team' }, { id: 't-asha-north2', name: 'Asha Northstar Two' }] },
    '/api/assessment/teams/t-asha-north': { team: { id: 't-asha-north', name: 'Asha Northstar Team' }, dimensions: [{ id: 'd-asha-1', title: 'Asha Delivery Dimension' }, { id: 'd-asha-2', title: 'Asha Delivery Cadence' }] },
    '/api/assessment/runs': { runs: [{ id: 'r-asha-1', title: 'Asha scorer run', status: 'running' }] },
    '/api/assessment/feedback': { tasks: [{ task_id: 'f-asha-1', title: 'Asha follow-up task', status: 'open' }] },
    '/api/social/plane/search': { results: [{ type: 'calllog', id: 'call-a|u-asha', title: 'Missed call from Asha Caller', href: '/assessment/communication', updatedAt: '2026-11-08T09:00:00Z' }], total: 1 },
  },
};
const BEA: World = {
  tenant: 'assessment', role: 'member', social: false, socialRequestItemId: 'role:social:participant', computers: [], roster: peer('Bea Peer Person', 'u-bea-peer'),
  allow: ['ViewAssessment', 'VoiceNavigate'],
  page: { path: '/assessment/runs', rowsLabel: 'runs', rows: [{ ref: 'run:r-bea-1', title: 'Bea review run' }] },
  reads: {
    '/api/assessment/teams': { teams: [{ id: 't-bea-falcon', name: 'Bea Falcon Team' }] },
    '/api/assessment/runs': { runs: [{ id: 'r-bea-1', title: 'Bea review run', status: 'done' }] },
  },
};
const ASSESSMENT_VARIANTS: Record<string, unknown[]> = {
  open: [{ page: 'teams' }, { page: 'nowhere' }, { ref: '1' }, { kind: 'team', name: 'Northstar' }, { kind: 'team', name: 'Nothing Like It' }, { ref: 'team:t-not-theirs' }],
  search: [{ query: 'below target', type: 'team' }, { query: 'x', type: 'person' }],
  list: [{ kind: 'team', filter: { q: 'nothing like it' } }, { kind: 'not-a-kind' }, { kind: 'run', filter: { status: 'failed' } }, { kind: 'feedback', filter: { since: 'soon' } }],
  get: [{ ref: '1' }, { ref: 'team:t-nope' }, { ref: 'team:t-asha-north', part: 'nope' }, { ref: 'Asha Northstar Team' }],
  summary: [{ kind: 'rollup' }, { kind: 'live' }, { kind: 'sweeps' }],
  budget: [{ scope: 'me' }, { scope: 'org' }],
  activity: [{ scope: 'missed-calls' }, { scope: 'work' }, { scope: 'online', who: 'nobody' }],
  set_status: [{ status: 'busy' }],
  queue_work: [{ kind: 'assessment-run', target: 'Northstar' }, { kind: 'assessment-run', target: 'nothing like it' }, { kind: 'draft-evidence', target: 'Delivery for Asha Northstar Team' },
    { kind: 'draft-followups', target: 'no shape' }, { kind: 'deck', target: 'Northstar' }, { kind: 'pipeline', target: 'x' }],
  decide: [{ ref: 'draft:x', decision: 'approve' }, { ref: '1', decision: 'approve' }, { ref: 'nonsense', decision: 'approve' }],
  update: [{ ref: 'run:r-not-theirs', fields: { status: 'stopped' } }, { ref: 'feedback:f-asha-1', fields: { status: 'nope' } }, { ref: 'report:program', fields: { publish: true } }, { ref: '2', fields: { status: 'resolved' } }],
  access_request_status: [{ scope: 'approvals' }, { query: 'x' }],
};

// ── Pipelines: an operator who runs, approves and cancels, an author who only reads ──

const KOFI: World = {
  tenant: 'pipelines', role: 'operator', social: true, socialRequestItemId: null, computers: [], roster: peer('Kofi Peer Person', 'u-kofi-peer'),
  allow: ['ViewPipelines', 'RunPipeline', 'ApproveStep', 'CancelRun', 'ViewSocial', 'VoiceNavigate'],
  page: { path: '/pipelines/runs', rowsLabel: 'runs', rows: [{ ref: 'run:run-kofi-1', title: 'Kofi nightly ingest', status: 'failed', href: '/pipelines/runs/run-kofi-1' }] },
  reads: {
    '/api/pipelines/search': { results: [{ type: 'run', id: 'run-kofi-1', title: 'Kofi nightly ingest', href: '/pipelines/runs/run-kofi-1' }], total: 1 },
    '/api/pipelines/runs': { runs: [{ id: 'run-kofi-1', title: 'Kofi nightly ingest', status: 'failed' }, { id: 'run-kofi-2', title: 'Kofi nightly export', status: 'running' }] },
    '/api/pipelines/runbooks': { runbooks: [{ id: 'rb-kofi-1', title: 'Kofi ingest runbook' }, { id: 'rb-kofi-2', title: 'Kofi ingest backfill' }, { id: 'rb-kofi-x' }] },
    '/api/pipelines/approvals': { approvals: [{ id: 'ap-kofi-1', title: 'Kofi approve deploy', stepId: 's1' }] },
    '/api/social/plane/search': { results: [{ type: 'calllog', id: 'call-k|u-kofi', title: 'Missed call from Kofi Caller', href: '/pipelines/communication', updatedAt: '2026-11-08T09:00:00Z' }], total: 1 },
  },
};
const PIA: World = {
  tenant: 'pipelines', role: 'author', social: false, socialRequestItemId: 'role:social:participant', computers: [], roster: peer('Pia Peer Person', 'u-pia-peer'),
  allow: ['ViewPipelines', 'VoiceNavigate'],
  page: { path: '/pipelines/definitions', rowsLabel: 'definitions', rows: [{ ref: 'definition:def-pia', title: 'Pia draft definition' }] },
  reads: {
    '/api/pipelines/runs': { runs: [{ id: 'run-pia-1', title: 'Pia test run', status: 'done' }] },
    '/api/pipelines/definitions': { definitions: [{ id: 'def-pia', name: 'Pia draft definition' }] },
  },
};
const PIPELINES_VARIANTS: Record<string, unknown[]> = {
  open: [{ page: 'runs' }, { page: 'nowhere' }, { ref: '1' }, { kind: 'run', name: 'Kofi nightly' }, { kind: 'run', name: 'Nothing Like It' }, { ref: 'run:run-not-theirs' }],
  search: [{ query: 'failed', type: 'run' }, { query: 'x', type: 'team' }],
  list: [{ kind: 'run', filter: { q: 'nothing like it' } }, { kind: 'not-a-kind' }, { kind: 'approval' }, { kind: 'run', filter: { since: 'soon' } }],
  get: [{ ref: '1' }, { ref: 'run:nope' }, { ref: 'run:run-kofi-1', part: 'nope' }, { ref: 'Kofi nightly ingest' }],
  summary: [{ kind: 'pipelines', since: 'whenever' }, { kind: 'pipelines' }, { kind: 'rollup' }],
  budget: [{ scope: 'me' }, { scope: 'org' }],
  activity: [{ scope: 'missed-calls' }, { scope: 'work' }, { scope: 'recent', since: 'tomorrow' }],
  set_status: [{ status: 'busy' }],
  queue_work: [{ kind: 'pipeline', target: 'Kofi ingest' }, { kind: 'pipeline', target: 'nothing like it' }, { kind: 'deck', target: 'Kofi nightly' }, { kind: 'deck', target: 'none at all' }, { kind: 'sweep', target: 'all' }],
  decide: [{ ref: 'approval:ap-not-theirs', decision: 'approve' }, { ref: '1', decision: 'reject' }, { ref: 'nonsense', decision: 'approve' }],
  update: [{ ref: 'run:run-not-theirs', fields: { status: 'cancelled' } }, { ref: 'run:run-kofi-1', fields: { status: 'nope' } }, { ref: '2', fields: { status: 'cancelled' } }],
  access_request_status: [{ scope: 'approvals' }, { query: 'x' }],
};

// ── Access: an approver, and a requester who only files and reads their own ──

const OMAR: World = {
  tenant: 'access', role: 'approver', social: false, socialRequestItemId: null, computers: [], roster: peer('Omar Peer Person', 'u-omar-peer'),
  allow: ['ViewAccess', 'RequestAccess', 'DecideAccess', 'VoiceNavigate'],
  page: { path: '/access/approvals', rowsLabel: 'approvals', rows: [{ ref: 'approval:req-omar-1', title: 'Omar SME in Work' }] },
  reads: {
    '/api/access/search': { results: [{ type: 'request', id: 'req-omar-1', title: 'Omar SME in Work', href: '/access/requests/req-omar-1' }], total: 1 },
    '/api/access/requests': { items: [{ id: 'req-omar-1', item: { id: 'orgiq:sme', title: 'Omar SME in Work' }, status: 'pending', requester: { id: 'u-omar-r', displayName: 'Omar Requester' } }] },
    '/api/access/approvals': { items: [{ id: 'req-omar-1', item: { id: 'orgiq:sme', title: 'Omar SME in Work' }, status: 'pending', requester: { id: 'u-omar-r', displayName: 'Omar Requester' } },
      { id: 'req-omar-2', item: { id: 'orgiq:sme2', title: 'Omar SME in Work Two' }, status: 'pending', requester: { id: 'u-omar-r2', displayName: 'Omar Requester Two' } }] },
    '/api/access/catalog': { items: [{ id: 'cat-omar-1', title: 'Omar Operator in Pipelines', kind: 'role' }, { id: 'cat-omar-2', title: 'Omar Operator in Work', kind: 'role' }] },
    '/api/access/delegations': { items: [] },
  },
};
const RHEA: World = {
  tenant: 'access', role: 'requester', social: false, socialRequestItemId: null, computers: [], roster: peer('Rhea Peer Person', 'u-rhea-peer'),
  allow: ['ViewAccess', 'RequestAccess', 'VoiceNavigate'],
  page: { path: '/access/requests', rowsLabel: 'requests', rows: [{ ref: 'request:req-rhea-1', title: 'Rhea Viewer in Assessment' }] },
  reads: {
    '/api/access/requests': { items: [{ id: 'req-rhea-1', item: { id: 'assessment:viewer', title: 'Rhea Viewer in Assessment' }, status: 'pending', requester: { id: 'u-me', displayName: 'Rhea Self' } }] },
    '/api/access/catalog': { items: [{ id: 'cat-rhea-1', title: 'Rhea Reader in Social', kind: 'role' }] },
  },
};
const ACCESS_VARIANTS: Record<string, unknown[]> = {
  open: [{ page: 'approvals' }, { page: 'nowhere' }, { ref: '1' }, { kind: 'request', name: 'SME' }, { kind: 'catalog-item', name: 'Nothing Like It' }, { ref: 'request:req-not-theirs' }],
  search: [{ query: 'sme', type: 'request' }, { query: 'x', type: 'team' }],
  list: [{ kind: 'request', filter: { q: 'nothing like it', scope: 'mine' } }, { kind: 'not-a-kind' }, { kind: 'approval' }, { kind: 'request', filter: { scope: 'all' } }],
  get: [{ ref: '1' }, { ref: 'request:nope' }, { ref: 'review:rv-x', part: 'items' }, { ref: 'Omar SME in Work' }],
  summary: [{ kind: 'access' }, { kind: 'unread', since: 'whenever' }, { kind: 'live' }],
  budget: [{ scope: 'me' }, { scope: 'org' }],
  decide: [{ ref: 'approval:req-not-theirs', decision: 'approve' }, { ref: '1', decision: 'approve' }, { ref: 'nonsense', decision: 'approve' }, { ref: 'review-item:ri-x', decision: 'reject' }],
  create: [{ kind: 'access-request', fields: { item: 'Operator', justification: 'I cover the nightly runs while the operators are out.', duration: '7d' } },
    { kind: 'access-request', fields: { item: 'Nothing Like It', justification: 'I cover the nightly runs while the operators are out.', duration: '7d' } },
    { kind: 'delegation', fields: { delegate: 'x', window: '1d', reason: 'short' } }, { kind: 'channel', fields: { name: 'x' } }],
  update: [{ ref: 'request:req-not-theirs', fields: { status: 'withdrawn' } }, { ref: 'delegation:x', fields: { status: 'ended' } }, { ref: '2', fields: { status: 'withdrawn' } }],
  access_request_status: [{ scope: 'approvals' }, { scope: 'reports' }, { query: 'SME' }],
};

const TENANTS: ReadonlyArray<{ tenant: string; a: World; b: World; variants: Record<string, unknown[]> }> = [
  { tenant: 'social', a: LENA, b: PARK, variants: SOCIAL_VARIANTS },
  { tenant: 'assessment', a: ASHA, b: BEA, variants: ASSESSMENT_VARIANTS },
  { tenant: 'pipelines', a: KOFI, b: PIA, variants: PIPELINES_VARIANTS },
  { tenant: 'access', a: OMAR, b: RHEA, variants: ACCESS_VARIANTS },
];

for (const { tenant, a, b, variants } of TENANTS) {
  test(`V2-14 ${tenant}: no refused, ambiguous or failed payload names a row the persona's own reads did not return (${a.role} and ${b.role})`, async (t) => {
    const mw = await middlewareVoice<{ toolsForTenant(t: string, o?: { role?: string }): Array<{ name: string }> }>('catalogue.ts');
    // Every tool either role is offered, from the catalogue the session is minted with.
    const names = [...new Set([...mw.toolsForTenant(tenant, { role: a.role }), ...mw.toolsForTenant(tenant, { role: b.role })].map((t) => t.name))];
    const stats = await assertPersonaProperty([[a.role!, a, b], [b.role!, b, a]], names, variants);
    // Pinned: every offered tool produced payloads the property checked, and every queue_work kind a refusal.
    for (const tool of names) assert.ok((stats.perTool.get(tool) ?? 0) > 0, `${tenant} ${tool}: no refused, ambiguous or failed payload was checked`);
    for (const kind of queueWorkKinds(tenant)) assert.ok((stats.perQueueKind.get(kind) ?? 0) > 0, `${tenant} queue_work ${kind}: no refusal payload was checked`);
    t.diagnostic(`${tenant}: ${stats.checked} payloads checked, ${stats.ambiguous} ambiguous, ${stats.rowsNamed} naming the persona's own rows`);
    assert.ok(stats.checked > 40, `${tenant}: the property saw ${stats.checked}`);
    // The fixtures reach rows: some payloads are ambiguities over the persona's own rows, so the property is not vacuous.
    assert.ok(stats.ambiguous > 0 && stats.rowsNamed > 0, `${tenant}: ${stats.ambiguous} ambiguous, ${stats.rowsNamed} naming rows`);
  });
}
