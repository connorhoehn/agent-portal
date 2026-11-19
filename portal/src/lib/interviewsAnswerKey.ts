// A board question's answer key on the interviewers' side (the master template's part C; middleware
// lib/interviews/answer-key.ts). The room gives the lead and the panel each question's `answerKey` (never the
// candidate): the pane's "Provided design" tab shows it, the lead's "Reveal to the candidate" asks the server for the
// provided design (POST /interviews/:id/board/reveal, which logs nothing), puts it on the shared board beside what is
// there, then acks (POST .../board/reveal/shown), which the server logs once per question; what was revealed is read
// from the server (GET .../board/reveals), so a reload or a second tab says so too. The scorecard turns the red flags into the lead's checklist (never scored).
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
const json = (body: unknown): RequestInit => ({ method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const errorOf = async (res: Response): Promise<string | null> => {
  try { const b = (await res.json()) as { error?: unknown }; return typeof b.error === 'string' ? b.error : null; } catch { return null; }
};

export type RevealAnswer = { ok: true; board: KitBoard; already: boolean } | { ok: false; error: string | null };
/** The lead's reveal: the server checks (lead, live, a chosen question with a provided design, room in the log) and
 *  answers the board, logging nothing yet; a refusal carries the server's words when it gave any. */
export async function revealProvidedDesign(interviewId: string, questionId: string, fetcher: typeof fetch = fetch): Promise<RevealAnswer> {
  try {
    const res = await fetcher(revealPath(interviewId), json({ questionId }));
    if (!res.ok) return { ok: false, error: await errorOf(res) };
    const body = (await res.json()) as { board?: KitBoard; already?: unknown };
    return body.board && Array.isArray(body.board.elements) ? { ok: true, board: body.board, already: body.already === true } : { ok: false, error: null };
  } catch { return { ok: false, error: null }; }
}

/** The questions the server says were revealed, per interview; listeners hear every change. */
const revealedIds = new Map<string, Set<string>>();
const revealsListeners = new Set<() => void>();
const markRevealed = (interviewId: string, ids: readonly string[]): void => {
  revealedIds.set(interviewId, new Set([...(revealedIds.get(interviewId) ?? []), ...ids]));
  for (const l of revealsListeners) l();
};
export function onReveals(fn: () => void): () => void { revealsListeners.add(fn); return () => { revealsListeners.delete(fn); }; }
/** Whether the server holds a reveal of the question's design (loaded with `loadReveals`, or acked on this page). */
export const wasRevealed = (interviewId: string, questionId: string): boolean => revealedIds.get(interviewId)?.has(questionId) ?? false;
/** Read what was revealed from the server (the tab calls it on open). */
export async function loadReveals(interviewId: string, fetcher: typeof fetch = fetch): Promise<void> {
  try {
    const res = await fetcher(`${revealPath(interviewId)}s`, { credentials: 'include' });
    if (!res.ok) return;
    const body = (await res.json()) as { questionIds?: unknown };
    if (Array.isArray(body.questionIds)) markRevealed(interviewId, body.questionIds.filter((x): x is string => typeof x === 'string'));
  } catch { /* the tab keeps what it knew */ }
}
/** The board holds the revealed design: tell the server, which logs it once. Null when it is recorded, else the words to show. */
export async function ackReveal(interviewId: string, questionId: string, fetcher: typeof fetch = fetch): Promise<string | null> {
  try {
    const res = await fetcher(`${revealPath(interviewId)}/shown`, json({ questionId }));
    if (!res.ok) return (await errorOf(res)) ?? REVEAL_NOT_ACKED;
    markRevealed(interviewId, [questionId]);
    return null;
  } catch { return REVEAL_NOT_ACKED; }
}
export const REVEAL_NOT_ACKED = 'The provided design is on the board, but the record could not note it.';

/** The scorecard's seen red flags: only the question's own, in its order. */
export const seenFlagsOf = (seen: readonly string[] | undefined, flags: readonly string[]): string[] =>
  flags.filter((f) => (seen ?? []).includes(f));
export const toggleSeenFlag = (seen: readonly string[], flag: string, flags: readonly string[]): string[] =>
  seenFlagsOf(seen.includes(flag) ? seen.filter((f) => f !== flag) : [...seen, flag], flags);

/**
 * The revealed design on its way to the shared board: the Provided design tab queues it and opens the Board tab, whose
 * lead canvas takes it once it is in sync (the pad's queuePadQuestion pattern), places it beside what is drawn, and acks.
 */
const pendingReveal = new Map<string, { questionId: string; board: KitBoard }>();
const revealListeners = new Set<() => void>();
export function queueBoardReveal(interviewId: string, questionId: string, board: KitBoard): void {
  pendingReveal.set(interviewId, { questionId, board });
  for (const l of revealListeners) l();
}
/** The queued design for this interview and its question, once: taking it clears it. */
export function takeBoardReveal(interviewId: string): { questionId: string; board: KitBoard } | null {
  const b = pendingReveal.get(interviewId) ?? null;
  pendingReveal.delete(interviewId);
  return b;
}
export function onBoardReveal(fn: () => void): () => void { revealListeners.add(fn); return () => { revealListeners.delete(fn); }; }
