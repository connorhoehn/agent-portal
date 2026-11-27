// Assigning a round and answering a seat, the portal's pure helpers (lib/interviewsAssign.ts, row I1.4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NOTICE_LATER, NOTICE_READ, answerPanelNotice, assignHref, canReassign, conflictsLine, declineLines, pickedConflicts, noticeParagraphs, panelChoices, reasonProblem, seatingOf, seatsOfRow,
  type PanelNotice, type WriteOutcome,
} from '../interviewsAssign.ts';

test('a decline needs a reason between the floor and the ceiling, as the server says', () => {
  assert.match(reasonProblem('busy') ?? '', /at least 10 characters/);
  assert.equal(reasonProblem('  On leave   that whole week. '), null);
  assert.match(reasonProblem('x'.repeat(501)) ?? '', /under 500/);
});

test('the form\'s seats drop blanks, repeats and the lead', () => {
  assert.deepEqual(seatingOf('u-hugo', ['', 'u-wen']), { leadId: 'u-hugo', panelIds: ['u-wen'] });
  assert.deepEqual(seatingOf('u-hugo', ['u-wen', 'u-wen']), { leadId: 'u-hugo', panelIds: ['u-wen'] });
  assert.deepEqual(seatingOf('u-hugo', ['u-hugo', '']), { leadId: 'u-hugo', panelIds: [] });
  const people = [{ id: 'u-hugo', name: 'Hugo' }, { id: 'u-wen', name: 'Wen' }, { id: 'u-ola', name: 'Ola' }];
  assert.deepEqual(panelChoices(people, 'u-hugo', 'u-wen').map((p) => p.id), ['u-ola']);
  assert.deepEqual(seatsOfRow({ lead: { id: 'u-hugo', name: 'Hugo' }, panel: [{ id: 'u-wen', name: 'Wen' }] }), { leadId: 'u-hugo', panel: ['u-wen', ''] });
  assert.deepEqual(seatsOfRow(null), { leadId: '', panel: ['', ''] });
});

test('who declined and why, the latest first; who sits may change until the call starts', () => {
  const lines = declineLines({ declines: [
    { person: { id: 'u-wen', name: 'Wen Zhao' }, seat: 'panel', reason: 'Clashes with on-call.', at: '2026-11-16T10:00:00Z' },
    { person: { id: 'u-hugo', name: 'Hugo Marchetti' }, seat: 'lead', reason: 'On leave.', at: '2026-11-16T12:00:00Z' },
  ] });
  assert.deepEqual(lines, ['Hugo Marchetti declined to lead: On leave.', 'Wen Zhao declined the panel seat: Clashes with on-call.']);
  assert.deepEqual(['assigned', 'accepted', 'ready', 'declined', 'live', 'ended', 'cancelled'].map((s) => canReassign(s as 'live')), [true, true, true, true, false, false, false]);
  assert.equal(assignHref('cand-x', { application: 'app-x' }), '/interviews/candidates/cand-x/assign?application=app-x');
  assert.equal(assignHref('cand-x', { round: 'iv-1' }), '/interviews/candidates/cand-x/assign?round=iv-1');
});

// The panel's notice at Accept (decision 5, its last sentence): the prompt's two answers.

const NOTICE: PanelNotice = { version: 'v2', title: 'Before your interview', text: 'First paragraph.\n\nSecond paragraph.', panelLine: 'This applies to you too.' };
const recorder = (ack: Awaited<ReturnType<Parameters<typeof answerPanelNotice>[2]['acknowledge']>> = { ok: true }, accepted: WriteOutcome = { ok: true, interview: null, conflicts: [] }) => {
  const calls: string[] = [];
  return { calls, writes: {
    acknowledge: async (v: string) => { calls.push(`ack:${v}`); return ack; },
    accept: async () => { calls.push('accept'); return accepted; },
  } };
};

test('"I have read it — accept" acknowledges the version shown, then accepts, with one receipt', async () => {
  const r = recorder();
  const out = await answerPanelNotice(NOTICE_READ, NOTICE, r.writes);
  assert.deepEqual(r.calls, ['ack:v2', 'accept']);
  assert.equal('receipt' in out && out.accepted, true);
  assert.match('receipt' in out ? out.receipt : '', /^Accepted\./);
});

test('"Not now" writes nothing', async () => {
  const r = recorder();
  const out = await answerPanelNotice(NOTICE_LATER, NOTICE, r.writes);
  assert.deepEqual(r.calls, []);
  assert.equal('receipt' in out && out.accepted, false);
});

