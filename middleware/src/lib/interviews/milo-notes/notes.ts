// Milo's notes for the panel (docs/interviews-tenant-plan.md row I3.6, the part with no model; decision 6). Pure.
//
// Per competency of the kit: what has been ASKED ABOUT, and which chosen questions are still to ask. Never how the
// candidate did: no "covered well", no bar, no percentage, no count of evidence. A question counts as asked when
//   * a panel line contains its opening words (its first six, as the scripted coach judges "asked"), or
//   * the lead answered a suggestion of it "I'll ask it" or "Have Milo ask".
// A suggestion the lead took that is not one of the chosen questions (a follow-up, the model's own words) is listed under
// its competency as asked too. A skipped or dropped suggestion is not.
//
// The time check: minutes since the start, the round's length, minutes left. The start is the set time when there is one,
// else when Milo joined the call (the interview record keeps no start instant; the footer counts the same way).
import type { SuggestionRecord } from '../coach/store.js';
import type { KitCompetency, KitQuestion } from '../types.js';

export interface NotesInput {
  competencies: readonly Pick<KitCompetency, 'id' | 'name'>[];
  /** The chosen questions of this round, in their order. */
  chosen: readonly Pick<KitQuestion, 'id' | 'prompt' | 'competencyId'>[];
  /** What the panel said, oldest first (the candidate's words are never read here). */
  panelLines: readonly string[];
  suggestions: readonly Pick<SuggestionRecord, 'text' | 'competencyId' | 'answer' | 'dropped'>[];
}

export type AskedBy = 'panel' | 'milo';
export interface AskedItem { text: string; questionId: string | null; by: AskedBy }
export interface CompetencyNotes { id: string; name: string; asked: AskedItem[]; toAsk: Array<{ questionId: string; text: string }> }
export interface TimeCheck { startedAt: string | null; minutesIn: number | null; minutes: number; minutesLeft: number | null; line: string }
export interface MiloNotesView { competencies: CompetencyNotes[]; time: TimeCheck }

const words = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim();
/** A question's opening words (its first six). */
export const openingWords = (s: string): string => words(s).split(' ').slice(0, 6).join(' ');
const said = (prompt: string, line: string): boolean => { const o = openingWords(prompt); return o.length > 0 && words(line).includes(o); };
const sameText = (a: string, b: string): boolean => words(a) === words(b);

export function competencyNotes(input: NotesInput): CompetencyNotes[] {
  const taken = input.suggestions.filter((s) => s.dropped === null && (s.answer === 'ask' || s.answer === 'milo-ask') && s.text.trim());
  return input.competencies.map((c) => {
    const asked: AskedItem[] = [];
    const toAsk: CompetencyNotes['toAsk'] = [];
    const chosen = input.chosen.filter((q) => q.competencyId === c.id);
    for (const q of chosen) {
      const bySuggestion = taken.find((s) => sameText(s.text, q.prompt));
      if (bySuggestion) asked.push({ text: q.prompt, questionId: q.id, by: bySuggestion.answer === 'milo-ask' ? 'milo' : 'panel' });
      else if (input.panelLines.some((l) => said(q.prompt, l))) asked.push({ text: q.prompt, questionId: q.id, by: 'panel' });
      else toAsk.push({ questionId: q.id, text: q.prompt });
    }
    for (const s of taken) {
      if (s.competencyId !== c.id || input.chosen.some((q) => sameText(q.prompt, s.text))) continue;
      if (asked.some((a) => sameText(a.text, s.text))) continue;
      asked.push({ text: s.text, questionId: null, by: s.answer === 'milo-ask' ? 'milo' : 'panel' });
    }
    return { id: c.id, name: c.name, asked, toAsk };
  });
}

const MIN = 60_000;

/** The time check in one plain line, computed on the server from the start, the round's length and now. */
export function timeCheck(startMs: number | null, minutes: number, nowMs: number): TimeCheck {
  if (startMs === null || !Number.isFinite(startMs)) {
    return { startedAt: null, minutesIn: null, minutes, minutesLeft: null, line: `The round is ${minutes} min; its start time is not known yet.` };
  }
  const startedAt = new Date(startMs).toISOString();
  if (nowMs < startMs) {
    return { startedAt, minutesIn: 0, minutes, minutesLeft: minutes, line: `Starts in ${Math.max(1, Math.ceil((startMs - nowMs) / MIN))} min; the round is ${minutes} min.` };
  }
  const minutesIn = Math.floor((nowMs - startMs) / MIN);
  const left = minutes - minutesIn;
  const line = left > 0 ? `${minutesIn} of ${minutes} min, ${left} min left.` : `${minutesIn} of ${minutes} min, over by ${Math.max(0, -left)} min.`;
  return { startedAt, minutesIn, minutes, minutesLeft: Math.max(0, left), line: left === 0 ? `${minutesIn} of ${minutes} min, no time left.` : line };
}

/**
 * Where the time check counts from: the set time, else when Milo joined the call. A round the lead started before its set time
 * counts from that start (`startedAt`, finding I3.6h: a live round never reads "Starts in"); one started late keeps its set time.
 */
export function notesStartMs(scheduledAt: string | null, callStartedAtMs: number | null, startedAt: string | null = null): number | null {
  const set = scheduledAt ? Date.parse(scheduledAt) : NaN;
  const started = startedAt ? Date.parse(startedAt) : NaN;
  if (Number.isFinite(started) && !(started >= set)) return started;
  if (Number.isFinite(set)) return set;
  return callStartedAtMs !== null && Number.isFinite(callStartedAtMs) ? callStartedAtMs : null;
}
