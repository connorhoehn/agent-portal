// decide (catalogue v2, V2-10): a row a read of this session handed out, read
// again through its page's own list, decided by the page button's route with
// the card's toggle and note; the button's action before any request; the
// route's refusals said as the route said them; never twice.

import test from 'node:test';
import assert from 'node:assert/strict';
import { VOICE_PLANNERS, VOICE_RUNNERS } from '../actions.ts';
import { planPreparedCall, prepareToolCall, ResultMemory, runPreparedCall, type CardAnswer, type ConfirmPlan, type ToolResult } from '../tools.ts';
import { fakeFetch, route, toolContext, type Route } from './voiceHarness.ts';
import type { Action } from '../../capabilities';

async function decide(args: Record<string, unknown>, opts: { tenant: string; role?: string; allow: Action[]; routes: Route[]; answer?: CardAnswer; results?: ResultMemory }) {
  const { fetch, log } = fakeFetch(opts.routes);
  const ctx = toolContext({ tenant: opts.tenant, role: opts.role ?? 'tester', allow: opts.allow, fetch, ...(opts.results ? { results: opts.results } : {}) });
  const p = prepareToolCall('decide', args, ctx);
  assert.ok(p.ok, JSON.stringify(p));
  const planned = await planPreparedCall(p.call, ctx, VOICE_PLANNERS);
  if (!planned || 'result' in planned) return { card: null as ConfirmPlan | null, result: planned?.result as ToolResult, log, again: null as ToolResult | null };
  const writesBefore = log.filter((l) => l.method !== 'GET').length;
  assert.equal(writesBefore, 0, 'nothing is decided before the confirm');
  const result = await runPreparedCall(p.call, ctx, VOICE_RUNNERS, planned.plan.data, opts.answer);
  const again = await runPreparedCall(p.call, ctx, VOICE_RUNNERS, planned.plan.data, opts.answer);
  return { card: planned.plan, result, log, again };
}

const writes = (log: Array<{ method: string; url: string; body: unknown }>) => log.filter((l) => l.method !== 'GET').map((l) => [l.method, l.url, l.body]);

const ADA = { id: 'r-ada', requester: { displayName: 'Ada Okafor' }, beneficiary: { displayName: 'Ada Okafor' }, item: { title: 'SME in Work' }, requestedUsd: 120,
  steps: [{ step: 1, kind: 'manager', status: 'approved' }, { step: 2, kind: 'owner', status: 'current' }] };
const ACCESS = { tenant: 'access', allow: ['ViewAccess', 'DecideAccess'] as Action[] };

test('decide: an approver approves the request waiting on them, the current step, with the amount on the card; never twice', async () => {
  const r = await decide({ ref: 'approval:r-ada', decision: 'approve' }, { ...ACCESS, routes: [route('GET', '/api/access/approvals', 200, { items: [ADA] }), route('POST', '/api/access/requests/r-ada/steps/2/decide', 200, { id: 'r-ada' })] });
  assert.equal(r.card!.title, 'Approve SME in Work for Ada Okafor');
  assert.deepEqual(r.card!.detail, ['Step 2 (owner).', 'Requests $120.00.']);
  assert.deepEqual(r.card!.fields, { decision: 'approve', notePlaceholder: 'Reason (needed to reject)' });
  assert.equal(r.result.outcome, 'done');
  assert.equal(r.result.summary, 'Approved: SME in Work for Ada Okafor');
  assert.deepEqual(writes(r.log), [['POST', '/api/access/requests/r-ada/steps/2/decide', { decision: 'approve' }]], 'one decision: the retry is answered from the ledger');
  assert.equal(r.again!.output['alreadyDecided'], true);
});

