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
//
// CREATING (meeting consent, package 4). `POST /` makes a decision on an
// initiative from one statement: `resolved` only for someone the decide rule
// lets decide there (its owner, an org-leader or admin), recorded with them as
// decider; `waiting` for anyone on the initiative (RaiseDecision), with the
// initiative's owner as its decider, so it lands in the owner's decision
// dialogue and lists like any other waiting decision.

import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { asyncHandler, NotFoundError, ValidationError } from '../lib/async-handler.js';
import { isAllowed, requireAction, resolveSession } from '../lib/authz.js';
import { eventFromSession, logAuthz } from '../lib/audit.js';
import { decisionActor, mayDecideDecision, nameDeciders, type NamedBy } from '../lib/decision-authority.js';
import { requireInitiativeScope } from '../lib/initiative-scope.js';
import { noteSearchWriteSoon } from '../lib/search-index/writes.js';
import {
  CREATE_STATES, DECISION_OUTCOMES, DECISION_SOURCES, WAITING_STATUSES, createDecision, decideDecision, getDecision, listDecisions,
  type CreateDecisionInput, type CreateState, type DecisionOutcome, type DecisionSource,
} from '../providers/decisions.js';

/** The longest statement a created decision keeps (the proposal card's limit). */
export const STATEMENT_MAX = 280;
/** The most people one created decision names. */
export const PARTICIPANTS_MAX = 25;

/** The longest rationale a decision keeps (G54). */
export const RATIONALE_MAX = 500;

/**
 * The outcome recorded for a chosen option (G57): its label, then ", because
 * <rationale>" when one was given (a leading "because" is not doubled).
 */
export function optionOutcome(label: string, rationale: string): string {
  const why = rationale.trim().replace(/^because\b[\s,:]*/i, '').trim();
  return why ? `${label}, because ${why}` : label;
}

export const decisionsRouter = Router();

// GET /api/graph/decisions?limit=N&since=ISO
decisionsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const rawLimit = parseInt(req.query['limit'] as string ?? '50', 10);
    const limit = Number.isNaN(rawLimit) ? 50 : Math.min(Math.max(rawLimit, 1), 200);
    const since = req.query['since'] as string | undefined;

    // Each row names who decided it (settled) or who it waits on (waiting):
    // the provider applies lib/decision-authority.ts, and a bare id is named
    // here as the record route names it (nameDeciders), so the list never
    // shows more than the record page already does.
    const decisions = await listDecisions({ limit, since });
    const session = resolveSession(req);
    res.json(await Promise.all(decisions.map(async (d) => {
      if (!d.decidedBy) return d;
      const { decidedBy } = await nameDeciders(session, { decidedBy: d.decidedBy, history: [] });
      return { ...d, decidedBy };
    })));
  }),
);

// Loaded lazily, as lib/decision-authority.ts does: a module-scope import drags config.ts into every test of this router.
async function people() {
  const [identity, projects] = await Promise.all([import('../providers/identity.js'), import('../providers/projects.js')]);
  return { getUser: identity.getUser, getProject: projects.getProject };
}

interface CreateBody { initiativeId: string; statement: string; state: CreateState; participants: string[]; source: DecisionSource; callId: string | null }

function createBody(raw: unknown): CreateBody {
  const b = (raw ?? {}) as Record<string, unknown>;
  const initiativeId = typeof b['initiativeId'] === 'string' ? b['initiativeId'].trim() : '';
  if (!initiativeId) throw new ValidationError('initiativeId is required: a decision is raised on an initiative');
  if (typeof b['statement'] !== 'string' || !b['statement'].trim()) throw new ValidationError('statement is required: say what was agreed');
  const statement = b['statement'].replace(/\s+/g, ' ').trim();
  if (statement.length > STATEMENT_MAX) throw new ValidationError(`statement must be at most ${STATEMENT_MAX} characters`);
  if (!(CREATE_STATES as readonly unknown[]).includes(b['state'])) throw new ValidationError(`state must be one of ${CREATE_STATES.join(', ')}`);
  if (!(DECISION_SOURCES as readonly unknown[]).includes(b['source'])) throw new ValidationError(`source must be one of ${DECISION_SOURCES.join(', ')}`);
  const source = b['source'] as DecisionSource;
  const callId = typeof b['callId'] === 'string' && b['callId'].trim() ? b['callId'].trim() : null;
  if (source === 'call' && !callId) throw new ValidationError('callId is required when the source is a call');
  if (source === 'manual' && b['callId'] != null) throw new ValidationError('callId is only for a decision agreed in a call');
  if (callId && callId.length > 200) throw new ValidationError('callId must be at most 200 characters');
  const list = b['participants'] ?? [];
  if (!Array.isArray(list) || list.some((p) => typeof p !== 'string' || !p.trim())) throw new ValidationError('participants must be a list of user ids');
  const participants = [...new Set((list as string[]).map((p) => p.trim()))];
  if (participants.length > PARTICIPANTS_MAX) throw new ValidationError(`participants must name at most ${PARTICIPANTS_MAX} people`);
  return { initiativeId, statement, state: b['state'] as CreateState, participants, source, callId };
}

