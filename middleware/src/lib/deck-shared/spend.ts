// Money on the deck drafter calls (ledger P-12, docs/spend-map.md row 18).
//
// Deck drafting (`applyNarrative`, the Social `/deck` run) and deck revision
// (`reviseWithAgent`) and the operations proposal (`proposeDeckOperations`) call the drafter agent, which spends Bedrock tokens. Each
// such call now goes through the agent-invoke chokepoint
// (lib/agent-invoke-spend.ts): a hold is judged and taken before the call, and
// one `agent_invoke` ledger row (trigger `deck:<tenant>:<draft|revise|propose>`) is
// written after it, which settles the hold when its cost is known.
//
// A refusal (a cap, a budget, a kill switch, an unattributed call refused)
// never fails the deck: the caller takes the deterministic fallback it already
// takes when the agent is unavailable, and surfaces `reason`. An agent call
// that throws releases its hold; an answer, even an error envelope, is booked
// (priced from a usage block when there is one, else with an unknown cost).
//
// Callers reach this only when a real call is about to be made: the
// MOCK_AGENTCORE and DEV_OFFLINE paths return before it, so they hold nothing.

import { randomUUID } from 'node:crypto';
import type { AgentInvokeResult } from '../../providers/types.js';
import { holdAgentInvoke, recordAgentInvoke, releaseAgentInvokeHold, usageFromEvent } from '../agent-invoke-spend.js';

export interface DeckSpendCall {
  tenant: string;
  action: 'draft' | 'revise' | 'propose';
  /** The person who asked. */
  actorId: string | null;
  /** The deck's initiative, when it has one; null books the call unattributed. */
  initiativeId: string | null;
}

export type MeteredDeckInvoke =
  | { kind: 'answered'; res: AgentInvokeResult }
  | { kind: 'refused'; reason: string };

/** The sentence a refusal is surfaced with, in place of the drafter's prose. */
export const deckSpendRefusalReason = (reason: string): string => `spend refused: ${reason}`;

/** The ledger trigger a deck call's row carries. */
export const deckSpendFeature = (call: Pick<DeckSpendCall, 'tenant' | 'action'>): string => `deck:${call.tenant}:${call.action}`;

/**
 * Hold, call, then book. `invoke` runs only when the hold is taken; a throw from
 * it releases the hold and is rethrown for the caller's existing fallback.
 */
export async function meteredDeckInvoke(call: DeckSpendCall, invoke: () => Promise<AgentInvokeResult>): Promise<MeteredDeckInvoke> {
  const sourceId = `deck-${call.action}-${randomUUID()}`;
  let held: Awaited<ReturnType<typeof holdAgentInvoke>>;
  try {
    held = await holdAgentInvoke({ actorId: call.actorId, initiativeId: call.initiativeId, sourceId });
  } catch (error) {
    // A hold that cannot be judged is not a hold: nothing is spent.
    return { kind: 'refused', reason: deckSpendRefusalReason(`the spend check failed (${error instanceof Error ? error.message : 'unknown error'})`) };
  }
  if (held.kind !== 'held') return { kind: 'refused', reason: deckSpendRefusalReason(held.reason) };
  let res: AgentInvokeResult;
  try {
    res = await invoke();
  } catch (error) {
    await releaseAgentInvokeHold(held.holdId).catch(() => undefined);
    throw error;
  }
  await recordAgentInvoke({
    sourceId, actorId: call.actorId, initiativeId: call.initiativeId,
    feature: deckSpendFeature(call), usage: usageFromEvent(res.raw),
  });
  return { kind: 'answered', res };
}