test('decide: the card\'s toggle and note win on a click; a reject carries its note, and one without a reason sends nothing', async () => {
  const routes = [route('GET', '/api/access/approvals', 200, { items: [ADA] }), route('POST', '/api/access/requests/r-ada/steps/2/decide', 200, { id: 'r-ada' })];
  const flipped = await decide({ ref: 'request:r-ada', decision: 'approve' }, { ...ACCESS, routes, answer: { decision: 'reject', note: 'Not this quarter' } });
  assert.deepEqual(writes(flipped.log), [['POST', '/api/access/requests/r-ada/steps/2/decide', { decision: 'reject', comment: 'Not this quarter' }]]);
  assert.equal(flipped.result.output['decision'], 'reject');
  const bare = await decide({ ref: 'approval:r-ada', decision: 'reject' }, { ...ACCESS, routes });
  assert.equal(bare.card!.fields!.decision, 'reject', 'the toggle starts where the user said');
  assert.equal(bare.result.outcome, 'refused');
  assert.match(bare.result.summary, /needs a reason/);
  assert.deepEqual(writes(bare.log), []);
});

test('decide: a ref the persona\'s own read does not hold, a role without the button\'s action and a name are refused, with no write', async () => {
  const other = await decide({ ref: 'approval:r-not-mine', decision: 'approve' }, { ...ACCESS, routes: [route('GET', '/api/access/approvals', 200, { items: [ADA] })] });
  assert.equal(other.result.outcome, 'refused');
  assert.doesNotMatch(JSON.stringify(other.result.output), /Ada|SME/, 'the refusal names no row');
  const role = await decide({ ref: 'approval:r-ada', decision: 'approve' }, { tenant: 'access', allow: ['ViewAccess'], routes: [route('GET', '/api/access/approvals', 200, { items: [ADA] })] });
  assert.equal(role.result.outcome, 'refused');
  assert.equal(role.log.length, 0, 'refused before any read');
  const name = await decide({ ref: 'Ada Okafor', decision: 'approve' }, { ...ACCESS, routes: [] });
  assert.match(name.result.summary, /ref a result gave/);
  // A position names the row the last list kept.
  const kept = new ResultMemory();
  kept.keep([{ ref: 'approval:r-ada', title: 'SME in Work', href: '/access/requests/r-ada' }]);
  const byPosition = await decide({ ref: '1', decision: 'approve' }, { ...ACCESS, results: kept, routes: [route('GET', '/api/access/approvals', 200, { items: [ADA] }), route('POST', '/api/access/requests/r-ada/steps/2/decide', 200, {})] });
  assert.equal(byPosition.result.outcome, 'done');
  // Elsewhere the kind is not decided at all.
  const elsewhere = await decide({ ref: 'approval:r-ada', decision: 'approve' }, { tenant: 'orgiq', allow: ['DecideAccess'], routes: [] });
  assert.equal(elsewhere.result.outcome, 'refused');
});

test('decide: the author of an agent change is refused by the route, and the voice says why; an approved change is delivered', async () => {
  const author = await decide({ ref: 'change:cr-1', decision: 'approve' }, { tenant: 'orgiq', allow: ['DecideAgentChange', 'DeliverAgentChange', 'ManageDevbox'], routes: [
    route('GET', '/api/sdlc/changes/cr-1', 200, { change: { id: 'cr-1', title: 'Tighten retries', status: 'needs_approval' } }),
    route('POST', '/api/sdlc/changes/cr-1/decide', 409, { error: 'you caused this change, so someone else must decide it', gate: 'self-approval', confirmFlag: 'override' }),
  ] });
  assert.equal(author.card!.title, 'Approve "Tighten retries"');
  assert.equal(author.result.outcome, 'refused');
  assert.equal(author.result.summary, 'Not decided: you caused this change, so someone else must decide it.');
  assert.ok(!JSON.stringify(author.log.map((l) => l.body)).includes('override'), 'no override is ever sent');
  const deliver = await decide({ ref: 'change:cr-2', decision: 'deliver' }, { tenant: 'orgiq', allow: ['DeliverAgentChange', 'ManageDevbox'], routes: [
    route('GET', '/api/sdlc/changes/cr-2', 200, { change: { id: 'cr-2', title: 'Add the audit log', status: 'approved' } }),
    route('POST', '/api/sdlc/changes/cr-2/deliver', 200, { ok: true, prUrl: 'https://github.example/pr/9' }),
  ] });
  assert.equal(deliver.card!.fields, undefined, 'delivering is no decision: no toggle');
  assert.deepEqual(writes(deliver.log), [['POST', '/api/sdlc/changes/cr-2/deliver', {}]]);
  assert.equal(deliver.result.output['delivered'], true);
  assert.doesNotMatch(JSON.stringify(deliver.result.output), /github/, 'the PR link stays on the page');
});

