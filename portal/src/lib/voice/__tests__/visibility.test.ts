// Profile reads and DMs stay inside the UI's visibility (G14,
// docs/voice-navigator-gaps.md §2.5). Every planner and runner runs as two
// personas with different grants, each over its own world of fixtures (what
// that persona's own GETs of the backing reads answer). Property: no name, id
// or href in a refused, ambiguous or failed payload is absent from that
// persona's own reads, and nothing of the other persona's world appears in it
// at all. Plus the confirm-time DM: the resolver only names it, the runner
// opens it, and a refused open sends nothing.

import test from 'node:test';
import assert from 'node:assert/strict';
import { VOICE_PLANNERS, VOICE_RUNNERS } from '../actions.ts';
import { planPreparedCall, prepareToolCall, runPreparedCall, type SocialAccess } from '../tools.ts';
import { middlewareVoice, toolContext, type LoggedRequest } from './voiceHarness.ts';
import { pageContextNote } from '../pageContext.ts';
import { queueWorkKinds } from '../catalogue.ts';
import { assertPersonaProperty, runAs, strings, type World } from './personaProperty.ts';

const SID = (c: string) => c.repeat(40);

/** Sana: a Work member with a Social grant and the Computer Lab. */
const SANA: World = {
  allow: ['Search', 'ViewSocial', 'PostMessage', 'StartCall', 'ManageDevbox', 'OpenDevboxShell', 'ManageBots', 'ConnectLocalCompute', 'DispatchAgentRun', 'RunDevboxTask',
    'ApproveTransaction', 'DecideAgentChange', 'DeliverAgentChange', 'ReviewRunbook', 'VoiceNavigate'],
  social: true, socialRequestItemId: null,
  page: {
    path: '/iq/projects/p-sana-alpha', record: { ref: 'initiative:p-sana-alpha', title: 'Sana Alpha Initiative' }, rowsLabel: 'work items',
    rows: [
      { ref: 'work-item:w-sana-1', title: 'Sana fix the login', status: 'open', priority: 'high', href: '/iq/projects/p-sana-alpha?item=w-sana-1' },
      { ref: 'work-item:w-sana-2', title: 'Sana fix the logout', status: 'open', priority: 'medium', href: '/iq/projects/p-sana-alpha?item=w-sana-2' },
    ],
  },
  computers: [{ id: 'c-sana-alpha', label: 'sana-alpha-box', sessionId: SID('a'), status: 'running', projectId: 'p-sana-alpha', project: 'Sana Alpha Initiative' }],
  roster: { roster: () => [{ userId: 'u-sana-peer', name: 'Sana Peer Person', status: 'online' }], lobby: () => null },
  reads: {
    '/api/graph/projects': [{ id: 'p-sana-alpha', name: 'Sana Alpha Initiative' }, { id: 'p-sana-beta', name: 'Sana Beta Initiative' }],
    '/api/social/plane/resolve': { kind: 'person', match: null, candidates: [{ id: 'u-sana-ada1', name: 'Ada Sana-One' }, { id: 'u-sana-ada2', name: 'Ada Sana-Two' }] },
    '/api/social/plane/search': { results: [{ type: 'calllog', id: 'call-s|u-sana', title: 'Missed call from Sana Caller', href: '/social/calls', updatedAt: '2026-11-08T09:00:00Z' }], total: 1 },
    '/api/search': { results: [{ type: 'person', id: 'p-sana-x', title: 'Sana Search Hit', href: '/iq/search?selection=person%3Ap-sana-x' }], total: 1 },
    '/api/devbox/allowlist': { prefixes: ['git status'] },
    '/api/work/findings': { findings: [] },
    '/api/access-requests/mine': { items: [] },
    '/api/bots': { bots: [{ id: 'b-sana-1', name: 'sana-nightly-bot', enabled: true }, { id: 'b-sana-2', name: 'sana-nightly-check', enabled: true }, { id: 'b-sana-3', name: 'sana-parked-bot', enabled: false, pausedReason: 'Sana parked it' }] },
    // V2-8: the lab's own fleet read (one box Sana started, one a colleague did) and Sana's paired machines with Local compute's pick list.
    '/api/devbox/boxes': { boxes: [{ id: 'c-sana-alpha', label: 'sana-alpha-box', sessionId: SID('a'), status: 'running', ownerId: 'u-me' }, { id: 'c-sana-other', label: 'sana-other-box', sessionId: SID('b'), status: 'running', ownerId: 'u-sana-colleague' }] },
    '/api/local-compute/nodes': { nodes: [{ id: 'n-sana-1', label: 'sana-laptop', acceptJobs: true }, { id: 'n-sana-2', label: 'sana-parked-laptop', acceptJobs: false }] },
    // V2-10: the rows decide reads again (a delivered change, a pending transaction, a closed design, a proposal not open for review).
    '/api/sdlc/changes/cr-sana': { change: { id: 'cr-sana', title: 'Sana tighten retries', status: 'delivered' } },
    '/api/observability/approvals': { approvals: [{ approvalId: 'ha-sana', reason: 'Sana refund batch', payload: { amount: 1200 }, agentId: 'sana-agent' }] },
    '/api/lab/consults': { consults: [{ id: 'co-sana', question: 'Sana which branch?' }] },
    '/api/designs/d-sana': { id: 'd-sana', title: 'Sana cache design', status: 'superseded' },
    '/api/runbooks/proposals/rp-sana': { proposal: { id: 'rp-sana', status: 'withdrawn', kind: 'edit', proposed: { title: 'Sana deploy runbook' } }, runbook: { current_version: 3 }, can_review: false },
    '/api/work/suggestions': { suggestions: [{ workItemId: 'w-sana-1', title: 'Sana fix the login', initiativeName: 'Sana Alpha Initiative' }, { workItemId: 'w-sana-2', title: 'Sana fix the logout', initiativeName: 'Sana Alpha Initiative' }] },
  },
};

