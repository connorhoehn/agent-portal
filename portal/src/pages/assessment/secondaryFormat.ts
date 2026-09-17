// Pure derivations for the assessment tenant's secondary pages. No React, no JSX —
// everything here is a plain function so revision grouping, time/duration formatting
// and the agent-run launch-response mapping can be unit-tested without mounting a page.
// Mirrors the source app's formatting helpers (`formatRelativeTime`/`formatDuration` in
// `ui/src/components/runs/ActivityPage.tsx`) and its revision-grouping logic
// (`ui/src/components/submissions/types.ts` `groupSubmissions`).

import type {
  ApiSubmissionEnvelope, FeedbackTask, LinkStatus, RowStatus, RunRecord, RunStatus, SubmissionGroupRef, SubmissionListItem, SubmissionRevisionGroup } from './secondaryTypes';
import type { AssessmentSSEEvent } from './knowledge/types';
import type { ChipTone } from '@connorhoehnslalom/ui-components/shared';
import { pgTimestampMs } from '../../lib/pgTimestamp.ts';

// ─── Agent-run status → StatusPill state ────────────────────────────────────
//
// RunsPage.tsx and RunPromptStep.tsx each declared this table locally under
// the same name (`STATUS_STATE` / `RUN_STATE`) — harmless while they agreed,
// but nothing stopped them drifting apart on what "running" reads as.
// Centralised here; each page keeps its own label convention (RunsPage shows
// the raw status word, RunPromptStep shows it Title Cased).
export const RUN_STATUS_PILL_STATE: Record<RunStatus, 'info' | 'success' | 'error'> = {
  running: 'info',
  completed: 'success',
  failed: 'error',
};

// ─── Forms export CSV parsing (client-side; no multipart parser on the server) ─
// RFC-4180-ish: quoted fields, doubled-quote escapes ("" -> "), commas and
// newlines embedded in a quoted field, CRLF or bare LF line endings, and a
// leading UTF-8 BOM (Excel/Forms exports commonly carry one). No dependency —
// a small hand-rolled state machine, not a regex split (which breaks on
// embedded commas/newlines).

export function parseFormsCsv(text: string): { headers: string[]; records: Record<string, string>[] } {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let sawAnyField = false;

  const endField = () => { row.push(field); field = ''; };
  const endRow = () => { endField(); rows.push(row); row = []; sawAnyField = false; };

  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i += 1; continue;
      }
      field += ch; i += 1; continue;
    }
    if (ch === '"') { inQuotes = true; sawAnyField = true; i += 1; continue; }
    if (ch === ',') { sawAnyField = true; endField(); i += 1; continue; }
    if (ch === '\r') {
      if (src[i + 1] === '\n') i += 1;
      endRow(); i += 1; continue;
    }
    if (ch === '\n') { endRow(); i += 1; continue; }
    field += ch; sawAnyField = true; i += 1;
  }
  // A trailing newline must not manufacture a bogus empty final row; a real
  // unterminated last line (no trailing newline) must still be kept.
  if (field.length > 0 || sawAnyField || row.length > 0) endRow();

  const [headerRow, ...dataRows] = rows;
  const headers = headerRow ?? [];
  const records = dataRows
    .filter((r) => !(r.length === 1 && r[0] === ''))
    .map((r) => {
      const record: Record<string, string> = {};
      headers.forEach((h, idx) => { record[h] = r[idx] ?? ''; });
      return record;
    });
  return { headers, records };
}

// ─── Time / duration ─────────────────────────────────────────────────────────

