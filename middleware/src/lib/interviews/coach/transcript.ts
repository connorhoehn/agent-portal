// Where the coach reads an interview's words (row I3.3): the meeting assistant's transcript of the interview's call.
//
// The call is the interview's `callId` when it is set, else the newest assistant record still listening or paused in the
// interview's lobby (`interviews:interview:<id>`). Only lines the store already holds are read, and the store holds a
// guest's words only when the transcript and Milo were accepted (lib/interviews/milo-policy.ts `acknowledgedElsewhere`).
// Each line becomes its side and its words: `candidate` for a guest identity, `panel` for anyone else. Unattributed lines
// (nobody's audio was voiced) are left out: the coach never guesses who spoke. No names, times or audio reach the coach.
import { assistantStore } from '../../meeting-assistant/store-select.js';
import type { AssistantRecord } from '../../meeting-assistant/types.js';
import { isGuestId } from '../milo-policy.js';
import { MAX_TRANSCRIPT_LINES, type CoachLine } from './prompt.js';

export interface CoachTranscript { callId: string; lastSeq: number; lines: CoachLine[] }
export type TranscriptSource = (interview: { id: string; callId: string | null }) => Promise<CoachTranscript | null>;

/** How many lines are fetched from the store before the newest MAX_TRANSCRIPT_LINES are kept. */
const FETCH_LIMIT = 5000;
const LISTED_CALLS = 500;

async function callOf(interview: { id: string; callId: string | null }): Promise<AssistantRecord | null> {
  const store = assistantStore();
  if (interview.callId) {
    const r = await store.get(interview.callId);
    if (r) return r;
  }
  const lobby = `interviews:interview:${interview.id}`;
  const open = (await store.listByState(['listening', 'paused'], LISTED_CALLS)).filter((r) => r.lobby === lobby);
  return open.at(-1) ?? null;
}

export const assistantTranscript: TranscriptSource = async (interview) => {
  const record = await callOf(interview);
  if (!record) return null;
  const all = await assistantStore().lines(record.callId, 0, FETCH_LIMIT);
  const lastSeq = all.reduce((m, l) => Math.max(m, l.seq), 0);
  const lines = all
    .filter((l) => l.userId !== null && l.text.trim().length > 0)
    .map((l): CoachLine => ({ seq: l.seq, side: isGuestId(l.userId!) ? 'candidate' : 'panel', text: l.text }))
    .slice(-MAX_TRANSCRIPT_LINES);
  return { callId: record.callId, lastSeq, lines };
};