/** Eli: a Work member with no Social grant and no Computer Lab. */
const ELI: World = {
  allow: ['Search', 'VoiceNavigate'],
  social: false, socialRequestItemId: 'role:social:moderator',
  page: {
    path: '/iq/projects/p-eli-gamma', record: { ref: 'initiative:p-eli-gamma', title: 'Eli Gamma Initiative' }, rowsLabel: 'work items',
    rows: [{ ref: 'work-item:w-eli-1', title: 'Eli tidy the docs', status: 'open', priority: 'low', href: '/iq/projects/p-eli-gamma?item=w-eli-1' }],
  },
  computers: [],
  roster: { roster: () => [{ userId: 'u-eli-peer', name: 'Eli Lobby Person', status: 'online' }], lobby: () => ({ channel: 'orgiq:lobby', setStatus: () => {}, updateMetadata: () => {} }) },
  reads: {
    '/api/graph/projects': [{ id: 'p-eli-gamma', name: 'Eli Gamma Initiative' }],
    '/api/search': { results: [{ type: 'person', id: 'p-eli-x', title: 'Eli Search Hit', href: '/iq/search?selection=person%3Ap-eli-x' }], total: 1 },
    '/api/work/findings': { findings: [] },
    '/api/access-requests/mine': { items: [] },
  },
};

