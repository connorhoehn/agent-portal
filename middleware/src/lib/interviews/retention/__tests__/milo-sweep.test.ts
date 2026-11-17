// Two sweeps, one call each (docs/interviews-tenant-plan.md decision 17; round 5's notice gate): the meeting assistant's
// 30-day sweep leaves an interview call alone, through the policy seam (policy.ts `keepsOwnRetention`), while a Work call
// of the same age loses its words; the interviews sweep then removes the interview call's at 91 days, everything the
// meeting assistant's own sweep would have.
jest.mock('../../../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true }, meetingAssistant: { enabled: true, transcriptRetentionDays: 30 } } }));
import { fixtureRegistry } from '../../../../mock/core/index.js';
import { familiesKeepingOwnRetention } from '../../../meeting-assistant/policy.js';
import { sweepTranscripts } from '../../../meeting-assistant/retention.js';
import { MemoryAssistantStore } from '../../../meeting-assistant/store.js';
import { SqlAssistantStore } from '../../../meeting-assistant/store-sql.js';
import type { AssistantRecord } from '../../../meeting-assistant/types.js';
import { registerInterviewsMiloPolicy, unregisterInterviewsMiloPolicy } from '../../milo-policy.js';
import type { Interview, InterviewsWorld } from '../../types.js';
import { callWordsEraser, recordingEraser } from '../erasers.js';
import { DEFAULT_PERIODS } from '../periods.js';
import { registerEraser } from '../registry.js';
import { DAY_MS, interviewLobby } from '../rules.js';
import { sweep } from '../service.js';
import { setDeletionStore } from '../store.js';

const END = Date.parse('2026-01-10T15:00:00.000Z');
const WORK = 'call-work';
const IV = 'call-iv';

const rec = (callId: string, lobby: string, tenant: string): AssistantRecord => ({
  callId, tenant, lobby, initiativeId: null, state: 'listening', invitedBy: 'u-lead', invitedAt: END - 3_600_000, pausedBy: null, leftAt: null, leftBy: null,
  acked: [], attendees: ['u-lead'], presentAtInvite: [], requests: 0, linesStored: 0, nextSeq: 1, pendingRequests: [],
});

async function held(s: MemoryAssistantStore, r: AssistantRecord): Promise<void> {
  await s.create(r);
  await s.appendLine({ callId: r.callId, userId: 'u-lead', participantId: 'p', speakerName: 'L', text: 'words', at: END - 1_800_000, captionId: 'c' });
  await s.putMinutes({ callId: r.callId, tenant: r.tenant, lobby: r.lobby, initiativeId: null, callName: 'n', startedAt: 1, endedAt: 2, invitedBy: 'u-lead', attendees: ['u-lead'],
    summary: 's', decisions: [], actionItems: [], topics: [], lineCount: 1, truncated: false, writer: 'scripted', createdAt: END });
  await s.createTurn({ turnId: 't', callId: r.callId, askedBy: 'u-lead', tool: { name: 'x', args: {} }, kind: 'read', status: 'done', createdAt: 1, expiresAt: 2 });
  await s.transition(r.callId, { from: ['listening'], to: 'left', by: 'u-lead', at: END });
}

const kept = async (s: MemoryAssistantStore, id: string) => ({
  record: !!(await s.get(id)), lines: (await s.lines(id, 0, 9)).length, minutes: !!(await s.getMinutes(id)), turns: (await s.listTurns(id)).length,
});

const iv: Interview = {
  id: 'iv-gate', applicationId: 'app-x', roundId: 'rd', type: 'behavioural', leadId: 'u-lead', panelIds: [], scheduledAt: '2026-01-10T14:00:00.000Z', minutes: 60,
  state: 'ended', questionIds: [], assignedBy: 'u-r', assignedAt: '2026-01-01T09:00:00.000Z', callId: IV,
  endedAt: new Date(END).toISOString(), acceptances: [], declines: [], revision: 1,
} as unknown as Interview;
const world = {
  openings: [], scorecards: [], candidates: [],
  applications: [{ id: 'app-x', candidateId: 'cand-x', openingId: 'op', stage: 'interviewing', appliedAt: '2026-01-01T00:00:00.000Z', history: [] }],
  interviews: [iv],
} as unknown as InterviewsWorld;

afterEach(() => { unregisterInterviewsMiloPolicy(); fixtureRegistry.resetAll('default'); setDeletionStore(null); });

describe('the meeting assistant\'s sweep and an interview call', () => {
  it('keeps an interview call 31 days old whole while a Work call of the same age loses everything; at 91 days the interviews sweep removes it', async () => {
    expect(registerInterviewsMiloPolicy({ INTERVIEWS_ENABLED: 'true' })).toBe(true);
    expect(familiesKeepingOwnRetention()).toEqual(['interviews:interview']);
    const s = new MemoryAssistantStore();
    await held(s, rec(WORK, 'orgiq:initiative:i-1', 'orgiq'));
    await held(s, rec(IV, interviewLobby(iv.id), 'interviews'));
    const chats: string[] = [];

    await sweepTranscripts(s, END + 31 * DAY_MS, 30, { eraseChat: async (id) => { chats.push(id); } });
    expect(await kept(s, WORK)).toEqual({ record: false, lines: 0, minutes: false, turns: 0 });
    expect(await kept(s, IV)).toEqual({ record: true, lines: 1, minutes: true, turns: 1 });
    expect(chats).toEqual([WORK]);

    // Still kept at 89 days, by both sweeps.
    const at = { now: END + 89 * DAY_MS };
    registerEraser(recordingEraser({ env: {} }));
    registerEraser(callWordsEraser({ store: () => s, eraseCall: (st, id, by, t) => st.tombstoneMinutes(id, by, t), now: () => at.now }));
    const deps = { now: () => at.now, load: async () => world, enabled: () => true, periods: () => ({ ...DEFAULT_PERIODS }) };
    await sweepTranscripts(s, at.now, 30, { eraseChat: async (id) => { chats.push(id); } });
    expect((await sweep(deps)).media).toBe(0);
    expect(await kept(s, IV)).toEqual({ record: true, lines: 1, minutes: true, turns: 1 });

    at.now = END + 91 * DAY_MS;
    expect((await sweep(deps)).media).toBe(1);
    expect(await kept(s, IV)).toEqual({ record: false, lines: 0, minutes: false, turns: 0 });
    expect(chats).toEqual([WORK]);
  });

  it('with no family keeping its own retention, the sweep is today\'s: the interview call goes at 31 days too', async () => {
    expect(familiesKeepingOwnRetention()).toEqual([]);
    const s = new MemoryAssistantStore();
    await held(s, rec(IV, interviewLobby(iv.id), 'interviews'));
    await sweepTranscripts(s, END + 31 * DAY_MS, 30, { eraseChat: async () => undefined });
    expect(await kept(s, IV)).toEqual({ record: false, lines: 0, minutes: false, turns: 0 });
  });

  it('the SQL store leaves the kept families out of the line, minutes and expired-call statements, and is today\'s statement without them', async () => {
    const seen: Array<{ sql: string; params: unknown }> = [];
    const store = new SqlAssistantStore(async (sql, params) => { seen.push({ sql, params }); return [{ removed: 0 }]; });
    await store.sweepLines(1, ['interviews:interview']);
    await store.sweepMinutes(1, ['interviews:interview']);
    await store.expiredCalls(1, 10, ['interviews:interview']);
    const term = /COALESCE\(lobby, ''\) = :keep0 OR COALESCE\(lobby, ''\) LIKE :keepUnder0/;
    expect(seen[0]!.sql).toMatch(/WHERE state IN \('listening', 'paused'\) OR \(COALESCE\(lobby/);
    expect(seen[1]!.sql).toMatch(/AND NOT \(COALESCE\(lobby/);
    expect(seen[2]!.sql).toMatch(/AND NOT \(COALESCE\(lobby/);
    for (const c of seen) {
      expect(c.sql).toMatch(term);
      expect(c.params).toEqual(expect.arrayContaining([{ name: 'keep0', value: { stringValue: 'interviews:interview' } }, { name: 'keepUnder0', value: { stringValue: 'interviews:interview:%' } }]));
    }
    seen.length = 0;
    await store.sweepLines(1); await store.sweepMinutes(1); await store.expiredCalls(1, 10);
    for (const c of seen) expect(c.sql).not.toMatch(/keep/);
  });
});
