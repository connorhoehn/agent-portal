// Run with:  cd portal && node --test 'src/components/chat/__tests__/conversationAgent.test.ts'

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AGENT_PIPELINE_ID, CONVERSATION_AGENT_BASE, approvalExpiryNote, canDecideApproval, isWaitingApproval, SOCIAL_AGENT_BASE, agentApi, agentCommand, agentRunStatusOf, canDecide, canStop, conversationAgentApi,
  isAgentPipeline, isSettled, planMarkdown, stepLinkView, type AgentPlan, type AgentRunStatusBody,
} from '../conversationAgent.ts';
import { CONVERSATION_CHAT_COMMANDS, socialChatCommands, withoutAgent } from '../chatCommandRegistry.ts';
import { isLiveFlowRunId } from '../../../hooks/flowRunFollower.ts';

const plan = (over: Partial<AgentPlan> = {}): AgentPlan => ({
  goal: 'wrap up', summary: 'Summarize, then draw it.', fallback: false,
  steps: [
    { kind: 'summarize', title: 'Summarize the thread', instruction: '', acceptance: 'Quotes the messages.' },
    { kind: 'diagram', title: 'Draw the flow', instruction: '', acceptance: 'One box per key message.' },
  ], ...over,
});
const status = (over: Partial<AgentRunStatusBody> = {}): AgentRunStatusBody => ({
  runId: 'sag-1', channel: 'social:ch:general', stage: 'awaiting-approval', phase: 'completed', error: null, plan: plan(),
  steps: [{ id: 's1', label: 'Summarize the thread', status: 'pending' }, { id: 's2', label: 'Draw the flow', status: 'pending' }], ...over,
});

test('each mount calls its own routes, and the goal travels as the argument text', async () => {
  const calls: Array<[string, string, unknown]> = [];
  const stub = (async (url: string, init?: RequestInit) => { calls.push([init?.method ?? 'GET', url, init?.body ? JSON.parse(String(init.body)) : null]); return { ok: true, json: async () => ({ runId: 'x', stage: 'running' }) }; }) as unknown as typeof fetch;
  const social = agentApi(SOCIAL_AGENT_BASE);
  await social.start('social:ch:x', 'wrap up', stub); await social.status('sag-1', stub); await social.approve('sag-1', stub); await social.discard('sag-1', stub);
  await conversationAgentApi.start('orgiq:initiative:p-auth', 'goal', stub);
  assert.deepEqual(calls, [
    ['POST', '/api/chat/commands/agent/run', { channel: 'social:ch:x', text: 'wrap up' }],
    ['GET', '/api/chat/commands/agent/runs/sag-1', null],
    ['POST', '/api/chat/commands/agent/runs/sag-1/approve', { requestId: 'rq-sag-1' }],
    ['POST', '/api/chat/commands/agent/runs/sag-1/discard', {}],
    ['POST', `${CONVERSATION_AGENT_BASE}/run`, { channel: 'orgiq:initiative:p-auth', text: 'goal' }],
  ]);
});

test('a running loop offers Stop, a decided plan does not', () => {
  assert.equal(canStop(status({ stage: 'running' })), true);
  assert.equal(canStop(status()), false);
});

test('a refusal surfaces the server\'s own message', async () => {
  const refuse = (async () => ({ ok: false, json: async () => ({ error: 'You cannot post to this conversation' }) })) as unknown as typeof fetch;
  await assert.rejects(agentApi('/x').start('c', 'g', refuse), /You cannot post to this conversation/);
  const empty = (async () => ({ ok: false, json: async () => { throw new Error('no body'); } })) as unknown as typeof fetch;
  await assert.rejects(agentApi('/x').approve('r', empty), /could not be approved/);
});