/** Arguments that drive each tool to a refusal, an ambiguity or a failure. */
const VARIANTS: Record<string, unknown[]> = {
  open: [{ page: 'bots' }, { page: 'nowhere' }, { page: 'search', params: { q: 'x' } }, { ref: 'person:p-not-kept' }, { ref: '1' }, { ref: 'initiative:p-sana-alpha' },
    { kind: 'initiative', name: 'Initiative' }, { kind: 'initiative', name: 'Nothing Like It' }, { kind: 'bot', name: 'sana' }, { kind: 'channel', name: 'x' }, { page: 'search', ref: '1' },
    // G21: rows of the page in view, by position (one past the page), by a name two rows share, by a name none has.
    { ref: '9', scope: 'this-page' }, { name: 'fix', scope: 'this-page' }, { name: 'Nothing Like It', scope: 'this-page' }, { ref: '1', kind: 'decision', scope: 'this-page' }],
  search: [{ query: 'kubernetes', type: 'person' }, { query: 'alpha', type: 'initiative' }, { query: 'x', type: 'not-a-type' }, { query: 'who decided it', answer: true }],
  list: [{ kind: 'initiative', filter: { q: 'nothing like it' } }, { kind: 'bot' }, { kind: 'channel' }, { kind: 'not-a-kind' }, { kind: 'finding', filter: { since: 'soon' } },
    { kind: 'work-item', scope: 'this-page' }, { kind: 'decision', scope: 'this-page' }],
  get: [{ ref: '1' }, { ref: 'initiative:p-unknown' }, { ref: 'bot:b-x', part: 'runs' }, { ref: 'person:p-sana-x' }, { ref: 'Sana Alpha Initiative' }],
  computer: [{ action: 'start', initiatives: ['Unknown Initiative'] }, { action: 'open-shell', computer: 'unknown-box' },
    { action: 'run', computer: 'unknown-box', phrase: 'status' }, { action: 'run', computer: 'unknown-box', phrase: 'commits-since', since: 'soon' },
    { action: 'run', computer: 'unknown-box' }, { action: 'stop', computer: 'unknown-box' }, { action: 'stop', computer: 'sana-alpha-box' }, { action: 'stop', computer: 'sana-other-box' },
    { action: 'hand-work', machine: 'nobody-laptop', job: 'x' }, { action: 'hand-work', machine: 'sana', job: 'nothing like it' }, { action: 'hand-work', machine: 'sana-laptop', job: 'sana' },
    { action: 'hand-work', machine: 'sana-parked-laptop', job: 'sana' }, { action: 'hand-work' }],
  budget: [{ scope: 'me' }, { scope: 'initiative', initiative: 'Nobody Initiative' }, { scope: 'initiative', initiative: 'Initiative' }, { scope: 'org' }, { scope: 'allocations' }, { scope: 'cost' }],
  summary: [{ kind: 'sweeps', since: 'whenever' }, { kind: 'sweeps', since: 'yesterday' }, { kind: 'fleet' }, { kind: 'live' }, { kind: 'ingest' }, { kind: 'rollup' }, { kind: 'today' }],
  message: [{ target: { kind: 'dm', name: 'Ada' }, text: 'hello' }, { target: { kind: 'team', name: 'nobody' }, text: 'x' }],
  call: [{ action: 'start', target: { kind: 'dm', name: 'Ada' } }, { action: 'join' }, { action: 'join', target: { kind: 'channel', name: 'nowhere' } }, { action: 'start' }],
  set_status: [{ status: 'away', message: 'out' }],
  access_request_status: [{ scope: 'approvals' }, { query: 'budget' }],
  queue_work: [{ kind: 'sweep', target: 'vibes' }, { kind: 'bot-run', target: 'nightly' }, { kind: 'bot-run', target: 'unknown thing' }, { kind: 'bot-run', target: 'sana parked' }, { kind: 'pipeline', target: 'ingest' },
    // V2-9: the new kinds, driven to an ambiguity (two of the persona's own rows), nothing found, or the gate.
    { kind: 'job', target: 'sana fix' }, { kind: 'job', target: 'payroll' }, { kind: 'dispatch', target: 'nothing like it' }, { kind: 'dispatch', target: 'Initiative', model: 'gpt-9' },
    { kind: 'finding-promote', target: 'x' }, { kind: 'finding-analyze', target: '3' }, { kind: 'change-address', target: 'anything' }, { kind: 'change-rereview', target: 'anything' },
    { kind: 'deck', target: 'Initiative' }, { kind: 'summarize', target: 'Initiative' }, { kind: 'diagram', target: 'Nothing Like It' }, { kind: 'doc', target: 'initiative:p-not-theirs' },
    // G21: page positions past the page, and a page row's name that matches two rows.
    { kind: 'finding-promote', target: 'the seventh', rows: [7] }, { kind: 'finding-promote', target: 'fix', scope: 'this-page' }],
  // V2-10: a decision on a row the persona's read holds (in a state that refuses), one it does not, a position, a missing note.
  decide: [{ ref: 'change:cr-sana', decision: 'approve' }, { ref: 'change:cr-not-theirs', decision: 'deliver' }, { ref: 'hitl-approval:ha-sana', decision: 'reject' },
    { ref: 'hitl-approval:ha-other', decision: 'approve' }, { ref: '1', decision: 'approve' }, { ref: 'consult:co-sana', decision: 'approve' },
    { ref: 'proposal:gp-x', decision: 'reject' }, { ref: 'design:d-sana', decision: 'approve' }, { ref: 'runbook-proposal:rp-sana', decision: 'accept' }, { ref: 'nonsense', decision: 'approve' },
    { ref: '5', decision: 'approve', scope: 'this-page' }, { ref: '1', decision: 'approve', scope: 'this-page' }],
  // V2-11: creates and updates driven to an ambiguity, nothing found, a refused field set or a state that refuses.
  create: [{ kind: 'work-item', fields: { initiative: 'Initiative', title: 'x' } }, { kind: 'work-item', fields: { initiative: 'Nothing Like It', title: 'x' } },
    { kind: 'comment', fields: { on: 'Sana Alpha', text: 'hi' } }, { kind: 'comment', fields: { on: 'work-item:w-not-theirs', text: 'hi' } },
    { kind: 'sprint', fields: { initiative: 'Initiative', name: 's', startsOn: '2026-11-10', endsOn: '2026-11-01' } }, { kind: 'saved-search', fields: { name: 'n', query: 'q', title: 'extra' } },
    { kind: 'channel', fields: { name: 'x' } }, { kind: 'delegation', fields: { delegate: 'x', window: '1d', reason: 'short' } }],
  update: [{ ref: 'work-item:w-sana-1', fields: { status: 'done' } }, { ref: 'bot:b-sana-3', fields: { paused: false, member: true } }, { ref: 'bot:b-not-theirs', fields: { paused: true } },
    { ref: 'finding:f-x', fields: { status: 'dismissed' } }, { ref: 'channel:general', fields: { member: true } }, { ref: '2', fields: { status: 'done' } }, { ref: 'nonsense', fields: { status: 'done' } },
    { ref: 'report:program', fields: { publish: true } }],
  activity: [{ scope: 'missed-calls' }, { scope: 'online', who: 'nobody' }, { scope: 'recent', since: 'tomorrow' }, { scope: 'work', who: 'Someone' }],
};