test('decide: a pending transaction shows its amount and goes to the HITL route; the route\'s amount check refuses it as the route says', async () => {
  const routes = [route('GET', '/api/observability/approvals', 200, { approvals: [{ approvalId: 'ha-1', reason: 'Refund batch 42', payload: { amount: 1200 }, agentId: 'billing-agent' }] })];
  const ok = await decide({ ref: 'hitl-approval:ha-1', decision: 'reject', note: 'Wrong batch' }, { tenant: 'orgiq', allow: ['ApproveTransaction', 'ViewObservability'], routes: [...routes, route('POST', '/api/observability/approvals/ha-1/decision', 200, { status: 'REJECTED' })] });
  assert.deepEqual(ok.card!.detail, ['Amount: $1200.00.', 'Requested by billing-agent.', 'Note: Wrong batch']);
  assert.deepEqual(writes(ok.log), [['POST', '/api/observability/approvals/ha-1/decision', { decision: 'REJECTED', note: 'Wrong batch' }]]);
  const over = await decide({ ref: 'hitl-approval:ha-1', decision: 'approve' }, { tenant: 'orgiq', allow: ['ApproveTransaction', 'ViewObservability'], routes: [...routes, route('POST', '/api/observability/approvals/ha-1/decision', 403, { error: 'Forbidden', action: 'ApproveTransaction' })] });
  assert.equal(over.result.outcome, 'refused');
  assert.match(over.result.summary, /your role cannot decide that/);
});

test('decide: a pipelines step only for a role it names; a draft accepts or, flipped on the card, discards under its own action', async () => {
  const step = { id: 'job:j-1', title: 'Promote to prod', question: 'Ship build 77?', requiredRoles: ['pipeline-admin'] };
  const operator = await decide({ ref: 'approval:job:j-1', decision: 'approve' }, { tenant: 'pipelines', role: 'operator', allow: ['ApproveStep', 'ViewPipelines'], routes: [route('GET', '/api/pipelines/approvals', 200, { approvals: [step] })] });
  assert.match(operator.result.summary, /decided by pipeline-admin/);
  const admin = await decide({ ref: 'approval:job:j-1', decision: 'approve', note: 'ok' }, { tenant: 'pipelines', role: 'pipeline-admin', allow: ['ApproveStep', 'ViewPipelines'], routes: [route('GET', '/api/pipelines/approvals', 200, { approvals: [step] }), route('POST', '/api/pipelines/approvals/job%3Aj-1/decide', 200, {})] });
  assert.deepEqual(writes(admin.log), [['POST', '/api/pipelines/approvals/job%3Aj-1/decide', { decision: 'approve', note: 'ok' }]]);
  const draftRoutes = [route('GET', '/api/assessment/drafts/adr-1', 200, { runId: 'adr-1', kind: 'followups', phase: 'completed', decision: null, revision: 2, teamId: 'TEAM-001' }),
    route('POST', '/api/assessment/drafts/adr-1/accept', 200, { created: 3 }), route('POST', '/api/assessment/drafts/adr-1/discard', 200, { ok: true })];
  const accept = await decide({ ref: 'draft:adr-1', decision: 'accept' }, { tenant: 'assessment', allow: ['ScoreAssessment', 'RunAssessmentAgent'], routes: draftRoutes });
  assert.deepEqual(writes(accept.log), [['POST', '/api/assessment/drafts/adr-1/accept', { baseRevision: 2 }]]);
  const flipped = await decide({ ref: 'draft:adr-1', decision: 'accept' }, { tenant: 'assessment', allow: ['ScoreAssessment'], routes: draftRoutes, answer: { decision: 'reject', note: '' } });
  assert.equal(flipped.result.outcome, 'refused', 'discard is RunAssessmentAgent\'s, checked again at confirm');
  assert.deepEqual(writes(flipped.log), []);
});

