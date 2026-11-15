// The consent rule (docs/meeting-consent-design.md): the pure function, every state move, the service over the memory store
// (concurrent answers, expiry, the consented hook), and the SQL store's proposal statements against a recording executor.
jest.mock('../../../config.js', () => ({ config: { mock: { aurora: true }, meetingAssistant: { enabled: true, transcriptRetentionDays: 30 } } }));
import { MemoryAssistantStore } from '../store.js';
import { SqlAssistantStore, proposalFromRow } from '../store-sql.js';
import {
  applyResponse, buildProposal, cleanReason, closeProposals, consentMet, createProposal, listProposalsFor, onProposalConsented,
  mayDismiss, mayRaiseAgain, ProposalInputError, PROPOSAL_AFTER_CALL_MS, raiseAgain, respondToProposal, settle, startsRun, whatIsMissing, type ResponseInput,
} from '../proposals.js';
import { hashToolArgs } from '../../voice/catalogue.js';
import type { AssistantRecord, Proposal } from '../types.js';

const T0 = Date.parse('2026-11-14T10:00:00.000Z');
const base = (over: Partial<Parameters<typeof buildProposal>[0]> = {}) => buildProposal({
  id: 'p-1', callId: 'call-1', tenant: 'orgiq', statement: 'Cut over the smallest tenants first', outcome: { kind: 'decision', initiativeId: 'p-auth' },
  named: [], executor: 'u-priya', source: 'dev', evidence: [3, 4], at: T0, ...over,
});
const answer = (p: Proposal, userId: string, response: ResponseInput['response'], reason?: string): Proposal => {
  const out = applyResponse(p, { userId, response, at: T0 + 1000, ...(reason !== undefined ? { reason } : {}) });
  if (!out.ok) throw new Error(out.why);
  return out.proposal;
};

