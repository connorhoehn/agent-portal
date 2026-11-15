// The decision watcher (docs/meeting-consent-design.md, "Detection", package 5): the scripted detector on fixed transcripts, the
// pause and its cap, the caps and dedupe, suppression after "Not a decision", a malformed answer, the Bedrock request as text, the
// spend booked, and nothing after a pause or a stop. Names and transcripts are fictional. No network: Bedrock's send is faked.
jest.mock('../../../config.js', () => ({ config: { mock: { aurora: true }, region: 'us-east-1', meetingAssistant: { enabled: true, transcriptRetentionDays: 30 } } }));
import { Fence } from '../../untrusted-text.js';
import { MemoryAssistantStore } from '../store.js';
import { createProposal, respondToProposal } from '../proposals.js';
import {
  buildDecisionRequest, DECISION_SYSTEM_PROMPT, parseDecisionAnswer, type DecisionCheckInput,
} from '../decision-prompt.js';
import { BedrockDecisionModel, ScriptedDecisionModel, scriptedAnswer, type DecisionModel, type ModelCheckResult } from '../decision-model.js';
import { DecisionWatcher, MAX_PER_CALL, MAX_WAIT_MS, MIN_GAP_MS, QUIET_MS, TRIGGER, capNotice, noticeIfCapReached, similarity, type WatcherDeps } from '../decision-watcher.js';
import { LineIntake } from '../intake.js';
import { MockTranscriptSource } from '../transcript-source.js';
import { watcherBudgetLeft, type WatcherSpend } from '../spend.js';
import type { AssistantRecord, TranscriptLine } from '../types.js';

const NAMES: Record<string, string> = { 'u-priya': 'Priya Shah', 'u-sam': 'Sam Ortiz', 'u-lee': 'Lee Park' };
const line = (seq: number, speaker: string, text: string): { seq: number; speaker: string; text: string } => ({ seq, speaker, text });
const input = (...lines: ReturnType<typeof line>[]): DecisionCheckInput => ({ lines, roster: ['Priya Shah', 'Sam Ortiz', 'Lee Park', 'Lee'] });

describe('the scripted detector on fixed transcripts', () => {
  it('chatter is nothing', () => {
    expect(scriptedAnswer(input(line(1, 'Sam Ortiz', 'the build was slow again this morning'), line(2, 'Lee Park', 'yeah the cache was cold'), line(3, 'Priya Shah', 'how was the offsite?'))).isDecision).toBe(false);
  });

  it('a proposal agreed by another person is one decision, with both lines as evidence', () => {
    const a = scriptedAnswer(input(line(4, 'Sam Ortiz', "Let's cut over the smallest tenants first."), line(5, 'Priya Shah', 'Agreed.')));
    expect(a).toEqual({ isDecision: true, outcome: 'decision', statement: 'Cut over the smallest tenants first', named: [], evidence: [4, 5], confidence: 0.9 });
  });

  it('one person deciding alone is nothing', () => {
    expect(scriptedAnswer(input(line(1, 'Sam Ortiz', "So we'll ship it on Friday."), line(2, 'Sam Ortiz', 'Agreed, Friday it is.'))).isDecision).toBe(false);
  });

  it('a joke is nothing, even when someone plays along', () => {
    expect(scriptedAnswer(input(line(1, 'Sam Ortiz', "Let's rename the product to Banana, haha."), line(2, 'Lee Park', 'Agreed.'))).isDecision).toBe(false);
  });

  it('a non-committal "let\'s" is nothing', () => {
    expect(scriptedAnswer(input(line(1, 'Sam Ortiz', "Let's see what the numbers say."), line(2, 'Lee Park', 'Yes.'))).isDecision).toBe(false);
  });

  it('"Name, can you own X" answered by that person is a work item naming them', () => {
    const a = scriptedAnswer(input(line(7, 'Priya Shah', 'Lee, can you own the cutover runbook?'), line(8, 'Lee', "Sure, I'll take it.")));
    expect(a).toMatchObject({ outcome: 'work-item', named: ['Lee'], statement: 'Lee owns the cutover runbook', evidence: [7, 8] });
  });
});