/** "just now" / "12m ago" / "3h ago" / "2d ago". Returns "—" for an unparsable timestamp. */
export function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  // Through lib/pgTimestamp, not a bare Date.parse. Measured rather than
  // assumed: V8 DOES accept the raw wire shape `2026-09-08 08:19:23+00`, so
  // this was not broken. What it does not accept is the half-normalised
  // `2026-09-08T08:19:23+00` — a space swapped for a T without also widening
  // `+00` to `+00:00` — which is Invalid Date. The shared parser handles both
  // plus `…Z`; a bare parse handles only some, and pgTimestamp.ts's own header
  // gives the reason to route through it anyway: "one question answered by two
  // functions is how the two answers drift apart."
  const then = pgTimestampMs(iso);
  if (Number.isNaN(then)) return '—';
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (elapsedSeconds < 60) return 'just now';
  const minutes = Math.floor(elapsedSeconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** "4m 07s" between two timestamps, or "—" while there is no finish time yet
 * (or either timestamp fails to parse). Never claims a duration that wasn't measured. */
export function formatDuration(startedAt: string | null | undefined, finishedAt: string | null | undefined): string {
  if (!startedAt || !finishedAt) return '—';
  const start = Date.parse(startedAt);
  const finish = Date.parse(finishedAt);
  if (Number.isNaN(start) || Number.isNaN(finish) || finish < start) return '—';
  const durationSeconds = Math.floor((finish - start) / 1000);
  const minutes = Math.floor(durationSeconds / 60);
  return `${minutes}m ${String(durationSeconds % 60).padStart(2, '0')}s`;
}

// ─── Submission revision grouping ────────────────────────────────────────────
// One team's answers to one form are ONE submission, however many times it was
// re-ingested. Re-ingestions are "revisions" (r2, r3, …); every revision but the
// newest is "superseded" and must not be acted on — see docs/assessment-tenant.md
// and the source app's SubmissionsList.tsx header comment.

/** `2` for `sub-...-r2`, `1` for a base envelope id with no `-rN` suffix. */
export function revisionNumber(envelopeId: string): number {
  const match = /-r(\d+)$/.exec(envelopeId);
  return match ? Number(match[1]) : 1;
}

/** `r3` for a re-ingestion, `original` for the first submission. */
export function revisionLabel(envelopeId: string): string {
  const n = revisionNumber(envelopeId);
  return n === 1 ? 'original' : `r${n}`;
}

/**
 * Wire envelope → list row. The listing used to read a `submissions` array the
 * API never sent and white-screened on `undefined.map`; the API's `groups`
 * have a different shape again, so revision grouping is left to
 * `groupSubmissions`' own derivation from the `-rN` suffixes, which is the
 * same rule the server applies.
 */
export function envelopesToListItems(envelopes: ApiSubmissionEnvelope[]): SubmissionListItem[] {
  return envelopes.map((e) => {
    const links = e.links ?? [];
    const rev = typeof e.revision === 'number' ? e.revision : Number.parseInt(String(e.revision ?? '1'), 10) || 1;
    return {
      envelope_id: e.envelope_id,
      team_id: e.team_id,
      team_name_raw: e.team_name_raw,
      submitter_name: e.submitter?.name ?? e.submitter?.email ?? '—',
      submitted_at: e.submitted_at,
      ingested_at: e.ingested_at,
      links_pending: links.filter((l) => (l.status ?? 'pending') === 'pending').length,
      links_total: links.length,
      scored: e.status === 'scored' || e.status === 'processed',
      form_id: e.source?.form_submission_id != null ? String(e.source.form_submission_id) : null,
      revision: rev,
    };
  });
}

const groupKeyOf = (row: SubmissionListItem): string =>
  row.form_id
    ? `${row.team_id}::form:${row.form_id}`
    : `${row.team_id}::base:${row.envelope_id.replace(/-r\d+$/, '')}`;

/** A submission's team-name resolution: which name to show as the primary
 * label, and — only when there's something worth flagging — the submitter's
 * own text as secondary. A hand-matched row's `team_name_raw` is whatever the
 * submitter typed before a person picked the real team; once a `teamId` is
 * known, the roster's name for it is the truth (a raw "Ledger Reconciliation"
 * next to a resolved "TEAM-007" — which is really "Internal Tools" — must
 * never render as if TEAM-007 were named "Ledger Reconciliation"). */
export interface ResolvedTeamName {
  /** The matched team's real name, or the submitted text when there is no
   *  match (still unknown, or matched to a team missing from the roster). */
  teamName: string;
  /** The submitter's own team-name text, kept only when a genuine match
   *  exists AND it differs (case/whitespace-insensitive) from that match. */
  submittedTeamName: string | null;
}

/** Resolve one row's display name against the team roster. Pure and total —
 * an absent `teamId` or a roster miss both fall back to the raw text rather
 * than asserting a name that doesn't exist. */
export function resolveTeamName(
  teamId: string | null | undefined,
  teamNameRaw: string,
  teamsById: ReadonlyMap<string, string>,
): ResolvedTeamName {
  const matched = teamId ? teamsById.get(teamId) : undefined;
  if (!matched) return { teamName: teamNameRaw, submittedTeamName: null };
  const sameName = matched.trim().toLowerCase() === teamNameRaw.trim().toLowerCase();
  return { teamName: matched, submittedTeamName: sameName ? null : teamNameRaw };
}

export interface RowStatusDisplay {
  label: string;
  tone: ChipTone;
}

/**
 * The step-2 preview table's status chip, driven by the row's CURRENT match
 * state rather than the raw parse-time `status` alone. A row parses in as
 * `unknown_team` (amber "Unknown team" chip) when the Forms export's team
 * name didn't resolve to a roster id — but the wizard lets the operator
 * match it to a team right there in the row, and once matched the row is
 * counted as ready to commit (`isReady`/`blockedCount` in PreviewStep.tsx
 * key off the same "has a team id, from either source" fact). The chip was
 * keyed off `row.status` directly and never re-evaluated, so it kept
 * reading "Unknown team" — disagreeing with a ready-to-commit row right
 * next to it. `hasTeamId` should be true whenever `row.team_id` is set OR
 * the operator picked one in the assignments map (i.e. the same value
 * `PreviewStep`'s `isReady` computes) — that one bit is enough to fold
 * `unknown_team` over into a distinct "Matched" state without touching
 * `new`/`seen`, which were never wrong.
 */
export function resolveRowStatusDisplay(status: RowStatus, hasTeamId: boolean): RowStatusDisplay {
  if (status === 'unknown_team' && hasTeamId) return { label: 'Matched', tone: 'success' };
  if (status === 'new') return { label: 'New', tone: 'success' };
  if (status === 'seen') return { label: 'Seen', tone: 'neutral' };
  return { label: 'Unknown team', tone: 'warning' };
}

/**
 * Fold a listing response into one entry per submission, newest-first. Uses the API's
 * `groups` when present; otherwise derives the same grouping from the rows alone, so an
 * older/simpler mock backend still renders one row per submission rather than a pile of
 * look-alike revisions. `teamsById` (roster id → name) resolves the display name via
 * `resolveTeamName`; omit it (or pass an empty map) to fall back to the submitted text,
 * matching the pre-roster behavior.
 */
export function groupSubmissions(
  rows: SubmissionListItem[],
  groups?: SubmissionGroupRef[],
  teamsById: ReadonlyMap<string, string> = new Map(),
): SubmissionRevisionGroup[] {
  const byId = new Map(rows.map((row) => [row.envelope_id, row] as const));

  if (groups && groups.length > 0) {
    const built: SubmissionRevisionGroup[] = [];
    for (const group of groups) {
      const members = group.envelope_ids
        .map((id) => byId.get(id))
        .filter((row): row is SubmissionListItem => Boolean(row));
      if (members.length === 0) continue;
      const [current, ...superseded] = members;
      const { teamName, submittedTeamName } = resolveTeamName(group.team_id, group.team_name_raw, teamsById);
      built.push({
        key: group.group_id,
        teamId: group.team_id,
        teamName,
        submittedTeamName,
        formId: group.form_id,
        current,
        superseded,
        revisionCount: members.length,
        processed: current.scored,
      });
    }
    return built;
  }

  const buckets = new Map<string, SubmissionListItem[]>();
  rows.forEach((row) => {
    const key = groupKeyOf(row);
    buckets.set(key, [...(buckets.get(key) ?? []), row]);
  });

  return Array.from(buckets.values())
    .map((members) => {
      const ordered = [...members].sort(
        (a, b) =>
          revisionNumber(a.envelope_id) - revisionNumber(b.envelope_id) ||
          (a.ingested_at ?? '').localeCompare(b.ingested_at ?? '') ||
          a.envelope_id.localeCompare(b.envelope_id),
      );
      const current = ordered[ordered.length - 1];
      const { teamName, submittedTeamName } = resolveTeamName(current.team_id, current.team_name_raw, teamsById);
      return {
        key: ordered[0].envelope_id,
        teamId: current.team_id,
        teamName,
        submittedTeamName,
        formId: current.form_id,
        current,
        superseded: ordered.slice(0, -1).reverse(),
        revisionCount: ordered.length,
        processed: current.scored,
      };
    })
    .sort(
      (a, b) =>
        (b.current.ingested_at ?? '').localeCompare(a.current.ingested_at ?? '') ||
        b.current.envelope_id.localeCompare(a.current.envelope_id),
    );
}

// ─── Fetch-links wizard step ───────────────────────────────────────────────
// Shared by the step's own "Continue" button and the wizard shell's bottom
// "Next" button (SubmissionsPage.tsx) so the two controls can never disagree
// about whether every evidence link has been marked fetched or skipped.

/** Structurally just enough of a commit result row (or an equivalent live-status
 * projection of one) to check link completeness — accepts `CommitResultRow[]` as-is. */
export interface LinksStepResultLike {
  links: { status: LinkStatus }[];
}

/** True once every link across every committed result is fetched or skipped —
 * an envelope with no links at all never blocks. */
export function linksStepComplete(results: LinksStepResultLike[]): boolean {
  return results.every((r) => r.links.every((l) => l.status !== 'pending'));
}

/** Count of links still `pending` across every result. */
export function countPendingLinks(results: LinksStepResultLike[]): number {
  return results.reduce((n, r) => n + r.links.filter((l) => l.status === 'pending').length, 0);
}

/** "1 link still needs to be marked fetched or skipped before processing." /
 * "2 links still need to be marked fetched or skipped before processing." —
 * subject-verb agreement was wrong for the singular case. Returns '' when
 * nothing is pending (nothing to announce). */
export function pendingLinksBanner(count: number): string {
  if (count <= 0) return '';
  const noun = count === 1 ? 'link' : 'links';
  const verb = count === 1 ? 'needs' : 'need';
  return `${count} ${noun} still ${verb} to be marked fetched or skipped before processing.`;
}

// ─── Agent-run launch response → operator message ────────────────────────────
// docs/agent-runs.md §1 "Response codes on launch" — every one of these must be
// explained in the UI, never left as a bare HTTP status.

export interface LaunchOutcome {
  /** True for 202 — the caller should toast success and add the run row. */
  ok: boolean;
  message: string;
}

/** Maps a launch response's status (+ optional server `detail`) to what the operator
 * should be told. 202 always wins regardless of body shape — the run is accepted. */
export function launchResponseMessage(status: number, detail?: string | null): LaunchOutcome {
  if (status === 202) return { ok: true, message: 'Run started.' };
  switch (status) {
    case 400:
      return { ok: false, message: detail?.trim() || "That command couldn't be started — check the arguments." };
    case 403:
      return { ok: false, message: 'Runs need an authenticated operator.' };
    case 409:
      return { ok: false, message: 'Already running for this team.' };
    case 429:
      return { ok: false, message: 'Concurrency cap reached — wait for a run to finish and try again.' };
    default:
      return { ok: false, message: detail?.trim() || `Couldn't start the run (HTTP ${status}).` };
  }
}

/** Where a feedback action POSTs. Keyed by the wire's `task_id`, not an `id`. */
export function feedbackActionPath(task: Pick<FeedbackTask, 'task_id'>, action: 'resolve' | 'dismiss'): string {
  return `/api/assessment/feedback/${encodeURIComponent(task.task_id)}/${action}`;
}

// ─── Run ledger ← SSE reducer ─────────────────────────────────────────────────
// The Runs page's launcher must react to its own launch: `assessment-broker.ts`
// publishes `run.*` on the same GET /events stream the Workspace explorer already
// consumes (./knowledge/useAssessmentEvents.ts) — reused here rather than a
// second SSE client. A pure reducer so it's testable without mounting the page;
// unrelated event types (`knowledge.*`) are a no-op, not an error.

export function applyRunEvent(runs: RunRecord[], event: AssessmentSSEEvent): RunRecord[] {
  switch (event.type) {
    case 'run.started': {
      // A reconnect can replay an already-known run.started — never duplicate the row.
      if (runs.some((r) => r.id === event.run_id)) return runs;
      const started: RunRecord = {
        id: event.run_id, command: event.command, team_id: event.team_id, status: 'running',
        started_at: event.ts, finished_at: null, summary: null, error: null, progress: null,
      };
      return [started, ...runs];
    }
    case 'run.progress':
      return runs.map((r) => (r.id === event.run_id ? { ...r, progress: { phase: 'running', detail: `${event.percent}%` } } : r));
    case 'run.completed':
      return runs.map((r) => (r.id === event.run_id
        ? { ...r, status: 'completed', finished_at: event.ts, summary: event.summary, progress: null }
        : r));
    case 'run.failed':
      return runs.map((r) => (r.id === event.run_id
        ? { ...r, status: 'failed', finished_at: event.ts, error: event.reason, progress: null }
        : r));
    default:
      return runs;
  }
}

/**
 * Split the open feedback queue into what the TEAM owes and what YOU owe.
 *
 * A `follow_up` is a question the team still owes the assessment — the thing
 * the Question queue's title, description and "click a row to answer it" hint
 * all describe. Anything else (today `exception_review`: approve or deny an
 * N/A request) runs the other way: a decision the assessor owes, and one you
 * do not "answer".
 *
 * Counting them together under "Open questions" made three things wrong at
 * once. The number disagreed with the Assessor's-desk tile for what reads as
 * the same queue — 25 against 24 — because that tile sums each team's
 * `followups_open`, which is follow-ups only. The label called a decision a
 * question. And the kind was rendered nowhere, so the one odd row was
 * indistinguishable from the other twenty-four.
 *
 * The queue still LISTS everything; only the headline count is split, so no
 * work disappears from view.
 */
export function splitOpenFeedback(tasks: readonly FeedbackTask[]): {
  questions: FeedbackTask[];
  decisions: FeedbackTask[];
  teamsWithOpenQuestions: number;
} {
  const open = tasks.filter((t) => t.status === 'OPEN');
  const questions = open.filter((t) => t.kind === 'follow_up');
  return {
    questions,
    decisions: open.filter((t) => t.kind !== 'follow_up'),
    teamsWithOpenQuestions: new Set(questions.map((t) => t.team_id)).size,
  };
}

