// System › Logging (docs/voice-navigator-gaps.md G37): the page's sources,
// its paths, the rule that decides which sources a persona is offered, and the
// one record shape every source's model maps into. Pure, so `node --test`
// checks it without a browser.
//
// Every source reads the routes its own page already reads, so the server's
// gates stay the gates: the voice log's owner rule (routes/voice-log.ts), the
// bot runs page's read gate (routes/bots.ts readGate, the same one on the
// /api/runs façade), ViewObservability on the invocation traces, ViewWork on
// the work queue and the sweep runs' read gate (routes/work.ts). Nothing here
// is stored. A source whose reads all answer 401/403/404, or that the session's
// tenant does not have, is not offered in the source control.

import type { VoiceLogRange } from '../voice/voiceLogModel.ts';

export const LOGGING_PATH = '/iq/logging';
/** The pipelines tenant mounts the same page under its own base (App.tsx), page id `system-logging`. */
export const PIPELINES_LOGGING_PATH = '/pipelines/logging';

/** The base the page is mounted at, from the path it is open on. */
export function loggingBase(pathname: string): string {
  return pathname === '/pipelines' || pathname.startsWith('/pipelines/') ? PIPELINES_LOGGING_PATH : LOGGING_PATH;
}

export type LogSource = 'voice' | 'agents' | 'pipelines' | 'jobs';

/** The filter row's first control, in this order; the first offered one is the page's default. */
export const LOG_SOURCES: ReadonlyArray<{ value: LogSource; label: string; listTitle: string; listLabel: string; description: string }> = [
  { value: 'voice', label: 'Voice', listTitle: 'Sessions', listLabel: 'voice sessions',
    description: 'Your own voice sessions: what ran, what was refused, and every event in order. The server keeps no audio, words or tool arguments.' },
  { value: 'agents', label: 'Agents', listTitle: 'Runs', listLabel: 'agent runs',
    description: 'Bot runs and the agent runtime\'s invocation traces: each run\'s tool calls, its events in order and what it cost.' },
  { value: 'pipelines', label: 'Pipelines', listTitle: 'Runs', listLabel: 'pipeline runs',
    description: 'Pipeline runs as the run projection records them: their steps and their event stream.' },
  { value: 'jobs', label: 'Jobs and sweeps', listTitle: 'Jobs', listLabel: 'jobs and sweeps',
    description: 'Agent jobs on the work queue and the org sweeps\' runs: what each did, when, and how it ended.' },
];

export const sourceMeta = (s: LogSource) => LOG_SOURCES.find((x) => x.value === s)!;
export const isLogSource = (v: unknown): v is LogSource => LOG_SOURCES.some((s) => s.value === v);

/** The sources split into record kinds carry the kind in the path; voice and pipelines have one kind each. */
const KINDED: ReadonlySet<LogSource> = new Set<LogSource>(['agents', 'jobs']);

/** `<base>/<source>[/<kind>]/<id>`; the base is `/iq/logging` unless the page is open in the pipelines tenant. */
export function loggingHref(source: LogSource, kind?: string | null, id?: string | null, root: string = LOGGING_PATH): string {
  const base = `${root}/${source}`;
  if (!id) return base;
  return KINDED.has(source) && kind ? `${base}/${encodeURIComponent(kind)}/${encodeURIComponent(id)}` : `${base}/${encodeURIComponent(id)}`;
}

/** The record a path names; nulls where the path stops short (or names no source). */
export function parseLoggingPath(pathname: string): { source: LogSource | null; kind: string | null; id: string | null } {
  const segs = pathname.split('/').filter(Boolean);
  if ((segs[0] !== 'iq' && segs[0] !== 'pipelines') || segs[1] !== 'logging') return { source: null, kind: null, id: null };
  const source = isLogSource(segs[2]) ? segs[2] : null;
  if (!source) return { source: null, kind: null, id: null };
  const dec = (s: string | undefined) => { if (!s) return null; try { return decodeURIComponent(s); } catch { return s; } };
  if (KINDED.has(source)) return { source, kind: dec(segs[3]), id: dec(segs[4]) };
  return { source, kind: null, id: dec(segs[3]) };
}

