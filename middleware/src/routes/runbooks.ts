// Runbooks API.
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
//   POST /api/runbooks/proposals {kind:'restore'}  a retired runbook comes back only through review
//   POST /api/runbooks/:id/retire              ReviewRunbook + scope; names what superseded it
//   GET  /api/runbooks/:id/applications        runs that were given it and reported (?version=)
//   GET  /api/runbooks/evidence                the loop over 30 days, counted from run reports (lib/runbooks/evidence.ts)
//   GET  /api/runbooks/:id/evidence            one runbook over 30 days: given, followed as the runs said, outcomes, runs
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

import { noteSearchWriteSoon } from '../lib/search-index/writes.js';
import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { randomUUID, createHash } from 'node:crypto';
import { asyncHandler, ValidationError } from '../lib/async-handler.js';
import { isAllowed, requireAction, requireSession, requireTenant, resolveSession } from '../lib/authz.js';
import { rateLimit } from '../lib/rate-limit.js';
import { LAB_CALLBACK_SERVICE_AUTH, hasServiceAuth, requireServiceAuth } from '../lib/service-auth.js';
import { RUN_TOKEN_HEADER, runTokenMatches } from '../lib/run-token.js';
import type { Session } from '../lib/session.js';
import { REVIEW_OVERRIDE_ROLES, actorId, mayReviewRunbook, type ReviewVerdict } from '../lib/runbook-review.js';
import { notifyDecided, notifyFiled, newProposalScope, proposalArea, reviewableOpenCount, reviewScopeOf } from '../lib/runbooks/notices.js';
import { unifiedDiff } from '../lib/unified-diff.js';
import { loadCandidates } from '../lib/session-brief-preview.js';
import { proposalReach, providerReachSource, type ReachSource } from '../lib/runbooks/reach.js';
import { clock } from '../mock/core/clock.js';
import {
  findSimilar, lintErrors, lintRunbook, runbookHealth, versionOf,
  AlreadyExistsError, InvalidWriteError, NotFoundError as StoreNotFound, ProposalClosedError, RunbookStoreError,
  SelfAcceptError, VersionConflictError, RetiredRunbookError,
  type LintContext, type LintFinding, type Runbook, type RunbookApplication, type RunbookDoc, type RunbookProposal,
  type RunbookScope, type RunbookStore, type RunbookVersion, type SessionBrief,
} from '../lib/runbooks/index.js';
import { repoLintContext } from '../lib/runbooks/repo-context.js';
import { RunbookFileError, filesOf, fileManifest, parseSkill, skillDescription, type RunbookFile } from '../lib/runbooks/index.js';
import { filesUnifiedDiff } from '../lib/runbooks/files-diff.js';
import { loopEvidence, runbookEvidence, windowStart, EVIDENCE_WINDOW_DAYS } from '../lib/runbooks/evidence.js';
import type { RunReport } from '../lib/run-reports/types.js';
import type { RunReportStore } from '../lib/run-reports/store.js';
import { isExpired, PROPOSAL_EXPIRY_DAYS } from '../lib/runbooks/retire.js';
import { scopeEquals } from '../lib/runbooks/store.js';
import { eligibleReviewersExcept } from '../lib/runbook-review.js';

export interface RunbooksDeps {
  store: () => RunbookStore | Promise<RunbookStore>;
  /** The run report store the evidence reads count from (lib/run-reports/store-select.ts); injected by suites. */
  reports?: () => RunReportStore | Promise<RunReportStore>;
  /** A work item's labels for the evidence comparison (providers/work-items.ts); injected by suites. */
  workItemLabels?: (workItemId: string) => Promise<string[] | null>;
  /** Where a proposal's reach reads open work from (lib/runbooks/reach.ts); injected by suites. */
  reachSource?: () => ReachSource | Promise<ReachSource>;
}