describe('the consent rule (pure)', () => {
  it('starts open with nobody consented, the outcome digested and frozen', () => {
    const p = base({ outcome: { kind: 'tool', name: 'create', args: { title: 'Runbook', assignee: 'u-lee' } } });
    expect(p).toMatchObject({ state: 'open', responses: [], expiresAt: null, version: 1, dismissedBy: null });
    expect(p.argsDigest).toBe(hashToolArgs(p.outcome));
    expect(consentMet(p)).toBe(false);
  });

  it('one person agreeing with themselves is not consent, even the executor', () => {
    expect(answer(base(), 'u-priya', 'consent').state).toBe('open');
  });

  it('two people including the executor consent: consented', () => {
    const p = answer(answer(base(), 'u-sam', 'consent'), 'u-priya', 'consent');
    expect(p.state).toBe('consented');
    expect(consentMet(p)).toBe(true);
  });

  it('two people without the executor is not enough', () => {
    const p = answer(answer(base(), 'u-sam', 'consent'), 'u-lee', 'consent');
    expect(p.state).toBe('open');
    expect(whatIsMissing(p)).toEqual({ people: ['u-priya'], more: 0, objectedBy: [] });
  });

  it('a named person missing holds it open until they consent', () => {
    let p = base({ named: ['u-lee'] });
    p = answer(answer(p, 'u-sam', 'consent'), 'u-priya', 'consent');
    expect(p.state).toBe('open');
    expect(whatIsMissing(p).people).toEqual(['u-lee']);
    p = answer(p, 'u-lee', 'consent');
    expect(p.state).toBe('consented');
  });

  it('a named executor counts once: the executor alone is still one person', () => {
    const p = answer(base({ named: ['u-priya'] }), 'u-priya', 'consent');
    expect(p.state).toBe('open');
    expect(whatIsMissing(p)).toEqual({ people: [], more: 1, objectedBy: [] });
  });

  it('an objection blocks; withdrawing the last one re-evaluates', () => {
    let p = answer(base(), 'u-sam', 'consent');
    p = answer(p, 'u-lee', 'object', "I'm out next week");
    expect(p.state).toBe('objected');
    expect(p.responses.find((r) => r.userId === 'u-lee')).toMatchObject({ response: 'object', reason: "I'm out next week" });
    p = answer(p, 'u-priya', 'consent');
    expect(p.state).toBe('objected'); // consent is recorded but the objection still blocks
    p = answer(p, 'u-lee', 'withdraw');
    expect(p.state).toBe('consented');
  });

  it('withdrawing one of two objections keeps it objected; the last makes it open', () => {
    let p = answer(answer(base(), 'u-sam', 'object'), 'u-lee', 'object');
    p = answer(p, 'u-sam', 'withdraw');
    expect(p.state).toBe('objected');
    p = answer(p, 'u-lee', 'withdraw');
    expect(p.state).toBe('open');
  });

  it('an objection on a consented proposal stops it, and a withdrawn consent reopens it', () => {
    const consented = answer(answer(base(), 'u-sam', 'consent'), 'u-priya', 'consent');
    expect(answer(consented, 'u-lee', 'object').state).toBe('objected');
    expect(answer(consented, 'u-sam', 'withdraw').state).toBe('open');
  });

  it('a person has one answer: objecting replaces their consent', () => {
    const p = answer(answer(base(), 'u-sam', 'consent'), 'u-sam', 'object');
    expect(p.responses).toHaveLength(1);
    expect(p.state).toBe('objected');
  });

  it('repeating the same answer, or withdrawing nothing, changes nothing', () => {
    const p = answer(base(), 'u-sam', 'consent');
    expect(applyResponse(p, { userId: 'u-sam', response: 'consent', at: T0 + 5 })).toMatchObject({ ok: true, changed: false });
    expect(applyResponse(p, { userId: 'u-lee', response: 'withdraw', at: T0 + 5 })).toMatchObject({ ok: true, changed: false });
  });

  it('"Not a decision" dismisses it from any answerable state', () => {
    for (const p of [base(), answer(base(), 'u-sam', 'object'), answer(answer(base(), 'u-sam', 'consent'), 'u-priya', 'consent')]) {
      expect(answer(p, 'u-lee', 'not-a-decision')).toMatchObject({ state: 'dismissed', dismissedBy: 'u-lee' });
    }
  });

  it('nothing is answerable once running or finished', () => {
    for (const state of ['running', 'done', 'failed', 'dismissed', 'expired'] as const) {
      expect(applyResponse({ ...base(), state }, { userId: 'u-sam', response: 'withdraw', at: T0 })).toEqual({ ok: false, why: 'finished' });
    }
  });

  it('a reason belongs to an objection only', () => {
    expect(applyResponse(base(), { userId: 'u-sam', response: 'consent', reason: 'sure', at: T0 })).toEqual({ ok: false, why: 'reason-not-allowed' });
  });

  it('settle reads only the responses', () => {
    expect(settle({ named: [], executor: 'a', responses: [] })).toBe('open');
  });

  it('a take-over: only a person who consented, only once it is consented, only by consenting; they become the executor', () => {
    const done = answer(answer(base(), 'u-sam', 'consent'), 'u-priya', 'consent');
    const as = (p: Proposal, userId: string, response: ResponseInput['response'] = 'consent') => applyResponse(p, { userId, response, at: T0 + 2000, asExecutor: true });
    expect(as(answer(base(), 'u-sam', 'consent'), 'u-sam')).toEqual({ ok: false, why: 'not-consented' });
    expect(as(done, 'u-lee')).toEqual({ ok: false, why: 'not-a-consenter' });
    // Someone who has not answered joins only when the route found nobody who consented can run it (`mayJoin`); an objector never.
    const joined = applyResponse(done, { userId: 'u-lee', response: 'consent', at: T0 + 2000, asExecutor: true, mayJoin: true });
    expect(joined).toMatchObject({ ok: true, proposal: { executor: 'u-lee', state: 'consented' } });
    if (joined.ok) expect(joined.proposal.responses.map((r) => [r.userId, r.response])).toEqual([['u-sam', 'consent'], ['u-priya', 'consent'], ['u-lee', 'consent']]);
    const blocked = { ...done, responses: [...done.responses, { userId: 'u-bob', response: 'object' as const, reason: null, at: T0 }] };
    expect(applyResponse({ ...blocked, state: 'consented' }, { userId: 'u-bob', response: 'consent', at: T0 + 2000, asExecutor: true, mayJoin: true })).toEqual({ ok: false, why: 'not-a-consenter' });
    expect(as(done, 'u-sam', 'object')).toEqual({ ok: false, why: 'reason-not-allowed' });
    const out = as(done, 'u-sam');
    expect(out).toMatchObject({ ok: true, changed: true, proposal: { state: 'consented', executor: 'u-sam' } });
    // The rule still holds with the new executor: two people, the executor among them.
    if (out.ok) expect(consentMet(out.proposal)).toBe(true);
  });
});

