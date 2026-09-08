// Pure derivations for the Knowledge home page — reconciling the registry
// against the live account, the sync-gap detector, and the list's own
// search/status filter. Nothing here is React — see `__tests__/knowledgeFormat.test.ts`.

import type { ChipTone } from '@connorhoehnslalom/ui-components/shared';

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
  if (!iso) return 'never';
  const d = new Date(iso);
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return d.toLocaleDateString();
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
}

export function summarizeEntries(entries: Reconciled[]): EntrySummary {
  const live = entries.filter((e) => e.liveKbId);
  const problems = entries.filter((e) => e.drift !== 'ok');
  const docs = entries.reduce((n, e) => n + (e.documentCount ?? 0), 0);
  const dataSources = live.reduce((n, e) => n + (e.dataSourceCount ?? 0), 0);
  return { live, problems, docs, dataSources };
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
  lastSync: string | null;
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

  const scanned = syncTarget?.lastSyncScanned ?? null;
  const behind = storedObjects > 0 && (!lastSync || (scanned !== null && scanned < storedObjects));
  const neverRan = !lastSync;
  return { syncTarget, behind, neverRan, lastSync };
}
