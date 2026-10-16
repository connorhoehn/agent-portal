// Pure model of the Runbooks destination (docs/distillation-runbooks-design.md §4):
// hrefs, list grouping, health, proposal rows, brief rows, the step markers
// derived from applications, the honest messages for the API's refusals, the
// markdown guard and the redirect from the retired /iq/distillation tree.
// No React; relative imports carry their `.ts` so `node --test` runs it.
import { collectionCommandAdapter, resolveCollectionTarget } from '../../components/collections/collectionCommands.ts';
import type { CollectionCommandAdapter } from '../../components/collections/CollectionCommandHost.tsx';
import { NO_NAMES, type Names } from './runbookNames.ts';
import type {
  BriefSummary, HealthStatus, LintFinding, Proposal, RunbookApplication, RunbookRow, RunbookScope, ScopeKind,
} from './types.ts';

export const RUNBOOKS = '/iq/runbooks';
export const runbookHref = (id: string, tab?: RecordTab | null) => `${RUNBOOKS}/${encodeURIComponent(id)}${tab && tab !== 'read' ? `?tab=${tab}` : ''}`;
export const proposalsHref = () => `${RUNBOOKS}/proposals`;
export const proposalHref = (id: string) => `${RUNBOOKS}/proposals/${encodeURIComponent(id)}`;
export const briefsHref = () => `${RUNBOOKS}/briefs`;
export const briefHref = (runRef: string) => `${RUNBOOKS}/briefs/${encodeURIComponent(runRef)}`;

export type RecordTab = 'read' | 'history' | 'runs' | 'suggest';
export const RECORD_TABS: readonly RecordTab[] = ['read', 'history', 'runs', 'suggest'];
export function parseTab(value: string | null): RecordTab {
  return (RECORD_TABS as readonly string[]).includes(value ?? '') ? (value as RecordTab) : 'read';
}

// ── Library ──────────────────────────────────────────────────────────────────

export const SCOPE_GROUPS: ReadonlyArray<{ id: ScopeKind; title: string }> = [
  { id: 'org', title: 'Org-wide' },
  { id: 'initiative', title: 'Initiatives' },
  { id: 'repo', title: 'Repositories' },
  { id: 'tool', title: 'Tools' },
];

/** Where a scope points, by name: an initiative's name, a repository's own name, a tool. */
export function scopeTarget(scope: RunbookScope, names: Names = NO_NAMES): string {
  if (scope.kind === 'org') return 'Whole organisation';
  if (scope.kind === 'initiative') return names.initiative(scope.ref);
  return scope.ref ?? '';
}

export function scopeLabel(scope: RunbookScope, names: Names = NO_NAMES): string {
  switch (scope.kind) {
    case 'org': return 'Whole organisation';
    case 'initiative': return `Initiative ${names.initiative(scope.ref)}`;
    case 'repo': return `Repository ${scope.ref ?? ''}`.trim();
    case 'tool': return `Tool ${scope.ref ?? ''}`.trim();
  }
}

export const HEALTH_LABEL: Record<HealthStatus, string> = { proven: 'Proven', drifting: 'Drifting', unproven: 'Unproven' };
export const HEALTH_TONE: Record<HealthStatus, 'success' | 'warning' | 'neutral'> = { proven: 'success', drifting: 'warning', unproven: 'neutral' };

export interface LibraryRow { id: string; groupId: ScopeKind; title: string; subline: string; health: HealthStatus; status: RunbookRow['status'] }

export function matchesRunbook(r: RunbookRow, q: string, names: Names = NO_NAMES): boolean {
  const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const hay = `${r.id} ${r.title} ${r.summary} ${r.scope.ref ?? ''} ${scopeTarget(r.scope, names)} ${r.scope.kind}`.toLowerCase();
  return terms.every((t) => hay.includes(t));
}

export function libraryRows(runbooks: readonly RunbookRow[], q = '', status: string | null = null, names: Names = NO_NAMES): LibraryRow[] {
  return runbooks
    .filter((r) => matchesRunbook(r, q, names) && (!status || r.status === status))
    .map((r) => ({
      id: r.id, groupId: r.scope.kind, title: r.title, health: r.health.status, status: r.status,
      subline: `${scopeTarget(r.scope, names)} · v${r.current_version}${r.status !== 'published' ? ` · ${r.status}` : r.health.status === 'drifting' ? ' · drifting' : ''}${r.open_proposals ? ` · ${r.open_proposals} open` : ''}`,
    }));
}

export function libraryGroups(rows: readonly LibraryRow[]) {
  return SCOPE_GROUPS.map((g) => ({ id: g.id, title: g.title, count: rows.filter((r) => r.groupId === g.id).length })).filter((g) => g.count > 0);
}