test('/agent is a private command in every list that has /summarize, and readers without the posting right get none', () => {
  const triggers = (list: readonly { trigger: string }[]) => list.map(c => c.trigger);
  assert.ok(triggers(CONVERSATION_CHAT_COMMANDS).includes('/summarize') && triggers(CONVERSATION_CHAT_COMMANDS).includes('/agent'));
  const social = socialChatCommands(CONVERSATION_CHAT_COMMANDS[0]!, CONVERSATION_CHAT_COMMANDS[0]!);
  assert.ok(triggers(social).includes('/agent'));
  for (const list of [CONVERSATION_CHAT_COMMANDS, social]) assert.ok(!triggers(withoutAgent(list)).includes('/agent'));
  assert.equal(triggers(withoutAgent(CONVERSATION_CHAT_COMMANDS)).length, triggers(CONVERSATION_CHAT_COMMANDS).length - 1);
});

test('the command starts a run and returns a private card, not a message', async () => {
  const api = { ...agentApi('/x'), start: async (channel: string, text: string) => ({ runId: `sag-${channel}-${text}`, pipelineId: AGENT_PIPELINE_ID, card: { kind: 'agent-run' } }) };
  const out = await agentCommand(api).run({ channel: 'c', text: '/agent do it', argumentText: 'do it' } as never);
  assert.deepEqual(out, { kind: 'run', runId: 'sag-c-do it', pipelineId: AGENT_PIPELINE_ID, card: { kind: 'agent-run' }, echo: '/agent do it', visibility: 'private' });
  assert.ok(isAgentPipeline(AGENT_PIPELINE_ID) && !isAgentPipeline('conversation-doc'));
});

test('Approve / Discard are offered only while a non-empty plan waits', () => {
  assert.equal(canDecide(status()), true);
  for (const stage of ['planning', 'running', 'done', 'stopped', 'discarded', 'failed'] as const) assert.equal(canDecide(status({ stage })), false);
  assert.equal(canDecide(status({ plan: null })), false);
  assert.equal(canDecide(status({ plan: plan({ steps: [] }) })), false);
});

test('the card follows a plan to its decision, and the plan lists each step with its acceptance', () => {
  assert.equal(isSettled(status()), true);
  assert.equal(isSettled(status({ stage: 'planning', phase: 'running' })), false);
  assert.equal(isSettled(status({ stage: 'running', phase: 'running' })), false);
  const md = planMarkdown(plan());
  assert.match(md, /1\. \*\*Summarize\*\*: Summarize the thread\n {3}- Done when: Quotes the messages\./);
  assert.match(md, /2\. \*\*Diagram\*\*: Draw the flow/);
});

test('the run card says it is waiting, shows the stopped step\'s reason, and flags a fallback plan', () => {
  assert.match(agentRunStatusOf(status()).detail ?? '', /Nothing runs until you approve/);
  assert.equal(agentRunStatusOf(status()).phase, 'running');
  const stopped = status({ stage: 'stopped', phase: 'failed', error: 'Step 2 stopped the loop: 429 Wait', steps: [
    { id: 's1', label: 'Summarize the thread', status: 'completed' }, { id: 's2', label: 'Draw the flow', status: 'failed', detail: '429 Wait for your running requests to finish' }] });
  assert.equal(agentRunStatusOf(stopped).phase, 'failed');
  assert.match(agentRunStatusOf(stopped).detail ?? '', /Draw the flow: 429 Wait/);
  assert.match(agentRunStatusOf(status({ plan: plan({ fallback: true, unavailable: 'forbidden' }) })).detail ?? '', /one-step plan.*|not available.*forbidden/);
  assert.equal(agentRunStatusOf(status({ stage: 'running', phase: 'running', steps: [{ id: 's1', label: 'Summarize the thread', status: 'running' }] })).stepLabel, 'Summarize the thread');
});

test('/agent runs follow live over their own private channel', () => {
  for (const p of ['sag', 'oag', 'aag', 'pag']) assert.equal(isLiveFlowRunId(`${p}-6f1c2a4e-1111-4222-8333-444455556666`), true);
});

