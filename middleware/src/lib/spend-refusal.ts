// The HTTP shape of a money refusal from lib/spend-holds.ts `reserveSpend`.
//
// Its own module, importing types only, so a route that renders a refusal
// (routes/agent-projects.ts) does not load the whole budget provider graph
// just to format one. lib/spend-holds.ts re-exports it.
//
// One renderer, so dispatch-work, a manual bot run, a direct governed run and
// a box task cannot drift:
//   409 soft brake  { error, gate: allocation|envelope|user-budget, confirmFlag, confidence,
//                     allocation? | envelope? | userBudget? }
//   403 hard cap    { error, gate: allocation-cap|envelope-cap|user-cap|maintenance-reserve|learning-cap|interview-cap|opening-cap,
//                     capUsd, spentUsd, heldUsd, amountUsd, allocation? | envelope? | userBudget? }
//   403 refused     { error, gate: 'spend-hold' }
//   503 unreadable  { error, gate: 'spend-hold' | 'budget-state' }
//   429 run limit   { error, gate: 'run-limit', scope: {kind,id}, limitKind, limit, current, retryAfterS }
//                   (DE-37; the route sets Retry-After from retryAfterS)
//   423 paused      { error, gate: 'paused', scope }  (DE-50)
// `extra` rides along on every body (dispatch-work adds its `estimate`).

import type { ReserveSpendResult } from './spend-holds.js';

export function spendRefusalResponse(
  r: Exclude<ReserveSpendResult, { kind: 'held' }>, extra: Record<string, unknown> = {},
): { status: number; body: Record<string, unknown>; headers?: Record<string, string> } {
  const context = {
    ...('allocation' in r && r.allocation ? { allocation: r.allocation } : {}),
    ...('envelope' in r && r.envelope ? { envelope: r.envelope } : {}),
    ...('userBudget' in r && r.userBudget ? { userBudget: r.userBudget } : {}),
  };
  switch (r.kind) {
    case 'confirm':
      return { status: 409, body: { error: r.reason, gate: r.gate, confirmFlag: r.confirmFlag, confidence: r.confidence, ...extra, ...context } };
    case 'capped':
      return { status: 403, body: { error: r.reason, gate: r.gate, capUsd: r.capUsd, spentUsd: r.spentUsd, heldUsd: r.heldUsd, amountUsd: r.amountUsd, ...extra, ...context } };
    case 'refused':
      return { status: 403, body: { error: r.reason, gate: 'spend-hold', ...extra } };
    case 'unavailable':
      return { status: 503, body: { error: r.reason, gate: r.gate ?? 'spend-hold', ...extra } };
    case 'limited':
      return {
        status: 429,
        body: { error: r.reason, gate: 'run-limit', scope: r.scope, limitKind: r.limitKind, limit: r.limit, current: r.current, retryAfterS: r.retryAfterS, ...extra },
        headers: { 'Retry-After': String(r.retryAfterS) },
      };
    case 'paused':
      return { status: 423, body: { error: r.reason, gate: 'paused', scope: r.scope, ...extra } };
  }
}

// ── An interview's spend (lib/interviews/spend.ts) ───────────────────────────
// The sentence a recruiter, a hiring manager or an interviewer reads when an interview's spend is refused: which cap
// was reached (this interview's or the opening's), how much is left, and that the recruiter raises it. No ids, no
// setting names, nobody blamed: a cap reached is the cap doing its job.

export type InterviewRefusalInput =
  | { kind: 'no-interview' }
  | { kind: 'no-cap' }
  | { kind: 'interview-cap' | 'opening-cap'; capUsd: number; spentUsd: number; heldUsd: number; amountUsd: number };

/** Dollars to the cent, as a person reads them. */
export function dollars(usd: number): string {
  return `$${(Math.round(Math.max(0, usd) * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function interviewSpendRefusal(i: InterviewRefusalInput): string {
  if (i.kind === 'no-interview') return 'This spend is not tied to an interview, so nothing was started.';
  if (i.kind === 'no-cap') {
    return "This opening has no spending cap yet, so nothing that costs money can start in its interviews. The recruiter can set one on the opening's page.";
  }
  const used = Math.round((i.spentUsd + i.heldUsd) * 10_000) / 10_000;
  const left = Math.max(0, Math.round((i.capUsd - used) * 10_000) / 10_000);
  const leftLine = left >= 0.005 ? `so ${dollars(left)} is left` : 'so nothing is left';
  const needs = i.amountUsd > 0 && i.amountUsd < 0.005 ? 'less than a cent' : `about ${dollars(i.amountUsd)}`;
  if (i.kind === 'interview-cap') {
    return `This interview has reached its spending cap of ${dollars(i.capUsd)}: ${dollars(used)} is already spent or set aside, ${leftLine}, `
      + `and this needs ${needs}. Nothing was started. The recruiter can raise the cap per interview on the opening's page.`;
  }
  return `This opening has reached its spending cap of ${dollars(i.capUsd)}: ${dollars(used)} is already spent or set aside across its interviews, ${leftLine}, `
    + `and this needs ${needs}. Nothing was started. The recruiter can raise the opening's cap on its page.`;
}
