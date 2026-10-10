// The facts the initiative's right pane states: the maintenance floor as the
// server read it, the workspace documents' kinds and order, a run's log lines
// and calendar days. Pure, so `__tests__/initiativePaneModel.test.ts` runs
// under `node --test`.
//
// The pane itself — its tabs, their URL contract and per-device memory, the
// split — is the library pane model (ui-components 2.438 `SidePane` +
// `usePaneState`, `?pane=<tab>&paneRecord=<kind>:<id>`); InitiativeSidePane.tsx
// declares the initiative's tabs and draws their bodies.

// ─── The maintenance floor ──────────────────────────────────────────────────
// What `v_initiative_maintenance_30d` (schema/program_schema.sql) states —
// cron-triggered COSTED runs and their cost over the trailing 30 days — read
// as the server decided it (`GET /api/bots/initiative-runs` carries
// `maintenance30d`, the same value the Budgets ledger reads). Nothing is summed
// here: a browser summing a capped run list with unknown costs as zero reported
// a floor that was neither the view's nor honest (audit H11). When the server
// could not read the view the floor is "not known", never 0.

export interface Maintenance30d { cronRuns: number; costUsd: number }
export interface MaintenanceRead { loading: boolean; error: string | null; floor: Maintenance30d | null | undefined }

export const FLOOR_DAYS = 30;

export function maintenanceFact(read: MaintenanceRead, money: (usd: number) => string, compact = false): { value: string; muted: boolean } {
  if (read.floor) {
    const runs = `${read.floor.cronRuns} cron run${read.floor.cronRuns === 1 ? '' : 's'}`;
    return { value: `${money(read.floor.costUsd)} · ${runs}, ${compact ? '30d' : `last ${FLOOR_DAYS} days`}`, muted: false };
  }
  if (read.loading) return { value: 'Loading…', muted: true };
  if (read.error) return { value: 'Runs could not be read', muted: true };
  return { value: 'Maintenance not known', muted: true };
}

// ─── Workspace documents ────────────────────────────────────────────────────
// The Docs tab lists the canonical OrgIQ corpus records linked to this
// initiative's work (work_item_documents, read per item through
// `GET /api/graph/work-items/:id/documents` under its own reader authority),
// governance kinds first: charter, ADR, runbook, policy/governance, then
// postmortems, then everything else. The kind is read from the record id's
// prefix (the corpus names its records `adr-…`, `postmortem-…`) and, failing
// that, the title's leading word — never inferred from content.

export interface WorkspaceDocument { id: string; title: string | null; source: string | null }

const KINDS: Array<{ label: string; test: RegExp }> = [
  { label: 'Charter', test: /^charter\b/i },
  { label: 'ADR', test: /^adr\b/i },
  { label: 'Runbook', test: /^runbook\b/i },
  { label: 'Governance', test: /^(governance|policy|standard)\b/i },
  { label: 'Postmortem', test: /^postmortem\b/i },
];

/** "ADR", "Runbook"… or "Document"; and its rank (governance first). */
export function documentKind(doc: Pick<WorkspaceDocument, 'id' | 'title'>): { label: string; rank: number } {
  for (const [rank, kind] of KINDS.entries()) {
    if (kind.test.test(doc.id.replace(/[-_]/g, ' ')) || kind.test.test((doc.title ?? '').trim())) return { label: kind.label, rank };
  }
  return { label: 'Document', rank: KINDS.length };
}

/** One list from the per-item reads: each record once, governance kinds first, then by title. */
export function workspaceDocuments<T extends WorkspaceDocument>(lists: ReadonlyArray<readonly T[]>): T[] {
  const byId = new Map<string, T>();
  for (const list of lists) for (const doc of list) if (!byId.has(doc.id)) byId.set(doc.id, doc);
  return [...byId.values()].sort((a, b) => documentKind(a).rank - documentKind(b).rank
    || (a.title ?? a.id).localeCompare(b.title ?? b.id));
}

/** The pane's list is short: the rest is one "Open workspace" away. */

// ─── A run's log ────────────────────────────────────────────────────────────
// The Log tab reads the job the page `/iq/work/<jobId>` reads
// (`GET /api/work/jobs/:id`, a session floor). Its lines: the recorded
// transcript when the dispatcher kept one, else the run's tool calls in
// order, then the outcome.

export interface LogJob {
  status: string;
  error: string | null;
  result: {
    summary?: string;
    transcript?: Array<{ t: string; name?: string; detail: string }>;
    toolCallList?: Array<{ name: string; done?: boolean }>;
  } | null;
}
export interface LogLine { id: string; kind: 'text' | 'tool' | 'error' | 'outcome'; label: string; text: string }

export function logLines(job: LogJob): LogLine[] {
  const lines: LogLine[] = [];
  const transcript = job.result?.transcript ?? [];
  if (transcript.length) {
    transcript.forEach((entry, i) => lines.push({
      id: `t${i}`,
      kind: entry.t === 'tool' ? 'tool' : entry.t === 'error' ? 'error' : 'text',
      label: entry.t === 'tool' ? entry.name ?? 'tool' : entry.t === 'error' ? 'error' : 'agent',
      text: entry.detail,
    }));
  } else {
    (job.result?.toolCallList ?? []).forEach((call, i) => lines.push({
      id: `c${i}`, kind: 'tool', label: call.name, text: call.done === false ? 'did not finish' : 'done',
    }));
  }
  const outcome = job.error ?? job.result?.summary ?? null;
  if (outcome) lines.push({ id: 'outcome', kind: job.error ? 'error' : 'outcome', label: job.error ? 'error' : 'outcome', text: outcome });
  return lines;
}

/** Statuses the job's own state machine is still moving through: the Log keeps refreshing. */
export function jobIsLive(status: string | null | undefined): boolean {
  return status === 'queued' || status === 'claimed' || status === 'running';
}

/** "Oct 7, 2026" for an instant or a calendar DATE ('YYYY-MM-DD', read as that day, not a UTC midnight shifted a day back). */
export function calendarDay(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00`) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