/** `/iq/voice-log[/<id>]` (G20) → `/iq/logging[/voice/<id>]`, the query kept. */
export function legacyVoiceLogTarget(sessionId: string | null | undefined, search = ''): string {
  return `${sessionId ? loggingHref('voice', null, sessionId) : LOGGING_PATH}${search}`;
}

// ── Which sources a persona is offered ──────────────────────────────────────

/** What a source's list read answered: rows, a refusal, or something else gone wrong. */
export type ReadOutcome = 'ok' | 'denied' | 'error' | 'pending' | 'skipped';

/** A read's outcome from what `useFetch` holds: 401/403/404 is a refusal (a tenant without the route answers 403 at its mount). */
export function readOutcome(r: { data: unknown; error: string | null; failure?: { status: number | null; kind: string } | null; skipped?: boolean }): ReadOutcome {
  if (r.skipped) return 'skipped';
  if (r.data != null) return 'ok';
  const status = r.failure?.status ?? null;
  if (r.failure?.kind === 'forbidden' || r.failure?.kind === 'session-invalid' || status === 401 || status === 403 || status === 404) return 'denied';
  if (r.error) return 'error';
  return 'pending';
}

/** The tenants each source's routes are mounted for (index.ts): the pipelines runs read through /api/runs in orgiq, /api/pipelines/runs in pipelines. */
const SOURCE_TENANTS: Record<LogSource, readonly string[] | '*'> = {
  voice: '*', agents: ['orgiq'], pipelines: ['orgiq', 'pipelines'], jobs: ['orgiq'],
};

export function sourceInTenant(source: LogSource, tenant: string | null | undefined): boolean {
  const t = SOURCE_TENANTS[source];
  return t === '*' || (!!tenant && t.includes(tenant));
}

/** A source's run list base for a tenant, or null where the tenant has none. */
export function pipelineRunsBase(tenant: string | null | undefined): string | null {
  return tenant === 'pipelines' ? '/api/pipelines/runs' : tenant === 'orgiq' ? '/api/runs' : null;
}

/**
 * The sources the control offers: in the tenant, and at least one of its reads answered (an error that is not a
 * refusal still offers it, so the failure shows in the rail). A source still loading is held back until it answers.
 */
export function offeredSources(tenant: string | null | undefined, reads: Readonly<Record<LogSource, readonly ReadOutcome[]>>): LogSource[] {
  return LOG_SOURCES.map((s) => s.value).filter((s) => {
    if (!sourceInTenant(s, tenant)) return false;
    const r = reads[s].filter((o) => o !== 'skipped');
    return r.some((o) => o === 'ok') || (r.length > 0 && r.every((o) => o === 'error' || o === 'denied') && r.some((o) => o === 'error'));
  });
}

/** The source control's options: the offered sources, and the one open while its reads settle. */
export function sourceOptions(open: LogSource, offered: readonly LogSource[]): Array<{ value: LogSource; label: string }> {
  return LOG_SOURCES.filter((s) => s.value === open || offered.includes(s.value)).map((s) => ({ value: s.value, label: s.label }));
}

// ── Rows, days and the range ────────────────────────────────────────────────

/** One rail row: `kind/id` is unique within a source. */
export interface LogRow {
  source: LogSource;
  kind: string;
  id: string;
  /** When it started: the rail's sort, its day group and its title. */
  at: string;
  subline: string;
}

export const rowKey = (r: Pick<LogRow, 'kind' | 'id'>): string => `${r.kind}/${r.id}`;

/** Newest first; an undated row last. */
export function newestFirst<T extends { at: string }>(rows: readonly T[]): T[] {
  const t = (r: T) => { const n = Date.parse(r.at); return Number.isFinite(n) ? n : -Infinity; };
  return [...rows].sort((a, b) => t(b) - t(a));
}

