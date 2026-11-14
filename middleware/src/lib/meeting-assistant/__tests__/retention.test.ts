// Retention covers every table of the feature, by the call's age, and never touches a call that is still listening or paused (audit M3).
jest.mock('../../../config.js', () => ({ config: { mock: { aurora: true }, meetingAssistant: { enabled: true, transcriptRetentionDays: 30 } } }));
import { MemoryAssistantStore } from '../store.js';
import { SqlAssistantStore } from '../store-sql.js';
import { sweepTranscripts, startRetentionSweep, lastGoodRetentionSweepAt } from '../retention.js';
import type { AssistantRecord, AssistantState } from '../types.js';

const DAY = 86_400_000;
const NOW = 200 * DAY;
const rec = (callId: string, state: AssistantState, over: Partial<AssistantRecord> = {}): AssistantRecord => ({
  callId, tenant: 'orgiq', lobby: 'l', initiativeId: null, state, invitedBy: 'u-vera', invitedAt: NOW - 90 * DAY, pausedBy: null, leftAt: null, leftBy: null,
  acked: [], attendees: ['u-vera'], presentAtInvite: [], requests: 0, linesStored: 0, nextSeq: 1, pendingRequests: [], ...over,
});

async function fill(s: MemoryAssistantStore, r: AssistantRecord) {
  await s.create({ ...r, state: 'listening' });
  await s.appendLine({ callId: r.callId, userId: 'u-vera', participantId: 'p', speakerName: 'V', text: 'words', at: r.invitedAt + 1000, captionId: 'c' });
  await s.putMinutes({ callId: r.callId, tenant: 'orgiq', lobby: 'l', initiativeId: null, callName: 'n', startedAt: 1, endedAt: 2, invitedBy: 'u-vera', attendees: ['u-vera'], summary: 's', decisions: [], actionItems: [], topics: [], lineCount: 1, truncated: false, writer: 'scripted', createdAt: NOW - 1000 });
  await s.createTurn({ turnId: 't', callId: r.callId, askedBy: 'u-vera', tool: { name: 'x', args: { a: 1 } }, kind: 'read', status: 'done', createdAt: 1, expiresAt: 2 });
  await s.createAction({ callId: r.callId, actionId: 'a', messageId: 'm', askedBy: 'u-vera', toolName: 'x', argsDigest: 'd', status: 'done', createdAt: 1, decidedBy: null, decidedAt: null, resultText: 'r' });
  if (r.state !== 'listening') await s.transition(r.callId, { from: ['listening'], to: r.state, by: 'u-vera', at: r.leftAt ?? r.invitedAt + 2000 });
}
const present = async (s: MemoryAssistantStore, id: string) => ({
  record: !!(await s.get(id)), lines: (await s.lines(id, 0, 9)).length, minutes: !!(await s.getMinutes(id)), turns: (await s.listTurns(id)).length, action: !!(await s.getAction(id, 'a')),
});