describe("the executor's click is the last step", () => {
  const sam = { userId: 'u-sam', response: 'consent' as const };
  const priya = { userId: 'u-priya', response: 'consent' as const };
  it('the executor consenting last starts it; anyone else consenting last leaves it consented for the executor', () => {
    expect(startsRun({ state: 'open' }, { state: 'consented', executor: 'u-priya' }, priya)).toBe(true);
    expect(startsRun({ state: 'open' }, { state: 'consented', executor: 'u-priya' }, sam)).toBe(false);
    expect(startsRun({ state: 'objected' }, { state: 'consented', executor: 'u-priya' }, { userId: 'u-lee', response: 'withdraw' })).toBe(false);
    expect(startsRun({ state: 'consented' }, { state: 'consented', executor: 'u-priya' }, priya)).toBe(false);
    expect(startsRun({ state: 'consented' }, { state: 'consented', executor: 'u-priya' }, { ...priya, asExecutor: true })).toBe(true);
    expect(startsRun({ state: 'open' }, { state: 'open', executor: 'u-priya' }, priya)).toBe(false);
  });
});

describe('dismissing, undoing it, and raising it again', () => {
  it('"Not a decision" by anyone on one Milo raised; on an asked one only the asker may drop it', () => {
    expect(mayDismiss(base({ source: 'watcher' }), 'u-sam')).toBe(true);
    expect(mayDismiss(base({ source: 'dev' }), 'u-sam')).toBe(true);
    const asked = base({ source: 'asked', askedBy: 'u-dana', executor: 'u-dana' });
    expect(mayDismiss(asked, 'u-sam')).toBe(false);
    expect(mayDismiss(asked, 'u-dana')).toBe(true);
    expect(applyResponse(asked, { userId: 'u-sam', response: 'not-a-decision', at: T0 })).toEqual({ ok: false, why: 'not-allowed' });
    expect(applyResponse(asked, { userId: 'u-dana', response: 'not-a-decision', at: T0 })).toMatchObject({ ok: true, proposal: { state: 'dismissed', dismissedBy: 'u-dana' } });
    // An old row with no asker recorded: its executor asked.
    expect(mayDismiss({ source: 'asked', askedBy: null, executor: 'u-dana' }, 'u-dana')).toBe(true);
  });

  it('the person who dismissed it reopens it to where its answers put it; nobody else can', () => {
    const consented = answer(answer(base(), 'u-sam', 'consent'), 'u-priya', 'consent');
    const gone = answer(answer(base(), 'u-sam', 'consent'), 'u-lee', 'not-a-decision');
    expect(applyResponse(gone, { userId: 'u-sam', response: 'reopen', at: T0 + 5 })).toEqual({ ok: false, why: 'not-allowed' });
    expect(applyResponse(gone, { userId: 'u-lee', response: 'reopen', at: T0 + 5 })).toMatchObject({ ok: true, proposal: { state: 'open', dismissedBy: null } });
    const goneLate = answer(consented, 'u-lee', 'not-a-decision');
    expect(applyResponse(goneLate, { userId: 'u-lee', response: 'reopen', at: T0 + 5 })).toMatchObject({ ok: true, proposal: { state: 'consented' } });
    expect(applyResponse(base(), { userId: 'u-lee', response: 'reopen', at: T0 + 5 })).toEqual({ ok: false, why: 'finished' });
    const raised = { ...gone, run: { turnId: null, by: 'u-lee', at: T0, title: null, href: null, note: 'x', raisedAs: 'p-2' } };
    expect(applyResponse(raised, { userId: 'u-lee', response: 'reopen', at: T0 + 5 })).toEqual({ ok: false, why: 'not-allowed' });
  });

  it('only an objected or failed proposal is raised again, and only once', () => {
    expect(mayRaiseAgain({ state: 'objected', run: null })).toBe(true);
    expect(mayRaiseAgain({ state: 'failed', run: null })).toBe(true);
    expect(mayRaiseAgain({ state: 'open', run: null })).toBe(false);
    expect(mayRaiseAgain({ state: 'failed', run: { turnId: null, by: 'a', at: 0, title: null, href: null, note: null, raisedAs: 'p-2' } })).toBe(false);
  });
});

