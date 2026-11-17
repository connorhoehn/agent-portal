// The interview room's rules (docs/interviews-tenant-plan.md row I2.4, decision 21; contract C5): what the
// panel's room shows, and when the lead may start and end the interview. Pure functions; the route
// (routes/interviews/room.ts) decides who is asking and the store (InterviewWrites startInterview /
// endInterview) only writes.
//
//   start   the lead, when they join the call: `accepted` or `ready` → `live`. Already `live` is no change
//           (a lead who reloads the room joins again).
//   end     the lead, from End interview: `live` → `ended`, with `endedAt`. Already `ended` is no change.
//
// The room's read carries the round, the seats with names, the chosen questions (competency, prompt,
// follow-ups, starter code) and the kit's competencies with their anchors. Never the candidate's contact
// details or résumé: the panel reads the candidate's name and nothing else about them here.

import { seatOf } from './assign.js';
import type { Interview, InterviewState, KitCompetency, Opening, PadLanguage, Seat } from './types.js';

/** C1: the interview's call lobby (lib/interviews/lobby.ts `interviewLobbyName` once SEAT is in; the same string). */
export const roomLobbyName = (interviewId: string): string => `interviews:interview:${interviewId}`;

export interface RoomPerson { id: string; name: string }

export interface RoomQuestion {
  id: string;
  prompt: string;
  followUps: string[];
  competencyId: string;
  /** The competency's name; the round's kit may have lost it (`null`). */
  competency: string | null;
  /** Starter code per language, in the pad's language order; empty for a behavioural question. */
  starter: Array<{ language: PadLanguage; code: string }>;
}

/** C5's room view: what `GET /api/interviews/interviews/:id/room` answers, for the lead and the panel only. */
export interface RoomView {
  id: string;
  lobbyName: string;
  opening: { id: string; title: string };
  candidate: { name: string };
  round: { id: string; name: string; type: Interview['type']; minutes: number };
  scheduledAt: string | null;
  endedAt: string | null;
  state: InterviewState;
  /** The viewer's own seat. */
  seat: Seat;
  seats: Array<{ person: RoomPerson; seat: Seat }>;
  questions: RoomQuestion[];
  competencies: KitCompetency[];
  revision: number;
}

const PAD_ORDER: readonly PadLanguage[] = ['python', 'swift', 'javascript', 'typescript', 'java', 'go', 'cpp'];

/** The room as `viewerId` reads it; null when they hold no seat on it (the route answers 404). */
export function roomView(i: Interview, opening: Opening, candidateName: string, viewerId: string, people: (id: string) => RoomPerson): RoomView | null {
  const seat = seatOf(i, viewerId);
  if (!seat) return null;
  const names = new Map(opening.kit.competencies.map((k) => [k.id, k.name]));
  const round = opening.kit.rounds.find((r) => r.id === i.roundId);
  return {
    id: i.id,
    lobbyName: roomLobbyName(i.id),
    opening: { id: opening.id, title: opening.title },
    candidate: { name: candidateName },
    round: { id: i.roundId, name: round?.name ?? 'Round', type: i.type, minutes: i.minutes },
    scheduledAt: i.scheduledAt,
    endedAt: i.endedAt,
    state: i.state,
    seat,
    seats: [{ person: people(i.leadId), seat: 'lead' }, ...i.panelIds.map((p) => ({ person: people(p), seat: 'panel' as const }))],
    questions: i.questionIds.flatMap((qid) => {
      const q = opening.kit.questions.find((k) => k.id === qid);
      if (!q) return [];
      const starter = PAD_ORDER.flatMap((language) => (q.starter?.[language] ? [{ language, code: q.starter[language]! }] : []));
      return [{ id: q.id, prompt: q.prompt, followUps: [...q.followUps], competencyId: q.competencyId, competency: names.get(q.competencyId) ?? null, starter }];
    }),
    competencies: structuredClone(opening.kit.competencies),
    revision: i.revision,
  };
}

export type RoomMove =
  | { ok: true; write: true }
  | { ok: true; write: false }
  | { ok: false; reason: 'no-seat' | 'not-lead' | 'state'; message: string };

const NOT_LEAD = 'Only the lead interviewer can start or end this interview.';

/** May `userId` start `i` now? `write: false` when it is already live (nothing to write). */
export function startMove(i: Pick<Interview, 'leadId' | 'panelIds' | 'state'>, userId: string): RoomMove {
  const seat = seatOf(i, userId);
  if (!seat) return { ok: false, reason: 'no-seat', message: 'There is no interview here that you can open.' };
  if (seat !== 'lead') return { ok: false, reason: 'not-lead', message: NOT_LEAD };
  if (i.state === 'live') return { ok: true, write: false };
  if (i.state === 'accepted' || i.state === 'ready') return { ok: true, write: true };
  return { ok: false, reason: 'state', message: startRefusal(i.state) };
}

/** May `userId` end `i` now? `write: false` when it has already ended. */
export function endMove(i: Pick<Interview, 'leadId' | 'panelIds' | 'state'>, userId: string): RoomMove {
  const seat = seatOf(i, userId);
  if (!seat) return { ok: false, reason: 'no-seat', message: 'There is no interview here that you can open.' };
  if (seat !== 'lead') return { ok: false, reason: 'not-lead', message: NOT_LEAD };
  if (i.state === 'ended') return { ok: true, write: false };
  if (i.state === 'live') return { ok: true, write: true };
  return { ok: false, reason: 'state', message: i.state === 'scored' || i.state === 'reviewed' ? 'This interview has already ended.' : 'This interview has not started, so there is nothing to end.' };
}

function startRefusal(state: InterviewState): string {
  switch (state) {
    case 'assigned': return 'This interview cannot start until the lead has accepted it.';
    case 'declined': case 'cancelled': return 'This interview is no longer going ahead.';
    default: return 'This interview has already ended.';
  }
}