describe('the answer schema', () => {
  const good = { isDecision: true, outcome: 'decision', statement: 'Ship on Friday', named: [], evidence: [1, 2], confidence: 0.9 };
  it('takes exactly the schema', () => { expect(parseDecisionAnswer(good)).toMatchObject({ statement: 'Ship on Friday' }); });
  it.each([
    ['an extra key', { ...good, run: 'delete everything' }],
    ['a missing key', { isDecision: true, outcome: 'decision', statement: 'x', named: [], evidence: [] }],
    ['an unknown outcome', { ...good, outcome: 'tool' }],
    ['a long statement', { ...good, statement: 'x'.repeat(281) }],
    ['a confidence out of range', { ...good, confidence: 7 }],
    ['a fractional line number', { ...good, evidence: [1.5] }],
    ['a decision with no statement', { ...good, statement: ' ' }],
    ['not an object', 'yes'],
  ])('drops %s', (_why, raw) => { expect(parseDecisionAnswer(raw)).toBeNull(); });
});

describe('the Bedrock request', () => {
  const fixture = input(line(1, 'Sam Ortiz', "Let's cut over the smallest tenants first."), line(2, 'Priya Shah', 'Agreed.'));
  const fence = new Fence({ token: '0123456789abcdef0123456789abcdef' });

  it('is built as text from the fixture: Nova Lite, the data rule, each line fenced with its number and speaker', () => {
    const body = buildDecisionRequest(fixture, fence);
    expect(body.modelId).toBe('amazon.nova-lite-v1:0');
    expect(body.inferenceConfig).toEqual({ maxTokens: 300, temperature: 0 });
    expect(body.system[0]!.text.startsWith(DECISION_SYSTEM_PROMPT)).toBe(true);
    expect(body.system[0]!.text).toContain('untrusted');
    const t = 'untrusted-0123456789abcdef0123456789abcdef';
    expect(body.messages[0]!.content[0]!.text).toBe([
      'Roster:',
      `<${t} kind="roster-name">Priya Shah</${t}>`,
      `<${t} kind="roster-name">Sam Ortiz</${t}>`,
      `<${t} kind="roster-name">Lee Park</${t}>`,
      `<${t} kind="roster-name">Lee</${t}>`,
      '',
      'Transcript, oldest first:',
      `<${t} kind="line" n="1" speaker="Sam Ortiz">Let's cut over the smallest tenants first.</${t}>`,
      `<${t} kind="line" n="2" speaker="Priya Shah">Agreed.</${t}>`,
      '',
      'Answer with the JSON object only.',
    ].join('\n'));
  });

  const reply = (text: string, usage = { inputTokens: 1500, outputTokens: 150 }) => async () => ({ output: { message: { role: 'assistant', content: [{ text }] } }, usage, $metadata: {} }) as never;

  it('reads a JSON answer, tolerating a code fence', async () => {
    const m = new BedrockDecisionModel({ send: reply('```json\n{"isDecision":true,"outcome":"decision","statement":"Cut over the smallest tenants first","named":[],"evidence":[1,2],"confidence":0.92}\n```') });
    const r = await m.check(fixture);
    expect(r).toMatchObject({ code: 'ok', sent: true, usage: { inputTokens: 1500, outputTokens: 150 } });
    expect(r.answer?.evidence).toEqual([1, 2]);
  });

  it('a malformed answer is dropped as `malformed`', async () => {
    const r = await new BedrockDecisionModel({ send: reply('Yes, they agreed to cut over.') }).check(fixture);
    expect(r).toMatchObject({ code: 'malformed', answer: null, sent: true });
  });

  it('a timeout is a code, never a throw, and nothing of the request is logged', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const send = (_c: unknown, o: { abortSignal: AbortSignal }) => new Promise<never>((_r, reject) => { o.abortSignal.addEventListener('abort', () => reject(Object.assign(new Error('aborted: Agreed.'), { name: 'AbortError' }))); });
    const r = await new BedrockDecisionModel({ send: send as never, timeoutMs: 5 }).check(fixture);
    expect(r.code).toBe('timeout');
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/Agreed|tenants/);
    warn.mockRestore();
  });
});