describe('retention by the call age (memory store, injected clock)', () => {
  it('removes a call that ended before the window from every table, by leftAt, and keeps a newer one', async () => {
    const s = new MemoryAssistantStore(); const erased: string[] = [];
    await fill(s, rec('old', 'left', { invitedAt: NOW - 100 * DAY, leftAt: NOW - 31 * DAY }));
    await fill(s, rec('edge', 'left', { invitedAt: NOW - 100 * DAY, leftAt: NOW - 30 * DAY }));
    await fill(s, rec('new', 'left', { invitedAt: NOW - 100 * DAY, leftAt: NOW - 29 * DAY }));
    await sweepTranscripts(s, NOW, 30, { eraseChat: async (id) => { erased.push(id); } });
    expect(await present(s, 'old')).toEqual({ record: false, lines: 0, minutes: false, turns: 0, action: false });
    expect((await present(s, 'edge')).record).toBe(false);
    expect(erased.sort()).toEqual(['edge', 'old']);
    // `new` ended 29 days ago: its minutes (written 1 second ago) and its turns and actions stay.
    expect(await present(s, 'new')).toMatchObject({ record: true, minutes: true, turns: 1, action: true });
  });

  it('uses invitedAt when the call never recorded leaving', async () => {
    const s = new MemoryAssistantStore();
    await s.create(rec('stuck', 'invited', { invitedAt: NOW - 40 * DAY }));
    await sweepTranscripts(s, NOW, 30, { eraseChat: async () => undefined });
    expect(await s.get('stuck')).toBeNull();
  });

  it('never sweeps a call that is still listening or paused, however old its lines', async () => {
    const s = new MemoryAssistantStore(); const erased: string[] = [];
    await fill(s, rec('live', 'listening', { invitedAt: NOW - 90 * DAY }));
    await fill(s, rec('held', 'paused', { invitedAt: NOW - 90 * DAY }));
    for (const id of ['live', 'held']) await s.patchSession(id, { lastAliveAt: NOW - 60_000 }); // a heartbeat a minute ago: something serves them
    await sweepTranscripts(s, NOW, 30, { eraseChat: async (id) => { erased.push(id); } });
    expect(erased).toEqual([]);
    for (const id of ['live', 'held']) expect(await present(s, id)).toMatchObject({ record: true, lines: 1, turns: 1, action: true });
    expect(await s.purgeCall('live')).toBe(false);
  });

  it('ends a listening or paused record whose heartbeat is older than the hard maximum plus 30 minutes, then applies the ordinary rule', async () => {
    const hardMs = 180 * 60_000; const margin = 30 * 60_000;
    const s = new MemoryAssistantStore(); const erased: string[] = [];
    await fill(s, rec('quiet', 'listening', { invitedAt: NOW - 90 * DAY }));                      // no heartbeat ever: judged by invitedAt
    await fill(s, rec('quiet-paused', 'paused', { invitedAt: NOW - 90 * DAY }));
    await fill(s, rec('just-inside', 'listening', { invitedAt: NOW - 90 * DAY }));
    await fill(s, rec('just-outside', 'listening', { invitedAt: NOW - 90 * DAY }));
    await s.patchSession('just-inside', { lastAliveAt: NOW - hardMs - margin + 1000 });
    await s.patchSession('just-outside', { lastAliveAt: NOW - hardMs - margin - 1000 });
    const ended: string[] = [];
    const endAbandoned = async (id: string, at: number) => { ended.push(id); await s.patchSession(id, { settled: true }); await s.transition(id, { from: ['listening', 'paused'], to: 'left', by: 'system', at }); };
    await sweepTranscripts(s, NOW, 30, { eraseChat: async (id) => { erased.push(id); }, endAbandoned });
    expect(ended.sort()).toEqual(['just-outside', 'quiet', 'quiet-paused']);
    // The two with no heartbeat ended 90 days ago, so the 30-day rule removes them in the same sweep; the others stay.
    expect(erased.sort()).toEqual(['quiet', 'quiet-paused']);
    expect(await s.get('just-outside')).toMatchObject({ state: 'left' });
    expect(await s.get('quiet')).toBeNull();
    expect(await present(s, 'just-inside')).toMatchObject({ record: true, lines: 1 });
  });

  it('a recently abandoned record is left (state left, settled) and kept until it is 30 days old', async () => {
    const s = new MemoryAssistantStore();
    const hb = NOW - 5 * 3600_000;
    await fill(s, rec('gone', 'listening', { invitedAt: hb - 1000 })); await s.patchSession('gone', { lastAliveAt: hb });
    await sweepTranscripts(s, NOW, 30, { eraseChat: async () => undefined, endAbandoned: async (id, at) => { await s.patchSession(id, { settled: true }); await s.transition(id, { from: ['listening'], to: 'left', by: 'system', at }); } });
    expect(await s.get('gone')).toMatchObject({ state: 'left', leftBy: 'system', leftAt: hb });
    expect(await present(s, 'gone')).toMatchObject({ record: true, lines: 1 });
  });

  it('keeps a call whose chat messages could not be replaced, so the next sweep tries again', async () => {
    const s = new MemoryAssistantStore(); let fail = true;
    await fill(s, rec('old', 'left', { leftAt: NOW - 40 * DAY }));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const eraseChat = async () => { if (fail) throw new Error('chat down'); };
    await sweepTranscripts(s, NOW, 30, { eraseChat });
    expect(await s.get('old')).not.toBeNull();
    // The stored words are already gone, though the chat step failed.
    expect(await s.lines('old', 0, 9)).toEqual([]);
    expect(JSON.stringify(await s.listTurns('old'))).not.toContain('"a":1');
    expect((await s.getAction('old', 'a'))!.resultText).not.toBe('r');
    fail = false;
    await sweepTranscripts(s, NOW, 30, { eraseChat });
    expect(await s.get('old')).toBeNull();
    warn.mockRestore();
  });

  it('logs a repeated failure again when the message changes or a day has passed, and records the last good sweep', async () => {
    jest.useFakeTimers();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    let t = 1_000_000; let message = 'first'; let broken = true;
    const store = new MemoryAssistantStore();
    jest.spyOn(store, 'sweepLines').mockImplementation(async () => { if (broken) throw new Error(message); return 0; });
    const stop = startRetentionSweep(store, 1000, () => t);
    const tick = async (advanceMs: number) => { t += advanceMs; jest.advanceTimersByTime(1000); for (let i = 0; i < 6; i += 1) await Promise.resolve(); };
    const before = lastGoodRetentionSweepAt();
    await tick(1000); await tick(3_600_000);
    expect(warn).toHaveBeenCalledTimes(1);                   // same message within a day: quiet
    message = 'second'; await tick(3_600_000);
    expect(warn).toHaveBeenCalledTimes(2);                   // a new message: logged
    await tick(24 * 3_600_000);
    expect(warn).toHaveBeenCalledTimes(3);                   // a day later: logged again
    expect(lastGoodRetentionSweepAt()).toBe(before);
    broken = false; await tick(1000);
    expect(lastGoodRetentionSweepAt()).toBe(t);
    stop(); jest.useRealTimers(); warn.mockRestore();
  });

  it('is a no-op on empty tables', async () => {
    const s = new MemoryAssistantStore();
    await expect(sweepTranscripts(s, NOW, 30, { eraseChat: async () => undefined })).resolves.toBe(0);
  });

  it('the hourly sweep logs a failure once and keeps running', async () => {
    jest.useFakeTimers();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = new MemoryAssistantStore(); jest.spyOn(store, 'sweepLines').mockRejectedValue(new Error('relation "meeting_assistants" does not exist'));
    const stop = startRetentionSweep(store, 1000);
    for (let i = 0; i < 3; i += 1) { jest.advanceTimersByTime(1000); await Promise.resolve(); await Promise.resolve(); }
    expect(warn).toHaveBeenCalledTimes(1);
    stop(); jest.useRealTimers(); warn.mockRestore();
  });
});

describe('retention (SQL statements)', () => {
  it('purges every table in one conditional statement and selects expired calls by leftAt then invitedAt, never listening or paused', async () => {
    const calls: Array<{ sql: string }> = [];
    const store = new SqlAssistantStore(async (sql) => { calls.push({ sql }); return [{ removed: 1 }]; });
    expect(await store.purgeCall('c1')).toBe(true);
    for (const t of ['meeting_transcript_lines', 'meeting_minutes', 'meeting_assistant_turns', 'meeting_assistant_actions', 'meeting_assistants']) expect(calls[0]!.sql).toMatch(new RegExp(`DELETE FROM ${t} `));
    expect(calls[0]!.sql).toMatch(/state NOT IN \('listening', 'paused'\)/);
    await store.expiredCalls(1, 10);
    expect(calls[1]!.sql).toMatch(/state NOT IN \('listening', 'paused'\) AND COALESCE\(left_at, invited_at\) <= :cutoff/);
    await store.sweepLines(1);
    expect(calls[2]!.sql).toMatch(/NOT IN \(SELECT call_id FROM meeting_assistants WHERE state IN \('listening', 'paused'\)\)/);
  });
});