test('decide: a consult is answered with the note (required), a runbook edit is accepted at the page\'s version, a new one is not', async () => {
  const consult = [route('GET', '/api/lab/consults', 200, { consults: [{ id: 'co-1', question: 'Which branch?' }] }), route('POST', '/api/lab/consults/co-1/answer', 200, { consult: {} })];
  const silent = await decide({ ref: 'consult:co-1', decision: 'approve' }, { tenant: 'orgiq', allow: ['DispatchAgentRun'], routes: consult });
  assert.match(silent.result.summary, /Say the answer as the note/);
  const answered = await decide({ ref: 'consult:co-1', decision: 'approve', note: 'Use main' }, { tenant: 'orgiq', allow: ['DispatchAgentRun'], routes: consult });
  assert.deepEqual(writes(answered.log), [['POST', '/api/lab/consults/co-1/answer', { answer: 'Use main' }]]);
  const edit = await decide({ ref: 'runbook-proposal:rp-1', decision: 'accept' }, { tenant: 'orgiq', allow: ['ReviewRunbook'], routes: [
    route('GET', '/api/runbooks/proposals/rp-1', 200, { proposal: { id: 'rp-1', status: 'open', kind: 'edit', proposed: { title: 'Deploy runbook' } }, runbook: { current_version: 4 }, can_review: true }),
    route('POST', '/api/runbooks/proposals/rp-1/accept', 200, {})] });
  assert.deepEqual(writes(edit.log), [['POST', '/api/runbooks/proposals/rp-1/accept', { expected_version: 4 }]]);
  const fresh = await decide({ ref: 'runbook-proposal:rp-2', decision: 'accept' }, { tenant: 'orgiq', allow: ['ReviewRunbook'], routes: [
    route('GET', '/api/runbooks/proposals/rp-2', 200, { proposal: { id: 'rp-2', status: 'open', kind: 'new', proposed: { title: 'A new runbook' } }, runbook: null, can_review: true })] });
  assert.match(fresh.result.summary, /scope is chosen/);
});

// ── create and update (V2-11) ──

async function act(tool: 'create' | 'update', args: Record<string, unknown>, opts: { tenant: string; allow: Action[]; routes: Route[]; results?: ResultMemory; social?: boolean }) {
  const { fetch, log } = fakeFetch(opts.routes);
  const ctx = toolContext({ tenant: opts.tenant, allow: opts.allow, fetch, ...(opts.results ? { results: opts.results } : {}),
    ...(opts.social ? { social: { api: '/api/social/plane', unavailable: null, presence: null, deliveries: new Map(), send: async () => {} } } : {}) });
  const p = prepareToolCall(tool, args, ctx);
  if (!p.ok) return { card: null as ConfirmPlan | null, result: p.result, log, again: null as ToolResult | null };
  const planned = await planPreparedCall(p.call, ctx, VOICE_PLANNERS);
  if (!planned || 'result' in planned) return { card: null as ConfirmPlan | null, result: planned?.result as ToolResult, log, again: null as ToolResult | null };
  assert.deepEqual(writes(log).filter(([, url]) => !String(url).endsWith('/preview')), [], `${tool}: nothing is written before the confirm`);
  const result = await runPreparedCall(p.call, ctx, VOICE_RUNNERS, planned.plan.data);
  const again = await runPreparedCall(p.call, ctx, VOICE_RUNNERS, planned.plan.data);
  return { card: planned.plan, result, log, again };
}

const CATALOG = { items: [{ id: 'role:orgiq:sme', title: 'SME in Work', kind: 'role' }, { id: 'capability:orgiq:budgets-read', title: 'Budget visibility', kind: 'capability' }] };
const PREVIEW = { item: { id: 'role:orgiq:sme' }, steps: [{ step: 1, kind: 'manager', eligible: [{ id: 'u-m' }] }, { step: 2, kind: 'owner', eligible: [{ id: 'u-o' }, { id: 'u-p' }] }], sod: { verdict: 'clear', conflicts: [] }, refusal: null };

