// The structured scope an ask carries from the composer's context chip, and the
// stance it was asked under. Pure: no provider imports, so routes/agents.ts can
// parse it before the SSE stream opens without loading any data module.
//
// The scope used to travel as prose glued onto the question ("…\n\nAbout the
// organisation's initiatives. Advise only; do not change anything."), which put
// the framing in the breadcrumb, the page title and the transcript, and gave
// the server nothing it could act on. It is now a typed field; the prose is
// rebuilt here, server-side, only for the agent fall-through (an LLM still
// reads prose).

import { ValidationError } from '../async-handler.js';

export type AnswerScope =
  | { kind: 'initiatives' }
  | { kind: 'initiative'; id: string }
  | { kind: 'work'; id: string };

/** 'advise' — the asker wants advice only; nothing may be changed on their behalf. */
export type AnswerStance = 'advise';

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Validate the invoke body's `scope`; absent is null, malformed is a 400. */
export function parseAnswerScope(raw: unknown): AnswerScope | null {
  if (raw == null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new ValidationError('scope must be an object');
  const r = raw as Record<string, unknown>;
  if (r['kind'] === 'initiatives') return { kind: 'initiatives' };
  if ((r['kind'] === 'initiative' || r['kind'] === 'work') && typeof r['id'] === 'string' && ID_RE.test(r['id'])) {
    return { kind: r['kind'], id: r['id'] };
  }
  throw new ValidationError("scope must be {kind:'initiatives'} or {kind:'initiative'|'work', id}");
}

/** Validate the invoke body's `stance`; only 'advise' exists. */
export function parseAnswerStance(raw: unknown): AnswerStance | null {
  if (raw == null) return null;
  if (raw === 'advise') return 'advise';
  throw new ValidationError("stance must be 'advise'");
}

/**
 * The prose an LLM agent reads for a scope and stance — appended to the
 * message only on the agent fall-through, never shown to the user. Initiative
 * and work scopes name their records by id; the route's own server-resolved
 * selection (search_context) carries the titles when the client sent one.
 */
export function scopeContextLine(scope: AnswerScope | null, stance: AnswerStance | null): string {
  const about = !scope ? ''
    : scope.kind === 'initiatives' ? "About the organisation's initiatives."
    : scope.kind === 'initiative' ? `About the initiative ${scope.id}.`
    : `About the work item ${scope.id}.`;
  const advise = stance === 'advise' ? 'Advise only; do not change anything.' : '';
  return [about, advise].filter(Boolean).join(' ');
}
