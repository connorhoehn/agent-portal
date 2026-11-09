// The brief a person gives an initiative status deck (docs/voice-navigator-gaps.md
// G55): "Create a PowerPoint of this initiative's progress this past sprint"
// arrives as the words `progress this past sprint`. They are the requester's own
// words, quoted, never an instruction and never a fact:
//
//   - the deck builder keeps reading every count, point total, sprint and
//     decision from the initiative's rows (facts.ts); the words change none of it;
//   - the words may pick a WINDOW, deterministically, here: "this past sprint",
//     "last sprint", "the previous sprint" select the initiative's most recently
//     ended sprint (status done, or its last day before today); "this sprint" or
//     "the current sprint" select the active one. The window is a sprint row, so
//     its dates and numbers are the record's too;
//   - the drafter is handed both (DraftDeckInput.brief) so its prose covers that
//     period and theme, and the title slide's notes and the revision summary
//     carry the words, so a reader sees what was asked for.

import { clip } from '../deck-shared/plan.js';
import type { SprintRow } from '../../providers/sprints.js';

export const DECK_BRIEF_MAX = 200;

export interface DeckBriefWindow {
  sprintId: string;
  name: string;
  startsOn: string | null;
  endsOn: string | null;
  status: string;
  /** Which words chose it: the last sprint that ended, or the one running now. */
  which: 'last-ended' | 'current';
}

export interface DeckBrief { words: string; window: DeckBriefWindow | null }

/** The body's `brief`: absent, or one line of at most DECK_BRIEF_MAX characters. */
export function readBrief(value: unknown): { ok: true; words: string | null } | { ok: false; reason: string } {
  if (value === undefined || value === null) return { ok: true, words: null };
  if (typeof value !== 'string') return { ok: false, reason: 'brief must be a string' };
  // eslint-disable-next-line no-control-regex
  const words = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!words) return { ok: true, words: null };
  if (words.length > DECK_BRIEF_MAX) return { ok: false, reason: `brief must be at most ${DECK_BRIEF_MAX} characters` };
  return { ok: true, words };
}

const PAST = /\b(?:past|last|previous|prior|recent|ended|closed|finished|completed)\s+sprint\b|\bsprint\s+(?:that\s+)?(?:just\s+)?(?:ended|closed|finished)\b/i;
const CURRENT = /\b(?:this|current|ongoing|active|running)\s+sprint\b/i;

const day = (v: string | null): string | null => (v ? v.slice(0, 10) : null);

/** The sprint that ended most recently: done, or its last day before `asOf`; the latest end wins. */
export function lastEndedSprint(sprints: readonly SprintRow[], asOf: string): SprintRow | null {
  const ended = sprints.filter((s) => s.status !== 'planned' && (s.status === 'done' || (day(s.endsOn) !== null && day(s.endsOn)! < asOf)));
  return [...ended].sort((a, b) => (day(b.endsOn) ?? '').localeCompare(day(a.endsOn) ?? '') || (day(b.startsOn) ?? '').localeCompare(day(a.startsOn) ?? ''))[0] ?? null;
}

/** The window the words name, from the initiative's own sprints; null when they name none (or no sprint fits). */
export function briefWindow(words: string, sprints: readonly SprintRow[], asOf: string): DeckBriefWindow | null {
  const of = (s: SprintRow | null | undefined, which: DeckBriefWindow['which']): DeckBriefWindow | null =>
    s ? { sprintId: s.id, name: s.name, startsOn: day(s.startsOn), endsOn: day(s.endsOn), status: s.status, which } : null;
  if (PAST.test(words)) return of(lastEndedSprint(sprints, asOf), 'last-ended');
  if (CURRENT.test(words)) return of(sprints.find((s) => s.status === 'active'), 'current');
  return null;
}

export function resolveBrief(words: string | null, sprints: readonly SprintRow[], asOf: string): DeckBrief | null {
  return words ? { words, window: briefWindow(words, sprints, asOf) } : null;
}

/** "Sprint 12 (2026-10-20 to 2026-11-02)". */
export const windowLabel = (w: DeckBriefWindow): string => `${w.name} (${w.startsOn ?? 'no start'} to ${w.endsOn ?? 'no end'})`;

/** The one sentence the title slide's notes and the revision summary carry: the words, quoted, and the window. */
export function briefLine(brief: DeckBrief): string {
  return clip(`Focus, in the requester's words: “${brief.words}”.${brief.window ? ` Window: ${windowLabel(brief.window)}, the ${brief.window.which === 'current' ? 'current' : 'last ended'} sprint.` : ''}`, 400);
}
