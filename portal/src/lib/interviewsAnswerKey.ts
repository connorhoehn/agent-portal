// A board question's answer key on the interviewers' side (the master template's part C; middleware
// lib/interviews/answer-key.ts). The room gives the lead and the panel each question's `answerKey` (never the
// candidate): the pane's "Provided design" tab shows it, the lead's "Reveal to the candidate" asks the server for the
// provided design (POST /interviews/:id/board/reveal, logged) and puts it on the shared board beside what is there,
// and the scorecard turns the red flags into the lead's checklist (never scored).
import type { KitBoard } from './interviewsBoard.ts';
import { sceneBounds } from './interviewsBoard.ts';
import { INTERVIEWS_API } from './interviews.ts';

export type RedFlagGroup = 'over-engineering' | 'responsibility' | 'naming' | 'other';
export interface KitRedFlag { group: RedFlagGroup; text: string }
export interface KitDesignQuestion { text: string; answer?: string; enhancement?: true }
export interface AnswerKey { providedDesign?: KitBoard; designQuestions?: KitDesignQuestion[]; redFlags?: KitRedFlag[] }

/** The groups in the server's order (types.ts RED_FLAG_GROUPS), as headed on the tab and the scorecard. */
export const RED_FLAG_GROUP_LABELS: Readonly<Record<RedFlagGroup, string>> = {
  'over-engineering': 'Over-engineering', responsibility: 'Responsibility', naming: 'Naming', other: 'Other',
};

/** The questions that carry any of the answer key, in the round's order. */
export function answerKeyQuestions<Q extends { answerKey?: AnswerKey }>(questions: readonly Q[]): Array<Q & { answerKey: AnswerKey }> {
  return questions.filter((q): q is Q & { answerKey: AnswerKey } => !!q.answerKey
    && (!!q.answerKey.providedDesign || !!q.answerKey.designQuestions?.length || !!q.answerKey.redFlags?.length));
}

/** The red flags by group, in the groups' order; a group with none is left out. */
export function redFlagGroups(flags: readonly KitRedFlag[] | undefined): Array<{ group: RedFlagGroup; label: string; items: string[] }> {
  return (Object.keys(RED_FLAG_GROUP_LABELS) as RedFlagGroup[])
    .map((group) => ({ group, label: RED_FLAG_GROUP_LABELS[group], items: (flags ?? []).filter((f) => f.group === group).map((f) => f.text) }))
    .filter((g) => g.items.length > 0);
}

/** How far right of the board's content the revealed design goes, in scene units. */
export const REVEAL_GAP = 160;
/** The provided design moved to sit right of `onBoard`'s content, top-aligned with it (a copy; the kit's stays put). */
export function placeBeside(onBoard: ReadonlyArray<Record<string, unknown>>, board: KitBoard): KitBoard {
  const have = sceneBounds(onBoard);
  const own = sceneBounds(board.elements);
  if (!have || !own) return structuredClone(board);
  const dx = have.x2 + REVEAL_GAP - own.x1;
  const dy = have.y1 - own.y1;
  return { name: board.name, elements: board.elements.map((e) => ({ ...structuredClone(e), x: Number(e['x']) + dx, y: Number(e['y']) + dy })) };
}

export const revealPath = (interviewId: string): string => `${INTERVIEWS_API}/interviews/${encodeURIComponent(interviewId)}/board/reveal`;
/** The lead's reveal: the server checks (lead, live, a chosen question with a provided design), logs it and answers the board. */
export async function revealProvidedDesign(interviewId: string, questionId: string, fetcher: typeof fetch = fetch): Promise<KitBoard | null> {
  try {
    const res = await fetcher(revealPath(interviewId), {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ questionId }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { board?: KitBoard };
    return body.board && Array.isArray(body.board.elements) ? body.board : null;
  } catch { return null; }
}

/** The scorecard's seen red flags: only the question's own, in its order. */
export const seenFlagsOf = (seen: readonly string[] | undefined, flags: readonly string[]): string[] =>
  flags.filter((f) => (seen ?? []).includes(f));
export const toggleSeenFlag = (seen: readonly string[], flag: string, flags: readonly string[]): string[] =>
  seenFlagsOf(seen.includes(flag) ? seen.filter((f) => f !== flag) : [...seen, flag], flags);

/**
 * The revealed design on its way to the shared board: the Provided design tab queues it and opens the Board tab, whose
 * lead canvas takes it once it is in sync (the pad's queuePadQuestion pattern), placed beside what is drawn.
 */
const pendingReveal = new Map<string, KitBoard>();
const revealed = new Set<string>();
const revealListeners = new Set<() => void>();
export function queueBoardReveal(interviewId: string, questionId: string, board: KitBoard): void {
  pendingReveal.set(interviewId, board);
  revealed.add(`${interviewId}:${questionId}`);
  for (const l of revealListeners) l();
}
/** The queued design for this interview, once: taking it clears it. */
export function takeBoardReveal(interviewId: string): KitBoard | null { const b = pendingReveal.get(interviewId) ?? null; pendingReveal.delete(interviewId); return b; }
export function onBoardReveal(fn: () => void): () => void { revealListeners.add(fn); return () => { revealListeners.delete(fn); }; }
/** Whether this page already revealed the question's design (the tab's action then says so). */
export const wasRevealed = (interviewId: string, questionId: string): boolean => revealed.has(`${interviewId}:${questionId}`);