/** Every report that ended at or after `since`, newest first (the store lists newest first, so the walk stops early). */
async function reportsSince(reports: RunReportStore, since: string): Promise<RunReport[]> {
  const out: RunReport[] = [];
  let cursor: string | undefined;
  do {
    const page = await reports.listReports({ limit: 200, ...(cursor ? { cursor } : {}) });
    for (const r of page.items) {
      if (r.endedAt < since) return out;
      out.push(r);
    }
    cursor = page.next ?? undefined;
  } while (cursor);
  return out;
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
  void hasServiceAuth(req, LAB_CALLBACK_SERVICE_AUTH).then((ok) => {
    if (ok) res.locals['machine'] = true;
    next();
  }, next);
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

/** The lint context for a proposal: the tree, its files, and the skill it becomes (its name; collisions are judged at write time). */
function lintFor(
  files: readonly RunbookFile[] | undefined, name: string | null, others?: Array<{ name: string; description: string }>,
  frontmatter?: readonly string[],
): LintContext {
  return { ...(lintCtx() ?? {}), files: files ?? [], skill: { name, ...(others ? { others } : {}) }, ...(frontmatter ? { frontmatter } : {}) };
}

/** Every skill a new one must not collide with: the library's (published runbooks). Runbook ids carry the `rb-` prefix, which no other skill on a box does. */
async function otherSkills(s: RunbookStore): Promise<Array<{ name: string; description: string }>> {
  const lib = (await loadCandidates(s, Date.parse(clock.nowIso()))).map((c) => ({ name: c.runbook.id, description: skillDescription(c.version.doc) }));
  return lib;
}

/** A proposal's list view: files as a manifest, lint re-run. */
function proposalView(p: RunbookProposal, extra: Record<string, unknown> = {}) {
  // A list shows what files a proposal carries, not their bytes; the detail route adds the diff.
  const { proposed_files: files, ...rest } = p;
  return {
    ...rest,
    ...(files ? { proposed_files: fileManifest(files) } : {}),
    lint: p.proposed ? lintRunbook(p.proposed, lintFor(files, p.runbook_id ?? p.proposed_id ?? null, undefined, p.proposed_frontmatter_keys)) : [],
    // Lane C: a run-authored proposal nobody decided in fourteen days is withdrawn when the next report is saved; until then it reads as expired.
    expired: isExpired(p, Date.parse(clock.nowIso())),
    ...extra,
  };
}

/** A repository reference as a runbook scope ref: owner/name, whatever URL form the run carried. */
export function repoScopeRef(repo: string | null | undefined): string | null {
  if (!repo || typeof repo !== 'string') return null;
  const m = /^(?:https?:\/\/[^/]+\/|git@[^:]+:|ssh:\/\/[^/]+\/)?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(repo.trim());
  return m ? m[1]! : null;
}

/** A run-authored runbook's default scope (decision 8): the run's repository, else its initiative. Never the organisation. */
export function runAuthoredScope(input: { repo?: string | null; initiativeId?: string | null }): RunbookScope | null {
  const repo = repoScopeRef(input.repo);
  if (repo) return { kind: 'repo', ref: repo };
  if (input.initiativeId) return { kind: 'initiative', ref: input.initiativeId };
  return null;
}

/** The scripts a version carries that its base did not carry byte for byte: what a reviewer must confirm reading. */
export function scriptsToRead(files: readonly RunbookFile[], baseFiles: readonly RunbookFile[]): RunbookFile[] {
  return files.filter((f) => f.path.startsWith('scripts/') && !baseFiles.some((b) => b.path === f.path && b.sha256 === f.sha256));
}

/** How a run-authored proposal is filed (lane C): narrow scope, near duplicates as edits, and (for a debrief) lint as the gate. */
export interface RunAuthoredOptions {
  scope: RunbookScope;
  /** The run's initiative: its runbooks are near-duplicate candidates even when the scope is the repository. */
  initiativeId?: string | null;
  /** A lint error refuses the proposal (422 LINT, nothing stored) instead of storing it for a person to see. */
  refuseOnLint: boolean;
  /** A `new` proposal close to a published runbook is filed as an `edit` of it. */
  convertNearDuplicate: boolean;
  debrief?: RunbookProposal['debrief'];
}

/** What filing a proposal answered: the HTTP status and body the route sends, and the proposal when one was stored. */
export interface ProposeResult { status: number; body: Record<string, unknown>; proposal?: RunbookProposal }

/**
 * File one proposal from a request body whose `source` is already decided (a person's session,
 * or a run's frozen brief). The proposals route and the local-compute completion (a local run's
 * kept skill folders, the same body `lab keep` posts) both come through here, so a kept folder
 * from a laptop meets exactly the checks a devbox's does: files first, parse, lint, dedupe, and
 * nothing reaches the library until a person accepts it. Throws ValidationError for a 400.
 */
export async function fileProposal(
  s: RunbookStore, body: Record<string, unknown>, source: RunbookProposal['source'], runAuthored?: RunAuthoredOptions,
): Promise<ProposeResult> {
  let kind = oneOf(['new', 'edit', 'retire', 'restore'] as const, body['kind'], 'kind');
  if (!kind) throw new ValidationError('`kind` is required: new | edit | retire | restore');
  const rationale = str(body['rationale']);
  if (!rationale) throw new ValidationError('`rationale` is required');
  // Bringing a retired runbook back is a person's call; a run or a box never files one.
  if (kind === 'restore' && source.kind !== 'person') {
    return { status: 403, body: { error: 'only a person proposes restoring a retired runbook', code: 'PERSON_ONLY' } };
  }

  let runbookId: string | null = null;
  let baseVersion: number | null = null;
  let target: Runbook | null = null;
  if (kind !== 'new') {
    runbookId = str(body['runbook_id']) ?? null;
    if (!runbookId) throw new ValidationError('`runbook_id` is required for an edit, a retire or a restore');
    target = await s.getRunbook(runbookId);
    if (!target) return { status: 404, body: { error: 'runbook not found' } };
    if (kind === 'restore') {
      if (target.status !== 'retired') return { status: 409, body: { error: `${target.id} is not retired`, code: 'NOT_RETIRED' } };
    } else if (target.status === 'retired') return { status: 409, body: { error: `${target.id} is retired`, code: 'RETIRED' } };
    baseVersion = int(body['base_version']) ?? target.current_version;
    if (baseVersion < 1 || baseVersion > target.current_version) throw new ValidationError(`base_version must be between 1 and ${target.current_version}`);
  } else if (body['runbook_id'] !== undefined && body['runbook_id'] !== null) {
    throw new ValidationError('a `new` proposal has no runbook_id');
  }

  let proposed: RunbookDoc | null = null;
  let proposedFiles: RunbookFile[] | undefined;
  let proposedId: string | undefined;
  let frontmatterKeys: string[] = [];
  let convertedFrom: string | null = null;
  if (kind === 'new' || kind === 'edit') {
    // Either canonical runbook markdown (`lab propose`) or a SKILL.md-shaped draft (`lab keep`, R8):
    // frontmatter name + description, then the same canonical body.
    // Files first, before any parsing — they are untrusted input: safe paths only, text only, capped per file and per bundle (lib/runbooks/files.ts).
    if (body['files'] !== undefined) {
      try { proposedFiles = filesOf(body['files']); } catch (e) {
        if (e instanceof RunbookFileError) return { status: 422, body: { error: 'the files are not acceptable', code: 'FILES', problems: e.problems } };
        throw e;
      }
    }
    const md = typeof body['markdown'] === 'string' ? body['markdown'] : typeof body['skill_md'] === 'string' ? body['skill_md'] : undefined;
    if (!md || !md.trim()) throw new ValidationError('`markdown` (or `skill_md`) is required for a new runbook or an edit');
    if (md.length > 200_000) throw new ValidationError('`markdown` is too long');
    const parsed = parseSkill(md);
    if (!parsed.ok) return { status: 422, body: { error: 'the runbook markdown does not parse', code: 'PARSE', problems: parsed.errors } };
    proposed = parsed.doc;
    frontmatterKeys = parsed.keys;
    if (kind === 'new' && parsed.name) {
      if (!RUNBOOK_ID.test(parsed.name)) throw new ValidationError('the draft\'s `name` must look like rb-some-name (lowercase letters, digits, hyphens)');
      proposedId = parsed.name;
    }
    // Lane C (decision 9): a run's new runbook that reads like a published one is filed as an EDIT
    // of it, so the reviewer sees a diff and the library does not grow by copies.
    if (kind === 'new' && runAuthored?.convertNearDuplicate) {
      // Against every published runbook the run could have been given: org-wide, its initiative, its repository.
      const reach = (sc: RunbookScope) => sc.kind === 'org' || scopeEquals(sc, runAuthored.scope)
        || (sc.kind === 'initiative' && !!runAuthored.initiativeId && sc.ref === runAuthored.initiativeId);
      const candidates = (await loadCandidates(s, Date.parse(clock.nowIso())))
        .filter((c) => reach(c.runbook.scope))
        .map((c) => ({ runbook_id: c.runbook.id, scope: c.runbook.scope, doc: c.version.doc }));
      const near = findSimilar(proposed, { kind: 'org', ref: null }, candidates)[0];
      if (near) {
        const t = await s.getRunbook(near.runbook_id);
        if (t && t.status === 'published') {
          kind = 'edit'; target = t; runbookId = t.id; baseVersion = t.current_version; convertedFrom = t.id; proposedId = undefined;
        }
      }
    }
    if (kind === 'edit') {
      const base = await s.getVersion(target!.id, baseVersion!);
      // An edit that sends no `files` keeps the base's; `files: []` removes them.
      if (proposedFiles === undefined && base?.files?.length) proposedFiles = base.files;
      const next = versionOf({ runbook_id: target!.id, version: baseVersion!, doc: proposed, author: { kind: 'person', id: '-' }, files: proposedFiles ?? [] });
      if (base && (next.bundle_sha256 ?? next.sha256) === (base.bundle_sha256 ?? base.sha256)) {
        return { status: 422, body: { error: 'the proposal changes nothing from the base version', code: 'NO_CHANGE' } };
      }
    }
  }

  const others = proposed ? await otherSkills(s) : [];
  const lint: LintFinding[] = proposed
    ? lintRunbook(proposed, lintFor(proposedFiles, runbookId ?? proposedId ?? slug(proposed.title), others, frontmatterKeys))
    : [];
  // Lane C: what a debrief wrote enters the queue only when it passes lint; the errors go on the run instead.
  if (runAuthored?.refuseOnLint && lintErrors(lint).length) {
    return { status: 422, body: { error: 'the runbook has lint errors', code: 'LINT', findings: lintErrors(lint) } };
  }
  const similar = kind === 'new' && proposed
    ? findSimilar(proposed, runAuthored?.scope ?? { kind: 'org', ref: null }, (await loadCandidates(s, Date.parse(clock.nowIso()))).map((c) => ({ runbook_id: c.runbook.id, scope: c.runbook.scope, doc: c.version.doc })))
    : [];

  // A person who writes a runbook by hand may say where it should apply: a repository or an initiative.
  // It is a request the reviewer sees and confirms at accept, never a grant; the area checks there still apply.
  let personScope: RunbookScope | null = null;
  if (kind === 'new' && source.kind === 'person' && body['scope'] !== undefined && body['scope'] !== null) {
    const raw = body['scope'] as Record<string, unknown>;
    const sk = raw && typeof raw === 'object' ? raw['kind'] : undefined;
    const ref = raw && typeof raw === 'object' ? str(raw['ref']) : undefined;
    if ((sk !== 'repo' && sk !== 'initiative') || !ref || ref.length > 200) {
      throw new ValidationError('`scope` must be { kind: "repo" | "initiative", ref } with a ref of at most 200 characters');
    }
    personScope = { kind: sk, ref };
  }

  const proposal: RunbookProposal = {
    id: `prop-${randomUUID().slice(0, 12)}`,
    kind, runbook_id: runbookId, base_version: baseVersion, proposed, rationale, source,
    ...(proposedFiles ? { proposed_files: proposedFiles } : {}),
    ...(proposedId ? { proposed_id: proposedId } : {}),
    lint, similar, status: 'open', decided_by: null, decided_at: null, note: null, merged_into: null, created_at: clock.nowIso(),
    ...(frontmatterKeys.length ? { proposed_frontmatter_keys: frontmatterKeys } : {}),
    ...(runAuthored && kind === 'new' ? { proposed_scope: runAuthored.scope } : personScope ? { proposed_scope: personScope } : {}),
    ...(runAuthored?.debrief ? { debrief: { ...runAuthored.debrief, converted_from_new: convertedFrom !== null } } : {}),
  };
  await s.putProposal(proposal);
  noteSearchWriteSoon({ type: 'proposal', id: proposal.id });
  // Tell the people who may review it; best effort, never part of the filing's outcome.
  await notifyFiled(s, proposal);
  return { status: 201, body: { proposal: proposalView(proposal), ...(convertedFrom ? { converted_from_new: convertedFrom } : {}) }, proposal };
}

/** A run proposal's source, attributed from the run's frozen brief (never the body). */
export function runProposalSource(brief: Pick<SessionBrief, 'work_item_id'> & { dispatched_by?: string | null }, runRef: string, src: Record<string, unknown>): RunbookProposal['source'] {
  const labIds = Array.isArray(src['lab_experience_ids']) ? src['lab_experience_ids'].filter((x): x is string => typeof x === 'string') : [];
  return {
    kind: 'run', run_ref: runRef, lab_experience_ids: labIds,
    ...(str(src['session_id']) ? { session_id: str(src['session_id'])! } : {}),
    ...(brief.work_item_id ? { work_item_id: brief.work_item_id } : {}),
    ...(brief.dispatched_by ? { dispatched_by: brief.dispatched_by } : {}),
  };
}

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
    const kind = oneOf(['new', 'edit', 'retire', 'restore'] as const, req.query['kind'], 'kind');
    const runbookId = str(req.query['runbook_id']);
    const cursor = str(req.query['cursor']);
    const limit = pageLimit(req.query['limit']);
    // An initiative narrows the same list the caller may already read: a proposal belongs to it when its
    // proposed scope, its target runbook's scope or its area resolves to that initiative.
    const initiative = str(req.query['initiative']);
    if (initiative) {
      const mine: RunbookProposal[] = [];
      let next: string | undefined;
      do {
        const part = await s.listProposals({ ...(status ? { status } : {}), ...(runbookId ? { runbook_id: runbookId } : {}), ...(next ? { cursor: next } : {}) });
        for (const p of part.items) {
          if (kind && p.kind !== kind) continue;
          const rs = await reviewScopeOf(s, p);
          // A person's requested initiative lists here too, though it does not choose the reviewers.
          const asked = p.proposed_scope?.kind === 'initiative' && p.proposed_scope.ref === initiative;
          if (asked || (rs && ((rs.scope.kind === 'initiative' && rs.scope.ref === initiative) || rs.area === initiative))) mine.push(p);
        }
        next = part.next ?? undefined;
      } while (next);
      res.json({ proposals: mine.slice(0, limit ?? 200).map((p) => proposalView(p)), next: null });
      return;
    }
    const page = await s.listProposals({
      ...(status ? { status } : {}), ...(runbookId ? { runbook_id: runbookId } : {}),
      ...(cursor ? { cursor } : {}), ...(limit ? { limit } : {}),
    });
    const items = kind ? page.items.filter((p) => p.kind === kind) : page.items;
    res.json({ proposals: items.map((p) => proposalView(p)), next: page.next });
  }));

  /** The rail's number: open proposals this caller may decide now (their own and expired ones excluded). */
  router.get('/proposals/review-count', ...readGate, handler(async (req, res) => {
    const sess = session(req);
    const { actor, personId } = await actorId(sess);
    res.json({ count: await reviewableOpenCount(await store(), sess, actor, personId, Date.parse(now())) });
  }));

  router.get('/proposals/:pid', ...readGate, handler(async (req, res) => {
    const s = await store();
    const p = await s.getProposal(String(req.params['pid']));
    if (!p) { res.status(404).json({ error: 'proposal not found' }); return; }
    const target = await proposalTarget(s, p);
    const base = target && p.base_version !== null ? await s.getVersion(target.id, p.base_version) : null;
    const proposedMd = p.proposed ? versionOf({ runbook_id: p.runbook_id ?? 'new', version: 0, doc: p.proposed, author: { kind: 'person', id: '-' } }).markdown : '';
    const diff = (p.kind === 'retire' || p.kind === 'restore') ? null
      : unifiedDiff(base?.markdown ?? '', proposedMd, { from: base ? `${target!.id} v${base.version}` : '/dev/null', to: 'proposed' });
    const s0 = session(req);
    const verdict = await mayReviewRunbook(s0, target?.scope ?? (p.kind === 'new' ? await newProposalScope(p) : { kind: 'org', ref: null }), target?.owner_person_id ?? null, target ? (target.area ?? null) : await proposalArea(p));
    const { actor, personId } = await actorId(s0);
    const mine = p.source.person_id !== undefined && (p.source.person_id === actor || p.source.person_id === personId);
    // R8: what the proposal does to the files the runbook carries, as text (the portal never executes it).
    const baseFiles = base?.files ?? [];
    const proposedFiles = p.proposed_files ?? ((p.kind === 'retire' || p.kind === 'restore') ? [] : baseFiles);
    const fd = (p.kind === 'retire' || p.kind === 'restore') ? null : filesUnifiedDiff(baseFiles, proposedFiles);
    // Who would receive it: the open work items the selector would give this text to at the proposed scope.
    // Read from the same providers as the work-item reads, which any orgiq member may make (this route is orgiq-gated).
    let reach: Awaited<ReturnType<typeof proposalReach>> = null;
    if (s0 && (s0.tenant === 'orgiq' || s0.role === 'admin')) { // the same test requireTenant('orgiq') applies to the work-item reads
      try {
      const targetVersion = target ? await s.getVersion(target.id, target.current_version) : null;
      reach = await proposalReach({
        proposal: p, target,
        newScope: p.proposed_scope ?? await newProposalScope(p),
        candidates: await loadCandidates(s, Date.parse(clock.nowIso())),
        targetVersion,
        source: deps.reachSource ? await deps.reachSource() : await providerReachSource(),
      });
      } catch (e) {
        // The reach is a read for the reviewer, not part of deciding: a failed lookup leaves it out rather than the page.
        console.warn('[runbooks] could not compute the proposal reach:', (e as Error).message);
      }
    }
    res.json({
      reach,
      proposal: proposalView(p),
      runbook: target,
      base_markdown: base?.markdown ?? null,
      proposed_markdown: p.proposed ? proposedMd : null,
      diff,
      proposed_files: (p.kind === 'retire' || p.kind === 'restore') ? [] : proposedFiles,
      files_diff: fd,
      // Lane C: the scripts the reviewer must confirm reading (accept's `scripts_read`), by path and sha256.
      scripts_to_read: (p.kind === 'retire' || p.kind === 'restore') ? [] : scriptsToRead(proposedFiles, baseFiles).map((f) => ({ path: f.path, sha256: f.sha256 })),
      can_review: verdict.ok && !mine && p.status === 'open' && (await isAllowed(s0, 'ReviewRunbook')),
    });
  }));

  // ── Evidence (docs/learning-loop-design.md stage 5) ──────────────────────
  // Counted from run-report rows at read time, over the last 30 days, with the sample sizes;
  // no figure is stored apart from its rows. Same access as every other runbook read.
  const reportStore = async (): Promise<RunReportStore> =>
    deps.reports ? deps.reports() : (await import('../lib/run-reports/store-select.js')).runReportStore();
  const labelsOf = async (id: string): Promise<string[] | null> => {
    if (deps.workItemLabels) return deps.workItemLabels(id);
    const { getWorkItem } = await import('../providers/work-items.js');
    return (await getWorkItem(id))?.labels ?? null;
  };

  router.get('/evidence', ...readGate, handler(async (_req, res) => {
    const s = await store();
    const nowMs = Date.parse(now());
    const rows = await reportsSince(await reportStore(), windowStart(nowMs));
    const proposals: RunbookProposal[] = [];
    let cursor: string | undefined;
    do {
      const page = await s.listProposals({ limit: 200, ...(cursor ? { cursor } : {}) });
      proposals.push(...page.items);
      cursor = page.next ?? undefined;
    } while (cursor);
    res.json({ evidence: loopEvidence(rows, proposals, { nowMs }) });
  }));

  router.get('/:id/evidence', ...readGate, handler(async (req, res) => {
    const s = await store();
    const r = await s.getRunbook(String(req.params['id']));
    if (!r) { res.status(404).json({ error: 'runbook not found' }); return; }
    const nowMs = Date.parse(now());
    const rows = await reportsSince(await reportStore(), windowStart(nowMs, EVIDENCE_WINDOW_DAYS));
    // Labels only for the work items the comparison can read: the window's runs.
    const ids = [...new Set(rows.flatMap((x) => (x.workItemId ? [x.workItemId] : [])))];
    const labels = new Map<string, string[]>();
    for (const id of ids) {
      const l = await labelsOf(id);
      if (l) labels.set(id, l);
    }
    res.json({ evidence: runbookEvidence(r.id, rows, { nowMs, labelsOf: labels }), health: await healthOf(s, r) });
  }));

  router.get('/:id', ...readGate, handler(async (req, res) => {
    const s = await store();
    const r = await s.getRunbook(String(req.params['id']));
    if (!r) { res.status(404).json({ error: 'runbook not found' }); return; }
    const v = await currentVersion(s, r);
    const open = (await s.listProposals({ status: ['open'], runbook_id: r.id, limit: 200 })).items.length;
    const s0 = session(req);
    const verdict = await mayReviewRunbook(s0, r.scope, r.owner_person_id, r.area ?? null);
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
    res.json({ versions: versions.map(({ doc: _doc, files, ...v }) => ({ ...v, ...(files ? { files: fileManifest(files) } : {}) })) });
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
    // Shape errors before attribution, as before: an unknown kind or no rationale is a 400 for anyone.
    const kind = oneOf(['new', 'edit', 'retire', 'restore'] as const, body['kind'], 'kind');
    if (!kind) throw new ValidationError('`kind` is required: new | edit | retire | restore');
    if (!str(body['rationale'])) throw new ValidationError('`rationale` is required');
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
      source = runProposalSource(brief, runRef, src);
    } else {
      if (refuseMasquerade(req, res)) return;
      const { actor } = await actorId(session(req));
      source = {
        kind: 'person', person_id: actor, lab_experience_ids: labIds,
        ...(str(src['work_item_id']) ? { work_item_id: str(src['work_item_id'])! } : {}),
      };
    }

    const out = await fileProposal(s, body, source);
    res.status(out.status).json(out.body);
  }));

  // ── Deciding ───────────────────────────────────────────────────────────────

  /** Load an OPEN proposal and prove the caller may decide it; sends the refusal and returns null otherwise. */
  async function decidable(req: Request, res: Response, s: RunbookStore, scopeOverride?: { scope: RunbookScope; owner: string | null; area?: string | null }) {
    if (refuseMasquerade(req, res)) return null;
    const sess = session(req);
    const p = await s.getProposal(String(req.params['pid']));
    if (!p) { res.status(404).json({ error: 'proposal not found' }); return null; }
    if (p.status !== 'open') {
      res.status(409).json({ error: `proposal ${p.id} is already ${p.status}`, code: 'PROPOSAL_CLOSED', status: p.status });
      return null;
    }
    // Lane C: a run-authored proposal nobody decided in fourteen days is withdrawn, not decided late.
    if (isExpired(p, Date.parse(now()))) {
      await s.decideProposal({
        proposal_id: p.id, decision: 'withdrawn', decided_by: 'system', at: now(), closed_reason: 'expired',
        note: `Expired: nobody decided it in ${PROPOSAL_EXPIRY_DAYS} days.`,
      }).catch(() => undefined);
      res.status(409).json({ error: `proposal ${p.id} expired: nobody decided it in ${PROPOSAL_EXPIRY_DAYS} days`, code: 'EXPIRED' });
      return null;
    }
    const { actor, personId } = await actorId(sess);
    if (p.source.kind === 'person' && p.source.person_id && (p.source.person_id === actor || p.source.person_id === personId || p.source.person_id === sess.sub)) {
      res.status(403).json({ error: 'you cannot decide your own proposal', code: 'SELF_ACCEPT' });
      return null;
    }
    const target = await proposalTarget(s, p);
    if (p.kind !== 'new' && !target) { res.status(404).json({ error: `runbook ${p.runbook_id} not found` }); return null; }
    const reviewScope = scopeOverride ?? (target ? { scope: target.scope, owner: target.owner_person_id, area: target.area ?? null } : null);
    // A run's proposal is its dispatcher's: whoever sent the box cannot accept what the box wrote —
    // unless nobody else could (decision 11): then the dispatcher decides, and the record says so.
    let soleReviewer = false;
    const dispatcher = p.source.kind === 'run' ? p.source.dispatched_by : undefined;
    if (dispatcher && (dispatcher === actor || dispatcher === personId || dispatcher === sess.sub)) {
      const others = reviewScope
        ? await eligibleReviewersExcept(reviewScope.scope, reviewScope.owner, reviewScope.area ?? null, [actor, personId, sess.sub, dispatcher])
        : 1;
      if (others > 0) {
        res.status(403).json({ error: 'you dispatched the run that proposed this; someone else decides it', code: 'SELF_ACCEPT', other_reviewers: others });
        return null;
      }
      soleReviewer = true;
    }
    if (reviewScope) {
      const v = await mayReviewRunbook(sess, reviewScope.scope, reviewScope.owner, reviewScope.area ?? null);
      if (!v.ok) { deny(res, v); return null; }
    }
    return { sess, p, target, actor, soleReviewer };
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
    if (peek && peek.kind === 'new' && peek.proposed_scope) {
      // Lane C (decision 8): a run-authored runbook lands at the run's repository or initiative.
      // Any other scope is a widening the reviewer confirms separately (`widen_scope: true`), and
      // organisation-wide only by an org-leader or admin.
      const asked = parseScope(body['scope']);
      newScope = asked ?? peek.proposed_scope;
      if (asked && !scopeEquals(asked, peek.proposed_scope)) {
        if (body['widen_scope'] !== true) {
          res.status(409).json({
            error: `this runbook ${peek.source.kind === 'run' ? 'came from a run and is scoped' : 'was proposed for'} ${peek.source.kind === 'run' ? 'to ' : ''}${peek.proposed_scope.kind} ${peek.proposed_scope.ref ?? ''}`.trim() + '; confirm the different scope with `widen_scope: true`',
            code: 'WIDEN_UNCONFIRMED', proposed_scope: peek.proposed_scope,
          });
          return;
        }
        const sess0 = resolveSession(req);
        if (asked.kind === 'org' && (!sess0 || !(REVIEW_OVERRIDE_ROLES as readonly string[]).includes(sess0.role))) {
          res.status(403).json({ error: 'only an org-leader can make a runbook from a run organisation-wide', code: 'OUT_OF_SCOPE', action: 'ReviewRunbook' });
          return;
        }
      }
    } else if (peek && peek.kind === 'new') {
      newScope = parseScope(body['scope']);
      // A captured tool (a draft carrying files) is a cross-project skill: org scope unless the reviewer says otherwise.
      if (!newScope && peek.proposed_files?.length) newScope = { kind: 'org', ref: null };
      if (!newScope) {
        const inferred = await newProposalScope(peek);
        if (inferred.kind === 'initiative') newScope = inferred;
      }
      if (!newScope) throw new ValidationError('a new runbook needs a `scope` ({ kind, ref }) — it names who may review it');
    }

    const area = peek?.kind === 'new' ? await proposalArea(peek) : null;
    // A new runbook's initiative is where it came from, not where a reviewer would like it: naming an
    // initiative other than the proposal's area would let any SME make themselves its steward. Only an
    // override role (org-leader, admin) places a new runbook on an initiative it did not come from.
    if (peek?.kind === 'new' && newScope?.kind === 'initiative' && newScope.ref !== area) {
      const sess0 = resolveSession(req);
      if (!sess0 || !(REVIEW_OVERRIDE_ROLES as readonly string[]).includes(sess0.role)) {
        res.status(403).json({
          error: area
            ? `this proposal came from ${area}; only an org-leader can place it on ${newScope.ref}`
            : `this proposal has no area (no work item on an initiative its proposer works on); only an org-leader can place it on ${newScope.ref}`,
          code: 'OUT_OF_SCOPE', action: 'ReviewRunbook',
        });
        return;
      }
    }
    const d = await decidable(req, res, s, newScope ? { scope: newScope, owner: null, area } : undefined);
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

    if (p.kind === 'restore') {
      if (!target || target.status !== 'retired') { res.status(409).json({ error: `${p.runbook_id} is not retired`, code: 'NOT_RETIRED' }); return; }
      const result = await s.acceptProposal({ proposal_id: p.id, decided_by: actor, at, note });
      noteSearchWriteSoon({ type: 'knowledge', id: result.runbook.id }, { type: 'proposal', id: p.id });
      await notifyDecided(result.proposal, 'accepted', [actor, d.sess.sub]);
      res.json({ proposal: result.proposal, runbook: result.runbook, version: null });
      return;
    }

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
      noteSearchWriteSoon({ type: 'knowledge', id: result.runbook.id }, { type: 'proposal', id: p.id });
      await notifyDecided(result.proposal, 'accepted', [actor, d.sess.sub]);
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
    const baseFiles = p.kind === 'edit' ? (await s.getVersion(target!.id, target!.current_version))?.files ?? [] : [];
    const files = p.proposed_files ?? baseFiles;
    const acceptName = p.kind === 'edit' ? target!.id : (str(body['id']) ?? p.proposed_id ?? slug(doc.title));
    const blocking = lintErrors(lintRunbook(doc, lintFor(files, acceptName, await otherSkills(s), p.proposed_frontmatter_keys)));
    if (blocking.length) { res.status(422).json({ error: 'the proposal has lint errors', code: 'LINT', findings: blocking }); return; }

    // Lane C (decision 10): a script runs on future machines, so a version that carries a script it
    // did not carry before (new, or changed) is accepted only when the reviewer confirms they read
    // each one, by path AND the sha256 of the bytes they were shown (GET /proposals/:pid returns
    // both). A tick without the bytes' hash is not a confirmation.
    const unread = scriptsToRead(files, baseFiles);
    if (unread.length) {
      const claimed = Array.isArray(body['scripts_read']) ? body['scripts_read'] as unknown[] : [];
      const ok = (f: RunbookFile) => claimed.some((c) => !!c && typeof c === 'object'
        && (c as Record<string, unknown>)['path'] === f.path && (c as Record<string, unknown>)['sha256'] === f.sha256);
      const missing = unread.filter((f) => !ok(f));
      if (missing.length) {
        res.status(409).json({
          error: `confirm you read ${missing.length === 1 ? 'the script' : `all ${missing.length} scripts`} before accepting: ${missing.map((f) => f.path).join(', ')}`,
          code: 'SCRIPTS_UNREAD', scripts: missing.map((f) => ({ path: f.path, sha256: f.sha256 })),
        });
        return;
      }
    }
    if (unread.length || d.soleReviewer) {
      await s.putProposal({
        ...p,
        ...(unread.length ? { scripts_read: { by: actor, at, files: unread.map((f) => ({ path: f.path, sha256: f.sha256 })) } } : {}),
        ...(d.soleReviewer ? { decided_as: 'sole-reviewer-dispatcher' as const } : {}),
      });
    }
    const stamp = {
      ...(d.soleReviewer ? { accepted_as: 'sole-reviewer-dispatcher' as const } : {}),
      ...(p.debrief?.simulated ? { demo_data: true } : {}),
    };

    if (p.kind === 'edit') {
      const version = { ...versionOf({ runbook_id: target!.id, version: target!.current_version + 1, doc, author, provenance, files }), ...stamp };
      const result = await s.acceptProposal({ proposal_id: p.id, decided_by: actor, at, note, version });
      noteSearchWriteSoon({ type: 'knowledge', id: result.runbook.id }, { type: 'proposal', id: p.id });
      await notifyDecided(result.proposal, 'accepted', [actor, d.sess.sub]);
      res.json({ proposal: result.proposal, runbook: result.runbook, version: result.version });
      return;
    }

    const ownerId = str(body['owner_person_id']);
    if (ownerId && !await personExists(ownerId)) throw new ValidationError('`owner_person_id` does not name a person');
    const id = acceptName;
    if (!RUNBOOK_ID.test(id)) throw new ValidationError('`id` must look like rb-some-name (lowercase letters, digits, hyphens)');
    const runbook: Runbook = {
      id, scope: newScope!, owner_person_id: ownerId ?? actor, status: 'published',
      ...(newScope!.kind !== 'initiative' && area ? { area } : {}),
      current_version: 1, created_at: at, updated_at: at,
    };
    const version = { ...versionOf({ runbook_id: id, version: 1, doc, author, provenance, files }), ...stamp };
    const result = await s.acceptProposal({ proposal_id: p.id, decided_by: actor, at, note, runbook, version });
    noteSearchWriteSoon({ type: 'knowledge', id: result.runbook.id }, { type: 'proposal', id: p.id });
    await notifyDecided(result.proposal, 'accepted', [actor, d.sess.sub]);
    res.status(201).json({ proposal: result.proposal, runbook: result.runbook, version: result.version });
  }));

  router.post('/proposals/:pid/reject', ...reviewGate, handler(async (req, res) => {
    const s = await store();
    const note = str((req.body as Record<string, unknown> | undefined)?.['note']);
    if (!note) throw new ValidationError('a rejection needs a `note` saying why');
    const peek = await s.getProposal(String(req.params['pid']));
    // A `new` proposal has no scope yet: only the org-wide reviewers (or the initiative of its work item) may reject it.
    let override: { scope: RunbookScope; owner: string | null; area?: string | null } | undefined;
    if (peek?.kind === 'new') override = { scope: await newProposalScope(peek), owner: null, area: await proposalArea(peek) };
    const d = await decidable(req, res, s, override);
    if (!d) return;
    if (d.soleReviewer) await s.putProposal({ ...d.p, decided_as: 'sole-reviewer-dispatcher' });
    const proposal = await s.decideProposal({ proposal_id: d.p.id, decision: 'rejected', decided_by: d.actor, at: now(), note });
    noteSearchWriteSoon({ type: 'proposal', id: proposal.id });
    await notifyDecided(proposal, 'rejected', [d.actor, d.sess.sub]);
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
    noteSearchWriteSoon({ type: 'proposal', id: proposal.id });
    res.json({ proposal });
  }));

  router.post('/proposals/:pid/merge', ...reviewGate, handler(async (req, res) => {
    const s = await store();
    const body = (req.body ?? {}) as Record<string, unknown>;
    const into = str(body['into']);
    if (!into) throw new ValidationError('`into` (the runbook to merge this into) is required');
    const dest = await s.getRunbook(into);
    if (!dest) { res.status(404).json({ error: `runbook ${into} not found` }); return; }
    if (dest.status !== 'published') { res.status(409).json({ error: `${dest.id} is ${dest.status}; merge into a published runbook`, code: 'NOT_PUBLISHED' }); return; }
    // The reviewer must be able to review the TARGET, whatever the source says.
    const d = await decidable(req, res, s, { scope: dest.scope, owner: dest.owner_person_id, area: dest.area ?? null });
    if (!d) return;
    const { p, actor, target: source } = d;
    // Merging closes the proposal on its own target, so it is a decision about THAT
    // runbook too: without this, a reviewer of any published runbook could close any
    // edit anywhere by merging it into their own.
    if (source) {
      const v = await mayReviewRunbook(d.sess, source.scope, source.owner_person_id, source.area ?? null);
      if (!v.ok) { deny(res, v); return; }
    }
    if (p.kind === 'retire' || p.kind === 'restore' || !p.proposed) { res.status(409).json({ error: 'a retire proposal cannot be merged', code: 'NOT_MERGEABLE' }); return; }
    if (p.runbook_id === dest.id) { res.status(409).json({ error: 'this proposal already targets that runbook; accept it instead', code: 'SAME_TARGET' }); return; }

    const at = now();
    const edit: RunbookProposal = {
      ...p,
      id: `prop-${randomUUID().slice(0, 12)}`,
      kind: 'edit', runbook_id: dest.id, base_version: dest.current_version,
      rationale: `Merged from ${p.id}${p.runbook_id ? ` (was aimed at ${p.runbook_id})` : ' (a new runbook)'}: ${p.rationale}`,
      lint: lintRunbook(p.proposed, lintFor(p.proposed_files, dest.id, undefined, p.proposed_frontmatter_keys)), similar: [],
      status: 'open', decided_by: null, decided_at: null, note: null, merged_into: null, created_at: at,
    };
    const merged = await s.decideProposal({
      proposal_id: p.id, decision: 'merged', decided_by: actor, at, note: str(body['note']) ?? null, merged_into: edit.id,
    });
    await s.putProposal(edit);
    noteSearchWriteSoon({ type: 'proposal', id: p.id }, { type: 'proposal', id: edit.id });
    res.status(201).json({ merged, proposal: proposalView(edit) });
  }));

  // ── Retiring ───────────────────────────────────────────────────────────────

  router.post('/:id/retire', ...reviewGate, handler(async (req, res) => {
    if (refuseMasquerade(req, res)) return;
    const s = await store();
    const sess = session(req);
    const r = await s.getRunbook(String(req.params['id']));
    if (!r) { res.status(404).json({ error: 'runbook not found' }); return; }
    const verdict = await mayReviewRunbook(sess, r.scope, r.owner_person_id, r.area ?? null);
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
    noteSearchWriteSoon({ type: 'knowledge', id: next.id });
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
    // R8: a v2 brief records the org's skill library the run's box synced (every published skill
    // and its version); a v1 brief named the runbooks it inlined.
    const brief = await s.getBrief(runRef);
    const given = brief?.skill_library
      ? brief.skill_library.skills.find((k) => k.name === r.id)?.version
      : brief?.sections.find((sec) => sec.kind === 'runbook' && sec.ref === r.id)?.version;
    if (!brief || given === undefined) {
      res.status(409).json({ error: `run ${runRef} was not given ${r.id}`, code: 'NOT_GIVEN' });
      return;
    }
    const version = given;
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
