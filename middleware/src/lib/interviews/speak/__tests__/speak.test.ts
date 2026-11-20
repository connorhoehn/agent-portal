// Milo speaks in an interview (lib/interviews/speak; rows I3.5, I3.8; decisions 9, 10). The order is the bar: the said log's row
// and the chat post exist before the session is asked to speak; the candidate's requests are answered from held text only; the
// two stores behave the same.
jest.mock('../../../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true, cloudwatch: true, guardrails: true, agentcore: true } } }));
import type { SqlParameter } from '@aws-sdk/client-rds-data';
import type { SqlExec } from '../../store-sql.js';
import {
  MILO_CAN_DO, MemorySaidStore, NO_QUESTION_YET, answerCandidate, candidateLine, candidateRequestOf, lastQuestion, logCandidateLine,
  noteHeldSaid, roundStartMs, sayApproved, setSaidStore, setSpeakDeps, timeLeftLine, type SaidRecord, type SaidStore,
} from '../index.js';
import { ERASE_SAID_SQL, INSERT_SAID_SQL, LIST_SAID_SQL, MARK_POSTED_SQL, MARK_SPOKEN_SQL, SqlSaidStore } from '../store-sql.js';

const IV = { id: 'iv-1', callId: 'call-1', minutes: 45, scheduledAt: null as string | null };
const NOW = Date.parse('2026-11-17T15:00:00.000Z');
const order: string[] = [];
let store: SaidStore;
let n = 0;
let sayOut: 'spoken' | 'posted' | 'no-call' = 'spoken';
let sayPartly: string | undefined;
let posted: Array<{ text: string; kind: string }> = [];

beforeEach(() => {
  order.length = 0; posted = []; n = 0; sayOut = 'spoken'; sayPartly = undefined;
  store = new MemorySaidStore();
  const logged: SaidStore = {
    list: (id) => store.list(id),
    append: async (row) => { order.push(`log:${row.kind}`); return store.append(row); },
    markPosted: async (id, rowId) => { order.push('posted'); return store.markPosted(id, rowId); },
    markSpoken: async (id, rowId) => { order.push('spoken'); return store.markSpoken(id, rowId); },
    markSpokenPart: async (id, rowId, heard) => { order.push('spoken-part'); return store.markSpokenPart(id, rowId, heard); },
    erase: (ids) => store.erase(ids),
  };
  setSpeakDeps({
    store: () => logged,
    post: async (_c, text, kind) => { order.push(`post:${kind}`); posted.push({ text, kind }); return true; },
    say: async () => { order.push('say'); return { outcome: sayOut, why: null, ...(sayPartly ? { partly: sayPartly } : {}) }; },
    miloJoinedAt: async () => NOW - 10 * 60_000,
    now: () => NOW,
    newId: () => `said-${++n}`, holdSpeech: async () => ({ ok: true as const, release: async () => undefined }),
  });
});
afterAll(() => { setSpeakDeps(null); setSaidStore(null); });

describe('approved words: logged, then posted, then said', () => {
  it('the log row and the chat post come before the session is asked; spoken is marked only when relayed', async () => {
    const out = await sayApproved(IV, { kind: 'question', source: 'kit', text: 'Design a URL shortener.', askedBy: 'u-wen', questionId: 'q-1' });
    expect(order).toEqual(['log:question', 'post:question', 'posted', 'say', 'spoken']);
    expect(out.said).toBe('spoken');
    expect((await store.list('iv-1'))[0]).toMatchObject({ kind: 'question', source: 'kit', questionId: 'q-1', text: 'Design a URL shortener.', posted: true, spoken: true });
  });

  it('cut part way on the voice: the row stays unspoken and says which words were heard (review 1, item 5)', async () => {
    sayOut = 'posted'; sayPartly = 'Walk me';
    const { said, row } = await sayApproved({ id: 'iv-1', callId: 'call-1' }, { kind: 'question', source: 'kit', text: 'Walk me through how you would design it.', askedBy: 'u-hugo', questionId: 'q1' });
    expect(said).toBe('chat');
    expect(order).toContain('spoken-part');
    const stored = (await store.list('iv-1')).find((r) => r.id === row.id)!;
    expect(stored).toMatchObject({ spoken: false, spokenPart: 'Walk me' });
  });

  it('withheld or voice off: chat only, the row stays unspoken; Milo not in the call: nothing posted, nothing said', async () => {
    sayOut = 'posted';
    expect((await sayApproved(IV, { kind: 'question', source: 'kit', text: 'Q', askedBy: 'u-wen' })).said).toBe('chat');
    expect((await store.list('iv-1'))[0]).toMatchObject({ posted: true, spoken: false });
    order.length = 0;
    setSpeakDeps({ store: () => store, post: async () => false, say: async () => { order.push('say'); return { outcome: 'spoken' as const, why: null }; }, now: () => NOW, newId: () => `said-${++n}`, holdSpeech: async () => ({ ok: true as const, release: async () => undefined }) });
    expect((await sayApproved(IV, { kind: 'question', source: 'kit', text: 'Q', askedBy: 'u-wen' })).said).toBe('none');
    expect(order).toEqual([]);
    expect((await store.list('iv-1'))[1]).toMatchObject({ posted: false, spoken: false });
  });
});

describe('the candidate\'s requests (decision 10)', () => {
  it('reads the two fixed requests; anything else is other', () => {
    expect(candidateRequestOf('Milo, repeat the question')).toBe('repeat');
    expect(candidateRequestOf('Milo, can you say that again?')).toBe('repeat');
    expect(candidateRequestOf('Milo, how much time is left?')).toBe('time');
    expect(candidateRequestOf('Milo, how long do I have?')).toBe('time');
    for (const t of ['how are we on time', 'Milo, how are we doing on time?', 'time check', 'Milo, time check please', 'how much time do we have', 'how much time is left']) expect(candidateRequestOf(t)).toBe('time');
    for (const t of ['could you repeat the question', 'can you say that again', 'Oh, so sorry, Milo, I was focusing. Could you repeat the question?', 'sorry, what was the question']) expect(candidateRequestOf(t)).toBe('repeat');
    expect(candidateRequestOf('Milo, give me a hint')).toBe('other');
    expect(candidateRequestOf('Milo, what is the time complexity of a heap?')).toBe('other');
  });

  it('repeat: the round\'s question the candidate has on screen when the lead asked it himself (Milo asked none)', async () => {
    setSpeakDeps({ store: () => store, roundQuestion: async (id) => (id === IV.id ? 'Design a news feed for 300 million users.' : null) });
    expect(await candidateLine(IV, 'repeat')).toEqual({ text: 'Design a news feed for 300 million users.', source: 'repeat' });
    // A question Milo was approved to ask later is the last one asked: it is read, not the round's.
    await store.append({ id: 'said-q', interviewId: IV.id, callId: IV.callId, kind: 'question', source: 'suggestion', questionId: null, suggestionId: null, text: 'Where would you cache?', askedBy: 'u-wen', saidAt: new Date(NOW).toISOString(), posted: true, spoken: true });
    expect((await candidateLine(IV, 'repeat')).text).toBe('Where would you cache?');
  });

  it('repeat: the last approved question, or a plain sentence before there is one', async () => {
    expect((await candidateLine(IV, 'repeat')).text).toBe(NO_QUESTION_YET);
    await sayApproved(IV, { kind: 'question', source: 'suggestion', text: 'First question?', askedBy: 'u-wen' });
    await sayApproved(IV, { kind: 'answer', source: 'time', text: 'About 5 minutes are left in this round.', askedBy: 'guest:x' });
    await sayApproved(IV, { kind: 'question', source: 'kit', text: 'Second question?', askedBy: 'u-wen' });
    await sayApproved(IV, { kind: 'answer', source: 'refusal', text: MILO_CAN_DO, askedBy: 'guest:x' });
    expect((await candidateLine(IV, 'repeat')).text).toBe('Second question?');
    expect(lastQuestion([])).toBeNull();
  });

  it('time: from the set time once passed, else from when Milo joined; anything else: the fixed sentence', async () => {
    expect((await candidateLine(IV, 'time')).text).toBe('About 35 minutes are left in this round.');
    expect(timeLeftLine(45, NOW - 44.5 * 60_000, NOW)).toBe('About 1 minute is left in this round.');
    expect(timeLeftLine(45, NOW - 50 * 60_000, NOW)).toBe('This round is at the end of its time.');
    expect(timeLeftLine(45, null, NOW)).toBe('This round is 45 minutes long.');
    expect(roundStartMs(new Date(NOW + 3_600_000).toISOString(), NOW - 60_000, NOW)).toBe(NOW - 60_000);
    expect(roundStartMs(new Date(NOW - 120_000).toISOString(), NOW - 60_000, NOW)).toBe(NOW - 120_000);
    expect((await candidateLine(IV, 'other')).text).toBe(MILO_CAN_DO);
  });

  it('the button: logged as an answer, posted with the answer mark, said', async () => {
    const out = await answerCandidate(IV, 'time', 'guest:inv-1');
    expect(out).toEqual({ line: 'About 35 minutes are left in this round.', said: 'spoken' });
    expect(order).toEqual(['log:answer', 'post:answer', 'posted', 'say', 'spoken']);
    expect(posted).toEqual([{ text: out.line, kind: 'answer' }]);
  });

  it('the spoken request: logged unposted (the orchestrator posts and says it), then marked by its words and asker', async () => {
    const line = await logCandidateLine(IV, 'Milo, please give me a hint', 'guest:inv-1');
    expect(line).toBe(MILO_CAN_DO);
    expect(order).toEqual(['log:answer']);
    await noteHeldSaid('iv-1', MILO_CAN_DO, 'guest:other', { posted: true, spoken: true });
    await noteHeldSaid('iv-1', MILO_CAN_DO, 'guest:inv-1', { posted: false, spoken: false });
    expect((await store.list('iv-1'))[0]).toMatchObject({ posted: false, spoken: false });
    await noteHeldSaid('iv-1', MILO_CAN_DO, 'guest:inv-1', { posted: true, spoken: true });
    expect((await store.list('iv-1'))[0]).toMatchObject({ posted: true, spoken: true });
  });
});

// ── The two stores behave the same ──────────────────────────────────────────────────────────────────────────────────
type P = { stringValue?: string; booleanValue?: boolean; isNull?: boolean };
const param = (params: SqlParameter[] | undefined, name: string): P => (params?.find((x) => x.name === name)?.value ?? {}) as P;
function saidTableExec(): SqlExec {
  const table: Record<string, unknown>[] = [];
  return async (sql, params) => {
    const s = (k: string) => { const p = param(params, k); return p.isNull ? null : (p.stringValue ?? null); };
    if (sql === LIST_SAID_SQL) return table.filter((r) => r['interview_id'] === s('interview_id')).sort((a, b) => String(a['said_at']).localeCompare(String(b['said_at'])) || String(a['id']).localeCompare(String(b['id']))).map((r) => ({ ...r }));
    if (sql === INSERT_SAID_SQL) {
      if (table.some((r) => r['id'] === s('id'))) throw new Error('duplicate key');
      const row = { id: s('id'), interview_id: s('interview_id'), call_id: s('call_id'), kind: s('kind'), source: s('source'), question_id: s('question_id'),
        suggestion_id: s('suggestion_id'), text: s('text'), asked_by: s('asked_by'), said_at: s('said_at')!.replace('T', ' ').replace('Z', ''), posted: param(params, 'posted').booleanValue, spoken: param(params, 'spoken').booleanValue };
      table.push(row); return [{ ...row }];
    }
    if (sql === MARK_POSTED_SQL) { const r = table.find((x) => x['interview_id'] === s('interview_id') && x['id'] === s('id')); if (!r) return []; r['posted'] = true; return [{ ...r }]; }
    if (sql === MARK_SPOKEN_SQL) { const r = table.find((x) => x['interview_id'] === s('interview_id') && x['id'] === s('id')); if (!r) return []; r['spoken'] = true; return [{ ...r }]; }
    if (sql === ERASE_SAID_SQL) { const ids = new Set(String(s('interview_ids')).split(',')); const gone = table.filter((r) => ids.has(String(r['interview_id']))); for (const g of gone) table.splice(table.indexOf(g), 1); return gone.map((g) => ({ id: g['id'] })); }
    throw new Error(`unexpected statement: ${sql.slice(0, 40)}`);
  };
}

describe.each([['memory', () => new MemorySaidStore()], ['sql', () => new SqlSaidStore(saidTableExec())]] as const)('the said log (%s)', (_name, make) => {
  const row = (over: Partial<SaidRecord> = {}): SaidRecord => ({ id: 'said-a', interviewId: 'iv-1', callId: 'call-1', kind: 'question', source: 'kit', questionId: 'q-1',
    suggestionId: null, text: 'Q?', askedBy: 'u-wen', saidAt: '2026-11-17T15:00:00.000Z', posted: false, spoken: false, ...over });
  it('appends once, lists oldest first, marks posted and spoken, erases by interview', async () => {
    const s = make();
    await s.append(row({ id: 'said-b', saidAt: '2026-11-17T15:01:00.000Z' }));
    await s.append(row());
    await s.append(row({ id: 'said-c', interviewId: 'iv-2' }));
    await expect(s.append(row())).rejects.toThrow();
    expect((await s.list('iv-1')).map((r) => r.id)).toEqual(['said-a', 'said-b']);
    expect(await s.list('iv-1')).toEqual([row(), row({ id: 'said-b', saidAt: '2026-11-17T15:01:00.000Z' })]);
    expect(await s.markSpoken('iv-1', 'said-b')).toMatchObject({ id: 'said-b', spoken: true });
    expect(await s.markSpoken('iv-1', 'nope')).toBeNull();
    expect(await s.markPosted('iv-1', 'said-a')).toMatchObject({ id: 'said-a', posted: true, spoken: false });
    expect(await s.markPosted('iv-1', 'nope')).toBeNull();
    expect(await s.erase(['iv-1'])).toBe(2);
    expect(await s.list('iv-1')).toEqual([]);
    expect(await s.list('iv-2')).toHaveLength(1);
  });
});

// OWED O-225 (lane H8): the process stops after the said log's row is written and while the session is asked to speak. The
// row is kept unspoken (a SQL store keeps it across the restart; the memory store stands in for it here) and nothing replays
// it on its own afterwards: only a new approval is said. ("Repeat the question" may still read it: that is the candidate's
// own request for the last approved question, answered from the log by design.)
describe('a restart between the log row and the speech', () => {
  it('the row stays unspoken and is never said later on its own', async () => {
    const asked: string[] = [];
    setSpeakDeps({
      store: () => store, post: async () => true, callOf: async () => 'call-1', now: () => NOW, newId: () => `said-${++n}`, holdSpeech: async () => ({ ok: true as const, release: async () => undefined }),
      say: (_c, text) => { asked.push(text); return new Promise(() => { /* the process stops here: no answer, ever */ }); },
    });
    void sayApproved(IV, { kind: 'question', source: 'kit', text: 'Before the restart.', askedBy: 'u-wen' });
    for (let i = 0; i < 10 && asked.length === 0; i += 1) await new Promise((r) => setImmediate(r));
    expect(asked).toEqual(['Before the restart.']);
    expect((await store.list('iv-1')).map((r) => [r.text, r.spoken])).toEqual([['Before the restart.', false]]);

    // After the restart: fresh dependencies over the same stored rows.
    const said: string[] = [];
    setSpeakDeps({
      store: () => store, post: async () => true, callOf: async () => 'call-1', now: () => NOW, newId: () => `said-${++n}`, holdSpeech: async () => ({ ok: true as const, release: async () => undefined }),
      say: async (_c, text) => { said.push(text); return { outcome: 'spoken' as const, why: null }; },
    });
    expect((await sayApproved(IV, { kind: 'question', source: 'kit', text: 'After the restart.', askedBy: 'u-wen' })).said).toBe('spoken');
    await noteHeldSaid('iv-1', 'Before the restart.', 'u-wen', { posted: true, spoken: true });
    expect(said).toEqual(['After the restart.']);
    expect((await store.list('iv-1')).map((r) => [r.text, r.spoken])).toEqual([['Before the restart.', false], ['After the restart.', true]]);
  });
});
