// The org graph's decision layer over HTTP — `decisions` + `decision_participants`
// (+ `decision_events`, the recorded history).
//
// Consumed by the portal's Decisions register (portal/src/pages/decisions/):
// the list, one decision's record and, since G54, the one write: a waiting
// decision (open or escalated) is resolved or rejected with the decider's
// rationale, on the record page or by the voice's `decide` (which goes through
// this same route behind its click-only card).
//
// `decisions` is ONE table with one concept (see the comment on it in
// schema/orgiq_schema.sql): a call the org has made or still has to make,
// optionally raised against an initiative. This route serves all of them; an
// initiative's Decisions tab (`GET /api/graph/projects/:id/decisions`,
// providers/work-items.ts) serves the same rows filtered by `project_id`, and
// mock/core/parity/invariants.ts fails if the two drift apart. The wire shape
// is pinned by routes/__tests__/graph-decisions-route.test.ts.
//
// AUTHORITY (G54). The route decides who may decide, not the portal: Cedar's
// DecideDecision is the floor (role-wide, requireAction below), then
// lib/decision-authority.ts scopes it to the decider and the initiative's
// owner with org-leader and admin overriding (403 NOT_DECIDER otherwise),
// then Cedar is asked again with `decidesThis` for production's forbid. The
// portal's can('DecideDecision') and the detail's `viewerMayDecide` only
// decide whether the control is drawn.

import { Router } from 'express';
import { asyncHandler, NotFoundError, ValidationError } from '../lib/async-handler.js';
import { isAllowed, requireAction, resolveSession } from '../lib/authz.js';
import { eventFromSession, logAuthz } from '../lib/audit.js';
import { decisionActor, mayDecideDecision } from '../lib/decision-authority.js';
import { noteSearchWriteSoon } from '../lib/search-index/writes.js';
import {
  DECISION_OUTCOMES, WAITING_STATUSES, decideDecision, getDecision, listDecisions, type DecisionOutcome,
} from '../providers/decisions.js';

/** The longest rationale a decision keeps (G54). */
export const RATIONALE_MAX = 500;

export const decisionsRouter = Router();

// GET /api/graph/decisions?limit=N&since=ISO
decisionsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const rawLimit = parseInt(req.query['limit'] as string ?? '50', 10);
    const limit = Number.isNaN(rawLimit) ? 50 : Math.min(Math.max(rawLimit, 1), 200);
    const since = req.query['since'] as string | undefined;

    const decisions = await listDecisions({ limit, since });
    res.json(decisions);
  }),
);

// GET /api/graph/decisions/:id
decisionsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = req.params['id'] as string;
    const decision = await getDecision(id);
    if (!decision) {
      res.status(404).json({ error: 'Decision not found' });
      return;
    }
    // Whether the viewer is someone POST /:id/decide would let through (the
    // decider, the initiative's owner, an org-leader or admin). Presentation
    // only: the write asks the same question again, and Cedar.
    const session = resolveSession(req);
    const viewerMayDecide = session ? (await mayDecideDecision(session, decision)).ok : false;
    res.json({ ...decision, viewerMayDecide });
  }),
);

// POST /api/graph/decisions/:id/decide { outcome: 'resolved' | 'rejected', rationale }
//
// 400 a bad outcome or a rationale that is empty or over RATIONALE_MAX; 404 no
// such decision; 403 the caller is neither its decider, its initiative's
// owner, nor an org-leader / admin (NOT_DECIDER); 409 it is no longer waiting
// (already resolved or rejected). 200 answers the decision as the record reads it.
decisionsRouter.post(
  '/:id/decide',
  requireAction('DecideDecision'),
  asyncHandler(async (req, res) => {
    const session = resolveSession(req);
    if (!session) { res.status(401).json({ error: 'Unauthenticated', code: 'SESSION_INVALID' }); return; }
    const id = String(req.params['id'] ?? '');
    const body = (req.body ?? {}) as { outcome?: unknown; rationale?: unknown };
    if (!(DECISION_OUTCOMES as readonly unknown[]).includes(body.outcome)) {
      throw new ValidationError(`outcome must be one of ${DECISION_OUTCOMES.join(', ')}`);
    }
    const outcome = body.outcome as DecisionOutcome;
    const rationale = typeof body.rationale === 'string' ? body.rationale.trim() : '';
    if (!rationale) throw new ValidationError('rationale is required: say what was decided and why');
    if (rationale.length > RATIONALE_MAX) throw new ValidationError(`rationale must be at most ${RATIONALE_MAX} characters`);

    const decision = await getDecision(id);
    if (!decision) throw new NotFoundError('Decision not found');

    const verdict = await mayDecideDecision(session, decision);
    if (!verdict.ok) {
      logAuthz(eventFromSession(session, 'DecideDecision', 'DENY', { path: req.path, reason: 'not the decider or the initiative owner' }));
      res.status(403).json({
        error: 'only the decider, the initiative\'s owner or an org-leader can decide this', code: 'NOT_DECIDER',
        action: 'DecideDecision', role: session.role,
      });
      return;
    }
    if (!WAITING_STATUSES.includes(decision.status)) {
      res.status(409).json({ error: `this decision is already ${decision.status}`, status: decision.status });
      return;
    }
    // Production's copy of the scope rule (member.cedar's forbid reads decidesThis).
    if (!await isAllowed(session, 'DecideDecision', { decidesThis: verdict.decidesThis })) {
      logAuthz(eventFromSession(session, 'DecideDecision', 'DENY', { path: req.path, reason: 'cedar refused decidesThis' }));
      res.status(403).json({ error: 'Forbidden', action: 'DecideDecision', role: session.role, tenant: session.tenant });
      return;
    }

    const actor = await decisionActor(session);
    const out = await decideDecision(id, { outcome, rationale, actorId: actor.id, actorName: actor.name });
    if (out.kind === 'not-found') throw new NotFoundError('Decision not found');
    if (out.kind === 'settled') {
      res.status(409).json({ error: `this decision is already ${out.status}`, status: out.status });
      return;
    }
    logAuthz(eventFromSession(session, 'DecideDecision', 'ALLOW', { path: req.path, reason: `${outcome} via ${verdict.via}` }));
    noteSearchWriteSoon({ type: 'decision', id });
    res.json({ ...out.decision, viewerMayDecide: true });
  }),
);