test('a changed notice comes back to be shown, and nothing is accepted; a refused accept shows its error', async () => {
  const changed = recorder({ ok: false, error: 'The notice has changed.', needsNotice: { ...NOTICE, version: 'v3' } });
  const out = await answerPanelNotice(NOTICE_READ, NOTICE, changed.writes);
  assert.deepEqual(changed.calls, ['ack:v2']);
  assert.equal('error' in out && out.renotice?.version, 'v3');
  const refused = recorder({ ok: true }, { ok: false, error: 'Someone else changed this round.', fields: [], stale: true, interview: null });
  assert.deepEqual(await answerPanelNotice(NOTICE_READ, NOTICE, refused.writes), { error: 'Someone else changed this round.' });
});

test('the notice\'s paragraphs split on the blank line the server puts between them', () => {
  assert.deepEqual(noticeParagraphs(NOTICE.text), ['First paragraph.', 'Second paragraph.']);
});

// ── Row I6.4: the notice asked again after it changes ─────────────────────────────────────────────────────────
import { answerChangedNotice, shouldReaskNotice, type PanelNoticeStatus } from '../interviewsAssign.ts';

const NOTICE_V2 = { version: 'v2', title: 'How your interview is recorded', text: 'One.\n\nTwo.', panelLine: 'This applies to you too.' };

test('shouldReaskNotice: only when not acknowledged and a pending round exists', () => {
  const status = (over: Partial<PanelNoticeStatus>): PanelNoticeStatus => ({ notice: NOTICE_V2, acknowledged: false, pendingRounds: 2, roundId: 'iv-1', ...over });
  assert.equal(shouldReaskNotice(status({})), true);
  assert.equal(shouldReaskNotice(status({ acknowledged: true })), false);
  assert.equal(shouldReaskNotice(status({ pendingRounds: 0, roundId: null })), false);
  assert.equal(shouldReaskNotice(status({ roundId: null })), false);
  assert.equal(shouldReaskNotice(null), false);
});

test('answerChangedNotice: read acknowledges the version shown; not now changes nothing; a changed notice comes back', async () => {
  const versions: string[] = [];
  const ok = async (v: string) => { versions.push(v); return { ok: true as const }; };
  assert.deepEqual(await answerChangedNotice(NOTICE_READ, NOTICE_V2, ok), { receipt: 'Thank you. You have read the current notice.', acknowledged: true });
  assert.deepEqual(versions, ['v2']);
  const later = await answerChangedNotice(NOTICE_LATER, NOTICE_V2, ok);
  assert.equal('receipt' in later && later.acknowledged, false);
  assert.deepEqual(versions, ['v2']);
  const v3 = { ...NOTICE_V2, version: 'v3' };
  assert.deepEqual(await answerChangedNotice(NOTICE_READ, NOTICE_V2, async () => ({ ok: false, error: 'changed', needsNotice: v3 })), { error: 'changed', renotice: v3 });
});

// Double-booking (ledger row C-17): the form's check while a person is picked, and the words.
test('a picked person already on an overlapping round is named; touching, closed and own rounds are not', () => {
  const T0 = Date.parse('2031-03-04T14:00:00.000Z');
  const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
  const people = [{ id: 'u-hugo', name: 'Hugo Marchetti' }, { id: 'u-wen', name: 'Wen Zhao' }];
  const row = (id: string, start: number, minutes: number, lead: string, state: 'accepted' | 'cancelled' | 'ended' | 'live' = 'accepted', panel: string[] = []) =>
    ({ id, scheduledAt: at(start), state, round: { minutes }, lead: { id: lead, name: lead }, panel: panel.map((p) => ({ id: p, name: p })) });
  const mine = row('iv-this', 0, 60, 'u-hugo');
  const rows = [mine, row('iv-touch', 60, 60, 'u-hugo'), row('iv-gone', 10, 30, 'u-hugo', 'cancelled'), row('iv-done', 10, 30, 'u-hugo', 'ended'),
    row('iv-clash', 30, 60, 'u-ola', 'live', ['u-wen'])];
  assert.deepEqual(pickedConflicts(mine, { leadId: 'u-hugo', panelIds: ['u-wen'] }, rows, people),
    [{ person: { id: 'u-wen', name: 'Wen Zhao' }, interviewId: 'iv-clash', scheduledAt: at(30), minutes: 60 }]);
  assert.deepEqual(pickedConflicts(mine, { leadId: 'u-hugo', panelIds: [] }, rows, people), []);
  assert.deepEqual(pickedConflicts({ ...mine, scheduledAt: null }, { leadId: 'u-hugo', panelIds: ['u-wen'] }, rows, people), []);
  assert.equal(conflictsLine([{ person: { id: 'u-hugo', name: 'Hugo Marchetti' }, interviewId: 'iv-x', scheduledAt: at(0), minutes: 60 }], 'UTC'),
    'Hugo Marchetti is also on a round from 14:00 to 15:00 that day.');
});
