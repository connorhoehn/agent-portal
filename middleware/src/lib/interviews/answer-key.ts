// A board question's answer key stays with the interviewers (the master template's part C; docs/interviews-tenant-plan.md,
// "System design master template"). A kit question may carry the interviewer's reference design (`providedDesign`), the
// design questions with their answers (`designQuestions`) and the red flags (`redFlags`). The lead, the panel and the
// kit's editors read them; the candidate never does, until the lead reveals the provided design onto the shared board.
//
// Every payload a candidate can reach takes a question through `candidateQuestion`: the guest's routes, the board
// document (only `board` is ever inserted from it) and Milo's tools, which speak and write in the candidate's call. It
// copies the fields it names and nothing else, so it fails closed: a field added to KitQuestion later is not on the
// candidate's side until someone adds it here on purpose.
import type { Interview, KitBoard, KitQuestion, Opening } from './types.js';
import { scopeBoardIds } from './board/elements.js';

/** The fields only the interviewers read. */
export const ANSWER_KEY_FIELDS = ['providedDesign', 'designQuestions', 'redFlags'] as const;

/** A kit question as the candidate's side may hold it: no answer key. */
export type CandidateQuestion = Omit<KitQuestion, typeof ANSWER_KEY_FIELDS[number]>;

/** The question with only the fields the candidate's side may carry, each copied. */
export function candidateQuestion(q: KitQuestion): CandidateQuestion {
  return {
    id: q.id, prompt: q.prompt, followUps: [...q.followUps], competencyId: q.competencyId, roundType: q.roundType,
    ...(q.starter ? { starter: { ...q.starter } } : {}),
    ...(q.board ? { board: structuredClone(q.board) } : {}),
    ...(q.clarifying ? { clarifying: [...q.clarifying] } : {}),
  };
}

/** Does the question carry any of the answer key? */
export const hasAnswerKey = (q: KitQuestion): boolean => ANSWER_KEY_FIELDS.some((k) => q[k] !== undefined);

export const NOTHING_TO_REVEAL = 'There is no provided design to show for this question.';

/**
 * May `userId` reveal question `questionId`'s provided design on `interview`'s board now: the lead, while the round is
 * live, for a question chosen for it that carries one. The board to put on the shared board, its ids scoped to the
 * question (board/elements.ts scopeBoardIds, so two questions' designs never collide), or null (the route's 404).
 */
export function revealable(interview: Pick<Interview, 'leadId' | 'state' | 'type' | 'questionIds'>, opening: Pick<Opening, 'kit'> | null, userId: string, questionId: unknown): KitBoard | null {
  if (!opening || interview.leadId !== userId || interview.state !== 'live' || interview.type !== 'technical') return null;
  if (typeof questionId !== 'string' || !interview.questionIds.includes(questionId)) return null;
  const q = opening.kit.questions.find((k) => k.id === questionId);
  return q?.providedDesign ? { ...q.providedDesign, elements: scopeBoardIds(q.providedDesign.elements, q.id) } : null;
}