describe('checking input', () => {
  it('refuses a long or empty statement, a bad outcome and odd people', () => {
    expect(() => base({ statement: 'x'.repeat(281) })).toThrow(ProposalInputError);
    expect(() => base({ statement: '   ' })).toThrow(ProposalInputError);
    expect(() => base({ outcome: { kind: 'other' } as never })).toThrow(/outcome.kind/);
    expect(() => base({ outcome: { kind: 'tool', name: 'bad name', args: {} } })).toThrow(/tool name/);
    expect(() => base({ executor: '' })).toThrow(/executor/);
    expect(() => base({ named: Array.from({ length: 11 }, (_, i) => `u-${i}`) })).toThrow(/named/);
    expect(base({ statement: 'x'.repeat(280) }).statement).toHaveLength(280);
  });

  it('keeps a reason to one line of at most 200 characters', () => {
    expect(cleanReason('  fine  ')).toBe('fine');
    expect(cleanReason('')).toBeNull();
    expect(() => cleanReason('a\nb')).toThrow(/one line/);
    expect(() => cleanReason('x'.repeat(201))).toThrow(/200/);
    expect(() => cleanReason(5)).toThrow(/string/);
  });
});

const record = (over: Partial<AssistantRecord> = {}): AssistantRecord => ({
  callId: 'call-1', tenant: 'orgiq', lobby: 'orgiq:initiative:p-auth', initiativeId: 'p-auth', state: 'listening', invitedBy: 'u-priya',
  invitedAt: T0, pausedBy: null, leftAt: null, leftBy: null, acked: ['u-priya'], attendees: ['u-priya'], presentAtInvite: ['u-priya'],
  requests: 0, linesStored: 0, nextSeq: 1, pendingRequests: [], ...over,
});