// ---- the watcher over the memory store ------------------------------------------------------------------------------------------

let now: number;
let store: MemoryAssistantStore;
let timers: Array<{ due: number; fn: () => void; cancelled: boolean }>;
let seated: string[];
let owner: string | null;
let answering: boolean;
let echoes: Set<number>;
let spendRows: Parameters<WatcherSpend['record']>[0][];
let budget: boolean;
let watcher: DecisionWatcher;
let modelCalls: number;
let model: DecisionModel;

const T0 = Date.parse('2026-11-14T10:00:00.000Z');
const base = (over: Partial<AssistantRecord> = {}): AssistantRecord => ({
  callId: 'call-1', tenant: 'orgiq', lobby: 'orgiq:initiative:p-auth', initiativeId: 'p-auth', state: 'listening', invitedBy: 'u-priya', invitedAt: T0,
  pausedBy: null, leftAt: null, leftBy: null, acked: ['u-priya', 'u-sam', 'u-lee'], attendees: ['u-priya', 'u-sam', 'u-lee'], presentAtInvite: ['u-priya'],
  requests: 0, linesStored: 0, nextSeq: 1, pendingRequests: [], ...over,
});

const counting = (inner: DecisionModel): DecisionModel => ({ kind: inner.kind, modelId: inner.modelId, check: async (i) => { modelCalls += 1; return inner.check(i); } });

function makeWatcher(over: Partial<WatcherDeps> = {}): DecisionWatcher {
  return new DecisionWatcher({
    store: () => store, clock: () => now,
    seated: async () => seated, nameOf: async (u) => NAMES[u] ?? u, ownerOf: async () => owner, initiativeName: async () => 'Auth Migration',
    model: () => model,
    spend: () => ({ allowed: (r, at) => budget && watcherBudgetLeft(r, at), record: async (row) => { spendRows.push(row); } }),
    novaAnswering: () => answering, isEcho: (_c, l) => echoes.has(l.seq),
    schedule: (fn, ms) => { const t = { due: now + ms, fn, cancelled: false }; timers.push(t); return () => { t.cancelled = true; }; },
    ...over,
  });
}

beforeEach(async () => {
  now = T0; timers = []; seated = ['u-priya', 'u-sam', 'u-lee']; owner = 'u-priya'; answering = false; echoes = new Set(); spendRows = []; budget = true; modelCalls = 0;
  model = counting(new ScriptedDecisionModel());
  store = new MemoryAssistantStore();
  await store.create(base());
  watcher = makeWatcher();
  watcher.start('call-1');
  jest.spyOn(console, 'info').mockImplementation(() => undefined);
});
afterEach(() => { watcher.dispose(); jest.restoreAllMocks(); });

const pending = () => timers.filter((t) => !t.cancelled);
async function advance(ms: number): Promise<void> {
  const target = now + ms;
  for (;;) {
    const next = pending().filter((t) => t.due <= target).sort((a, b) => a.due - b.due)[0];
    if (!next) break;
    now = next.due; next.cancelled = true; next.fn();
    await watcher.idle('call-1');
  }
  now = target;
}
async function say(userId: string, text: string): Promise<TranscriptLine> {
  const l = await store.appendLine({ callId: 'call-1', userId, participantId: '', speakerName: userId, text, at: now, captionId: `c-${now}-${Math.random()}` });
  watcher.onLine(l!);
  return l!;
}
const proposals = () => store.listProposals('call-1');

