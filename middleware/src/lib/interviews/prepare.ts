// Preparing a round: the lead chooses its questions (docs/interviews-tenant-plan.md row I1.7; decisions 2 and 20).
//
// Pure rules, so the route and the tests hold every write to the same sentences.
//
//   who     the LEAD of that interview. A panel member reads the page and does not choose.
//   when    while the round is `accepted` or `ready`: never before the lead accepts, never once it is live,
//           ended, declined or cancelled.
//   what    ids from that opening's kit only, each once, in the order given, at most MAX_QUESTIONS; a technical
//           round takes technical questions and a behavioural round behavioural ones (the kit's own typing), each
//           for a competency the round assesses (kit.ts questionsOfRound, the bank the page offers).
//   leaves  `ready` when a time is set and at least one question is chosen, else `accepted` (readyState).
//
// `ready` is a fact about three things (the lead accepted, a time is set, questions are chosen), and two of them
// are written by different people (the recruiter sets the time, row I1.5, which does not touch the state). So
// the READ computes it with readyState and never trusts the stored word alone; this write stores what readyState
// says. A recruiter clearing the time leaves the stored state `ready` until the next write; the record
// (views.ts) and the page show `readyState`, so nobody sees a ready round that is not ready.

import { competencyIdsOfRound, type Checked, type FieldProblem } from './kit.js';
import { hasAccepted } from './assign.js';
import type { Interview, InterviewState, OpeningKit } from './types.js';

/** Questions in one round's plan: more than a lead can ask in the longest round (180 minutes) at a sensible pace. */
export const MAX_QUESTIONS = 8;

const PREPARABLE: ReadonlySet<InterviewState> = new Set(['accepted', 'ready']);
export const isPreparable = (state: InterviewState): boolean => PREPARABLE.has(state);

type Readiness = Pick<Interview, 'state' | 'scheduledAt' | 'questionIds'>;

/** The state a round is really in: `accepted` and `ready` follow the time and the plan; every other state is as stored. */
export function readyState(i: Readiness): InterviewState {
  if (!PREPARABLE.has(i.state)) return i.state;
  return i.scheduledAt !== null && i.questionIds.length > 0 ? 'ready' : 'accepted';
}

/** What is still missing before the round is ready, as one plain line; null when nothing is. */
export function missingLine(i: Readiness): string | null {
  if (!PREPARABLE.has(i.state)) return null;
  const noTime = i.scheduledAt === null;
  const noPlan = i.questionIds.length === 0;
  if (noTime && noPlan) return 'Waiting for a time from the recruiter, and for you to choose questions.';
  if (noTime) return 'Waiting for a time from the recruiter.';
  if (noPlan) return 'Choose at least one question to be ready.';
  return null;
}

/** The lead of the interview may choose its questions. */
export const mayChoose = (i: Pick<Interview, 'leadId'>, userId: string): boolean => i.leadId === userId;

export function checkQuestions(
  input: unknown, i: Pick<Interview, 'state' | 'type' | 'leadId' | 'acceptances' | 'roundId'>, kit: OpeningKit,
): Checked<{ questionIds: string[] }> {
  if (!PREPARABLE.has(i.state) || !hasAccepted(i, i.leadId, 'lead')) {
    return { ok: false, problems: [{ path: 'state', message:
      i.state === 'assigned' ? 'Accept this round first: you can choose its questions once you have.'
        : i.state === 'declined' || i.state === 'cancelled' ? 'This round is no longer going ahead, so its questions cannot change.'
          : 'This round has already started, so its questions can no longer change.' }] };
  }
  const raw = input !== null && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>)['questionIds'] : undefined;
  const bad = (message: string): Checked<{ questionIds: string[] }> => ({ ok: false, problems: [{ path: 'questionIds', message }] });
  if (!Array.isArray(raw) || raw.some((q) => typeof q !== 'string')) return bad('Choose the questions from the list below.');
  const ids = raw as string[];
  if (ids.length > MAX_QUESTIONS) return bad(`Choose at most ${MAX_QUESTIONS} questions for one round.`);
  if (new Set(ids).size !== ids.length) return bad('A question can be in the plan only once.');
  const problems: FieldProblem[] = [];
  const assessed = new Set(competencyIdsOfRound(kit, i.roundId));
  for (const id of ids) {
    const q = kit.questions.find((k) => k.id === id);
    if (!q) problems.push({ path: 'questionIds', message: 'One of those questions is not in this opening\'s question bank any more.' });
    else if (q.roundType !== i.type) problems.push({ path: 'questionIds', message: i.type === 'technical'
      ? 'A technical round takes technical questions: one of those is a behavioural question.'
      : 'A behavioural round takes behavioural questions: one of those is a technical question.' });
    else if (!assessed.has(q.competencyId)) problems.push({ path: 'questionIds', message: 'One of those questions is for a competency this round does not assess. Choose from the list below.' });
  }
  if (problems.length) return { ok: false, problems: problems.slice(0, 1) };
  return { ok: true, value: { questionIds: ids } };
}

export function questionsProblemsLine(count: number): string {
  return `The plan was not saved: ${count === 1 ? 'one thing needs' : `${count} things need`} fixing.`;
}
