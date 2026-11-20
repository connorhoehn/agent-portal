// The seed phrasing of a scenario: the wording under test, with the name, casing, punctuation and filler taken out. The dev / hold-out
// split is BY SEED: every scenario built on one seed (the same request from another role, with the name moved, misheard or dropped, on a
// hold, after an answer) sits on one side only. A hold-out number then measures unseen wordings, not the dev wordings with the name moved.
import type { Scenario } from './types.mts';

/** Milo's name and the forms the transcriber mishears it as. */
export const NAME_SPELLINGS = ['milo', 'mylo', 'nilo', 'nylo', 'ilo', 'milow', 'mylow', 'meelo', 'mielo'] as const;
const NAME_WORD = new RegExp(`\\b(${NAME_SPELLINGS.join('|')})\\b`, 'g');
const FILLER = /\b(please|hey|um|uh|okay|ok)\b/g;

export const normalisePhrasing = (text: string): string =>
  text.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(NAME_WORD, ' ').replace(FILLER, ' ').replace(/\s+/g, ' ').trim();

/** `seed` when the scenario states one; else its last sentence (earlier sentences are set-up: the request a follow-up follows, the first half of a split request). */
export function seedOf(s: Scenario): string {
  if (s.seed) return normalisePhrasing(s.seed);
  const sentences = s.events.filter((e) => e.kind === 'sentence');
  const last = sentences[sentences.length - 1];
  if (!last) throw new Error(`${s.id}: no sentence to take a seed phrasing from`);
  return normalisePhrasing(last.text);
}

/** Seeds that sit on both sides of the split (must be empty). */
export function sharedSeeds(dev: Scenario[], holdout: Scenario[]): string[] {
  const d = new Set(dev.map(seedOf));
  return [...new Set(holdout.map(seedOf))].filter((x) => d.has(x));
}