test('the plan names creation steps, and a made link is drawn by what it opens', () => {
  const md = planMarkdown(plan({ steps: [
    { kind: 'document:create', title: 'Kickoff notes', instruction: '', acceptance: 'The document exists.', body: '# Notes' },
    { kind: 'meeting:create', title: 'Kickoff meeting', instruction: '', acceptance: 'A meeting is open.' },
  ] }));
  assert.match(md, /1\. \*\*Create document\*\*: Kickoff notes/);
  assert.match(md, /2\. \*\*Create meeting\*\*: Kickoff meeting/);
  assert.deepEqual(stepLinkView({ kind: 'document', label: 'Notes', href: '/assessment/workspace?doc=draft%3A1' }), { noun: 'Document', label: 'Notes', open: 'route', href: '/assessment/workspace?doc=draft%3A1' });
  assert.deepEqual(stepLinkView({ kind: 'document', label: 'k.md', href: '/api/uploads/abc' }), { noun: 'Document', label: 'k.md', open: 'file', href: '/api/uploads/abc' });
  assert.deepEqual(stepLinkView({ kind: 'room', label: 'Kickoff', href: '/social/rooms?room=kickoff' }), { noun: 'Room', label: 'Kickoff', open: 'route', href: '/social/rooms?room=kickoff' });
  assert.deepEqual(stepLinkView({ kind: 'huddle', label: 'Kickoff', lobbyName: 'assessment:doc:d-1' }), {
    noun: 'Huddle', label: 'Kickoff', open: 'none', note: 'Lobby assessment:doc:d-1. Start it from the Huddle button in the footer.' });
  // An off-site or protocol-relative href is never made clickable.
  assert.equal(stepLinkView({ kind: 'document', label: 'x', href: '//evil.example/x' }).open, 'none');
  assert.equal(stepLinkView({ kind: 'document', label: 'x', href: 'https://evil.example/x' }).open, 'none');
});

test('a step that made something reads as completed in the run card', () => {
  const s = status({ stage: 'done', phase: 'completed', steps: [{ id: 's1', label: 'Kickoff notes', status: 'completed', link: { kind: 'document', label: 'Notes', href: '/api/uploads/a' } }] });
  assert.equal(agentRunStatusOf(s).phase, 'completed');
  assert.equal(isSettled(s), true);
});

// ─── approval steps (HITL) ──────────────────────────────────────────────────

const approval = { stepId: 's2', question: 'Draft the page?', since: '2026-10-06T12:00:00.000Z', expiresAt: '2026-10-07T12:00:00.000Z' };
const paused = (over: Partial<AgentRunStatusBody> = {}): AgentRunStatusBody => status({
  stage: 'waiting-approval', phase: 'running', approval,
  plan: plan({ steps: [
    { kind: 'summarize', title: 'Summarize', instruction: '', acceptance: 'Quotes.' },
    { kind: 'approval', title: 'Check first', instruction: 'Draft the page?', acceptance: 'You decided.' },
    { kind: 'doc', title: 'Draft the page', instruction: '', acceptance: 'A page exists.' },
  ] }),
  steps: [{ id: 's1', label: 'Summarize', status: 'completed' }, { id: 's2', label: 'Check first', status: 'running' }, { id: 's3', label: 'Draft the page', status: 'pending' }], ...over,
});