test('create: a requester files a request from the catalogue; the card is the route\'s own preview, and it is filed once', async () => {
  const args = { kind: 'access-request', fields: { item: 'SME', justification: 'I review the platform team\'s agent changes every week.', duration: '30d' } };
  const r = await act('create', args, { tenant: 'access', allow: ['ViewAccess', 'RequestAccess'], routes: [
    route('GET', '/api/access/catalog', 200, CATALOG), route('POST', '/api/access/requests/preview', 200, PREVIEW), route('POST', '/api/access/requests', 201, { id: 'req-9' })] });
  assert.equal(r.card!.title, 'Request SME in Work for 30d');
  assert.deepEqual(r.card!.detail, ['I review the platform team\'s agent changes every week.', 'Approvers: step 1: manager (1 can decide); step 2: owner (2 can decide).']);
  assert.equal(r.result.outcome, 'done');
  assert.deepEqual(writes(r.log), [
    ['POST', '/api/access/requests/preview', { itemId: 'role:orgiq:sme', duration: '30d' }],
    ['POST', '/api/access/requests', { itemId: 'role:orgiq:sme', justification: 'I review the platform team\'s agent changes every week.', duration: '30d' }],
  ], 'the preview, then one submit; the retry is answered from the ledger');
  assert.equal(r.again!.output['already'], true);
  // The preview's refusal ends it with no card; a short justification never reaches the route.
  const held = await act('create', args, { tenant: 'access', allow: ['ViewAccess', 'RequestAccess'], routes: [
    route('GET', '/api/access/catalog', 200, CATALOG), route('POST', '/api/access/requests/preview', 200, { ...PREVIEW, refusal: { error: 'You already hold SME in Work' } })] });
  assert.equal(held.card, null);
  assert.match(held.result.summary, /already hold/);
  const short = await act('create', { kind: 'access-request', fields: { item: 'SME', justification: 'need it', duration: '7d' } }, { tenant: 'access', allow: ['ViewAccess', 'RequestAccess'], routes: [] });
  assert.match(short.result.summary, /at least 20 characters/);
  assert.equal(short.log.length, 0);
  // Standing access is chosen on the page (its own reason), never by voice.
  assert.equal(prepareToolCall('create', { kind: 'access-request', fields: { item: 'SME', justification: 'x'.repeat(30), duration: 'standing' } }, toolContext({ tenant: 'access' })).ok, false);
});

test('create: one field set per kind; a work item on an initiative by name; a comment only on a ref', async () => {
  const extra = await act('create', { kind: 'saved-search', fields: { name: 'k8s', query: 'kubernetes', title: 'nope' } }, { tenant: 'orgiq', allow: ['Search'], routes: [] });
  assert.match(extra.result.summary, /takes name, query; not title/);
  const item = await act('create', { kind: 'work-item', fields: { initiative: 'auth migration', title: 'Rotate the signing keys', type: 'bug' } }, { tenant: 'orgiq', allow: ['DispatchAgentRun'], routes: [
    route('GET', '/api/graph/projects', 200, [{ id: 'p-auth', name: 'Auth Migration' }]), route('POST', '/api/graph/work-items', 201, { id: 'w-77' })] });
  assert.equal(item.card!.title, 'Create a bug on Auth Migration');
  assert.deepEqual(writes(item.log), [['POST', '/api/graph/work-items', { projectId: 'p-auth', type: 'bug', title: 'Rotate the signing keys', priority: 'medium' }]]);
  const byName = await act('create', { kind: 'comment', fields: { on: 'the signing keys', text: 'Looks good' } }, { tenant: 'orgiq', allow: [], routes: [] });
  assert.match(byName.result.summary, /by the ref a result gave/);
  const comment = await act('create', { kind: 'comment', fields: { on: 'work-item:w-77', text: 'Rotated in staging; prod next.' } }, { tenant: 'orgiq', allow: [], routes: [
    route('GET', '/api/graph/work', 200, [{ id: 'w-77', title: 'Rotate the signing keys', projectId: 'p-auth' }]), route('POST', '/api/graph/work-items/w-77/comments', 201, { id: 'c-1' })] });
  assert.deepEqual(comment.card!.detail, ['Rotated in staging; prod next.', 'Everyone on the initiative reads it.']);
  assert.deepEqual(writes(comment.log), [['POST', '/api/graph/work-items/w-77/comments', { body: 'Rotated in staging; prod next.' }]]);
  // A role without the form's action is refused before any read.
  const role = await act('create', { kind: 'sprint', fields: { initiative: 'Auth', name: 'S12', startsOn: '2026-11-10', endsOn: '2026-11-24' } }, { tenant: 'orgiq', allow: [], routes: [] });
  assert.equal(role.result.outcome, 'refused');
  assert.equal(role.log.length, 0);
  // Social's kinds are created in Social only.
  const elsewhere = await act('create', { kind: 'channel', fields: { name: 'retro' } }, { tenant: 'orgiq', allow: ['ManageChannels'], routes: [] });
  assert.equal(elsewhere.result.outcome, 'refused');
});

