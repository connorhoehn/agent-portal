// RowsRunbookStore: the mock-floor implementation of RunbookStore. It reads and
// writes the five registered fixtures (mock/runbooks.ts) through accessors, so
// `POST /api/__mock/reset` takes back every write and scenarios (default,
// empty, large) apply. Every method is synchronous inside, so each conditional
// write is atomic without a lock.
import type {
  Runbook, RunbookApplication, RunbookProposal, RunbookVersion, SessionBrief,
} from './types.js';
import {
  AlreadyExistsError, BriefExistsError, NotFoundError, InvalidWriteError, byNewest, checkCreate, checkPutRunbook, clone,
  filterProposals, filterRunbooks, matchesText, paginate, planAccept, planDecision, planPutVersion, runbookSearchText,
  type AcceptProposalInput, type AcceptProposalResult, type DecideProposalInput, type ListBriefsQuery, type ListProposalsQuery,
  type ListRunbooksQuery, type Page, type RunbookStore,
} from './store.js';

/** Where the rows live. The default (mock/runbooks.ts) is five registered fixtures; tests pass private arrays. */
export interface RunbookRowSources {
  runbooks(): Runbook[];
  versions(): RunbookVersion[];
  proposals(): RunbookProposal[];
  applications(): RunbookApplication[];
  briefs(): SessionBrief[];
}

export function privateRowSources(): RunbookRowSources {
  const rb: Runbook[] = [], vs: RunbookVersion[] = [], ps: RunbookProposal[] = [], as: RunbookApplication[] = [], bs: SessionBrief[] = [];
  return { runbooks: () => rb, versions: () => vs, proposals: () => ps, applications: () => as, briefs: () => bs };
}

export class RowsRunbookStore implements RunbookStore {
  readonly kind = 'rows' as const;
  constructor(private readonly src: RunbookRowSources) {}

  private runbook(id: string): Runbook | null { return this.src.runbooks().find((r) => r.id === id) ?? null; }
  private version(id: string, n: number): RunbookVersion | null { return this.src.versions().find((v) => v.runbook_id === id && v.version === n) ?? null; }
  private proposal(id: string): RunbookProposal | null { return this.src.proposals().find((p) => p.id === id) ?? null; }
  private replace<T>(rows: T[], where: (t: T) => boolean, next: T): void {
    const i = rows.findIndex(where);
    if (i < 0) rows.push(clone(next)); else rows[i] = clone(next);
  }

  async getRunbook(id: string): Promise<Runbook | null> { const r = this.runbook(id); return r ? clone(r) : null; }

  async listRunbooks(q?: ListRunbooksQuery): Promise<Page<Runbook>> {
    let rows = filterRunbooks(this.src.runbooks(), q);
    if (q?.text?.trim()) {
      rows = rows.filter((r) => matchesText(q.text, runbookSearchText(r, this.version(r.id, r.current_version)?.doc ?? null)));
    }
    const page = paginate([...rows].sort(byNewest((r) => r.updated_at, (r) => r.id)), q?.cursor, q?.limit);
    return { items: clone(page.items), next: page.next };
  }

  async createRunbook(runbook: Runbook, v1: RunbookVersion): Promise<void> {
    checkCreate(runbook, v1);
    if (this.runbook(runbook.id)) throw new AlreadyExistsError(`runbook ${runbook.id}`);
    this.src.runbooks().push(clone(runbook));
    this.src.versions().push(clone(v1));
  }

  async putRunbook(runbook: Runbook, expectedUpdatedAt: string): Promise<void> {
    checkPutRunbook(this.runbook(runbook.id), runbook, expectedUpdatedAt);
    this.replace(this.src.runbooks(), (r) => r.id === runbook.id, runbook);
  }

  async getVersion(runbookId: string, version: number): Promise<RunbookVersion | null> {
    const v = this.version(runbookId, version); return v ? clone(v) : null;
  }
  async listVersions(runbookId: string): Promise<RunbookVersion[]> {
    return clone(this.src.versions().filter((v) => v.runbook_id === runbookId).sort((a, b) => a.version - b.version));
  }

  async putVersion(v: RunbookVersion, expectedCurrent: number, at: string): Promise<void> {
    const next = planPutVersion(this.runbook(v.runbook_id), v, expectedCurrent, at);
    if (this.version(v.runbook_id, v.version)) throw new AlreadyExistsError(`${v.runbook_id} v${v.version}`);
    this.src.versions().push(clone(v));
    this.replace(this.src.runbooks(), (r) => r.id === next.id, next);
  }

  async getProposal(id: string): Promise<RunbookProposal | null> { const p = this.proposal(id); return p ? clone(p) : null; }

  async putProposal(p: RunbookProposal): Promise<void> {
    const existing = this.proposal(p.id);
    if (existing && existing.status !== 'open') throw new AlreadyExistsError(`decided proposal ${p.id}`);
    this.replace(this.src.proposals(), (x) => x.id === p.id, p);
  }

  async listProposals(q?: ListProposalsQuery): Promise<Page<RunbookProposal>> {
    const page = paginate(filterProposals(this.src.proposals(), q).sort(byNewest((p) => p.created_at, (p) => p.id)), q?.cursor, q?.limit);
    return { items: clone(page.items), next: page.next };
  }

  async acceptProposal(input: AcceptProposalInput): Promise<AcceptProposalResult> {
    const proposal = this.proposal(input.proposal_id);
    const plan = planAccept(proposal, proposal?.runbook_id ? this.runbook(proposal.runbook_id) : input.runbook ? this.runbook(input.runbook.id) : null, input);
    if (plan.version && this.version(plan.version.runbook_id, plan.version.version)) throw new AlreadyExistsError(`${plan.version.runbook_id} v${plan.version.version}`);
    if (plan.version) this.src.versions().push(clone(plan.version));
    this.replace(this.src.runbooks(), (r) => r.id === plan.runbook.id, plan.runbook);
    this.replace(this.src.proposals(), (p) => p.id === plan.proposal.id, plan.proposal);
    return clone(plan);
  }

  async decideProposal(input: DecideProposalInput): Promise<RunbookProposal> {
    const next = planDecision(this.proposal(input.proposal_id), input);
    this.replace(this.src.proposals(), (p) => p.id === next.id, next);
    return clone(next);
  }

  async appendApplication(a: RunbookApplication): Promise<void> {
    if (this.src.applications().some((x) => x.id === a.id)) throw new AlreadyExistsError(`application ${a.id}`);
    this.src.applications().push(clone(a));
  }
  async listApplications(runbookId: string, version?: number): Promise<RunbookApplication[]> {
    return clone(this.src.applications()
      .filter((a) => a.runbook_id === runbookId && (version === undefined || a.version === version))
      .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id)));
  }

  async putBrief(b: SessionBrief): Promise<void> {
    if (!b.run_ref) throw new InvalidWriteError('a brief needs a run_ref');
    const existing = this.src.briefs().find((x) => x.run_ref === b.run_ref);
    if (existing) { if (existing.sha256 === b.sha256) return; throw new BriefExistsError(b.run_ref); }
    this.src.briefs().push(clone(b));
  }
  async getBrief(runRef: string): Promise<SessionBrief | null> {
    const b = this.src.briefs().find((x) => x.run_ref === runRef); return b ? clone(b) : null;
  }
  async listBriefs(q?: ListBriefsQuery): Promise<Page<SessionBrief>> {
    const page = paginate([...this.src.briefs()].sort(byNewest((b) => b.assembled_at, (b) => b.id)), q?.cursor, q?.limit);
    return { items: clone(page.items), next: page.next };
  }
}

