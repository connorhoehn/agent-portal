// The pure half of useUrlDraft: when may a URL change overwrite what the
// person is typing?
//
// The router commits a navigation inside a transition, so `?q=` lags the
// keystroke that wrote it. A box bound straight to the URL therefore renders
// the stale value after every key, and the next key lands on that stale text —
// "zzznope" typed into Asset promotions came out "zzp". So the box keeps its
// own text and writes the URL behind it, and the one rule that matters is
// which URL changes are allowed to come back into the box:
//
//   * our own write arriving late — never (the person has typed on since);
//   * a value the box already shows, modulo surrounding space — never (a
//     trailing space between words would otherwise be trimmed away);
//   * anything else (Back/Forward, a "Clear filters", a pasted link) — yes.

export interface DraftState {
  /** What the field shows. */
  text: string;
  /** Values this box wrote to the URL that the router has not delivered yet,
   *  oldest first. Two can be in flight when a commit lands mid-transition. */
  pending: string[];
}

export const draftValue = (text: string): string => text.trim();

/** The URL now reads `urlValue`: the state the box should move to. */
export function adoptUrlValue(state: DraftState, urlValue: string): DraftState {
  const mine = state.pending.indexOf(urlValue);
  if (mine >= 0) return { text: state.text, pending: state.pending.slice(mine + 1) };
  if (draftValue(state.text) === urlValue) return { text: state.text, pending: [] };
  return { text: urlValue, pending: [] };
}

/** Does the field hold something the URL does not say yet? */
export function needsCommit(text: string, urlValue: string): boolean {
  return draftValue(text) !== urlValue;
}
