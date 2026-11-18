// Milo speaks in an interview (lib/interviews/speak; rows I3.5, I3.8; decisions 9, 10). The order is the bar: the said log's row
// and the chat post exist before the session is asked to speak; the candidate's requests are answered from held text only; the
// two stores behave the same.
jest.mock('../../../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true, cloudwatch: true, guardrails: true, agentcore: true } } }));
import type { SqlParameter } from '@aws-sdk/client-rds-data';
import type { SqlExec } from '../../store-sql.js';
import {
  MILO_CAN_DO, MemorySaidStore, NO_QUESTION_YET, answerCandidate, candidateLine, candidateRequestOf, lastQuestion, logCandidateLine,
  noteHeldSpoken, roundStartMs, sayApproved, setSaidStore, setSpeakDeps, timeLeftLine, type SaidRecord, type SaidStore,
} from '../index.js';
import { ERASE_SAID_SQL, INSERT_SAID_SQL, LIST_SAID_SQL, MARK_SPOKEN_SQL, SqlSaidStore } from '../store-sql.js';

const IV = { id: 'iv-1', callId: 'call-1', minutes: 45, scheduledAt: null as string | null };
const NOW = Date.parse('2026-11-17T15:00:00.000Z');
const order: string[] = [];
let store: SaidStore;
let n = 0;
let sayOut: 'spoken' | 'posted' | 'no-call' = 'spoken';
let posted: Array<{ text: string; kind: string }> = [];

beforeEach(() => {
  order.length = 0; posted = []; n = 0; sayOut = 'spoken';
  store = new MemorySaidStore();
  const logged: SaidStore = {
    list: (id) => store.list(id),
    append: async (row) => { order.push(`log:${row.kind}`); return store.append(row); },
    markSpoken: async (id, rowId) => { order.push('spoken'); return store.markSpoken(id, rowId); },
    erase: (ids) => store.erase(ids),
  };
  setSpeakDeps({
    store: () => logged,
    post: async (_c, text, kind) => { order.push(`post:${kind}`); posted.push({ text, kind }); return true; },
    say: async () => { order.push('say'); return { outcome: sayOut, why: null }; },
    miloJoinedAt: async () => NOW - 10 * 60_000,
    now: () => NOW,
    newId: () => `said-${++n}`, holdSpeech: async () => ({ ok: true as const, release: async () => undefined }),
  });
});
afterAll(() => { setSpeakDeps(null); setSaidStore(null); });

describe('approved words: logged, then posted, then said', () => {
  it('the log row and the chat post come before the session is asked; spoken is marked only when relayed', async () => {
    const out = await sayApproved(IV, { kind: 'question', source: 'kit', text: 'Design a URL shortener.', askedBy: 'u-wen', questionId: 'q-1' });
    expect(order).toEqual(['log:question', 'post:question', 'say', 'spoken']);
    expect(out.said).toBe('spoken');
    expect((await store.list('iv-1'))[0]).toMatchObject({ kind: 'question', source: 'kit', questionId: 'q-1', text: 'Design a URL shortener.', spoken: true });
  });

  it('withheld or voice off: chat only, the row stays unspoken; Milo not in the call: nothing posted, nothing said', async () => {
    sayOut = 'posted';
    expect((await sayApproved(IV, { kind: 'question', source: 'kit', text: 'Q', askedBy: 'u-wen' })).said).toBe('chat');
    expect((await store.list('iv-1'))[0]!.spoken).toBe(false);
    order.length = 0;
    setSpeakDeps({ store: () => store, post: async () => false, say: async () => { order.push('say'); return { outcome: 'spoken' as const, why: null }; }, now: () => NOW, newId: () => `said-${++n}`, holdSpeech: async () => ({ ok: true as const, release: async () => undefined }) });
    expect((await sayApproved(IV, { kind: 'question', source: 'kit', text: 'Q', askedBy: 'u-wen' })).said).toBe('none');
    expect(order).toEqual([]);
  });
});

describe('the candidate\'s requests (decision 10)', () => {
  it('reads the two fixed requests; anything else is other', () => {
    expect(candidateRequestOf('Milo, repeat the question')).toBe('repeat');
    expect(candidateRequestOf('Milo, can you say that again?')).toBe('repeat');
    expect(candidateRequestOf('Milo, how much time is left?')).toBe('time');
    expect(candidateRequestOf('Milo, how long do I have?')).toBe('time');
    expect(candidateRequestOf('Milo, give me a hint')).toBe('other');
    expect(candidateRequestOf('Milo, what is the time complexity of a heap?')).toBe('other');
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
    expect(order).toEqual(['log:answer', 'post:answer', 'say', 'spoken']);
    expect(posted).toEqual([{ text: out.line, kind: 'answer' }]);
  });

  it('the spoken request: logged unspoken (the orchestrator posts and says it), then marked spoken by its words and asker', async () => {
    const line = await logCandidateLine(IV, 'Milo, please give me a hint', 'guest:inv-1');
    expect(line).toBe(MILO_CAN_DO);
    expect(order).toEqual(['log:answer']);
    await noteHeldSpoken('iv-1', MILO_CAN_DO, 'guest:other');
    expect((await store.list('iv-1'))[0]!.spoken).toBe(false);
    await noteHeldSpoken('iv-1', MILO_CAN_DO, 'guest:inv-1');
    expect((await store.list('iv-1'))[0]!.spoken).toBe(true);
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
        suggestion_id: s('suggestion_id'), text: s('text'), asked_by: s('asked_by'), said_at: s('said_at')!.replace('T', ' ').replace('Z', ''), spoken: param(params, 'spoken').booleanValue };
      table.push(row); return [{ ...row }];
    }
    if (sql === MARK_SPOKEN_SQL) { const r = table.find((x) => x['interview_id'] === s('interview_id') && x['id'] === s('id')); if (!r) return []; r['spoken'] = true; return [{ ...r }]; }
    if (sql === ERASE_SAID_SQL) { const ids = new Set(String(s('interview_ids')).split(',')); const gone = table.filter((r) => ids.has(String(r['interview_id']))); for (const g of gone) table.splice(table.indexOf(g), 1); return gone.map((g) => ({ id: g['id'] })); }
    throw new Error(`unexpected statement: ${sql.slice(0, 40)}`);
  };
}

describe.each([['memory', () => new MemorySaidStore()], ['sql', () => new SqlSaidStore(saidTableExec())]] as const)('the said log (%s)', (_name, make) => {
  const row = (over: Partial<SaidRecord> = {}): SaidRecord => ({ id: 'said-a', interviewId: 'iv-1', callId: 'call-1', kind: 'question', source: 'kit', questionId: 'q-1',
    suggestionId: null, text: 'Q?', askedBy: 'u-wen', saidAt: '2026-11-17T15:00:00.000Z', spoken: false, ...over });
  it('appends once, lists oldest first, marks spoken, erases by interview', async () => {
    const s = make();
    await s.append(row({ id: 'said-b', saidAt: '2026-11-17T15:01:00.000Z' }));
    await s.append(row());
    await s.append(row({ id: 'said-c', interviewId: 'iv-2' }));
    await expect(s.append(row())).rejects.toThrow();
    expect((await s.list('iv-1')).map((r) => r.id)).toEqual(['said-a', 'said-b']);
    expect(await s.list('iv-1')).toEqual([row(), row({ id: 'said-b', saidAt: '2026-11-17T15:01:00.000Z' })]);
    expect(await s.markSpoken('iv-1', 'said-b')).toMatchObject({ id: 'said-b', spoken: true });
    expect(await s.markSpoken('iv-1', 'nope')).toBeNull();
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
    await noteHeldSpoken('iv-1', 'Before the restart.', 'u-wen');
    expect(said).toEqual(['After the restart.']);
    expect((await store.list('iv-1')).map((r) => [r.text, r.spoken])).toEqual([['Before the restart.', false], ['After the restart.', true]]);
  });
});
