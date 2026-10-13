// The scope an Agent question is asked about — the composer's context chip
// ("Initiatives", an initiative, a work item) — as data, not prose.
//
// It used to be glued onto the question ("…\n\nAbout the organisation's
// initiatives. Advise only; do not change anything."), so the framing showed in
// Search's breadcrumb, title and transcript, and the server could not act on
// it. Now it rides the invoke body as `scope` + `stance` (middleware
// lib/local-answers/scope.ts validates them; the local data assistant answers
// within the scope, and the agent fall-through rebuilds the prose server-side)
// and the Search URL as `about=` so a deep link and its follow-ups keep it.

export type AskScope =
  | { kind: 'initiatives' }
  | { kind: 'initiative'; id: string }
  | { kind: 'work'; id: string };

/** Composer questions are advise-only: nothing is changed on the asker's behalf. */
export type AskStance = 'advise';

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** `about=` value: `initiatives`, `initiative:<id>` or `work:<id>`. */
export function encodeAskScope(scope: AskScope): string {
  return scope.kind === 'initiatives' ? 'initiatives' : `${scope.kind}:${scope.id}`;
}

/** The `about=` param back to a scope; anything unrecognised is no scope. */
export function parseAskScope(raw: string | null | undefined): AskScope | null {
  if (!raw) return null;
  if (raw === 'initiatives') return { kind: 'initiatives' };
  const m = /^(initiative|work):(.+)$/.exec(raw);
  return m && ID_RE.test(m[2]!) ? { kind: m[1] as 'initiative' | 'work', id: m[2]! } : null;
}

/** The invoke-body fields for a scope (empty when there is none). */
export function askScopeBody(scope: AskScope | null | undefined, stance: AskStance = 'advise'): { scope?: AskScope; stance?: AskStance } {
  return scope ? { scope, stance } : {};
}