// POST /api/graph/decisions { initiativeId, statement, state: 'resolved' | 'waiting', participants?: userId[], source: 'call' | 'manual', callId? }
//
// The statement is the decision's topic and its one option. `participants`
// are the user ids of the people who agreed (the consenters of a call's
// proposal); each must be a known account. Those linked to a person become its
// participant rows; every one of them is named on its history line.
//
// 400 a bad field or an unknown participant; 404 no such initiative; 403 the
// caller is not on the initiative (NOT_ON_INITIATIVE), or asks for `resolved`
// without being someone who may decide there (NOT_DECIDER); 201 answers the
// decision as the record reads it.
decisionsRouter.post(
  '/',
  requireAction('RaiseDecision'),
  asyncHandler(async (req, res) => {
    const session = resolveSession(req);
    if (!session) { res.status(401).json({ error: 'Unauthenticated', code: 'SESSION_INVALID' }); return; }
    const body = createBody(req.body);
    const { getUser, getProject } = await people();
    const project = await getProject(body.initiativeId);
    if (!project) throw new NotFoundError('Initiative not found');
    // Raising a decision on an initiative is its own people's (owner, contributor, org-wide role).
    if (!await requireInitiativeScope(req, res, body.initiativeId, { action: 'raise decisions' })) return;

    let decidesThis = false;
    if (body.state === 'resolved') {
      // Recording one already decided is deciding it: the decide rule, asked of this initiative.
      const verdict = await mayDecideDecision(session, { projectId: body.initiativeId, participants: [] });
      if (!verdict.ok) {
        logAuthz(eventFromSession(session, 'DecideDecision', 'DENY', { path: req.path, reason: 'record resolved: not the initiative owner' }));
        res.status(403).json({
          error: 'only the initiative\'s owner or an org-leader can record a decision as decided; raise it for the owner instead', code: 'NOT_DECIDER',
          action: 'DecideDecision', role: session.role,
        });
        return;
      }
      decidesThis = verdict.decidesThis;
      if (!await isAllowed(session, 'DecideDecision', { decidesThis })) {
        logAuthz(eventFromSession(session, 'DecideDecision', 'DENY', { path: req.path, reason: 'cedar refused decidesThis' }));
        res.status(403).json({ error: 'Forbidden', action: 'DecideDecision', role: session.role, tenant: session.tenant });
        return;
      }
    }

    // Who agreed: every participant must be a known account; a linked one is a participant row.
    const agreed: Array<NamedBy & { personId: string | null }> = [];
    for (const sub of body.participants) {
      const user = await getUser(sub);
      if (!user) throw new ValidationError(`participant "${sub}" is not a known user`);
      agreed.push({ id: user.personId ?? sub, personId: user.personId ?? null, name: user.displayName?.trim() || sub });
    }
    const actor = await decisionActor(session);
    const decider = body.state === 'resolved' ? actor.personId : project.ownerId ?? null;
    const rows: CreateDecisionInput['participants'] = [];
    const seen = new Set<string>();
    const add = (personId: string | null, role: 'decider' | 'contributor') => {
      if (!personId || seen.has(personId)) return;
      seen.add(personId);
      rows.push({ personId, role });
    };
    add(decider, 'decider');
    add(actor.personId, 'contributor');
    for (const p of agreed) add(p.personId, 'contributor');
    // The history names who agreed: the creator of a decided record agreed too; a raised one names only its raiser.
    const named = body.state === 'resolved'
      ? [{ id: actor.id, name: actor.name }, ...agreed.filter((p) => p.id !== actor.id).map(({ id, name }) => ({ id, name }))]
      : [{ id: actor.id, name: actor.name }];

    const id = `d-${randomUUID()}`;
    const created = await createDecision({
      id, projectId: body.initiativeId, statement: body.statement, state: body.state, participants: rows,
      actorId: actor.id, actorName: actor.name, source: body.source, callId: body.callId, people: named,
    });
    if (!created) throw new NotFoundError('Decision not found');
    logAuthz(eventFromSession(session, body.state === 'resolved' ? 'DecideDecision' : 'RaiseDecision', 'ALLOW', {
      path: req.path, reason: `${body.state === 'resolved' ? 'recorded' : 'raised'} on ${body.initiativeId} (${body.source})`,
    }));
    noteSearchWriteSoon({ type: 'decision', id });
    res.status(201).json({ ...await nameDeciders(session, created), viewerMayDecide: (await mayDecideDecision(session, created)).ok });
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
    res.json({ ...await nameDeciders(session, decision), viewerMayDecide });
  }),
);

