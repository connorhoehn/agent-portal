// Pure derivations for the Knowledge home page — reconciling the registry
// against the live account, the sync-gap detector, and the list's own
// search/status filter. Nothing here is React — see `__tests__/knowledgeFormat.test.ts`.

import type { ChipTone } from '@connorhoehnslalom/ui-components/shared';
import { relativeTime } from '../../lib/relativeTime.ts';

export type DriftKind = 'missing' | 'unregistered' | 'unprovisioned' | 'status-drift' | 'ok';

export interface Reconciled {
  id: string | null;
  slug: string | null;
  name: string;
  tenant: string | null;
  registryKbId: string | null;
  registryStatus: string | null;
  liveKbId: string | null;
  liveStatus: string | null;
  dataSourceCount: number | null;
  lastSyncStatus: string | null;
  lastSyncAt: string | null;
  lastSyncScanned: number | null;
  /** False when the sync read failed — the three nulls above mean nothing. */
  syncStateKnown: boolean;
  documentCount: number | null;
  drift: DriftKind;
  detail: string;
}

export const DRIFT_TONE: Record<DriftKind, ChipTone> = {
  missing: 'danger',
  unregistered: 'warning',
  unprovisioned: 'neutral',
  'status-drift': 'warning',
  ok: 'success',
};

export const DRIFT_LABEL: Record<DriftKind, string> = {
  missing: 'points at nothing',
  unregistered: 'not registered',
  unprovisioned: 'never created',
  'status-drift': 'status disagrees',
  ok: 'in sync',
};