test('create: a delegation names someone who can decide, for one of the page\'s windows, timed when it is sent', async () => {
  const r = await act('create', { kind: 'delegation', fields: { delegate: 'priya', window: '3d', reason: 'Out at the offsite until Thursday' } }, { tenant: 'access', allow: ['DecideAccess'], routes: [
    route('GET', '/api/access/delegates', 200, { items: [{ id: 'u-priya', displayName: 'Priya Natarajan' }, { id: 'u-omar', displayName: 'Omar Haddad' }] }), route('POST', '/api/access/delegations', 201, { id: 'd-1' })] });
  assert.equal(r.card!.title, 'Delegate your approvals to Priya Natarajan for 3 days');
  const sent = writes(r.log)[0]![2] as { delegateId: string; startsAt: string; endsAt: string; reason: string };
  assert.equal(sent.delegateId, 'u-priya');
  assert.equal(Date.parse(sent.endsAt) - Date.parse(sent.startsAt), 72 * 3_600_000);
  assert.equal(writes(r.log).length, 1);
});

test('update: a work item moves to in progress through the page\'s PATCH; a move the server refuses is refused first', async () => {
  const routes = [route('GET', '/api/graph/work', 200, [{ id: 'w-9', title: 'Fix the retry storm', status: 'open', projectId: 'p-auth' }]), route('PATCH', '/api/graph/work-items/w-9', 200, { id: 'w-9', status: 'in_progress' })];
  const r = await act('update', { ref: 'work-item:w-9', fields: { status: 'in_progress' } }, { tenant: 'orgiq', allow: ['DispatchAgentRun'], routes });
  assert.equal(r.card!.title, 'Move "Fix the retry storm" to in progress');
  assert.deepEqual(writes(r.log), [['PATCH', '/api/graph/work-items/w-9', { status: 'in_progress' }]]);
  const jump = await act('update', { ref: 'work-item:w-9', fields: { status: 'done' } }, { tenant: 'orgiq', allow: ['DispatchAgentRun'], routes });
  assert.match(jump.result.summary, /from there it moves to in progress or cancelled/);
  const two = await act('update', { ref: 'work-item:w-9', fields: { status: 'done', paused: true } }, { tenant: 'orgiq', allow: ['DispatchAgentRun'], routes });
  assert.match(two.result.summary, /takes one change here: status/);
});

