// Runbooks API (docs/distillation-runbooks-design.md §2.4–§2.6; lane D / R3).
//
//   GET  /api/runbooks                         list (filters: scope_kind, scope_ref, status, health, q, cursor, limit)
//   GET  /api/runbooks/proposals               proposals (status, runbook_id, kind, cursor, limit)
//   GET  /api/runbooks/proposals/:pid          one proposal + the diff against its base + lint re-run
//   POST /api/runbooks/proposals               propose (a person, or a box/worker with a signed lab envelope)
//   POST /api/runbooks/proposals/:pid/accept   ReviewRunbook + owner/initiative-SME scope; 409 on a stale base
//   POST /api/runbooks/proposals/:pid/reject   same gate; a note is required
//   POST /api/runbooks/proposals/:pid/merge    same gate on the TARGET runbook; re-targets as an edit
//   GET  /api/runbooks/:id                     the runbook, its current version, derived health
//   GET  /api/runbooks/:id/versions            every version (markdown + sha + who accepted it)
//   GET  /api/runbooks/:id/diff                unified diff of canonical markdown, ?from=&to=
//   POST /api/runbooks/:id/retire              ReviewRunbook + scope; names what superseded it
//   GET  /api/runbooks/:id/applications        runs that were given it and reported (?version=)
//   POST /api/runbooks/:id/applications        a box reports (`lab applied`); service auth only
//
// GATING (two layers, the ManageSprints + requireInitiativeSteward shape):
//   reads        signed-in orgiq user (requireTenant + requireSession) — "a member can read".
//   proposals    a person needs only a session (anyone may suggest an edit); a machine
//                presents LAB_CALLBACK_SERVICE_AUTH. A machine may only file `run` proposals;
//                a person's proposal is always attributed to their own session.
//   decisions    Cedar `ReviewRunbook` (the role floor) AND lib/runbook-review.ts (the
//                runbook's owner, or an SME on its initiative; org-leader/admin override).
//                Nobody accepts their own proposal. Merge needs review rights on BOTH the
//                proposal's own runbook and the target. No write is made under a masquerade.
//   applications service auth only — a person does not report on a run.
//   run binding  a box's proposal and its application also carry the run token for that
//                run_ref (lib/run-token.ts): the fleet secret alone acts for no run. A run
//                proposal's dispatcher (from its frozen brief) may not decide it.
//
// Machine-vs-person is decided ONCE (`machineMark`), because a signed envelope's nonce is
// single-use: asking hasServiceAuth twice would turn a valid call into a "replayed" one.
//
// The store is injected (`deps.store`), default `runbookStore()` (lib/runbooks/store-select),
// so a suite can hand the router a private RowsRunbookStore.

import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { randomUUID, createHash } from 'node:crypto';
import { asyncHandler, ValidationError } from '../lib/async-handler.js';
import { isAllowed, requireAction, requireSession, requireTenant, resolveSession } from '../lib/authz.js';
import { rateLimit } from '../lib/rate-limit.js';
import { LAB_CALLBACK_SERVICE_AUTH, hasServiceAuth, requireServiceAuth } from '../lib/service-auth.js';
import { RUN_TOKEN_HEADER, runTokenMatches } from '../lib/run-token.js';
import type { Session } from '../lib/session.js';
import { actorId, mayReviewRunbook, type ReviewVerdict } from '../lib/runbook-review.js';
import { unifiedDiff } from '../lib/unified-diff.js';
import { loadCandidates } from '../lib/session-brief-preview.js';
import { clock } from '../mock/core/clock.js';
import {
  findSimilar, lintErrors, lintRunbook, runbookHealth, tryParseRunbook, versionOf,
  AlreadyExistsError, InvalidWriteError, NotFoundError as StoreNotFound, ProposalClosedError, RunbookStoreError,
  SelfAcceptError, VersionConflictError, RetiredRunbookError,
  type LintContext, type LintFinding, type Runbook, type RunbookApplication, type RunbookDoc, type RunbookProposal,
  type RunbookScope, type RunbookStore, type RunbookVersion,
} from '../lib/runbooks/index.js';
import { repoLintContext } from '../lib/runbooks/repo-context.js';

export interface RunbooksDeps {
  store: () => RunbookStore | Promise<RunbookStore>;
}

const OUTCOMES = ['followed', 'followed_with_deviation', 'failed', 'not_used'] as const;
const SCOPE_KINDS = ['org', 'initiative', 'repo', 'tool'] as const;
const STATUSES = ['draft', 'published', 'retired'] as const;
const PROPOSAL_STATUSES = ['open', 'accepted', 'rejected', 'merged', 'withdrawn'] as const;
const RUNBOOK_ID = /^rb-[a-z0-9][a-z0-9-]{1,58}$/;

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const int = (v: unknown): number | undefined => (typeof v === 'number' && Number.isInteger(v) ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : undefined);