export const STATUS_FILTERS: Record<string, string> = { published: 'published', draft: 'draft', retired: 'retired' };

export function libraryCommandAdapter(rows: readonly { id: string; title: string }[], controls: {
  setQuery(v: string): void; setStatus(v: string | null): void; refresh(): void; open(id: string): void;
}): CollectionCommandAdapter {
  return collectionCommandAdapter({ noun: 'runbooks', filters: STATUS_FILTERS }, {
    id: 'runbooks-library-commands', label: 'Runbooks',
    setQuery: controls.setQuery, setFilter: (v) => controls.setStatus(v || null), refresh: controls.refresh,
    scopeNote: 'Search matches runbook titles, summaries and scopes; status filters the list. Open uses one exact runbook ID or title. Commands never edit, accept or retire a runbook.',
    open(target) { const row = resolveCollectionTarget(target, rows); controls.open(row.id); return `Opened ${row.title}.`; },
  });
}

/** Steps with their latest outcome from the newest application of this version. */
export function stepMarkers<T extends { do: string }>(steps: readonly T[], applications: readonly RunbookApplication[], version: number) {
  const latest = [...applications].filter((a) => a.version === version).sort((a, b) => b.at.localeCompare(a.at))[0] ?? null;
  return steps.map((s, i) => {
    const n = i + 1;
    let status: 'done' | 'failed' | 'skipped' | undefined;
    let note: string | undefined;
    if (latest?.outcome === 'followed' || latest?.outcome === 'followed_with_deviation') status = 'done';
    else if (latest?.outcome === 'failed') {
      const at = latest.failed_at_step;
      if (at == null) status = undefined;
      else if (n < at) status = 'done';
      else if (n === at) { status = 'failed'; note = latest.note ?? 'The last run failed here.'; }
      else { status = 'skipped'; note = 'Not reached in the last run.'; }
    }
    if (latest?.outcome === 'followed_with_deviation' && latest.note && n === 1) note = latest.note;
    return { step: s, n, status, note };
  });
}

export const OUTCOME_LABEL: Record<RunbookApplication['outcome'], string> = {
  followed: 'Followed', followed_with_deviation: 'Followed with changes', failed: 'Failed', not_used: 'Not used',
};

/** `job-0001` → the run page the workspace Runs list opens it on. */
export const runPageHref = (runRef: string) => `/iq/runs/${encodeURIComponent(runRef.includes(':') ? runRef : `job:${runRef}`)}`;

/** The brief's run_ref for a /iq/runs/:id id (`job:job-0001` → `job-0001`), or null when the run is not a job. */
export function briefRefOfRun(runId: string | undefined): string | null {
  if (!runId) return null;
  return runId.startsWith('job:') ? runId.slice(4) : null;
}

// ── Proposals ────────────────────────────────────────────────────────────────

export const KIND_LABEL: Record<Proposal['kind'], string> = { new: 'New runbook', edit: 'Edit', retire: 'Retire' };
export const PROPOSAL_STATUS_LABEL: Record<Proposal['status'], string> = { open: 'Open', accepted: 'Accepted', rejected: 'Rejected', merged: 'Merged' };
export const PROPOSAL_STATUS_TONE: Record<Proposal['status'], 'info' | 'success' | 'error' | 'neutral'> = { open: 'info', accepted: 'success', rejected: 'error', merged: 'neutral' };

export function proposalTitle(p: Proposal, titles: ReadonlyMap<string, string>): string {
  if (p.kind === 'new') return p.proposed?.title ?? 'New runbook';
  return (p.runbook_id && titles.get(p.runbook_id)) || p.proposed?.title || p.runbook_id || 'Runbook';
}

export function proposalAuthor(p: Proposal, names: Names = NO_NAMES): { name: string; kind: 'human' | 'agent' } {
  return p.source.kind === 'run'
    ? { name: names.run(p.source.run_ref), kind: 'agent' }
    : { name: names.person(p.source.person_id), kind: 'human' };
}

export interface ProposalRow { id: string; groupId: 'open' | 'decided'; title: string; subline: string; kind: Proposal['kind']; status: Proposal['status'] }

export function proposalRows(proposals: readonly Proposal[], titles: ReadonlyMap<string, string>, q = '', names: Names = NO_NAMES): ProposalRow[] {
  const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return proposals
    .map((p): ProposalRow => ({
      id: p.id, kind: p.kind, status: p.status, groupId: p.status === 'open' ? 'open' : 'decided',
      title: proposalTitle(p, titles),
      subline: `${KIND_LABEL[p.kind]} · ${proposalAuthor(p, names).name}${p.status !== 'open' ? ` · ${PROPOSAL_STATUS_LABEL[p.status].toLowerCase()}` : ''}${p.lint.some((f) => f.severity === 'error') ? ' · lint errors' : ''}`,
    }))
    .filter((r) => terms.every((t) => `${r.id} ${r.title} ${r.subline}`.toLowerCase().includes(t)));
}

