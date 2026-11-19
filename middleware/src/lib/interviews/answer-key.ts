// A board question's answer key stays with the interviewers (the master template's part C; docs/interviews-tenant-plan.md,
// "System design master template"). A kit question may carry the interviewer's reference design (`providedDesign`), the
// design questions with their answers (`designQuestions`) and the red flags (`redFlags`). The lead, the panel and the
// kit's editors read them; the candidate never does, until the lead reveals the provided design onto the shared board.
//
// Every payload a candidate can reach takes a question through `candidateQuestion`: the guest's routes, the board
// document (only `board` is ever inserted from it) and Milo's tools, which speak and write in the candidate's call. It
// copies the fields it names and nothing else, so it fails closed: a field added to KitQuestion later is not on the
// candidate's side until someone adds it here on purpose.
import type { KitQuestion } from './types.js';

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
