// The decision dialogue (G57): a waiting decision is decided in the page's
// agent box, not a form on the page. The owner, 9 November 2026: "It should
// really be a decision dialogue in the agent dialogue box with pre-canned
// decisions that I press my keypad to select."
//
// The record page hands the collection command host one ComposerPrompt
// (ui-components ComposerPromptDeck, the library's keypad dialogue), which the
// docked composer draws instead of its free text while it waits:
//
//   Decision · Cutover order for legacy SSO tenants
//   What did you decide?
//   [1 Smallest tenants first] [2 Riskiest two tenants first] [3 Something else…] [4 Reject]
//   1–4 choose · Esc hide
//
// 1–9 (or a click) picks a row; the chosen row asks for an optional one-line
// why, and Enter sends it (Enter on an empty line decides without one; the
// card's Back returns to the rows). "Something else…" takes what was decided
// and why as free text; "Reject" takes why. Esc hides the dialogue and the
// table commands are back (the deck keeps a Show to reopen it).
//
// The rows' numbering is the voice's too (`decide { option: 2 }`), so it lives
// here, once: `dialogueRows` and `matchDialogueRow`. No React and only type
// imports from the library, so node:test runs it.

import type { ComposerPrompt, ComposerPromptResult } from '@connorhoehn/ui-components/social/rich-composer';
import { RATIONALE_MAX } from './decisionFormat.ts';
import type { DecideBody, DecisionDetail, DecisionOption } from './types';

export const SOMETHING_ELSE = 'something-else';
export const REJECT = 'reject';

/** One numbered row of the dialogue: the decision's own options, then Something else…, then Reject. */
export interface DialogueRow {
  /** 1-based, as the keys and the voice count it. */
  n: number;
  /** The option's id, or SOMETHING_ELSE / REJECT. */
  id: string;
  label: string;
  detail?: string;
  kind: 'option' | 'other' | 'reject';
}

/** The numbered rows for a decision's options. A decision with none still offers Something else… and Reject. */
export function dialogueRows(options: readonly DecisionOption[] | null | undefined): DialogueRow[] {
  const own = (options ?? []).filter((o) => o && o.id && o.label && o.id !== SOMETHING_ELSE && o.id !== REJECT);
  const rows: DialogueRow[] = own.map((o, i) => ({ n: i + 1, id: o.id, label: o.label, ...(o.detail ? { detail: o.detail } : {}), kind: 'option' }));
  rows.push({ n: rows.length + 1, id: SOMETHING_ELSE, label: 'Something else…', detail: 'Say what was decided, and why', kind: 'other' });
  rows.push({ n: rows.length + 1, id: REJECT, label: 'Reject', detail: 'Say why', kind: 'reject' });
  return rows;
}