export function proposalGroups(rows: readonly ProposalRow[]) {
  return [{ id: 'open', title: 'Open' }, { id: 'decided', title: 'Decided' }]
    .map((g) => ({ ...g, count: rows.filter((r) => r.groupId === g.id).length })).filter((g) => g.count > 0);
}

export const PROPOSAL_STATUS_FILTERS: Record<string, string> = { open: 'open', accepted: 'accepted', rejected: 'rejected', merged: 'merged' };

export function proposalsCommandAdapter(rows: readonly { id: string; title: string }[], controls: {
  setQuery(v: string): void; setStatus(v: string | null): void; refresh(): void; open(id: string): void;
}): CollectionCommandAdapter {
  return collectionCommandAdapter({ noun: 'proposals', filters: PROPOSAL_STATUS_FILTERS }, {
    id: 'runbooks-proposals-commands', label: 'Proposals',
    setQuery: controls.setQuery, setFilter: (v) => controls.setStatus(v || null), refresh: controls.refresh,
    scopeNote: 'Search matches proposal titles and authors; status filters the list. Open uses one exact proposal ID or title. Commands never accept, reject or merge a proposal.',
    open(target) { const row = resolveCollectionTarget(target, rows); controls.open(row.id); return `Opened ${row.title}.`; },
  });
}

/** The diff text in the shape DiffViewer parses (a `diff --git` header over the API's ---/+++ hunks). */
export function viewerDiff(text: string | null | undefined, name: string): string {
  const t = (text ?? '').trim();
  if (!t) return '';
  return /^diff --git/m.test(t) ? t : `diff --git a/${name} b/${name}\n${t}\n`;
}

export function lintCounts(findings: readonly LintFinding[]) {
  return { errors: findings.filter((f) => f.severity === 'error').length, warnings: findings.filter((f) => f.severity === 'warning').length };
}

/** What a refused write says, in the reader's words. Never a bare status. */
export function refusalMessage(status: number, code: string | undefined, fallback: string | null): string {
  if (code === 'MASQUERADING' || (status === 403 && /masquerad/i.test(fallback ?? ''))) return 'You are viewing as someone else, so proposals and decisions are switched off. Stop masquerading to continue.';
  if (code === 'RETIRED') return 'This runbook is retired, so nothing can be accepted onto it. Reject the proposal, or merge it into a published runbook.';
  if (code === 'VERSION_CONFLICT' || (status === 409 && /written against/i.test(fallback ?? ''))) return 'This runbook changed since the proposal was written. Review the new diff, then ask for a fresh proposal.';
  if (code === 'PROPOSAL_CLOSED') return 'Someone already decided this proposal. Reload to see the decision.';
  if (code === 'SELF_ACCEPT') return 'You cannot decide your own proposal; another reviewer has to.';
  if (code === 'OUT_OF_SCOPE') return fallback ?? 'You are not a reviewer for this runbook’s scope.';
  if (code === 'LINT') return 'The proposal has lint errors, so it cannot be accepted until they are fixed.';
  if (status === 403) return fallback ?? 'You do not have permission for this action.';
  return fallback ?? `The request failed (HTTP ${status}).`;
}

// ── Briefs ───────────────────────────────────────────────────────────────────

export const shortSha = (sha: string) => sha.slice(0, 12);