test('update: joining a channel needs PostMessage, the route\'s own gate; leaving needs only the Social grant; nothing is sent without them', async () => {
  const routes = [route('GET', '/api/social/channels', 200, { channels: [{ slug: 'platform', name: 'platform' }] }),
    route('POST', '/api/social/channels/platform/join', 200, {}), route('POST', '/api/social/channels/platform/leave', 200, {})];
  const join = await act('update', { ref: 'channel:platform', fields: { member: true } }, { tenant: 'social', allow: ['ViewSocial', 'PostMessage'], routes });
  assert.deepEqual(writes(join.log), [['POST', '/api/social/channels/platform/join', {}]]);
  const noPost = await act('update', { ref: 'channel:platform', fields: { member: true } }, { tenant: 'social', allow: ['ViewSocial'], routes });
  assert.equal(noPost.result.outcome, 'refused');
  assert.deepEqual(writes(noPost.log), []);
  const leave = await act('update', { ref: 'channel:platform', fields: { member: false } }, { tenant: 'social', allow: ['ViewSocial'], routes });
  assert.deepEqual(writes(leave.log), [['POST', '/api/social/channels/platform/leave', {}]]);
  // Outside Social, the plane's twins with the grant; without it the request offer, and nothing read.
  const plane = await act('update', { ref: 'channel:platform', fields: { member: false } }, { tenant: 'orgiq', allow: ['Search'], social: true, routes: [
    route('GET', '/api/social/plane/channels', 200, { channels: [{ slug: 'platform', name: 'platform' }] }), route('POST', '/api/social/plane/channels/platform/leave', 200, {})] });
  assert.deepEqual(writes(plane.log), [['POST', '/api/social/plane/channels/platform/leave', {}]]);
  const noGrant = await act('update', { ref: 'channel:platform', fields: { member: false } }, { tenant: 'orgiq', allow: ['Search'], routes: [] });
  assert.equal(noGrant.result.outcome, 'refused');
  assert.equal(noGrant.log.length, 0);
});

test('update: pause a bot, withdraw a request only when it can be, cancel a queued pipeline run, publish the program report', async () => {
  const bot = await act('update', { ref: 'bot:b-1', fields: { paused: true } }, { tenant: 'orgiq', allow: ['ManageBots'], routes: [route('GET', '/api/bots', 200, { bots: [{ id: 'b-1', name: 'finops-daily' }] }), route('POST', '/api/bots/b-1/pause', 200, {})] });
  assert.deepEqual(writes(bot.log), [['POST', '/api/bots/b-1/pause', {}]]);
  const reqRoutes = (can: boolean) => [route('GET', '/api/access/requests', 200, { items: [{ id: 'r-1', item: { title: 'SME in Work' }, status: 'submitted', can: { withdraw: can } }] }), route('POST', '/api/access/requests/r-1/withdraw', 200, {})];
  const withdraw = await act('update', { ref: 'request:r-1', fields: { status: 'withdrawn' } }, { tenant: 'access', allow: ['ViewAccess'], routes: reqRoutes(true) });
  assert.deepEqual(writes(withdraw.log), [['POST', '/api/access/requests/r-1/withdraw', {}]]);
  const notMine = await act('update', { ref: 'request:r-1', fields: { status: 'withdrawn' } }, { tenant: 'access', allow: ['ViewAccess'], routes: reqRoutes(false) });
  assert.equal(notMine.result.outcome, 'refused');
  const run = await act('update', { ref: 'run:run-4', fields: { status: 'cancelled' } }, { tenant: 'pipelines', allow: ['ViewPipelines', 'CancelRun'], routes: [
    route('GET', '/api/pipelines/runs', 200, { runs: [{ id: 'run-4', definitionId: 'runbook:nightly', status: 'queued' }] }), route('POST', '/api/pipelines/runs/run-4/cancel', 200, {})] });
  assert.deepEqual(writes(run.log), [['POST', '/api/pipelines/runs/run-4/cancel', {}]]);
  const report = await act('update', { ref: 'report:program', fields: { publish: true } }, { tenant: 'assessment', allow: ['PublishReport'], routes: [route('POST', '/api/assessment/reports/publish', 201, {})] });
  assert.equal(report.card!.title, 'Publish the program report');
  assert.deepEqual(writes(report.log), [['POST', '/api/assessment/reports/publish', {}]]);
  const noPublish = await act('update', { ref: 'report:program', fields: { publish: true } }, { tenant: 'assessment', allow: [], routes: [] });
  assert.equal(noPublish.result.outcome, 'refused');
});