test('property: a refused, ambiguous or failed payload names only rows that persona\'s own reads returned, and nothing of the other persona', async () => {
  // Every tool an orgiq session is offered, from the catalogue the session is minted with.
  const mw = await middlewareVoice<{ toolsForTenant(t: string): Array<{ name: string }> }>('catalogue.ts');
  const names = mw.toolsForTenant('orgiq').map((t) => t.name);
  const stats = await assertPersonaProperty([['sana', SANA, ELI], ['eli', ELI, SANA]], names, VARIANTS);
  assert.ok(stats.checked > 60, `the property saw ${stats.checked} refusals, ambiguities and failures`);
  // V2-14: pinned per tool, and per queue_work kind (its refusal payloads).
  for (const tool of names) assert.ok((stats.perTool.get(tool) ?? 0) > 0, `${tool}: no refused, ambiguous or failed payload was checked`);
  for (const kind of queueWorkKinds('orgiq')) assert.ok((stats.perQueueKind.get(kind) ?? 0) > 0, `queue_work ${kind}: no refusal payload was checked`);
  assert.ok(stats.ambiguous > 0 && stats.rowsNamed > 0);
});

test('confirm-time DM: a refused or mismatched open sends nothing; an ambiguous name opens nothing', async () => {
  const channel = 'social:dm:u-ada:u-me';
  const resolved = { kind: 'person', match: { id: 'u-ada', name: 'Ada', channelId: channel, channel }, candidates: [{ id: 'u-ada', name: 'Ada' }] };
  for (const [status, body, outcome] of [[403, {}, 'refused'], [200, { channel: 'social:dm:u-ada:u-other' }, 'failed'], [500, {}, 'failed']] as const) {
    const sends: unknown[] = [];
    const log: LoggedRequest[] = [];
    const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
      log.push({ method: init?.method ?? 'GET', url, body: init?.body });
      if (url.includes('/resolve')) return new Response(JSON.stringify(resolved), { status: 200 });
      return new Response(JSON.stringify(body), { status });
    };
    const s: SocialAccess = { api: '/api/social/plane', unavailable: null, presence: null, deliveries: new Map(), send: async (x) => { sends.push(x); } };
    const ctx = toolContext({ fetch, social: s, socialRequestItemId: 'role:social:moderator' });
    const prepared = prepareToolCall('message', { target: { kind: 'dm', name: 'Ada' }, text: 'hi' }, ctx);
    assert.ok(prepared.ok);
    const planned = await planPreparedCall(prepared.call, ctx, VOICE_PLANNERS);
    assert.ok(planned && 'plan' in planned);
    const r = await runPreparedCall(prepared.call, ctx, VOICE_RUNNERS, planned.plan.data);
    assert.equal(r.outcome, outcome, `${status}`);
    assert.equal(sends.length, 0, `${status}: nothing sent`);
    assert.deepEqual(log.filter((l) => l.method === 'POST').map((l) => l.url), ['/api/social/dms']);
  }
  // Several Adas: candidates go back, no card, no POST at all.
  const log: string[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    log.push(`${init?.method ?? 'GET'} ${url}`);
    return new Response(JSON.stringify({ kind: 'person', match: null, candidates: [{ id: 'u1', name: 'Ada A' }, { id: 'u2', name: 'Ada B' }] }), { status: 200 });
  };
  const ctx = toolContext({ fetch, social: { api: '/api/social/plane', unavailable: null, presence: null, deliveries: new Map(), send: async () => {} } });
  const prepared = prepareToolCall('message', { target: { kind: 'dm', name: 'Ada' }, text: 'hi' }, ctx);
  assert.ok(prepared.ok);
  const planned = await planPreparedCall(prepared.call, ctx, VOICE_PLANNERS);
  assert.ok(planned && 'result' in planned && planned.result.output['kind'] === 'ambiguous');
  assert.ok(log.every((l) => l.startsWith('GET ')));
});

test('page context (G21): the note and a this-page list carry only the rows that persona\'s page rendered, never the other\'s', async () => {
  for (const [mine, other] of [[SANA, ELI], [ELI, SANA]] as const) {
    const foreign = [...strings([other.page])].filter((x) => x.length > 3 && !strings([mine.page]).has(x));
    const note = pageContextNote({ tenant: 'orgiq', pathname: mine.page.path, pageId: 'initiatives', page: mine.page });
    const { results } = await runAs(mine, 'world', 'list', { kind: 'work-item', scope: 'this-page' });
    const listed = JSON.stringify(results[0]!.output);
    assert.equal(results[0]!.outcome, 'done');
    for (const r of mine.page.rows) { assert.ok(note.includes(r.title)); assert.ok(listed.includes(r.ref)); }
    for (const f of foreign) { assert.ok(!note.includes(f), `the note names the other persona's "${f}"`); assert.ok(!listed.includes(f), `the list names the other persona's "${f}"`); }
  }
});