describe('the watcher', () => {
  it('chatter never triggers a check', async () => {
    await say('u-sam', 'the build was slow again'); await say('u-lee', 'the cache was cold');
    await advance(60_000);
    expect(modelCalls).toBe(0);
    expect(timers).toHaveLength(0);
  });

  it('a real agreement between two people posts one proposal from the watcher, after the pause, with no sound', async () => {
    await say('u-sam', "Let's cut over the smallest tenants first.");
    await say('u-priya', 'Agreed.');
    await advance(QUIET_MS - 1);
    expect(modelCalls).toBe(0);
    await advance(1);
    const [p, ...rest] = await proposals();
    expect(rest).toHaveLength(0);
    expect(p).toMatchObject({ source: 'watcher', statement: 'Cut over the smallest tenants first', outcome: { kind: 'decision', initiativeId: 'p-auth' }, evidence: [1, 2], executor: 'u-priya', state: 'open', responses: [] });
    expect(watcher.stats('call-1')).toMatchObject({ trigger: 1, posted: 1 });
  });

  it('a work item names the person by user id, who is also the executor while seated, with the minutes\' create arguments', async () => {
    await say('u-priya', 'Lee, can you own the cutover runbook?');
    await say('u-lee', "Sure, I'll take it.");
    await advance(QUIET_MS);
    const [p] = await proposals();
    expect(p).toMatchObject({ named: ['u-lee'], executor: 'u-lee', outcome: { kind: 'tool', name: 'create' } });
    expect((p!.outcome as { args: { kind: string; fields: Record<string, unknown> } }).args).toMatchObject({ kind: 'work-item', fields: { title: 'Lee owns the cutover runbook', initiative: 'Auth Migration' } });
  });

  it('with nobody named and the owner not seated, the executor is whoever spoke the agreeing line', async () => {
    owner = 'u-vera';
    await say('u-sam', "Let's cut over the smallest tenants first.");
    await say('u-lee', 'Agreed.');
    await advance(QUIET_MS);
    expect((await proposals())[0]!.executor).toBe('u-lee');
  });

  it('one person deciding alone posts nothing', async () => {
    await say('u-sam', "So we'll ship it on Friday."); await say('u-sam', 'Agreed, Friday.');
    await advance(QUIET_MS);
    expect(await proposals()).toHaveLength(0);
  });

  it('a call with one person seated is never checked', async () => {
    seated = ['u-sam'];
    await say('u-sam', "Let's cut over first."); await say('u-priya', 'Agreed.');
    await advance(QUIET_MS);
    expect(modelCalls).toBe(0);
    expect(watcher.stats('call-1')['alone']).toBe(1);
  });

  it("Nova's own echo neither triggers nor counts as the second person", async () => {
    await say('u-sam', "Let's cut over the smallest tenants first.");
    const echo = await store.appendLine({ callId: 'call-1', userId: 'u-priya', participantId: '', speakerName: 'u-priya', text: 'Agreed, cutting over the smallest tenants first.', at: now, captionId: 'echo' });
    echoes.add(echo!.seq); watcher.onLine(echo!);
    await advance(MAX_WAIT_MS);
    expect(await proposals()).toHaveLength(0);
    expect(watcher.stats('call-1')['trigger'] ?? 0).toBe(0);
  });

  it('a line during the wait resets it; the 45 s cap fires the check anyway', async () => {
    await say('u-sam', 'We decided to freeze the schema.');
    for (let i = 0; i < 8; i += 1) { await advance(QUIET_MS - 1000); await say(i % 2 ? 'u-lee' : 'u-priya', `still talking ${i}`); }
    expect(modelCalls).toBe(0); // 40 s of talk, never 6 s quiet
    await advance(5000);
    expect(modelCalls).toBe(1); // the cap: 45 s after the trigger, though the last line was only 5 s before
    expect(now - T0).toBe(MAX_WAIT_MS);
  });

  it('never checks while Nova is answering; still answering at the cap drops the wait', async () => {
    answering = true;
    await say('u-sam', "Let's cut over the smallest tenants first."); await say('u-priya', 'Agreed.');
    await advance(MAX_WAIT_MS + 1000);
    expect(modelCalls).toBe(0);
    expect(watcher.stats('call-1')['nova-busy']).toBe(1);
    expect(pending()).toHaveLength(0);
  });

  it('waits out Nova and checks once she is done', async () => {
    answering = true;
    await say('u-sam', "Let's cut over the smallest tenants first."); await say('u-priya', 'Agreed.');
    await advance(QUIET_MS);
    answering = false;
    await advance(QUIET_MS);
    expect(await proposals()).toHaveLength(1);
  });

  it('one proposal per two minutes', async () => {
    await say('u-sam', "Let's cut over the smallest tenants first."); await say('u-priya', 'Agreed.');
    await advance(QUIET_MS);
    await advance(30_000);
    await say('u-lee', "So we'll freeze the schema."); await say('u-sam', 'Agreed.');
    await advance(QUIET_MS);
    expect(await proposals()).toHaveLength(1);
    expect(watcher.stats('call-1')['too-soon']).toBe(1);
    expect(modelCalls).toBe(1); // the gap is judged before any money is spent
  });

  it('eight per call at most', async () => {
    for (let i = 0; i < MAX_PER_CALL; i += 1) {
      await createProposal(store, { callId: 'call-1', tenant: 'orgiq', statement: `Earlier decision ${i}`, outcome: { kind: 'decision', initiativeId: 'p-auth' }, named: [], executor: 'u-priya', source: 'watcher', at: T0 - 3_600_000 });
    }
    await say('u-sam', "Let's cut over the smallest tenants first."); await say('u-priya', 'Agreed.');
    await advance(QUIET_MS);
    expect(watcher.stats('call-1')['cap']).toBe(1);
    expect(modelCalls).toBe(0);
  });

  it('the proposal that reaches the cap is followed by one notice to the call; a later candidate raises nothing and says nothing', async () => {
    const notices: Array<{ callId: string; text: string }> = [];
    watcher.dispose();
    watcher = makeWatcher({ notice: async (callId, text) => { notices.push({ callId, text }); } });
    watcher.start('call-1');
    for (let i = 0; i < MAX_PER_CALL - 1; i += 1) {
      await createProposal(store, { callId: 'call-1', tenant: 'orgiq', statement: `Earlier decision ${i}`, outcome: { kind: 'decision', initiativeId: 'p-auth' }, named: [], executor: 'u-priya', source: 'watcher', at: T0 - 3_600_000 });
    }
    await say('u-sam', "Let's cut over the smallest tenants first."); await say('u-priya', 'Agreed.');
    await advance(QUIET_MS);
    expect(await proposals()).toHaveLength(MAX_PER_CALL);
    expect(notices).toEqual([{ callId: 'call-1', text: capNotice() }]);
    expect(capNotice()).toBe('Nova has raised 8 proposals in this call and will not raise more. You can still ask Nova to record a decision.');
    // A ninth candidate, past the gap: no proposal, no second notice.
    await advance(MIN_GAP_MS);
    await say('u-lee', "So we'll freeze the schema."); await say('u-sam', 'Agreed.');
    await advance(QUIET_MS);
    expect(await proposals()).toHaveLength(MAX_PER_CALL);
    expect(watcher.stats('call-1')['cap']).toBe(1);
    expect(notices).toHaveLength(1);
    // After a restart (a new watcher over the same store) the cap is read from the stored proposals: still silent.
    watcher.dispose();
    watcher = makeWatcher({ notice: async (callId, text) => { notices.push({ callId, text }); } });
    watcher.start('call-1');
    await advance(MIN_GAP_MS);
    await say('u-lee', "Let's move the standup to Tuesday."); await say('u-priya', 'Agreed.');
    await advance(QUIET_MS);
    expect(await proposals()).toHaveLength(MAX_PER_CALL);
    expect(notices).toHaveLength(1);
  });

  it('the cap notice counts the watcher\'s proposals only, and only the one that reaches the cap', async () => {
    const post = jest.fn(async () => undefined);
    await createProposal(store, { callId: 'call-1', tenant: 'orgiq', statement: 'Asked for', outcome: { kind: 'decision', initiativeId: 'p-auth' }, named: [], executor: 'u-priya', source: 'asked', at: T0 });
    expect(await noticeIfCapReached(store, 'call-1', 'asked', post)).toBe(false);
    for (let i = 0; i < MAX_PER_CALL; i += 1) {
      await createProposal(store, { callId: 'call-1', tenant: 'orgiq', statement: `Watched ${i}`, outcome: { kind: 'decision', initiativeId: 'p-auth' }, named: [], executor: 'u-priya', source: 'watcher', at: T0 });
      expect(await noticeIfCapReached(store, 'call-1', 'watcher', post)).toBe(i === MAX_PER_CALL - 1);
    }
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('a duplicate by normalised statement is dropped', async () => {
    await createProposal(store, { callId: 'call-1', tenant: 'orgiq', statement: 'cut over the SMALLEST tenants, first!', outcome: { kind: 'decision', initiativeId: 'p-auth' }, named: [], executor: 'u-priya', source: 'asked', at: T0 - 600_000 });
    await say('u-sam', "Let's cut over the smallest tenants first."); await say('u-priya', 'Agreed.');
    await advance(QUIET_MS);
    expect(watcher.stats('call-1')['duplicate']).toBe(1);
    expect(await proposals()).toHaveLength(1);
  });

  it('after "Not a decision", a near copy is suppressed for the rest of the call', async () => {
    const { proposal } = await createProposal(store, { callId: 'call-1', tenant: 'orgiq', statement: 'Cut over the smallest tenants first', outcome: { kind: 'decision', initiativeId: 'p-auth' }, named: [], executor: 'u-priya', source: 'watcher', at: T0 - 600_000 });
    await respondToProposal(store, 'call-1', proposal.id, { userId: 'u-lee', response: 'not-a-decision', at: T0 - 500_000 });
    expect(similarity('Cut over the smallest tenants first', 'We cut over the smallest tenants first')).toBeGreaterThanOrEqual(0.6);
    await say('u-sam', "So we'll cut over all the smallest tenants first."); await say('u-priya', 'Agreed.');
    await advance(QUIET_MS);
    expect(watcher.stats('call-1')['suppressed']).toBe(1);
  });

  it('a malformed model answer posts nothing (and the check is still booked)', async () => {
    model = counting(new BedrockDecisionModel({ send: async () => ({ output: { message: { role: 'assistant', content: [{ text: '{"isDecision": "yes"}' }] } }, usage: { inputTokens: 900, outputTokens: 12 }, $metadata: {} }) as never }));
    await say('u-sam', "Let's cut over the smallest tenants first."); await say('u-priya', 'Agreed.');
    await advance(QUIET_MS);
    expect(await proposals()).toHaveLength(0);
    expect(watcher.stats('call-1')['malformed']).toBe(1);
    expect(spendRows).toHaveLength(1);
    expect(spendRows[0]).toMatchObject({ basis: 'reported', tokensIn: 900, tokensOut: 12, model: 'amazon.nova-lite-v1:0' });
    expect(spendRows[0]!.costUsd).toBeCloseTo((900 * 0.00006 + 12 * 0.00024) / 1000, 10);
  });

  it('a low-confidence or one-speaker-evidence answer posts nothing', async () => {
    const fixed = (a: object): DecisionModel => ({ kind: 'bedrock', modelId: 'amazon.nova-lite-v1:0', check: async (): Promise<ModelCheckResult> => ({ answer: parseDecisionAnswer(a), code: 'ok', sent: true, usage: { inputTokens: 10, outputTokens: 10 }, estimate: { inputTokens: 10, outputTokens: 10 } }) });
    model = fixed({ isDecision: true, outcome: 'decision', statement: 'Freeze', named: [], evidence: [1, 2], confidence: 0.5 });
    await say('u-sam', 'We decided to freeze.'); await say('u-priya', 'Agreed.');
    await advance(QUIET_MS);
    model = fixed({ isDecision: true, outcome: 'decision', statement: 'Freeze', named: ['Someone Else'], evidence: [1, 99], confidence: 0.95 });
    await say('u-sam', 'We decided to freeze.');
    await advance(QUIET_MS);
    expect(watcher.stats('call-1')).toMatchObject({ 'low-confidence': 1, evidence: 1 });
    expect(await proposals()).toHaveLength(0);
  });

  it('books each scripted check to the inviter under meeting_assistant at the Nova Lite rate, as an estimate', async () => {
    await say('u-sam', "Let's cut over the smallest tenants first."); await say('u-priya', 'Agreed.');
    await advance(QUIET_MS);
    expect(spendRows).toHaveLength(1);
    expect(spendRows[0]).toMatchObject({ callId: 'call-1', inviterId: 'u-priya', initiativeId: 'p-auth', model: 'scripted-decision-check', basis: 'estimated', n: now });
    expect(spendRows[0]!.costUsd).toBeGreaterThan(0);
  });

  it('skips the check when the call\'s hold is used up', async () => {
    await store.patchSession('call-1', { listeningSeconds: 3600, ceilingSeconds: 3600 });
    await say('u-sam', "Let's cut over the smallest tenants first."); await say('u-priya', 'Agreed.');
    await advance(QUIET_MS);
    expect(modelCalls).toBe(0);
    expect(watcher.stats('call-1')['budget']).toBe(1);
  });

  it('nothing after a pause: the wait is cleared', async () => {
    await say('u-sam', "Let's cut over the smallest tenants first."); await say('u-priya', 'Agreed.');
    watcher.pause('call-1');
    expect(pending()).toHaveLength(0);
    await advance(MAX_WAIT_MS);
    expect(modelCalls).toBe(0);
  });

  it('a check under way when the call is paused posts nothing', async () => {
    let release: (() => void) | undefined;
    const inner = new ScriptedDecisionModel();
    model = { kind: 'scripted', modelId: inner.modelId, check: async (i) => { await new Promise<void>((r) => { release = r; }); return inner.check(i); } };
    await say('u-sam', "Let's cut over the smallest tenants first."); await say('u-priya', 'Agreed.');
    const t = pending()[0]!; now = t.due; t.cancelled = true; t.fn();
    for (let i = 0; i < 100 && !release; i += 1) await new Promise((r) => setImmediate(r));
    expect(release).toBeDefined();
    watcher.pause('call-1');
    await store.transition('call-1', { from: ['listening'], to: 'paused', by: 'u-sam', at: now });
    release!();
    await watcher.idle('call-1');
    expect(await proposals()).toHaveLength(0);
  });

  it('nothing after a stop or dismiss: timers cleared, state gone, later lines ignored', async () => {
    await say('u-sam', "Let's cut over the smallest tenants first.");
    watcher.stop('call-1');
    expect(pending()).toHaveLength(0);
    expect(watcher.isWatching('call-1')).toBe(false);
    await say('u-priya', 'Agreed.');
    await advance(MAX_WAIT_MS);
    expect(timers.filter((t) => !t.cancelled)).toHaveLength(0);
    expect(modelCalls).toBe(0);
  });

  it('logs codes and counts only, never the words', async () => {
    const info = jest.spyOn(console, 'info').mockImplementation(() => undefined);
    await say('u-sam', "Let's cut over the smallest tenants first."); await say('u-priya', 'Agreed.');
    await advance(QUIET_MS);
    expect(info).toHaveBeenCalledWith('[meeting-assistant] decision check', 'posted', 'lines=2');
    expect(JSON.stringify(info.mock.calls)).not.toMatch(/tenants|Agreed/);
  });
});

describe('the trigger and the intake hook', () => {
  it.each([["let's go with plan B", true], ["so we'll do that", true], ["I'll take the runbook", true], ['Lee, can you own it?', true], ['decision: ship it', true], ['agreed', true], ['the weather is nice', false]])('%s -> %s', (text, hit) => {
    expect(TRIGGER.test(text)).toBe(hit);
  });

  it('the intake tells its listeners each stored line once, and not a duplicate or an unstored one', async () => {
    const source = new MockTranscriptSource();
    const intake = new LineIntake(store, { clock: () => now, tickMs: 0, source: () => source });
    const heard: number[] = [];
    intake.onStored((l) => heard.push(l.seq));
    intake.start('call-1');
    await source.inject('call-1', { userId: 'u-sam', text: 'hello', captionId: 'a' });
    await source.inject('call-1', { userId: 'u-sam', text: 'hello', captionId: 'a' });
    await source.inject('call-1', { userId: 'u-stranger', text: 'unacknowledged', captionId: 'b' });
    expect(heard).toEqual([1]);
    intake.dispose();
  });
});