const WORD_NUMBERS: Readonly<Record<string, number>> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, first: 1, second: 2, third: 3, fourth: 4, fifth: 5 };
const STOP = new Set(['the', 'and', 'with', 'for', 'that', 'this', 'its', 'lets', 'let', 'go', 'take', 'pick', 'choose', 'option', 'decide', 'number', 'one', 'please', 'we', 'will', 'should', 'just']);
const norm = (s: string) => s.toLowerCase().replace(/[“”"'’.,!?…:;()]/g, ' ').replace(/\s+/g, ' ').trim();
const words = (s: string) => norm(s).split(' ').filter((w) => w.length >= 3 && !STOP.has(w));

/**
 * The row the user named: its number ("2", 2, "option 2", "two") or its
 * label, exact first, then a unique label the words contain (or that contains
 * them), then the one row sharing the most words ("go with the riskiest
 * first"). Anything else is an error naming the rows.
 */
export function matchDialogueRow(rows: readonly DialogueRow[], said: unknown): { row: DialogueRow } | { error: string } {
  const list = rows.map((r) => `${r.n}. ${r.label}`).join('; ');
  const none = { error: `Choose one of the options by its number or label: ${list}.` };
  if (typeof said === 'number') return rows.find((r) => r.n === said) ? { row: rows.find((r) => r.n === said)! } : none;
  if (typeof said !== 'string' || !said.trim()) return none;
  const text = norm(said);
  const numbered = /^(?:option |number |#)?(\d{1,2})$/.exec(text)?.[1] ?? (/^(?:option |number )?(\w+)$/.exec(text)?.[1] ?? '');
  const n = /^\d+$/.test(numbered) ? Number(numbered) : WORD_NUMBERS[numbered];
  if (n != null) return rows.find((r) => r.n === n) ? { row: rows.find((r) => r.n === n)! } : none;
  const exact = rows.filter((r) => norm(r.label) === text || (r.kind === 'other' && /^something else\b/.test(text) && text.length <= 16));
  if (exact.length === 1) return { row: exact[0]! };
  if (/^reject(?:ed|ion| it)?$/.test(text)) return { row: rows.find((r) => r.kind === 'reject')! };
  const contained = rows.filter((r) => r.kind === 'option' && (text.includes(norm(r.label)) || norm(r.label).includes(text)));
  if (contained.length === 1) return { row: contained[0]! };
  const mine = new Set(words(text));
  const scored = rows.filter((r) => r.kind === 'option').map((r) => ({ r, score: words(r.label).filter((w) => mine.has(w)).length }));
  const best = Math.max(0, ...scored.map((s) => s.score));
  const top = scored.filter((s) => s.score === best);
  return best > 0 && top.length === 1 ? { row: top[0]!.r } : none;
}

/** The body for a chosen option: its id, and the why when one was given (the route records "<label>, because <why>"). */
export function optionBody(optionId: string, rationale: string): { body: DecideBody } | { error: string } {
  const why = rationale.trim();
  if (why.length > RATIONALE_MAX) return { error: `Keep the reason to ${RATIONALE_MAX} characters (${why.length} now).` };
  return { body: { optionId, outcome: 'resolved', ...(why ? { rationale: why } : {}) } };
}

/** What the route records for an option (routes/decisions.ts optionOutcome), for receipts and the voice card. */
export function optionOutcome(label: string, rationale: string): string {
  const why = rationale.trim().replace(/^because\b[\s,:]*/i, '').trim();
  return why ? `${label}, because ${why}` : label;
}

/** Sends one body to POST /api/graph/decisions/:id/decide; resolves to null when taken, else the reason it was not. */
export type DecisionSend = (body: DecideBody) => Promise<string | null>;

const DECIDE_NOW = 'decide-now';

/** The answer's result: the receipt once taken, or the refusal kept on the card. */
async function sent(send: DecisionSend, body: DecideBody | { error: string }, receipt: string): Promise<ComposerPromptResult> {
  if ('error' in body) return { error: body.error };
  const refused = await send(body);
  return refused ? { error: `Not decided: ${refused}` } : { receipt };
}

/** A typed rationale, checked (required for Something else… and Reject). */
function required(text: string, what: string): string | { error: string } {
  const t = text.trim();
  if (!t) return { error: what };
  if (t.length > RATIONALE_MAX) return { error: `Keep it to ${RATIONALE_MAX} characters (${t.length} now).` };
  return t;
}

/** The follow-up a picked row opens: the optional why for an option, the outcome for Something else…, the why for Reject. */
export function followUpFor(d: Pick<DecisionDetail, 'id' | 'topic'>, row: DialogueRow, send: DecisionSend): ComposerPrompt {
  const base = { id: `decision:${d.id}:${row.id}`, eyebrow: `Decision · ${d.topic}`, scope: `decision:${d.id}` };
  if (row.kind === 'option') {
    return {
      ...base, kind: 'text', title: `${row.n}. ${row.label}`,
      question: 'Why? One line, optional. Enter decides.',
      placeholder: 'Because… (optional; Enter decides without one)',
      options: [{ id: DECIDE_NOW, label: 'Decide without a reason', emphasis: 'primary' }],
      defaultOptionId: DECIDE_NOW,
      onAnswer: (a) => {
        const why = a.kind === 'text' ? a.text : '';
        const ready = optionBody(row.id, why);
        return sent(send, 'error' in ready ? ready : ready.body, `Decided: ${optionOutcome(row.label, why)}`);
      },
    };
  }
  if (row.kind === 'other') {
    return {
      ...base, kind: 'text', title: `${row.n}. Something else`,
      question: 'What did you decide, and why?', placeholder: 'What was decided, and why',
      onAnswer: (a) => {
        const text = required(a.kind === 'text' ? a.text : '', 'Say what was decided, and why.');
        return typeof text === 'string' ? sent(send, { outcome: 'resolved', rationale: text }, `Decided: ${text}`) : text;
      },
    };
  }
  return {
    ...base, kind: 'text', title: `${row.n}. Reject`,
    question: 'Why reject it?', placeholder: 'Why it is rejected',
    onAnswer: (a) => {
      const text = required(a.kind === 'text' ? a.text : '', 'Say why it is rejected.');
      return typeof text === 'string' ? sent(send, { outcome: 'rejected', rationale: text }, `Rejected: ${text}`) : text;
    },
  };
}

/**
 * The dialogue for a waiting decision the viewer may decide: one choice
 * prompt over the numbered rows, each opening its follow-up. Null when there
 * is nothing to decide here (settled, or not this viewer's), so the composer
 * stays the table's.
 */
export function decisionDialogue(
  d: Pick<DecisionDetail, 'id' | 'topic' | 'status' | 'options'>, mayDecide: boolean, send: DecisionSend,
): ComposerPrompt | null {
  if (!mayDecide || (d.status !== 'open' && d.status !== 'escalated')) return null;
  const rows = dialogueRows(d.options);
  return {
    id: `decision:${d.id}`, scope: `decision:${d.id}`, kind: 'choice',
    eyebrow: 'Decision', title: d.topic,
    question: 'What did you decide?',
    options: rows.map((r) => ({ id: r.id, label: r.label, ...(r.detail ? { hint: r.detail } : {}), ...(r.kind === 'reject' ? { emphasis: 'danger' as const } : {}) })),
    onAnswer: (a) => {
      const row = 'optionId' in a ? rows.find((r) => r.id === a.optionId) : undefined;
      return row ? { next: followUpFor(d, row, send) } : { error: 'Choose one of the rows.' };
    },
  };
}