export function bytes(n: number | undefined | null): string {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

export function when(iso: string | null | undefined): string {
  // Delegates to lib/relativeTime rather than laddering here. Every copy of
  // this ladder in the portal had drifted differently — round vs floor at the
  // minute boundary, "just now" under 1 minute vs under 2, and past a week
  // some counted to "100d ago" forever while the shared one switches to a
  // date — so one instant read differently depending which page you were on.
  // The null sentinel below stays because callers here depend on it.
  if (!iso) return 'never';
  return relativeTime(iso);
}

// ─── Registry list — filter row ──────────────────────────────────────────────

export type EntryStatusFilter = 'all' | 'attention';

export function filterEntries(
  entries: Reconciled[],
  opts: { search: string; status: EntryStatusFilter },
): Reconciled[] {
  const q = opts.search.trim().toLowerCase();
  return entries.filter((e) => {
    if (opts.status === 'attention' && e.drift === 'ok') return false;
    if (!q) return true;
    const haystack = [e.name, e.slug, e.registryKbId, e.liveKbId].filter(Boolean).join(' ').toLowerCase();
    return haystack.includes(q);
  });
}

// ─── Summary numbers — feeds the "right now" stat strip ─────────────────────

export interface EntrySummary {
  live: Reconciled[];
  problems: Reconciled[];
  docs: number;
  dataSources: number;
  /** False when any live row's data-source count could not be read, so
   *  `dataSources` is a floor rather than a total — and in particular a zero
   *  must not be rendered as "no data source attached". */
  dataSourcesKnown: boolean;
}

export function summarizeEntries(entries: Reconciled[]): EntrySummary {
  const live = entries.filter((e) => e.liveKbId);
  const problems = entries.filter((e) => e.drift !== 'ok');
  const docs = entries.reduce((n, e) => n + (e.documentCount ?? 0), 0);
  const dataSources = live.reduce((n, e) => n + (e.dataSourceCount ?? 0), 0);
  const dataSourcesKnown = live.every((e) => e.dataSourceCount !== null);
  return { live, problems, docs, dataSources, dataSourcesKnown };
}

/**
 * Rows that may adopt an unclaimed knowledge base. Only broken pointers — a
 * row that names an id which does not exist is unambiguously wrong; a row
 * that was never provisioned is not evidence it should claim documents.
 */
export function adoptableEntries(entries: Reconciled[]): Reconciled[] {
  return entries.filter((e) => e.slug && e.drift === 'missing');
}

// ─── The stuck-pipeline detector ─────────────────────────────────────────────

export interface SyncGap {
  /** The one row eligible to receive a manual "Sync now". */
  syncTarget: Reconciled | null;
  /** Storage holds more than the knowledge base has ever read, or read once
   *  and fallen behind since. */
  behind: boolean;
  /** No sync has ever completed for any live knowledge base. */
  neverRan: boolean;
  /**
   * The sync history of at least one live knowledge base could not be read, so
   * neither `behind` nor `neverRan` is assertable. Both are forced false here
   * and a UI should say it cannot tell instead of picking the scarier story.
   */
  syncUnknown: boolean;
  /** A sync is in flight on the sync target right now. */
  running: boolean;
  /** The sync target's newest job ended without finishing the index. */
  failed: boolean;
  /** The newest job's raw Bedrock status, so a UI can name it rather than
   *  paraphrase it. Null when unknown or when nothing has ever run. */
  lastSyncStatus: string | null;
  lastSync: string | null;
}

// Bedrock `IngestionJobStatus`. Split by the only question this page asks of
// it: is the index still being built, and did the last attempt finish?
const RUNNING_STATUSES = new Set(['STARTING', 'IN_PROGRESS', 'STOPPING']);
const UNFINISHED_STATUSES = new Set(['FAILED', 'STOPPED']);

/**
 * How to render one row's last sync.
 *
 * A bare timestamp reads as success. `lastSyncAt` is the newest job's
 * `updatedAt` **whatever its status**, so a job that failed two minutes ago
 * rendered as "2m ago" beside a document count — which is the sentence a
 * healthy, current index produces. The status is already on the wire; the only
 * reason it read as success is that nothing printed it.
 */
export function lastSyncLabel(e: Reconciled): string {
  if (!e.syncStateKnown) return 'unreadable';
  if (!e.lastSyncAt) return 'never';
  const status = (e.lastSyncStatus ?? '').toUpperCase();
  if (!status || status === 'COMPLETE') return when(e.lastSyncAt);
  return `${status.replace(/_/g, ' ').toLowerCase()} · ${when(e.lastSyncAt)}`;
}

export function computeSyncGap(entries: Reconciled[], storedObjects: number): SyncGap {
  const live = entries.filter((e) => e.liveKbId);
  const lastSync = live
    .map((e) => e.lastSyncAt)
    .filter((v): v is string => Boolean(v))
    .sort()
    .reverse()[0] ?? null;

  // A knowledge base that is in sync with the account and has a data source,
  // but has never ingested anything, while storage is not empty. Both halves
  // matter: without storage content there is nothing to sync, and without a
  // data source the sync call is rejected outright.
  const syncTarget = entries.find(
    (e) => e.id && e.drift === 'ok' && e.liveKbId && (e.dataSourceCount ?? 0) > 0,
  ) ?? null;

  // `lastSync` is a maximum over every live row, so ONE unreadable row is
  // enough to make its absence meaningless — the newest sync could be the one
  // we could not see. This is the portal half of the bug the IAM fix removed
  // the symptom of: with `bedrock:ListIngestionJobs` denied the server returned
  // three honest nulls, and `neverRan = !lastSync` turned them into "this
  // knowledge base has never been indexed" on a page about 157 indexed
  // documents. The next unreadable sync history should read as unreadable.
  const syncUnknown = live.some((e) => !e.syncStateKnown);

  // The status of the run the "Sync now" button would be starting another of.
  // Read from `syncTarget` rather than across every row, because that is the
  // row the button acts on.
  const rawStatus = syncUnknown ? null : syncTarget?.lastSyncStatus ?? null;
  const lastSyncStatus = rawStatus;
  const status = (rawStatus ?? '').toUpperCase();
  const running = RUNNING_STATUSES.has(status);
  const failed = UNFINISHED_STATUSES.has(status);

  // `running` suppresses `behind`, and that is a fix rather than a preference.
  //
  // A job that has started but not finished reports no `numberOfDocumentsScanned`
  // and a fresh `updatedAt`. So `lastSync` was truthy and `scanned` was null,
  // the comparison below fell through to false, and the banner *vanished* the
  // instant a sync began — the page went from "behind" to showing nothing at
  // all while zero documents had been indexed. Suppressing it explicitly means
  // the caller has a `running` state to render instead of an accidental
  // silence.
  const scanned = syncTarget?.lastSyncScanned ?? null;
  const behind = !syncUnknown
    && !running
    && storedObjects > 0
    && (!lastSync || (scanned !== null && scanned < storedObjects));

  // A failed run is not "nobody has synced yet". `neverRan` drives the copy
  // that says documents "have never been indexed", which invites the operator
  // to press the button that just failed instead of reading why.
  const neverRan = !syncUnknown && !lastSync;
  return { syncTarget, behind, neverRan, syncUnknown, running, failed, lastSyncStatus, lastSync };
}