/** The range filter, applied in the browser to the sources whose reads take no `since`. */
export function inRange(iso: string | null | undefined, range: VoiceLogRange, now: Date = new Date()): boolean {
  if (range === 'all') return true;
  const t = Date.parse(iso ?? '');
  if (!Number.isFinite(t)) return false;
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (range === 'week' ? 6 : 0)).getTime();
  return t >= from;
}

const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;

/** The rail's day groups in the rows' order (newest first): Today, Yesterday, then "6 Nov". */
export function dayGroupsBy<T>(rows: readonly T[], at: (r: T) => string, now: Date = new Date(), locale?: string): {
  groups: Array<{ id: string; title: string; count: number }>;
  groupOf: (r: T) => string;
} {
  const today = dayKey(now);
  const yesterday = dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  const groupOf = (r: T) => { const t = Date.parse(at(r)); return Number.isFinite(t) ? dayKey(new Date(t)) : 'unknown'; };
  const groups: Array<{ id: string; title: string; count: number }> = [];
  for (const r of rows) {
    const id = groupOf(r);
    const g = groups.find((x) => x.id === id);
    if (g) { g.count++; continue; }
    const title = id === today ? 'Today' : id === yesterday ? 'Yesterday' : id === 'unknown' ? 'Undated'
      : new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' }).format(new Date(Date.parse(at(r))));
    groups.push({ id, title, count: 1 });
  }
  return { groups, groupOf };
}

// ── The record: one shape for every source ──────────────────────────────────

export interface LogFact { label: string; value: string; mono?: boolean }
/** A tool call or a step. */
export interface LogCall { id: string; at: string | null; name: string; outcome: string; detail: string; tookMs: number | null }
export interface LogEvent { seq: number; at: string | null; kind: string; data: string }

export interface LogRecord {
  source: LogSource;
  kind: string;
  id: string;
  /** The trail's last crumb. */
  label: string;
  facts: LogFact[];
  /** "Tool calls" or "Steps". */
  callsTitle: string;
  calls: LogCall[];
  events: LogEvent[];
  /** What "Copy as JSON" copies: the reads the record was built from. */
  raw: unknown;
}

/** "8 Nov, 17:49:02" in the reader's locale and zone; the raw string when it does not parse. */
export function when(iso: string | null | undefined, locale?: string): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(t));
}

/** "$0.0125"; "not recorded" for null (unknown cost is unknown, never zero). */
export const usd4 = (v: number | null | undefined): string => (v == null || !Number.isFinite(v) ? 'not recorded' : `$${v.toFixed(4)}`);

export function tookMs(from: string | null | undefined, to: string | null | undefined): number | null {
  const a = Date.parse(from ?? ''), b = Date.parse(to ?? '');
  return Number.isFinite(a) && Number.isFinite(b) && b >= a ? b - a : null;
}

export function took(ms: number | null | undefined): string {
  if (ms == null) return '';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}

/** One line of compact JSON; empty for an empty object. */
export function compact(data: unknown): string {
  if (data == null) return '';
  if (typeof data === 'string') return data;
  const text = JSON.stringify(data);
  return text === '{}' || text === '[]' ? '' : text;
}

/** Timestamped lifecycle marks as numbered events, in time order (undated last); a missing mark is left out. */
export function lifecycleEvents(marks: ReadonlyArray<{ at: string | null | undefined; kind: string; data?: unknown }>): LogEvent[] {
  const dated = marks.filter((m) => m.at);
  const t = (m: { at: string | null | undefined }) => { const n = Date.parse(m.at ?? ''); return Number.isFinite(n) ? n : Infinity; };
  return [...dated].map((m, i) => ({ m, i })).sort((a, b) => t(a.m) - t(b.m) || a.i - b.i)
    .map(({ m }, i) => ({ seq: i + 1, at: m.at ?? null, kind: m.kind, data: compact(m.data) }));
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
