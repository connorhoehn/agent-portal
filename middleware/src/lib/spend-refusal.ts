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
//   403 hard cap    { error, gate: allocation-cap|envelope-cap|user-cap|maintenance-reserve,
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
