// THE deck write rule — stated once, enforced once (docs/agentic-flows-migration.md,
// "Deck write authority", decided 2026-10-06).
//
//   A deck is writable (build, save, revise, share) by exactly the actor who may
//   run that tenant's agent on the deck's subject:
//
//     assessment  RunAssessmentAgent  + current team read      (ViewAssessment)
//     pipelines   RunPipeline         + current run read       (ViewPipelines)
//     orgiq       DispatchAgentRun    + the initiative's own people (owner,
//                                       contributor or org-wide role; reading is
//                                       tenant-open, the budget-tier redaction a
//                                       READ rule, providers/initiative-decks.ts)
//     social      PostMessage         + CURRENT conversation membership
//                                       (routes/chat-pins.ts chatAccess); only
//                                       the owner may delete.
//
// Every deck route (routes/assessment-decks.ts, pipeline-decks.ts,
// initiative-decks.ts, social-deck.ts) and the share-to-social path asks this
// function; no route keeps its own write gate. It is asked FRESH on every
// request: the session is re-read from the directory (live-principal.ts), the
// tenant must be the session's active tenant (or the cross-tenant admin), and
// each Cedar action is evaluated now. The portal reads the same rule through the
// deck api config's `build` / `revise` flags (portal can() -> same action).

import type { Request } from 'express';
import { AppError } from '../async-handler.js';
import { isAllowed } from '../authz.js';
import { currentLiveSession } from '../live-principal.js';
import type { Session } from '../session.js';

export type DeckTenant = 'assessment' | 'pipelines' | 'orgiq' | 'social';
export type DeckSubject =
  | { tenant: 'assessment'; teamId: string }
  | { tenant: 'pipelines'; runId: string }
  | { tenant: 'orgiq'; projectId: string }
  | { tenant: 'social'; channel: string; ownerId?: string | null };
export type DeckWriteOp = 'build' | 'save' | 'revise' | 'share' | 'delete';

/** The rule as data: one row per tenant. The portal mirrors the `write` action. */
export const DECK_WRITE_RULE: Readonly<Record<DeckTenant, { write: string; read: string | null }>> = {
  assessment: { write: 'RunAssessmentAgent', read: 'ViewAssessment' },
  pipelines: { write: 'RunPipeline', read: 'ViewPipelines' },
  orgiq: { write: 'DispatchAgentRun', read: null },
  social: { write: 'PostMessage', read: 'ViewSocial' },
};

export interface DeckWriter { sub: string; session: Session | null }

/**
 * Resolve the writer or throw 401/403/503. `tenant` must equal `subject.tenant`
 * (a caller cannot ask one tenant's rule for another tenant's subject).
 */
export async function deckWriteAuthority(
  tenant: DeckTenant, subject: DeckSubject, req: Request, op: DeckWriteOp = 'save',
): Promise<DeckWriter> {
  if (subject.tenant !== tenant) throw new AppError(403, 'Forbidden');
  if (tenant === 'social') return socialWriter(subject as Extract<DeckSubject, { tenant: 'social' }>, req, op);
  if (!req.session) throw new AppError(401, 'Unauthenticated');
  const live = await currentLiveSession(req.session);
  if (live.tenant !== tenant && live.role !== 'admin') throw new AppError(403, `This deck belongs to the ${tenant} tenant`);
  const principal = { sub: live.sub, tenant: live.tenant, role: live.role };
  const rule = DECK_WRITE_RULE[tenant];
  for (const action of [rule.write, ...(rule.read ? [rule.read] : [])]) {
    let ok: boolean;
    try { ok = await isAllowed(principal, action); }
    catch { throw new AppError(503, 'authorization unavailable'); }
    if (!ok) throw new AppError(403, `Forbidden: ${action} is required to ${op} a deck`);
  }
  // An initiative's deck is written by that initiative's own people (owner,
  // contributor or an org-wide role), the rule every other initiative write
  // asks (sweep 11: work items, workspace pages). Reading stays tenant-open.
  if (subject.tenant === 'orgiq') {
    const { stewardsInitiative } = await import('../initiative-scope.js');
    // An unknown deck (no projectId) falls through to the route's own 404.
    if (subject.projectId && !await stewardsInitiative(live, subject.projectId)) {
      throw new AppError(403, `you can only ${op} decks on initiatives you own or contribute to`);
    }
  }
  return { sub: live.sub, session: live };
}

async function socialWriter(subject: Extract<DeckSubject, { tenant: 'social' }>, req: Request, op: DeckWriteOp): Promise<DeckWriter> {
  // chatAccess = current Social grant (PostMessage) + current channel/DM/team membership.
  const { chatAccess } = await import('../../routes/chat-pins.js');
  const sub = await chatAccess(req, subject.channel, 'PostMessage');
  if (op === 'delete' && subject.ownerId !== sub) throw new AppError(403, 'Only the person who built this deck can delete it');
  return { sub, session: req.session ?? null };
}