describe('the service on the memory store', () => {
  let store: MemoryAssistantStore;
  const input = (over: Partial<Parameters<typeof createProposal>[1]> = {}) => ({ id: 'p-1', callId: 'call-1', tenant: 'orgiq', statement: 'Cut over first', outcome: { kind: 'decision' as const, initiativeId: null }, named: [], executor: 'u-priya', source: 'dev' as const, at: T0, ...over });
  beforeEach(async () => { store = new MemoryAssistantStore(); await store.create(record()); });

  it('creates once, takes the tenant from the call, and needs a call record', async () => {
    expect((await createProposal(store, input({ tenant: 'other' }))).proposal.tenant).toBe('orgiq');
    expect((await createProposal(store, input({ statement: 'Something else' }))).created).toBe(false);
    await expect(createProposal(store, input({ callId: 'call-none' }))).rejects.toThrow();
  });

  it('two answers at once are both kept', async () => {
    await createProposal(store, input());
    const [a, b] = await Promise.all([
      respondToProposal(store, 'call-1', 'p-1', { userId: 'u-sam', response: 'consent', at: T0 + 1 }),
      respondToProposal(store, 'call-1', 'p-1', { userId: 'u-priya', response: 'consent', at: T0 + 2 }),
    ]);
    expect(a.ok && b.ok).toBe(true);
    const p = (await store.getProposal('call-1', 'p-1'))!;
    expect(p.responses.map((r) => r.userId).sort()).toEqual(['u-priya', 'u-sam']);
    expect(p.state).toBe('consented');
    expect(p.version).toBe(3);
  });

  it('a save with a stale version is refused', async () => {
    const { proposal } = await createProposal(store, input());
    expect(await store.saveProposal({ ...proposal, state: 'dismissed' }, 1)).not.toBeNull();
    expect(await store.saveProposal({ ...proposal, state: 'open' }, 1)).toBeNull();
  });

  it('never rewrites the frozen fields (the executor changes only by a take-over, so the store writes it)', async () => {
    const { proposal } = await createProposal(store, input());
    await store.saveProposal({ ...proposal, statement: 'changed', named: ['u-x'], argsDigest: 'x' }, 1);
    expect(await store.getProposal('call-1', 'p-1')).toMatchObject({ statement: 'Cut over first', executor: 'u-priya', named: [], argsDigest: proposal.argsDigest });
  });

  it('announces the move into consented once, with nothing run', async () => {
    const seen: string[] = [];
    const off = onProposalConsented((p) => { seen.push(`${p.id}:${p.state}`); });
    await createProposal(store, input());
    await respondToProposal(store, 'call-1', 'p-1', { userId: 'u-sam', response: 'consent', at: T0 + 1 });
    await respondToProposal(store, 'call-1', 'p-1', { userId: 'u-priya', response: 'consent', at: T0 + 2 });
    await respondToProposal(store, 'call-1', 'p-1', { userId: 'u-lee', response: 'consent', at: T0 + 3 });
    await new Promise((r) => setImmediate(r));
    off();
    expect(seen).toEqual(['p-1:consented']);
    expect((await store.getProposal('call-1', 'p-1'))!.state).toBe('consented');
  });

  it('stays open through the call, gets end + 72 h when it ends, and expires unrun after that', async () => {
    await createProposal(store, input());
    const end = T0 + 3600_000;
    expect((await listProposalsFor(store, 'call-1', end + 10, null))[0]!.expiresAt).toBeNull();
    expect(await closeProposals(store, 'call-1', end)).toBe(1);
    expect(await closeProposals(store, 'call-1', end + 999)).toBe(0); // set once
    const before = await respondToProposal(store, 'call-1', 'p-1', { userId: 'u-sam', response: 'consent', at: end + PROPOSAL_AFTER_CALL_MS - 1 });
    expect(before.ok).toBe(true);
    const after = await respondToProposal(store, 'call-1', 'p-1', { userId: 'u-priya', response: 'consent', at: end + PROPOSAL_AFTER_CALL_MS });
    expect(after).toMatchObject({ ok: false, why: 'expired' });
    expect((await store.getProposal('call-1', 'p-1'))!.state).toBe('expired');
  });

  it('a list after the call sets the expiry and expires what is due', async () => {
    await createProposal(store, input());
    const end = T0 + 60_000;
    const [p] = await listProposalsFor(store, 'call-1', end + PROPOSAL_AFTER_CALL_MS, end);
    expect(p).toMatchObject({ state: 'expired', expiresAt: end + PROPOSAL_AFTER_CALL_MS });
  });

  it("a non-executor's last consent waits for the executor's own click, which starts it", async () => {
    const seen: string[] = [];
    const off = onProposalConsented((p) => { seen.push(`${p.executor}`); });
    await createProposal(store, input());
    await respondToProposal(store, 'call-1', 'p-1', { userId: 'u-priya', response: 'consent', at: T0 + 1 });
    await respondToProposal(store, 'call-1', 'p-1', { userId: 'u-sam', response: 'consent', at: T0 + 2 });
    await new Promise((r) => setImmediate(r));
    expect(seen).toEqual([]);
    expect((await store.getProposal('call-1', 'p-1'))!.state).toBe('consented');
    await respondToProposal(store, 'call-1', 'p-1', { userId: 'u-priya', response: 'consent', at: T0 + 3, asExecutor: true });
    await new Promise((r) => setImmediate(r));
    off();
    expect(seen).toEqual(['u-priya']);
  });

  it('raising an objected proposal again closes it and opens a new one with the same outcome and no answers, once', async () => {
    await createProposal(store, input({ named: ['u-lee'], source: 'asked', askedBy: 'u-priya', evidence: [] }));
    await respondToProposal(store, 'call-1', 'p-1', { userId: 'u-sam', response: 'consent', at: T0 + 1 });
    await respondToProposal(store, 'call-1', 'p-1', { userId: 'u-lee', response: 'object', reason: 'Out next week', at: T0 + 2 });
    expect(await raiseAgain(store, 'call-1', 'p-1', 'u-sam', T0 + 3, 8)).toMatchObject({ ok: true });
    const [old, fresh] = await store.listProposals('call-1');
    expect(old).toMatchObject({ state: 'dismissed', dismissedBy: 'u-sam', run: { raisedAs: fresh!.id, note: 'Raised again as a new proposal.' } });
    expect(fresh).toMatchObject({ state: 'open', responses: [], statement: old!.statement, outcome: old!.outcome, argsDigest: old!.argsDigest, named: ['u-lee'], executor: 'u-priya', source: 'asked', askedBy: 'u-priya' });
    expect(await raiseAgain(store, 'call-1', 'p-1', 'u-sam', T0 + 4, 8)).toMatchObject({ ok: false, why: 'not-raisable' });
    expect(await raiseAgain(store, 'call-1', fresh!.id, 'u-sam', T0 + 4, 8)).toMatchObject({ ok: false, why: 'not-raisable' });
  });

  it('a raised copy counts toward the call\'s cap for its source', async () => {
    await createProposal(store, input());
    await respondToProposal(store, 'call-1', 'p-1', { userId: 'u-lee', response: 'object', at: T0 + 1 });
    await createProposal(store, input({ id: 'p-2', statement: 'Another' }));
    expect(await raiseAgain(store, 'call-1', 'p-1', 'u-sam', T0 + 3, 2)).toMatchObject({ ok: false, why: 'cap' });
    expect((await store.getProposal('call-1', 'p-1'))!.state).toBe('objected');
  });

  it('an unknown proposal is not found', async () => {
    expect(await respondToProposal(store, 'call-1', 'p-x', { userId: 'u-sam', response: 'consent', at: T0 })).toEqual({ ok: false, why: 'not-found' });
  });

  it('the inviter\'s delete and the purge remove the call\'s proposals', async () => {
    await createProposal(store, input());
    await store.transition('call-1', { from: ['listening'], to: 'left', by: 'u-priya', at: T0 + 1 });
    await store.tombstoneMinutes('call-1', 'u-priya', T0 + 2);
    expect(await store.listProposals('call-1')).toEqual([]);
    await createProposal(store, input({ id: 'p-2' }));
    expect(await store.purgeCall('call-1')).toBe(true);
    expect(await store.listProposals('call-1')).toEqual([]);
  });
});