// POST /api/graph/decisions/:id/decide { optionId?, outcome: 'resolved' | 'rejected', rationale? }
//
// G57: a waiting decision offers pre-canned `options`; resolving with an
// `optionId` records that option's label as the outcome (", because
// <rationale>" appended when one is given), so the rationale is optional
// there. Without an option the rationale is the outcome and is required, as
// in G54. A rejection takes no option (an `optionId` with `rejected` is a 400).
//
// 400 a bad outcome, an option the decision does not offer, or a rationale
// that is missing (no option) or over RATIONALE_MAX; 404 no such decision; 403
// the caller is neither its decider, its initiative's owner, nor an
// org-leader / admin (NOT_DECIDER); 409 it is no longer waiting (already
// resolved or rejected). 200 answers the decision as the record reads it.
decisionsRouter.post(
  '/:id/decide',
  requireAction('DecideDecision'),
  asyncHandler(async (req, res) => {
    const session = resolveSession(req);
    if (!session) { res.status(401).json({ error: 'Unauthenticated', code: 'SESSION_INVALID' }); return; }
    const id = String(req.params['id'] ?? '');
    const body = (req.body ?? {}) as { optionId?: unknown; outcome?: unknown; rationale?: unknown };
    if (!(DECISION_OUTCOMES as readonly unknown[]).includes(body.outcome)) {
      throw new ValidationError(`outcome must be one of ${DECISION_OUTCOMES.join(', ')}`);
    }
    const outcome = body.outcome as DecisionOutcome;
    const optionId = body.optionId == null ? null : body.optionId;
    if (optionId !== null && (typeof optionId !== 'string' || !optionId.trim())) throw new ValidationError('optionId must be a non-empty string');
    if (optionId !== null && outcome === 'rejected') throw new ValidationError('optionId is for resolving with one of the options; a rejection takes a rationale');
    if (body.rationale != null && typeof body.rationale !== 'string') throw new ValidationError('rationale must be a string');
    const rationale = typeof body.rationale === 'string' ? body.rationale.trim() : '';
    if (!rationale && optionId === null) throw new ValidationError('rationale is required: say what was decided and why, or choose one of the options');
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
    // G57: the option must be one this decision offers; its label is what was decided.
    let recorded = rationale;
    if (typeof optionId === 'string') {
      const option = decision.options.find((o) => o.id === optionId.trim());
      if (!option) throw new ValidationError(`this decision offers no option "${optionId.trim()}"`);
      recorded = optionOutcome(option.label, rationale);
    }
    // Production's copy of the scope rule (member.cedar's forbid reads decidesThis).
    if (!await isAllowed(session, 'DecideDecision', { decidesThis: verdict.decidesThis })) {
      logAuthz(eventFromSession(session, 'DecideDecision', 'DENY', { path: req.path, reason: 'cedar refused decidesThis' }));
      res.status(403).json({ error: 'Forbidden', action: 'DecideDecision', role: session.role, tenant: session.tenant });
      return;
    }

    const actor = await decisionActor(session);
    // Deciding settles the work it held up in the same provider call (providers/decisions.ts decideDecision →
    // work-items.ts settle): resolved unblocks every item blocked on it, rejected leaves them blocked with the reason
    // "Decision rejected: <topic>". The answer's `heldWork` lists them.
    const out = await decideDecision(id, { outcome, rationale: recorded, actorId: actor.id, actorName: actor.name });
    if (out.kind === 'not-found') throw new NotFoundError('Decision not found');
    if (out.kind === 'settled') {
      res.status(409).json({ error: `this decision is already ${out.status}`, status: out.status });
      return;
    }
    logAuthz(eventFromSession(session, 'DecideDecision', 'ALLOW', { path: req.path, reason: `${outcome}${typeof optionId === 'string' ? ` (option ${optionId.trim()})` : ''} via ${verdict.via}` }));
    noteSearchWriteSoon({ type: 'decision', id });
    // The work it held up changed with it (providers/work-items.ts settleWorkBlockedOn).
    for (const w of out.settled) noteSearchWriteSoon({ type: 'work', id: w.id });
    res.json({ ...await nameDeciders(session, out.decision), viewerMayDecide: true });
  }),
);