function pageLimit(v: unknown): number | undefined {
  const n = int(v);
  return n === undefined ? undefined : Math.min(Math.max(n, 1), 200);
}

function oneOf<T extends string>(list: readonly T[], v: unknown, what: string): T | undefined {
  if (v === undefined || v === '') return undefined;
  if (typeof v !== 'string' || !(list as readonly string[]).includes(v)) throw new ValidationError(`${what} must be one of: ${list.join(', ')}`);
  return v as T;
}

function csv<T extends string>(list: readonly T[], v: unknown, what: string): T[] | undefined {
  if (typeof v !== 'string' || !v.trim()) return undefined;
  return v.split(',').map((s) => oneOf(list, s.trim(), what)!).filter(Boolean);
}

let lintContext: LintContext | null | undefined;
/** The route snapshot + tree, read once. Outside a checkout there is none and R-command-real checks nothing. */
function lintCtx(): LintContext | undefined {
  if (lintContext === undefined) {
    try { lintContext = repoLintContext(); } catch { lintContext = null; }
  }
  return lintContext ?? undefined;
}

const slug = (title: string): string =>
  `rb-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/g, '')}`;

// ── Caller kind ──────────────────────────────────────────────────────────────

/** Mark a request that carries a valid service credential. Never rejects. */
const machineMark: RequestHandler = (req, res, next) => {
  if (hasServiceAuth(req, LAB_CALLBACK_SERVICE_AUTH)) res.locals['machine'] = true;
  next();
};
/** Run `human` only for a caller that is not a machine. */
const unlessMachine = (human: RequestHandler): RequestHandler => (req, res, next) => {
  if (res.locals['machine']) { next(); return; }
  void human(req, res, next);
};

const readGate: RequestHandler[] = [requireTenant('orgiq'), requireSession('ViewRunbooks')];
const reviewGate: RequestHandler[] = [requireTenant('orgiq'), requireAction('ReviewRunbook')];
const suggestGate: RequestHandler[] = [machineMark, unlessMachine(requireTenant('orgiq')), unlessMachine(requireSession('SuggestRunbook'))];

const callbackLimit = rateLimit('runbook-callback', 120, 60_000);

/** A box acts only for its own run: the envelope AND the run token for exactly that run_ref (lib/run-token.ts). */
function refuseRunToken(res: Response): void {
  res.status(403).json({ error: `a box acts only for its own run: present ${RUN_TOKEN_HEADER} for this run_ref`, code: 'RUN_TOKEN' });
}
const requireLabAuth = requireServiceAuth(LAB_CALLBACK_SERVICE_AUTH);

/**
 * Refuse a write made under a masquerade. Every runbook write is identity-bound
 * (a proposal's author, a decision's decider, "never accept your own"), and a
 * masquerade splits that identity in two: an admin could propose as themselves and
 * accept as an SME they impersonate, or file a proposal as someone else and then
 * accept it as themselves. Impersonation is for seeing what someone sees.
 */
function refuseMasquerade(req: Request, res: Response): boolean {
  if (!resolveSession(req)?.act) return false;
  res.status(403).json({ error: 'stop masquerading to propose or decide on runbooks; these writes are attributed to a person', code: 'MASQUERADING' });
  return true;
}

async function workItemExists(id: string): Promise<boolean> {
  const { getWorkItem } = await import('../providers/work-items.js');
  return !!(await getWorkItem(id));
}

/** Mock mode has no people table: the registered cast answers; otherwise Aurora's `people`. */
async function personExists(id: string): Promise<boolean> {
  const { config } = await import('../config.js');
  if (config.mock.aurora) return (await import('../mock/people.js')).mockPeople.some((p) => p.id === id);
  return (await import('../providers/sprints.js')).personExists(id);
}

function session(req: Request): Session {
  const s = resolveSession(req);
  if (!s) throw new ValidationError('no session'); // the gate already 401'd; this keeps the handler honest
  return s;
}

// ── Errors ───────────────────────────────────────────────────────────────────

function storeError(err: unknown, res: Response): boolean {
  if (!(err instanceof RunbookStoreError)) return false;
  if (err instanceof VersionConflictError) {
    res.status(409).json({ error: err.message, code: 'VERSION_CONFLICT', expected: err.expected, actual: err.actual });
  } else if (err instanceof ProposalClosedError) {
    res.status(409).json({ error: err.message, code: 'PROPOSAL_CLOSED', status: err.status });
  } else if (err instanceof RetiredRunbookError) {
    res.status(409).json({ error: err.message, code: 'RETIRED' });
  } else if (err instanceof SelfAcceptError) {
    res.status(403).json({ error: err.message, code: 'SELF_ACCEPT' });
  } else if (err instanceof AlreadyExistsError) {
    res.status(409).json({ error: err.message, code: 'ALREADY_EXISTS' });
  } else if (err instanceof StoreNotFound) {
    res.status(404).json({ error: err.message });
  } else if (err instanceof InvalidWriteError) {
    res.status(400).json({ error: err.message });
  } else {
    res.status(500).json({ error: 'runbook store error' });
  }
  return true;
}