describe('SqlAssistantStore proposal statements', () => {
  const calls: Array<{ sql: string; params: Array<{ name: string; value: Record<string, unknown> }> }> = [];
  let rows: Record<string, unknown>[] = [];
  const store = () => new SqlAssistantStore(async (sql, params = []) => { calls.push({ sql, params: params as never }); return rows; });
  const row = (over: Record<string, unknown> = {}) => ({
    call_id: 'call-1', proposal_id: 'p-1', tenant: 'orgiq', statement: 'Cut over first', outcome: '{"kind":"decision","initiativeId":null}', args_digest: 'd',
    named: '["u-lee"]', executor: 'u-priya', source: 'dev', evidence: '[3]', state: 'open', responses: '[{"userId":"u-sam","response":"consent","reason":null,"at":5}]',
    dismissed_by: null, created_at: '2026-11-14T10:00:00.000Z', updated_at: '2026-11-14T10:00:01.000Z', expires_at: null, version: 2, ...over,
  });
  beforeEach(() => { calls.length = 0; rows = []; });

  it('maps a row', () => {
    expect(proposalFromRow(row())).toEqual({
      id: 'p-1', callId: 'call-1', tenant: 'orgiq', statement: 'Cut over first', outcome: { kind: 'decision', initiativeId: null }, argsDigest: 'd',
      named: ['u-lee'], executor: 'u-priya', source: 'dev', evidence: [3], state: 'open', responses: [{ userId: 'u-sam', response: 'consent', reason: null, at: 5 }],
      dismissedBy: null, createdAt: T0, updatedAt: T0 + 1000, expiresAt: null, version: 2, run: null, askedBy: null,
    });
    expect(proposalFromRow(row({ asked_by: 'u-dana' })).askedBy).toBe('u-dana');
  });

  it('creates from the call\'s own row (so it carries the tenant) and ignores a repeat', async () => {
    rows = [row({ version: 1, responses: '[]' })];
    const out = await store().createProposal(base());
    expect(calls[0]!.sql).toMatch(/INSERT INTO meeting_assistant_proposals[\s\S]*SELECT :call, :id, tenant[\s\S]*FROM meeting_assistants WHERE call_id = :call[\s\S]*ON CONFLICT \(call_id, proposal_id\) DO NOTHING/);
    expect(out.created).toBe(true);
  });

  it('saves only on the version read, and never names the frozen columns', async () => {
    rows = [];
    expect(await store().saveProposal(base(), 4)).toBeNull();
    expect(calls[0]!.sql).toMatch(/UPDATE meeting_assistant_proposals SET state = :state[\s\S]*version = version \+ 1[\s\S]*WHERE call_id = :call AND proposal_id = :id AND version = :version/);
    expect(calls[0]!.sql.split('RETURNING')[0]).not.toMatch(/statement|outcome|named|args_digest/);
    expect(calls[0]!.params.find((p) => p.name === 'version')!.value).toEqual({ longValue: 4 });
  });

  it('sets the expiry once, where none is set', async () => {
    rows = [{ changed: 2 }];
    expect(await store().setProposalExpiry('call-1', T0)).toBe(2);
    expect(calls[0]!.sql).toMatch(/UPDATE meeting_assistant_proposals SET expires_at = :expires::timestamptz, version = version \+ 1\s+WHERE call_id = :call AND expires_at IS NULL/);
  });

  it('the purge and the inviter\'s delete remove the proposals', async () => {
    await store().purgeCall('call-1');
    expect(calls[0]!.sql).toMatch(/DELETE FROM meeting_assistant_proposals WHERE call_id IN \(SELECT call_id FROM eligible\)/);
    await store().tombstoneMinutes('call-1', 'u-priya', T0);
    expect(calls[1]!.sql).toMatch(/DELETE FROM meeting_assistant_proposals WHERE call_id = :call/);
  });
});
