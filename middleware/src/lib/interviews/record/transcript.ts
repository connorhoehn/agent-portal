// The words of a finished interview (row I5.1, contract E1): what the meeting assistant stored for the interview's call.
//
// The call is the interview's `callId` when it is set and stored, else the newest assistant record in the interview's lobby
// (`interviews:interview:<id>`) in ANY state: the coach (coach/transcript.ts) reads only open calls, and a finished
// interview's call has left. Each line keeps its number, its time, its side (`candidate` for a guest identity, `panel` for
// anyone else) and a speaker label: a staff member's display name, the candidate's name from the interview's own record
// (never the guest id). Unattributed lines (nobody's audio was voiced) are left out.
//
// In the mock world, when no stored call is found, the seeded stand-in (mock/interviews-records.ts) is read instead, so the
// two seeded finished interviews have words. Nothing here logs a line.
import { config } from '../../../config.js';
import { runWithDbTenant } from '../../../providers/db-tenant.js';
import { interviewRecordLinesFixture, interviewRecordingsFixture } from '../../../mock/interviews-records.js';
import { assistantStore } from '../../meeting-assistant/store-select.js';
import type { AssistantRecord } from '../../meeting-assistant/types.js';
import { isGuestId } from '../milo-policy.js';
import { peopleLookup } from '../request.js';
import { interviewsStore } from '../store-select.js';
import { loadWorld } from '../store.js';
import { INTERVIEWS_TENANT } from '../types.js';

export type RecordSide = 'candidate' | 'panel';
export interface RecordLine { seq: number; at: string; side: RecordSide; speaker: string; text: string }
export interface RecordTranscript { callId: string; startedAt: string | null; lines: RecordLine[] }

/** How many lines are read from the store; an hour's interview is a few hundred. */
export const RECORD_FETCH_LIMIT = 5000;
const LISTED_CALLS = 500;
/** The label of a line whose candidate cannot be named (the interview's record is gone). */
export const CANDIDATE_LABEL = 'Candidate';

interface RawLine { seq: number; atMs: number; userId: string | null; text: string }
interface Found { callId: string; startedAtMs: number | null; lines: RawLine[] }

async function storedCall(interview: { id: string; callId: string | null }): Promise<AssistantRecord | null> {
  const store = assistantStore();
  if (interview.callId) {
    const r = await store.get(interview.callId);
    if (r) return r;
  }
  const lobby = `interviews:interview:${interview.id}`;
  const all = (await store.listByState(['invited', 'listening', 'paused', 'left'], LISTED_CALLS)).filter((r) => r.lobby === lobby);
  return all.sort((a, b) => a.invitedAt - b.invitedAt).at(-1) ?? null;
}

async function found(interview: { id: string; callId: string | null }): Promise<Found | null> {
  const record = await storedCall(interview);
  if (record) {
    const lines = await assistantStore().lines(record.callId, 0, RECORD_FETCH_LIMIT);
    return { callId: record.callId, startedAtMs: record.invitedAt, lines: lines.map((l) => ({ seq: l.seq, atMs: l.at, userId: l.userId, text: l.text })) };
  }
  if (!config.mock?.aurora) return null;
  const seeded = interviewRecordLinesFixture.rows().filter((l) => l.interviewId === interview.id);
  if (!seeded.length) return null;
  const rec = interviewRecordingsFixture.rows().find((r) => r.interviewId === interview.id);
  return {
    callId: `stand-in:${interview.id}`,
    startedAtMs: rec ? Date.parse(rec.startedAt) : null,
    lines: seeded.map((l) => ({ seq: l.seq, atMs: Date.parse(l.at), userId: l.userId, text: l.text })),
  };
}

/** The candidate's name as the interview's own record holds it; null when it cannot be read. */
export async function candidateName(interviewId: string): Promise<string | null> {
  const world = await runWithDbTenant(INTERVIEWS_TENANT, () => loadWorld(interviewsStore()));
  const i = world.interviews.find((x) => x.id === interviewId);
  const app = i ? world.applications.find((a) => a.id === i.applicationId) : undefined;
  return (app ? world.candidates.find((c) => c.id === app.candidateId)?.name : undefined) ?? null;
}

/** E1. Null when the interview's call left no words anywhere. */
export async function recordTranscript(interview: { id: string; callId: string | null }): Promise<RecordTranscript | null> {
  const f = await found(interview);
  if (!f) return null;
  const attributed = f.lines.filter((l) => l.userId !== null && l.text.trim().length > 0).sort((a, b) => a.seq - b.seq);
  const [people, candidate] = await Promise.all([peopleLookup(), attributed.some((l) => isGuestId(l.userId!)) ? candidateName(interview.id) : null]);
  return {
    callId: f.callId,
    startedAt: f.startedAtMs !== null ? new Date(f.startedAtMs).toISOString() : null,
    lines: attributed.map((l) => {
      const guest = isGuestId(l.userId!);
      return { seq: l.seq, at: new Date(l.atMs).toISOString(), side: guest ? 'candidate' : 'panel', speaker: guest ? candidate ?? CANDIDATE_LABEL : people(l.userId!).name, text: l.text };
    }),
  };
}