/** asyncHandler that turns the store's typed errors into their HTTP status. */
const handler = (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  asyncHandler(async (req, res, next) => {
    try { await fn(req, res, next); } catch (err) { if (!storeError(err, res)) throw err; }
  });

// ── The router ───────────────────────────────────────────────────────────────

export function createRunbooksRouter(deps: RunbooksDeps): Router {
  const router = Router();
  const store = async (): Promise<RunbookStore> => deps.store();

  const now = (): string => clock.nowIso();

  async function currentVersion(s: RunbookStore, r: Runbook): Promise<RunbookVersion | null> {
    return s.getVersion(r.id, r.current_version);
  }

  async function healthOf(s: RunbookStore, r: Runbook) {
    return runbookHealth(await s.listApplications(r.id, r.current_version), r.current_version, Date.parse(now()));
  }

  async function openCounts(s: RunbookStore): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    let cursor: string | undefined;
    do {
      const page = await s.listProposals({ status: ['open'], limit: 200, ...(cursor ? { cursor } : {}) });
      for (const p of page.items) if (p.runbook_id) counts.set(p.runbook_id, (counts.get(p.runbook_id) ?? 0) + 1);
      cursor = page.next ?? undefined;
    } while (cursor);
    return counts;
  }

  async function runbookRow(s: RunbookStore, r: Runbook, open: number) {
    const v = await currentVersion(s, r);
    return {
      ...r,
      title: v?.doc.title ?? r.id,
      summary: v?.doc.summary ?? '',
      sha256: v?.sha256 ?? null,
      health: await healthOf(s, r),
      open_proposals: open,
    };
  }

  /** The runbook's scope as the review rule sees it, or a 404/409 already sent. */
  async function proposalTarget(s: RunbookStore, p: RunbookProposal): Promise<Runbook | null> {
    return p.runbook_id ? s.getRunbook(p.runbook_id) : null;
  }

  function deny(res: Response, v: Extract<ReviewVerdict, { ok: false }>, action = 'ReviewRunbook'): void {
    res.status(403).json({ error: v.reason, code: 'OUT_OF_SCOPE', action });
  }

  function proposalView(p: RunbookProposal, extra: Record<string, unknown> = {}) {
    return {
      ...p,
      lint: p.proposed ? lintRunbook(p.proposed, lintCtx()) : [],
      ...extra,
    };
  }

  // ── Reads ──────────────────────────────────────────────────────────────────

  router.get('/', ...readGate, handler(async (req, res) => {
    const s = await store();
    const scopeKind = oneOf(SCOPE_KINDS, req.query['scope_kind'], 'scope_kind');
    const scopeRef = str(req.query['scope_ref']);
    const status = csv(STATUSES, req.query['status'], 'status') ?? ['draft', 'published'];
    const health = oneOf(['proven', 'drifting', 'unproven'] as const, req.query['health'], 'health');
    const q = str(req.query['q']);
    const cursor = str(req.query['cursor']);
    const limit = pageLimit(req.query['limit']);
    const page = await s.listRunbooks({
      ...(scopeKind ? { scope: { kind: scopeKind, ref: scopeKind === 'org' ? null : (scopeRef ?? null) } } : {}),
      status,
      ...(q ? { text: q } : {}),
      ...(cursor ? { cursor } : {}),
      ...(limit ? { limit } : {}),
    });
    const open = await openCounts(s);
    let rows = await Promise.all(page.items.map((r) => runbookRow(s, r, open.get(r.id) ?? 0)));
    if (health) rows = rows.filter((r) => r.health.status === health);
    res.json({ runbooks: rows, next: page.next });
  }));

  router.get('/proposals', ...readGate, handler(async (req, res) => {
    const s = await store();
    const status = csv(PROPOSAL_STATUSES, req.query['status'], 'status');
    const kind = oneOf(['new', 'edit', 'retire'] as const, req.query['kind'], 'kind');
    const runbookId = str(req.query['runbook_id']);
    const cursor = str(req.query['cursor']);
    const limit = pageLimit(req.query['limit']);
    const page = await s.listProposals({
      ...(status ? { status } : {}), ...(runbookId ? { runbook_id: runbookId } : {}),
      ...(cursor ? { cursor } : {}), ...(limit ? { limit } : {}),
    });
    const items = kind ? page.items.filter((p) => p.kind === kind) : page.items;
    res.json({ proposals: items.map((p) => proposalView(p)), next: page.next });
  }));

  router.get('/proposals/:pid', ...readGate, handler(async (req, res) => {
    const s = await store();
    const p = await s.getProposal(String(req.params['pid']));
    if (!p) { res.status(404).json({ error: 'proposal not found' }); return; }
    const target = await proposalTarget(s, p);
    const base = target && p.base_version !== null ? await s.getVersion(target.id, p.base_version) : null;
    const proposedMd = p.proposed ? versionOf({ runbook_id: p.runbook_id ?? 'new', version: 0, doc: p.proposed, author: { kind: 'person', id: '-' } }).markdown : '';
    const diff = p.kind === 'retire' ? null
      : unifiedDiff(base?.markdown ?? '', proposedMd, { from: base ? `${target!.id} v${base.version}` : '/dev/null', to: 'proposed' });
    const s0 = session(req);
    const verdict = await mayReviewRunbook(s0, target?.scope ?? { kind: 'org', ref: null }, target?.owner_person_id ?? null);
    const { actor, personId } = await actorId(s0);
    const mine = p.source.person_id !== undefined && (p.source.person_id === actor || p.source.person_id === personId);
    res.json({
      proposal: proposalView(p),
      runbook: target,
      base_markdown: base?.markdown ?? null,
      proposed_markdown: p.proposed ? proposedMd : null,
      diff,
      can_review: verdict.ok && !mine && p.status === 'open' && (await isAllowed(s0, 'ReviewRunbook')),
    });
  }));

  router.get('/:id', ...readGate, handler(async (req, res) => {
    const s = await store();
    const r = await s.getRunbook(String(req.params['id']));
    if (!r) { res.status(404).json({ error: 'runbook not found' }); return; }
    const v = await currentVersion(s, r);
    const open = (await s.listProposals({ status: ['open'], runbook_id: r.id, limit: 200 })).items.length;
    const s0 = session(req);
    const verdict = await mayReviewRunbook(s0, r.scope, r.owner_person_id);
    res.json({
      runbook: await runbookRow(s, r, open),
      current: v,
      can_review: verdict.ok && (await isAllowed(s0, 'ReviewRunbook')),
    });
  }));

  router.get('/:id/versions', ...readGate, handler(async (req, res) => {
    const s = await store();
    const id = String(req.params['id']);
    if (!(await s.getRunbook(id))) { res.status(404).json({ error: 'runbook not found' }); return; }
    const versions = await s.listVersions(id);
    res.json({ versions: versions.map(({ doc: _doc, ...v }) => v) });
  }));

  router.get('/:id/diff', ...readGate, handler(async (req, res) => {
    const s = await store();
    const r = await s.getRunbook(String(req.params['id']));
    if (!r) { res.status(404).json({ error: 'runbook not found' }); return; }
    const to = int(req.query['to']) ?? r.current_version;
    const from = int(req.query['from']) ?? to - 1;
    if (from < 1 || to < 1) throw new ValidationError('from and to must be version numbers of 1 or more');
    const [a, b] = await Promise.all([s.getVersion(r.id, from), s.getVersion(r.id, to)]);
    if (!a || !b) { res.status(404).json({ error: `version ${!a ? from : to} not found` }); return; }
    const d = unifiedDiff(a.markdown, b.markdown, { from: `${r.id} v${from}`, to: `${r.id} v${to}` });
    res.json({ runbook_id: r.id, from, to, from_sha256: a.sha256, to_sha256: b.sha256, diff: d.text, added: d.added, removed: d.removed });
  }));

  router.get('/:id/applications', ...readGate, handler(async (req, res) => {
    const s = await store();
    const id = String(req.params['id']);
    if (!(await s.getRunbook(id))) { res.status(404).json({ error: 'runbook not found' }); return; }
    const version = int(req.query['version']);
    res.json({ applications: await s.listApplications(id, version) });
  }));

  // ── Proposing ──────────────────────────────────────────────────────────────

  router.post('/proposals', callbackLimit, ...suggestGate, handler(async (req, res) => {
    const s = await store();
    const machine = res.locals['machine'] === true;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const kind = oneOf(['new', 'edit', 'retire'] as const, body['kind'], 'kind');
    if (!kind) throw new ValidationError('`kind` is required: new | edit | retire');
    const rationale = str(body['rationale']);
    if (!rationale) throw new ValidationError('`rationale` is required');
    const src = (body['source'] && typeof body['source'] === 'object' ? body['source'] : {}) as Record<string, unknown>;
    const labIds = Array.isArray(src['lab_experience_ids']) ? src['lab_experience_ids'].filter((x): x is string => typeof x === 'string') : [];

    // A person's work item must exist (work-item reads are open to every orgiq session, so existence is the read check).
    // A box's work item comes from its frozen brief, not the body.
    const workItemId = machine ? undefined : str(src['work_item_id']);
    if (workItemId && !await workItemExists(workItemId)) throw new ValidationError('`source.work_item_id` does not name a work item');

    // Attribution is never taken from the body for a person, and a machine is only ever a run.
    let source: RunbookProposal['source'];
    if (machine) {
      const runRef = str(src['run_ref']);
      if (!runRef) throw new ValidationError('a run proposal needs `source.run_ref`');
      // The fleet secret says "some box"; the run token says "the box running THIS run" (lib/run-token.ts).
      if (!(await runTokenMatches(req, runRef))) { refuseRunToken(res); return; }
      // A run proposal is attributed from the run's frozen brief, never the body: its work item, and
      // the person who dispatched it — who may then not accept it (decidable's SELF_ACCEPT).
      const brief = await s.getBrief(runRef);
      if (!brief) { res.status(409).json({ error: `no brief was frozen for run ${runRef}`, code: 'NO_BRIEF' }); return; }
      source = {
        kind: 'run', run_ref: runRef, lab_experience_ids: labIds,
        ...(str(src['session_id']) ? { session_id: str(src['session_id'])! } : {}),
        ...(brief.work_item_id ? { work_item_id: brief.work_item_id } : {}),
        ...(brief.dispatched_by ? { dispatched_by: brief.dispatched_by } : {}),
      };
    } else {
      if (refuseMasquerade(req, res)) return;
      const { actor } = await actorId(session(req));
      source = {
        kind: 'person', person_id: actor, lab_experience_ids: labIds,
        ...(str(src['work_item_id']) ? { work_item_id: str(src['work_item_id'])! } : {}),
      };
    }

    let runbookId: string | null = null;
    let baseVersion: number | null = null;
    let target: Runbook | null = null;
    if (kind !== 'new') {
      runbookId = str(body['runbook_id']) ?? null;
      if (!runbookId) throw new ValidationError('`runbook_id` is required for an edit or a retire');
      target = await s.getRunbook(runbookId);
      if (!target) { res.status(404).json({ error: 'runbook not found' }); return; }
      if (target.status === 'retired') { res.status(409).json({ error: `${target.id} is retired`, code: 'RETIRED' }); return; }
      baseVersion = int(body['base_version']) ?? target.current_version;
      if (baseVersion < 1 || baseVersion > target.current_version) throw new ValidationError(`base_version must be between 1 and ${target.current_version}`);
    } else if (body['runbook_id'] !== undefined && body['runbook_id'] !== null) {
      throw new ValidationError('a `new` proposal has no runbook_id');
    }

    let proposed: RunbookDoc | null = null;
    if (kind !== 'retire') {
      const md = typeof body['markdown'] === 'string' ? body['markdown'] : undefined;
      if (!md || !md.trim()) throw new ValidationError('`markdown` is required for a new runbook or an edit');
      if (md.length > 200_000) throw new ValidationError('`markdown` is too long');
      const parsed = tryParseRunbook(md);
      if (!parsed.ok) { res.status(422).json({ error: 'the runbook markdown does not parse', code: 'PARSE', problems: parsed.errors }); return; }
      proposed = parsed.doc;
      if (kind === 'edit') {
        const base = await s.getVersion(target!.id, baseVersion!);
        if (base && versionOf({ runbook_id: target!.id, version: base.version, doc: proposed, author: { kind: 'person', id: '-' } }).sha256 === base.sha256) {
          res.status(422).json({ error: 'the proposal changes nothing from the base version', code: 'NO_CHANGE' });
          return;
        }
      }
    }

    const lint: LintFinding[] = proposed ? lintRunbook(proposed, lintCtx()) : [];
    const similar = kind === 'new' && proposed
      ? findSimilar(proposed, { kind: 'org', ref: null }, (await loadCandidates(s, Date.parse(now()))).map((c) => ({ runbook_id: c.runbook.id, scope: c.runbook.scope, doc: c.version.doc })))
      : [];

    const proposal: RunbookProposal = {
      id: `prop-${randomUUID().slice(0, 12)}`,
      kind, runbook_id: runbookId, base_version: baseVersion, proposed, rationale, source,
      lint, similar, status: 'open', decided_by: null, decided_at: null, note: null, merged_into: null, created_at: now(),
    };
    await s.putProposal(proposal);
    res.status(201).json({ proposal: proposalView(proposal) });
  }));

  // ── Deciding ───────────────────────────────────────────────────────────────

  /** Load an OPEN proposal and prove the caller may decide it; sends the refusal and returns null otherwise. */
  async function decidable(req: Request, res: Response, s: RunbookStore, scopeOverride?: { scope: RunbookScope; owner: string | null }) {
    if (refuseMasquerade(req, res)) return null;
    const sess = session(req);
    const p = await s.getProposal(String(req.params['pid']));
    if (!p) { res.status(404).json({ error: 'proposal not found' }); return null; }
    if (p.status !== 'open') {
      res.status(409).json({ error: `proposal ${p.id} is already ${p.status}`, code: 'PROPOSAL_CLOSED', status: p.status });
      return null;
    }
    const { actor, personId } = await actorId(sess);
    if (p.source.kind === 'person' && p.source.person_id && (p.source.person_id === actor || p.source.person_id === personId || p.source.person_id === sess.sub)) {
      res.status(403).json({ error: 'you cannot decide your own proposal', code: 'SELF_ACCEPT' });
      return null;
    }
    // A run's proposal is its dispatcher's: whoever sent the box cannot accept what the box wrote.
    const dispatcher = p.source.kind === 'run' ? p.source.dispatched_by : undefined;
    if (dispatcher && (dispatcher === actor || dispatcher === personId || dispatcher === sess.sub)) {
      res.status(403).json({ error: 'you dispatched the run that proposed this; someone else decides it', code: 'SELF_ACCEPT' });
      return null;
    }
    const target = await proposalTarget(s, p);
    if (p.kind !== 'new' && !target) { res.status(404).json({ error: `runbook ${p.runbook_id} not found` }); return null; }
    if (scopeOverride) {
      const v = await mayReviewRunbook(sess, scopeOverride.scope, scopeOverride.owner);
      if (!v.ok) { deny(res, v); return null; }
    } else if (target) {
      const v = await mayReviewRunbook(sess, target.scope, target.owner_person_id);
      if (!v.ok) { deny(res, v); return null; }
    }
    return { sess, p, target, actor };
  }

  /** Validate a scope the reviewer names (for a `new` runbook). */
  function parseScope(raw: unknown): RunbookScope | null {
    if (!raw || typeof raw !== 'object') return null;
    const o = raw as Record<string, unknown>;
    const kind = oneOf(SCOPE_KINDS, o['kind'], 'scope.kind');
    if (!kind) return null;
    const ref = str(o['ref']) ?? null;
    if (kind === 'org') return { kind, ref: null };
    if (!ref) throw new ValidationError(`scope.ref is required for a ${kind} scope`);
    return { kind, ref };
  }

  router.post('/proposals/:pid/accept', ...reviewGate, handler(async (req, res) => {
    const s = await store();
    const body = (req.body ?? {}) as Record<string, unknown>;
    const note = str(body['note']) ?? null;
    const at = now();

    // `new` has no runbook yet: the reviewer names the scope, and is checked against IT.
    const peek = await s.getProposal(String(req.params['pid']));
    let newScope: RunbookScope | null = null;
    if (peek && peek.kind === 'new') {
      newScope = parseScope(body['scope']);
      if (!newScope && peek.source.work_item_id) {
        try {
          const { getWorkItem } = await import('../providers/work-items.js');
          const wi = await getWorkItem(peek.source.work_item_id);
          if (wi?.projectId) newScope = { kind: 'initiative', ref: wi.projectId };
        } catch { /* fall through to the 400 below */ }
      }
      if (!newScope) throw new ValidationError('a new runbook needs a `scope` ({ kind, ref }) — it names who may review it');
    }

    const d = await decidable(req, res, s, newScope ? { scope: newScope, owner: null } : undefined);
    if (!d) return;
    const { p, target, actor } = d;
    const provenance = {
      run_refs: p.source.run_ref ? [p.source.run_ref] : [],
      session_ids: p.source.session_id ? [p.source.session_id] : [],
      lab_experience_ids: p.source.lab_experience_ids,
    };
    const author: RunbookVersion['author'] = p.source.kind === 'person'
      ? { kind: 'person', id: p.source.person_id ?? 'unknown' }
      : { kind: 'run', id: p.source.run_ref ?? 'unknown' };

    // A runbook retired after this proposal was opened takes no more versions and no second retirement.
    if (target && target.status === 'retired') {
      res.status(409).json({ error: `${target.id} is retired`, code: 'RETIRED' });
      return;
    }

    if (p.kind === 'retire') {
      const reason = str(body['reason']) ?? p.rationale;
      const supersededBy = str(body['superseded_by']) ?? null;
      if (supersededBy) {
        const sup = await s.getRunbook(supersededBy);
        if (!sup || sup.status !== 'published' || sup.id === target!.id) throw new ValidationError('`superseded_by` must name another published runbook');
      }
      const result = await s.acceptProposal({
        proposal_id: p.id, decided_by: actor, at, note,
        retire: { reason, superseded_by: supersededBy },
      });
      res.json({ proposal: result.proposal, runbook: result.runbook, version: null });
      return;
    }

    // The reviewer saw some version; if it moved, they must rebase (409, not a silent overwrite).
    const expected = int(body['expected_version']);
    if (target && ((expected !== undefined && expected !== target.current_version) || p.base_version !== target.current_version)) {
      res.status(409).json({
        error: `proposal ${p.id} was written against v${p.base_version}; ${target.id} is at v${target.current_version}`,
        code: 'VERSION_CONFLICT', base_version: p.base_version, current_version: target.current_version,
      });
      return;
    }
    const doc = p.proposed!;
    const blocking = lintErrors(lintRunbook(doc, lintCtx()));
    if (blocking.length) { res.status(422).json({ error: 'the proposal has lint errors', code: 'LINT', findings: blocking }); return; }

    if (p.kind === 'edit') {
      const version = versionOf({ runbook_id: target!.id, version: target!.current_version + 1, doc, author, provenance });
      const result = await s.acceptProposal({ proposal_id: p.id, decided_by: actor, at, note, version });
      res.json({ proposal: result.proposal, runbook: result.runbook, version: result.version });
      return;
    }

    const ownerId = str(body['owner_person_id']);
    if (ownerId && !await personExists(ownerId)) throw new ValidationError('`owner_person_id` does not name a person');
    const id = str(body['id']) ?? slug(doc.title);
    if (!RUNBOOK_ID.test(id)) throw new ValidationError('`id` must look like rb-some-name (lowercase letters, digits, hyphens)');
    const runbook: Runbook = {
      id, scope: newScope!, owner_person_id: ownerId ?? actor, status: 'published',
      current_version: 1, created_at: at, updated_at: at,
    };
    const version = versionOf({ runbook_id: id, version: 1, doc, author, provenance });
    const result = await s.acceptProposal({ proposal_id: p.id, decided_by: actor, at, note, runbook, version });
    res.status(201).json({ proposal: result.proposal, runbook: result.runbook, version: result.version });
  }));

  router.post('/proposals/:pid/reject', ...reviewGate, handler(async (req, res) => {
    const s = await store();
    const note = str((req.body as Record<string, unknown> | undefined)?.['note']);
    if (!note) throw new ValidationError('a rejection needs a `note` saying why');
    const peek = await s.getProposal(String(req.params['pid']));
    // A `new` proposal has no scope yet: only the org-wide reviewers (or the initiative of its work item) may reject it.
    let override: { scope: RunbookScope; owner: string | null } | undefined;
    if (peek?.kind === 'new') override = { scope: await newProposalScope(peek), owner: null };
    const d = await decidable(req, res, s, override);
    if (!d) return;
    const proposal = await s.decideProposal({ proposal_id: d.p.id, decision: 'rejected', decided_by: d.actor, at: now(), note });
    res.json({ proposal });
  }));

  // The proposer pulls their own open proposal. Session-only (a run cannot withdraw), identity-bound like every
  // runbook write, so masquerade is refused; the reviewer's reject of one's own proposal stays blocked.
  router.post('/proposals/:pid/withdraw', requireTenant('orgiq'), requireSession('SuggestRunbook'), handler(async (req, res) => {
    if (refuseMasquerade(req, res)) return;
    const s = await store();
    const sess = session(req);
    const p = await s.getProposal(String(req.params['pid']));
    if (!p) { res.status(404).json({ error: 'proposal not found' }); return; }
    const { actor, personId } = await actorId(sess);
    if (p.source.kind !== 'person' || !p.source.person_id || ![actor, personId, sess.sub].includes(p.source.person_id)) {
      res.status(403).json({ error: 'only the proposer can withdraw a proposal', code: 'NOT_PROPOSER' });
      return;
    }
    if (p.status !== 'open') {
      res.status(409).json({ error: `proposal ${p.id} is already ${p.status}`, code: 'PROPOSAL_CLOSED', status: p.status });
      return;
    }
    const note = str((req.body as Record<string, unknown> | undefined)?.['note']) ?? null;
    const proposal = await s.decideProposal({ proposal_id: p.id, decision: 'withdrawn', decided_by: actor, at: now(), note });
    res.json({ proposal });
  }));

  async function newProposalScope(p: RunbookProposal): Promise<RunbookScope> {
    if (p.source.work_item_id) {
      try {
        const { getWorkItem } = await import('../providers/work-items.js');
        const wi = await getWorkItem(p.source.work_item_id);
        if (wi?.projectId) return { kind: 'initiative', ref: wi.projectId };
      } catch { /* org-wide reviewers only */ }
    }
    return { kind: 'org', ref: null };
  }

  router.post('/proposals/:pid/merge', ...reviewGate, handler(async (req, res) => {
    const s = await store();
    const body = (req.body ?? {}) as Record<string, unknown>;
    const into = str(body['into']);
    if (!into) throw new ValidationError('`into` (the runbook to merge this into) is required');
    const dest = await s.getRunbook(into);
    if (!dest) { res.status(404).json({ error: `runbook ${into} not found` }); return; }
    if (dest.status !== 'published') { res.status(409).json({ error: `${dest.id} is ${dest.status}; merge into a published runbook`, code: 'NOT_PUBLISHED' }); return; }
    // The reviewer must be able to review the TARGET, whatever the source says.
    const d = await decidable(req, res, s, { scope: dest.scope, owner: dest.owner_person_id });
    if (!d) return;
    const { p, actor, target: source } = d;
    // Merging closes the proposal on its own target, so it is a decision about THAT
    // runbook too: without this, a reviewer of any published runbook could close any
    // edit anywhere by merging it into their own.
    if (source) {
      const v = await mayReviewRunbook(d.sess, source.scope, source.owner_person_id);
      if (!v.ok) { deny(res, v); return; }
    }
    if (p.kind === 'retire' || !p.proposed) { res.status(409).json({ error: 'a retire proposal cannot be merged', code: 'NOT_MERGEABLE' }); return; }
    if (p.runbook_id === dest.id) { res.status(409).json({ error: 'this proposal already targets that runbook; accept it instead', code: 'SAME_TARGET' }); return; }

    const at = now();
    const edit: RunbookProposal = {
      ...p,
      id: `prop-${randomUUID().slice(0, 12)}`,
      kind: 'edit', runbook_id: dest.id, base_version: dest.current_version,
      rationale: `Merged from ${p.id}${p.runbook_id ? ` (was aimed at ${p.runbook_id})` : ' (a new runbook)'}: ${p.rationale}`,
      lint: lintRunbook(p.proposed, lintCtx()), similar: [],
      status: 'open', decided_by: null, decided_at: null, note: null, merged_into: null, created_at: at,
    };
    const merged = await s.decideProposal({
      proposal_id: p.id, decision: 'merged', decided_by: actor, at, note: str(body['note']) ?? null, merged_into: edit.id,
    });
    await s.putProposal(edit);
    res.status(201).json({ merged, proposal: proposalView(edit) });
  }));

  // ── Retiring ───────────────────────────────────────────────────────────────

  router.post('/:id/retire', ...reviewGate, handler(async (req, res) => {
    if (refuseMasquerade(req, res)) return;
    const s = await store();
    const sess = session(req);
    const r = await s.getRunbook(String(req.params['id']));
    if (!r) { res.status(404).json({ error: 'runbook not found' }); return; }
    const verdict = await mayReviewRunbook(sess, r.scope, r.owner_person_id);
    if (!verdict.ok) { deny(res, verdict); return; }
    if (r.status === 'retired') { res.status(409).json({ error: `${r.id} is already retired`, code: 'RETIRED' }); return; }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const reason = str(body['reason']);
    if (!reason) throw new ValidationError('retiring a runbook needs a `reason`');
    const supersededBy = str(body['superseded_by']) ?? null;
    if (supersededBy) {
      const sup = await s.getRunbook(supersededBy);
      if (!sup || sup.status !== 'published' || sup.id === r.id) throw new ValidationError('`superseded_by` must name another published runbook');
    }
    const { actor } = await actorId(sess);
    const at = now();
    const next: Runbook = { ...r, status: 'retired', updated_at: at, retired: { at, by: actor, reason, superseded_by: supersededBy } };
    await s.putRunbook(next, r.updated_at);
    res.json({ runbook: next });
  }));

  // ── Applications (a box reporting) ─────────────────────────────────────────

  router.post('/:id/applications', callbackLimit, requireLabAuth, handler(async (req, res) => {
    const s = await store();
    const r = await s.getRunbook(String(req.params['id']));
    if (!r) { res.status(404).json({ error: 'runbook not found' }); return; }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const runRef = str(body['run_ref']);
    if (!runRef) throw new ValidationError('`run_ref` is required');
    if (!(await runTokenMatches(req, runRef))) { refuseRunToken(res); return; }
    const outcome = oneOf(OUTCOMES, body['outcome'], 'outcome');
    if (!outcome) throw new ValidationError(`\`outcome\` is required: ${OUTCOMES.join(' | ')}`);
    const failedAt = body['failed_at_step'] === undefined || body['failed_at_step'] === null ? null : int(body['failed_at_step']);
    if (failedAt !== null && (failedAt === undefined || failedAt < 1)) throw new ValidationError('`failed_at_step` must be a step number of 1 or more');
    const note = str(body['note']);
    if (note && note.length > 1000) throw new ValidationError('`note` is too long (1000 characters)');

    // Health counts runs that were GIVEN this runbook; a report from a run whose frozen brief
    // does not include it would let anyone move another runbook's health.
    const brief = await s.getBrief(runRef);
    const given = brief?.sections.find((sec) => sec.kind === 'runbook' && sec.ref === r.id);
    if (!brief || !given) {
      res.status(409).json({ error: `run ${runRef} was not given ${r.id}`, code: 'NOT_GIVEN' });
      return;
    }
    const version = given.version ?? r.current_version;
    const claimed = int(body['version']);
    if (claimed !== undefined && claimed !== version) {
      res.status(409).json({ error: `run ${runRef} was given ${r.id} v${version}, not v${claimed}`, code: 'VERSION_MISMATCH' });
      return;
    }
    const prior = (await s.listApplications(r.id)).find((a) => a.run_ref === runRef);
    if (prior) { res.status(200).json({ application: prior, duplicate: true }); return; }

    const application: RunbookApplication = {
      id: `app-${createHash('sha256').update(`${runRef}|${r.id}`).digest('hex').slice(0, 12)}`,
      runbook_id: r.id, version, run_ref: runRef, brief_id: brief.id, outcome,
      failed_at_step: failedAt, note: note ?? null, at: now(),
    };
    await s.appendApplication(application);
    res.status(201).json({ application });
  }));

  return router;
}

export const runbooksRouter: Router = createRunbooksRouter({
  store: async () => (await import('../lib/runbooks/store-select.js')).runbookStore(),
});