test('the approval calls: the waiting list is read per conversation, a decision carries one request id per run and verb and the optional reason', async () => {
  const calls: Array<[string, string, unknown]> = [];
  const stub = (async (url: string, init?: RequestInit) => { calls.push([init?.method ?? 'GET', url, init?.body ? JSON.parse(String(init.body)) : null]); return { ok: true, json: async () => ({ runs: [], runId: 'x', stage: 'running' }) }; }) as unknown as typeof fetch;
  const api = agentApi(SOCIAL_AGENT_BASE);
  assert.deepEqual(await api.waiting('social:ch:general', stub), []);
  await api.decideApproval('sag-1', 'approve', undefined, stub);
  await api.decideApproval('sag-1', 'reject', 'Too early', stub);
  assert.deepEqual(calls, [
    ['GET', '/api/chat/commands/agent/waiting?channel=social%3Ach%3Ageneral', null],
    ['POST', '/api/chat/commands/agent/runs/sag-1/approval/approve', { requestId: 'ap-sag-1-approve' }],
    ['POST', '/api/chat/commands/agent/runs/sag-1/approval/reject', { requestId: 'ap-sag-1-reject', reason: 'Too early' }],
  ]);
});

test('a refused decision surfaces the server\'s own message (a moved epoch reads as the 403 text)', async () => {
  const refuse = (async () => ({ ok: false, json: async () => ({ error: 'authorization-unavailable: your access changed, so the loop was not continued. Start /agent again.' }) })) as unknown as typeof fetch;
  await assert.rejects(agentApi('/x').decideApproval('r', 'approve', undefined, refuse), /authorization-unavailable/);
  const empty = (async () => ({ ok: false, json: async () => { throw new Error('no body'); } })) as unknown as typeof fetch;
  await assert.rejects(agentApi('/x').decideApproval('r', 'reject', undefined, empty), /rejection could not be saved/);
});

test('card states: requester and approver may decide, a reader may not; only a paused loop with its question prompts', () => {
  assert.equal(canDecideApproval('requester'), true);
  assert.equal(canDecideApproval('approver'), true);
  assert.equal(canDecideApproval('reader'), false);
  assert.equal(isWaitingApproval(paused()), true);
  assert.equal(isWaitingApproval(paused({ approval: null })), false);
  assert.equal(isWaitingApproval(status()), false);
  // The plan decision (Approve / Discard) and the step decision are different states, never both.
  assert.equal(canDecide(paused()), false);
  assert.equal(canStop(paused()), false);
  assert.equal(isSettled(paused()), true);
});

test('the run card reads a paused loop as running with the question, and a rejected one as failed with its reason', () => {
  const run = agentRunStatusOf(paused());
  assert.equal(run.phase, 'running');
  assert.equal(run.detail, 'Waiting for a decision: Draft the page?');
  assert.equal(run.stepLabel, 'Check first');
  const rejected = agentRunStatusOf(paused({ stage: 'stopped', phase: 'failed', approval: null, error: 'Step 2 stopped the loop: rejected by u-sana: Too early',
    steps: [{ id: 's1', label: 'Summarize', status: 'completed' }, { id: 's2', label: 'Check first', status: 'failed', detail: 'rejected by u-sana: Too early' }, { id: 's3', label: 'Draft the page', status: 'pending' }] }));
  assert.equal(rejected.phase, 'failed');
  assert.equal(rejected.detail, 'Check first: rejected by u-sana: Too early');
});

test('the expiry note counts down to the server\'s 24 h deadline', () => {
  const at = (iso: string) => Date.parse(iso);
  assert.equal(approvalExpiryNote(approval, at('2026-10-06T12:00:00.000Z')), 'Expires in 24 h with no decision.');
  assert.equal(approvalExpiryNote(approval, at('2026-10-07T11:00:00.000Z')), 'Expires in 60 min with no decision.');
  assert.equal(approvalExpiryNote(approval, at('2026-10-07T11:59:30.000Z')), 'Expires in under a minute with no decision.');
  assert.equal(approvalExpiryNote(approval, at('2026-10-08T00:00:00.000Z')), 'Expires in under a minute with no decision.');
  assert.equal(approvalExpiryNote({ expiresAt: 'nope' }), '');
});

test('the plan lists an approval step by its own label', () => {
  assert.match(planMarkdown(paused().plan!), /\*\*Approval\*\*: Check first/);
});