/** 0 B, 812 B, 1.4 KB, 2.0 MB: the unit a reader expects, one decimal above bytes. */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0 B';
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024; let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(1)} ${units[i]}`;
}

/** 'script' for an executable (755) file, else 'file'. */
export const fileModeLabel = (mode: string) => (mode === '755' ? 'script' : 'file');

/** The label for what kind of file this is, from its extension. Display only; the viewer always renders as text. */
export function fileLanguageLabel(path: string): string {
  const ext = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase() ?? '';
  const map: Record<string, string> = { md: 'Markdown', sh: 'Shell', bash: 'Shell', py: 'Python', js: 'JavaScript', mjs: 'JavaScript', ts: 'TypeScript', json: 'JSON', yml: 'YAML', yaml: 'YAML', sql: 'SQL', txt: 'Text', toml: 'TOML' };
  return map[ext] ?? (ext ? ext.toUpperCase() : 'Text');
}

/** "+12 −3 · 2 files (1 added, 1 modified)" for the proposal's file diff. */
export function filesDiffSummary(d: { added: number; removed: number; files: ReadonlyArray<{ status: string }> }): string {
  const by = new Map<string, number>();
  for (const f of d.files) if (f.status !== 'unchanged') by.set(f.status, (by.get(f.status) ?? 0) + 1);
  const n = [...by.values()].reduce((a, b) => a + b, 0);
  const parts = [...by.entries()].map(([k, c]) => `${c} ${k}`).join(', ');
  return `+${d.added} −${d.removed} · ${n} ${n === 1 ? 'file' : 'files'}${parts ? ` (${parts})` : ''}`;
}

export interface BriefRow { id: string; groupId: string; title: string; subline: string }
export function briefRows(briefs: readonly BriefSummary[], q = '', names: Names = NO_NAMES): BriefRow[] {
  const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return briefs
    .map((b): BriefRow => {
      const n = b.sections.filter((s) => s.kind === 'runbook').length;
      return {
        id: b.run_ref, groupId: b.assembled_at.slice(0, 10),
        title: names.run(b.run_ref),
        subline: `${b.initiative_id ? `${names.initiative(b.initiative_id)} · ` : ''}${n} ${n === 1 ? 'runbook' : 'runbooks'} · ${shortSha(b.sha256)}`,
      };
    })
    // The ids stay searchable (a run reference pasted from a log finds its brief) even though they are not shown.
    .filter((r, i) => terms.every((t) => `${r.id} ${briefs[i]!.work_item_id ?? ''} ${r.title} ${r.subline}`.toLowerCase().includes(t)));
}
export function briefGroups(rows: readonly BriefRow[]) {
  const days = [...new Set(rows.map((r) => r.groupId))].sort().reverse();
  return days.map((d) => ({ id: d, title: d, count: rows.filter((r) => r.groupId === d).length }));
}

export function briefsCommandAdapter(rows: readonly { id: string; title: string }[], controls: {
  setQuery(v: string): void; refresh(): void; open(id: string): void;
}): CollectionCommandAdapter {
  return collectionCommandAdapter({ noun: 'briefs' }, {
    id: 'runbooks-briefs-commands', label: 'Briefs',
    setQuery: controls.setQuery, refresh: controls.refresh,
    scopeNote: 'Search matches work items, run references and shas. Open uses one exact run reference or work item. Commands never change a frozen brief.',
    open(target) { const row = resolveCollectionTarget(target, rows); controls.open(row.id); return `Opened the brief for ${row.title}.`; },
  });
}

export const SECTION_KIND_LABEL: Record<string, string> = {
  framing: 'Framing', work_item: 'The task', initiative: 'The project', decisions: 'Decisions', runbook: 'Runbook', skill_library: 'Org skills', how_to_report: 'How to report back',
};

// ── Markdown from people and boxes ───────────────────────────────────────────

/**
 * Runbook, proposal and brief markdown is written by people and boxes. The
 * library's MarkdownView already drops raw HTML (shown as text) and refuses
 * javascript:/data: URLs; this closes the one gap left: images would make the
 * reader's browser fetch a URL the author chose. Images become their alt text,
 * outside fenced code (code stays verbatim).
 */
export function guardMarkdown(markdown: string): string {
  const parts = markdown.split(/(^```[\s\S]*?^```[^\n]*$)/m);
  return parts.map((part, i) => (i % 2 === 1 ? part : part
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_m, alt: string) => (alt ? `(image omitted: ${alt})` : '(image omitted)'))
    .replace(/!\[([^\]]*)\]\[[^\]]*\]/g, (_m, alt: string) => (alt ? `(image omitted: ${alt})` : '(image omitted)'))
    .replace(/<img\b[^>]*>/gi, '(image omitted)'))).join('');
}

// ── The retired /iq/distillation tree ────────────────────────────────────────

/** Source artifact → the runbook the migration made of it (docs/distillation-runbooks-design.md §5.1). */
export const ARTIFACT_RUNBOOK: Readonly<Record<string, string>> = {
  'art-001': 'rb-flaky-test-rerun-diff', 'art-002': 'rb-aurora-cold-start-retry', 'art-003': 'rb-fargate-arm64-image',
  'art-004': 'rb-auth-pr-csrf-gate', 'art-005': 'rb-ingest-pii-scan', 'art-006': 'rb-statsd-decommission',
  'art-009': 'rb-sso-new-origin', 'art-010': 'rb-tenant-cutover', 'art-011': 'rb-idle-teardown-proposal',
};

/** Where a retired /iq/distillation URL now lives. Review → Proposals, a known guide → its runbook, everything else → the Library. */
export function distillationRedirect(pathname: string, search = ''): string {
  const params = new URLSearchParams(search);
  const page = pathname.replace(/^\/iq\/distillation\/?/, '').split('/')[0] ?? '';
  if (page === 'review') return proposalsHref();
  const item = params.get('item');
  const runbook = item ? ARTIFACT_RUNBOOK[item] : undefined;
  if (runbook) return runbookHref(runbook);
  return RUNBOOKS;
}
