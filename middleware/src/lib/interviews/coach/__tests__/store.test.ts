// The two suggestion-log stores behave the same (lib/interviews/coach/store.ts; decision 8, row I3.3), and D6's eraser.
jest.mock('../../../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));
import type { SqlParameter } from '@aws-sdk/client-rds-data';
import type { SqlExec } from '../../store-sql.js';
import { MemorySuggestionStore, setSuggestionStore, type SuggestionRecord, type SuggestionStore } from '../store.js';
import {
  ANSWER_SUGGESTION_SQL, ERASE_SUGGESTIONS_SQL, GET_SUGGESTION_SQL, INSERT_SUGGESTION_SQL, LIST_SUGGESTIONS_SQL, MARK_SHOWN_SQL,
  SqlSuggestionStore, SUGGESTION_STATEMENTS,
} from '../store-sql.js';
import { eraseSuggestions } from '../index.js';
import { fixtureRegistry } from '../../../../mock/core/index.js';
import { interviewSuggestionsFixture } from '../../../../mock/interviews-suggestions.js';
import { interviewsFixture } from '../../../../mock/interviews.js';

type P = { stringValue?: string; booleanValue?: boolean; longValue?: number; isNull?: boolean };
const param = (params: SqlParameter[] | undefined, name: string): P => (params?.find((x) => x.name === name)?.value ?? {}) as P;
const ts = (iso: string | null) => (iso === null ? null : iso.replace('T', ' ').replace('Z', ''));

/** interview_suggestions as the Data API would keep and answer it (timestamps as text, nulls as null). */
function suggestionsTableExec(): SqlExec {
  const table: Record<string, unknown>[] = [];
  const out = (rows: Record<string, unknown>[]) => rows.map((r) => ({ ...r }));
  return async (sql, params) => {
    const s = (n: string) => { const p = param(params, n); return p.isNull ? null : (p.stringValue ?? null); };
    const find = () => table.find((r) => r['interview_id'] === s('interview_id') && r['id'] === s('id'));
    if (sql === LIST_SUGGESTIONS_SQL) {
      return out(table.filter((r) => r['interview_id'] === s('interview_id')).sort((a, b) => String(a['made_at']).localeCompare(String(b['made_at'])) || String(a['id']).localeCompare(String(b['id']))));
    }
    if (sql === GET_SUGGESTION_SQL) { const r = find(); return r ? out([r]) : []; }
    if (sql === INSERT_SUGGESTION_SQL) {
      if (table.some((r) => r['id'] === s('id'))) throw new Error('duplicate key');
      const row = {
        id: s('id'), interview_id: s('interview_id'), call_id: s('call_id'), through_seq: param(params, 'through_seq').longValue, text: s('text'),
        competency_id: s('competency_id'), based_on: s('based_on'), made_at: ts(s('made_at')), shown_at: ts(s('shown_at')), answer: s('answer'),
        answered_at: ts(s('answered_at')), spoken: param(params, 'spoken').booleanValue, model_id: s('model_id'), prompt_version: s('prompt_version'), dropped: s('dropped'),
      };
      table.push(row);
      return out([row]);
    }
    if (sql === MARK_SHOWN_SQL) { const r = find(); if (!r) return []; r['shown_at'] ??= ts(s('at')); return out([r]); }
    if (sql === ANSWER_SUGGESTION_SQL) {
      const r = find();
      if (!r || r['dropped'] !== null || r['answer'] !== null) return [];
      r['answer'] = s('answer'); r['answered_at'] = ts(s('at'));
      return out([r]);
    }
    if (sql === ERASE_SUGGESTIONS_SQL) {
      const ids = String(s('interview_ids')).split(',');
      const gone = table.filter((r) => ids.includes(String(r['interview_id'])));
      for (const g of gone) table.splice(table.indexOf(g), 1);
      return gone.map((g) => ({ id: g['id'] }));
    }
    throw new Error(`unexpected statement: ${sql.slice(0, 60)}`);
  };
}

const T = (minute: number) => new Date(Date.UTC(2026, 10, 16, 10, minute)).toISOString();
const suggestion = (id: string, interviewId: string, minute: number, over: Partial<SuggestionRecord> = {}): SuggestionRecord => ({
  id, interviewId, callId: 'call-1', throughSeq: minute, text: 'Who did you bring in, and when?', competencyId: 'communication', basedOn: 'I paged the lead',
  madeAt: T(minute), shownAt: T(minute), answer: null, answeredAt: null, spoken: false, modelId: 'scripted-coach', promptVersion: 'coach-2026-11-16.1', dropped: null, ...over,
});
const droppedRow = (id: string, interviewId: string, minute: number): SuggestionRecord =>
  suggestion(id, interviewId, minute, { text: '', competencyId: null, basedOn: null, shownAt: null, dropped: 'judges' });

afterEach(() => { fixtureRegistry.resetAll('default'); setSuggestionStore(null); });

describe.each([
  ['memory', () => { fixtureRegistry.resetAll('empty'); return new MemorySuggestionStore() as SuggestionStore; }],
  ['sql', () => new SqlSuggestionStore(suggestionsTableExec()) as SuggestionStore],
])('the %s suggestion store', (_name, make) => {
  it('appends and lists an interview\'s rows oldest first, and nothing of another interview', async () => {
    const store = make();
    await store.appendSuggestion(suggestion('sg-b', 'iv-1', 5));
    await store.appendSuggestion(suggestion('sg-a', 'iv-1', 1));
    await store.appendSuggestion(suggestion('sg-c', 'iv-2', 2));
    expect((await store.listSuggestions('iv-1')).map((r) => r.id)).toEqual(['sg-a', 'sg-b']);
    expect(await store.listSuggestions('iv-1')).toEqual([suggestion('sg-a', 'iv-1', 1), suggestion('sg-b', 'iv-1', 5)]);
  });

  it('keeps a dropped attempt as its code only', async () => {
    const store = make();
    await store.appendSuggestion(droppedRow('sg-d', 'iv-1', 1));
    expect(await store.listSuggestions('iv-1')).toEqual([droppedRow('sg-d', 'iv-1', 1)]);
  });

  it('marks shown once: a second read keeps the first time', async () => {
    const store = make();
    await store.appendSuggestion(suggestion('sg-a', 'iv-1', 1, { shownAt: null }));
    expect((await store.markShown('iv-1', 'sg-a', T(2)))?.shownAt).toBe(T(2));
    expect((await store.markShown('iv-1', 'sg-a', T(3)))?.shownAt).toBe(T(2));
    expect(await store.markShown('iv-2', 'sg-a', T(3))).toBeNull();
  });

  it('answers once; a second answer is stale; a dropped or unknown row is not found', async () => {
    const store = make();
    await store.appendSuggestion(suggestion('sg-a', 'iv-1', 1));
    await store.appendSuggestion(droppedRow('sg-d', 'iv-1', 2));
    const first = await store.answerSuggestion('iv-1', 'sg-a', 'milo-ask', T(3));
    expect(first).toEqual({ ok: true, row: { ...suggestion('sg-a', 'iv-1', 1), answer: 'milo-ask', answeredAt: T(3), spoken: false } });
    expect(await store.answerSuggestion('iv-1', 'sg-a', 'skip', T(4))).toMatchObject({ ok: false, reason: 'stale', row: { answer: 'milo-ask' } });
    expect(await store.answerSuggestion('iv-1', 'sg-d', 'ask', T(4))).toEqual({ ok: false, reason: 'not-found' });
    expect(await store.answerSuggestion('iv-2', 'sg-a', 'ask', T(4))).toEqual({ ok: false, reason: 'not-found' });
  });

  it('erases the named interviews\' rows and no others', async () => {
    const store = make();
    await store.appendSuggestion(suggestion('sg-a', 'iv-1', 1));
    await store.appendSuggestion(droppedRow('sg-d', 'iv-1', 2));
    await store.appendSuggestion(suggestion('sg-c', 'iv-2', 2));
    expect(await store.eraseSuggestions(['iv-1', 'iv-3'])).toBe(2);
    expect(await store.listSuggestions('iv-1')).toEqual([]);
    expect((await store.listSuggestions('iv-2')).map((r) => r.id)).toEqual(['sg-c']);
    expect(await store.eraseSuggestions([])).toBe(0);
  });
});

describe('the statements', () => {
  it('only append, fill what is empty, or delete by interview', () => {
    const updates = SUGGESTION_STATEMENTS.filter((s) => /^UPDATE/.test(s));
    expect(updates).toEqual([MARK_SHOWN_SQL, ANSWER_SUGGESTION_SQL]);
    expect(MARK_SHOWN_SQL).toMatch(/COALESCE\(shown_at/);
    expect(ANSWER_SUGGESTION_SQL).toMatch(/answer IS NULL/);
    expect(SUGGESTION_STATEMENTS.filter((s) => /^DELETE/.test(s))).toEqual([ERASE_SUGGESTIONS_SQL]);
  });
});

describe('the seeded log', () => {
  it('holds answered suggestions on finished interviews only, and a dropped attempt without text', () => {
    const rows = interviewSuggestionsFixture.rows('default');
    const finished = new Set(interviewsFixture.rows('default').filter((i) => ['ended', 'scored', 'reviewed'].includes(i.state)).map((i) => i.id));
    expect(rows.length).toBeGreaterThanOrEqual(4);
    expect(rows.every((r) => finished.has(r.interviewId))).toBe(true);
    expect(new Set(rows.filter((r) => r.answer).map((r) => r.answer))).toEqual(new Set(['ask', 'milo-ask', 'skip']));
    expect(rows.every((r) => !r.spoken)).toBe(true);
    for (const r of rows.filter((x) => x.dropped)) expect([r.text, r.competencyId, r.basedOn, r.answer]).toEqual(['', null, null, null]);
  });
});

describe('D6: eraseSuggestions', () => {
  it('removes those interviews\' rows from the log and says how many', async () => {
    const before = interviewSuggestionsFixture.rows().filter((r) => r.interviewId === 'iv-mateo-coding').length;
    expect(before).toBeGreaterThan(0);
    expect(await eraseSuggestions(['iv-mateo-coding'])).toBe(before);
    expect(interviewSuggestionsFixture.rows().some((r) => r.interviewId === 'iv-mateo-coding')).toBe(false);
    expect(interviewSuggestionsFixture.rows().length).toBeGreaterThan(0);
  });
});
