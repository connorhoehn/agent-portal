// Knowledge — one journey for "where the agents' knowledge comes from".
//
// This replaces two nav destinations that were really one job. "Knowledge
// Bases" listed registry rows; "Ingest" had six sibling pages — summary, crawl
// targets, run history, data sources, storage, schedules — presented as peers
// when they are consecutive stages of a single pipeline. Neither said whether
// any of it was working, and neither connected to the rest of the app: nothing
// showed that these documents are what agents retrieve, or what the sweeps
// read.
//
// The order here is the order things actually happen: sources produce
// documents, documents land in storage, storage syncs into a knowledge base,
// and agents retrieve from it. Everything above that is what is wrong right
// now, because a knowledge pipeline that is quietly broken looks identical to
// one that is idle.

import { useCallback, useState } from 'react';
import { Link } from 'react-router';
import { PageSection, Card } from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { toastPending, toastSuccess, toastError } from '../../lib/toastStore';
import { DocumentDropzone } from '../../components/knowledge/DocumentDropzone';
import { ShareLinks } from '../../components/knowledge/ShareLinks';

type DriftKind = 'missing' | 'unregistered' | 'unprovisioned' | 'status-drift' | 'ok';

interface Reconciled {
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

interface IngestJob { jobId?: string; status?: string; startedAt?: string }
interface CrawlTarget { id: string; name?: string; url?: string; enabled?: boolean }
interface StorageBreakdown { totalObjects?: number; totalBytes?: number; chunks?: number }

const DRIFT_TONE: Record<DriftKind, string> = {
  missing: 'bg-danger-bg text-danger',
  unregistered: 'bg-warning-bg text-warning',
  unprovisioned: 'bg-surface-hover text-text-tertiary',
  'status-drift': 'bg-warning-bg text-warning',
  ok: 'bg-success-bg text-success',
};

const DRIFT_LABEL: Record<DriftKind, string> = {
  missing: 'points at nothing',
  unregistered: 'not registered',
  unprovisioned: 'never created',
  'status-drift': 'status disagrees',
  ok: 'in sync',
};

function bytes(n: number | undefined): string {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

function when(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const d = new Date(iso);
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return d.toLocaleDateString();
}

export default function KnowledgeHomePage() {
  const { data: rec, error: recError, refresh: refreshRec } =
    useFetch<{ entries: Reconciled[]; problem?: string }>('/api/admin/kb-registry/reconcile', 30_000);
  const { data: jobs } = useFetch<{ jobs: IngestJob[] }>('/api/ingest/jobs?limit=10', 30_000);
  const { data: targets } = useFetch<{ targets: CrawlTarget[] }>('/api/ingest/crawl-targets', 60_000);
  const { data: storage } = useFetch<StorageBreakdown>('/api/ingest/storage', 60_000);

  const [busy, setBusy] = useState<string | null>(null);

  const entries = rec?.entries ?? [];
  const live = entries.filter((e) => e.liveKbId);
  const problems = entries.filter((e) => e.drift !== 'ok');
  const docs = entries.reduce((n, e) => n + (e.documentCount ?? 0), 0);
  const dataSources = live.reduce((n, e) => n + (e.dataSourceCount ?? 0), 0);
  const lastSync = live
    .map((e) => e.lastSyncAt)
    .filter(Boolean)
    .sort()
    .reverse()[0] ?? null;

  const adopt = useCallback(async (slug: string, kbId: string) => {
    setBusy(slug);
    const tid = toastPending('Repointing the registry', `${slug} → ${kbId}`);
    try {
      const res = await fetch('/api/admin/kb-registry/reconcile/adopt', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug, kbId }),
      });
      const body = await res.json() as { status?: string; error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      toastSuccess(tid, 'Registry updated', `${slug} now points at ${kbId} (${body.status})`);
      refreshRec();
    } catch (err) {
      toastError(tid, 'Could not repoint', (err as Error).message);
    } finally { setBusy(null); }
  }, [refreshRec]);

  /**
   * Rows that may adopt an unclaimed knowledge base.
   *
   * Only broken pointers — a row that names an id which does not exist is
   * unambiguously wrong, and repointing it is a repair. A row that was never
   * provisioned is a different situation: "newsroom has no knowledge base yet"
   * is not evidence that it should claim the documents one, and offering that
   * as a button invites someone to make two corpora silently share an index.
   */
  const adopters = entries.filter((e) => e.slug && e.drift === 'missing');

  /**
   * A knowledge base that is in sync with the account and has a data source,
   * but has never ingested anything, while storage is not empty.
   *
   * Both halves matter: without storage content there is nothing to sync, and
   * without a data source the sync call is rejected outright — offering the
   * button in either case would be offering a failure.
   */
  const syncTarget = entries.find(
    (e) => e.id && e.drift === 'ok' && e.liveKbId && (e.dataSourceCount ?? 0) > 0,
  ) ?? null;
  // Behind, not merely never run. A sync that ran once and has been out of
  // date ever since reports a recent, successful job — indistinguishable from
  // a current index unless you compare what it covered against what is in
  // storage now. Both states get the same offer, with different wording.
  const stored = storage?.totalObjects ?? 0;
  const scanned = syncTarget?.lastSyncScanned ?? null;
  const behind = stored > 0 && (!lastSync || (scanned !== null && scanned < stored));
  const neverRan = !lastSync;

  const startSync = useCallback(async (id: string, name: string) => {
    setBusy('sync');
    const tid = toastPending('Starting ingestion', name);
    try {
      const res = await fetch(`/api/admin/kb-registry/${id}/sync`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: 'Manual sync from Knowledge' }),
      });
      const body = await res.json() as { jobId?: string; error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      toastSuccess(tid, 'Ingestion started', `Job ${body.jobId} — this runs in the background.`);
      refreshRec();
    } catch (err) {
      toastError(tid, 'Could not start ingestion', (err as Error).message);
    } finally { setBusy(null); }
  }, [refreshRec]);

  return (
    <PageSection
      title="Knowledge"
      description="Where the agents' knowledge comes from — sources, ingestion, and the knowledge bases they retrieve from."
    >
      {recError && (
        <UnavailableNotice
          error={recError}
          what="the knowledge base registry"
          source="The registry lives in Aurora and is compared against Bedrock"
          onRetry={refreshRec}
          className="mb-4"
        />
      )}
      {rec?.problem && !recError && (
        <UnavailableNotice error={rec.problem} what="the live account comparison" className="mb-4" />
      )}

      {/* ── Right now ────────────────────────────────────────────────────── */}
      <div className="grid gap-4 mb-5 grid-cols-1 md:grid-cols-3">
        <Card padding="md">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-text-tertiary">Knowledge bases</div>
          <div className="flex items-baseline gap-2 mt-1">
            <span className="text-[24px] font-bold leading-none">{recError ? '—' : live.length}</span>
            <span className="text-[12px] text-text-secondary">
              {recError ? 'unknown' : `${live.filter((e) => e.liveStatus === 'ACTIVE').length} active in AWS`}
            </span>
          </div>
          <div className="text-[11px] text-text-tertiary mt-2 leading-snug">
            Counted from the account, not from the registry.
          </div>
        </Card>

        <Card padding="md">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-text-tertiary">Documents indexed</div>
          <div className="flex items-baseline gap-2 mt-1">
            <span className="text-[24px] font-bold leading-none">{recError ? '—' : docs.toLocaleString()}</span>
            <span className="text-[12px] text-text-secondary">in the graph</span>
          </div>
          <div className="text-[11px] text-text-tertiary mt-2 leading-snug">
            These are what <Link to="/iq/work" className="text-primary no-underline hover:underline">sweeps</Link> read
            and what agents cite.
          </div>
        </Card>

        <Card padding="md">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-text-tertiary">Needs attention</div>
          <div className="flex items-baseline gap-2 mt-1">
            <span className={`text-[24px] font-bold leading-none ${problems.length ? 'text-warning' : ''}`}>
              {recError ? '—' : problems.length}
            </span>
            <span className="text-[12px] text-text-secondary">
              {problems.length === 1 ? 'disagreement' : 'disagreements'}
            </span>
          </div>
          <div className="text-[11px] text-text-tertiary mt-2 leading-snug">
            Between what the registry claims and what the account has.
          </div>
        </Card>
      </div>

      {/* ── What is wrong ────────────────────────────────────────────────── */}
      {problems.length > 0 && (
        <Card padding="none" className="mb-5 overflow-hidden border-warning/40">
          <div className="px-3.5 py-3 border-b border-border">
            <span className="text-xs font-semibold text-warning tracking-wide select-none">REGISTRY vs ACCOUNT</span>
            <span className="text-[11px] text-text-tertiary ml-2">
              the registry is bookkeeping about AWS resources; nothing kept it honest
            </span>
          </div>
          {problems.map((e) => (
            <div key={e.slug ?? e.liveKbId} className="px-3.5 py-3 border-b border-border last:border-b-0 flex items-start gap-3">
              <span className={`text-[10px] font-semibold px-2 py-0.5 rounded shrink-0 ${DRIFT_TONE[e.drift]}`}>
                {DRIFT_LABEL[e.drift]}
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-semibold text-text-primary">
                  {e.name}{e.slug ? <span className="text-text-tertiary font-normal"> · {e.slug}</span> : null}
                </div>
                <div className="text-[12px] text-text-secondary mt-1 leading-snug">{e.detail}</div>
                <div className="text-[11px] text-text-tertiary mt-1 font-mono">
                  registry: {e.registryKbId ?? '—'} · account: {e.liveKbId ?? '—'}
                  {e.liveStatus ? ` (${e.liveStatus})` : ''}
                </div>
              </div>

              {/* The only automatic repair offered. Creating, deleting or
                  syncing are decisions; repointing a row at a knowledge base
                  that demonstrably exists is not. */}
              {/* A row that was never provisioned needs a knowledge base
                  created, which builds real infrastructure and costs money —
                  so it links to the row's own page rather than firing from
                  here. Naming a problem without a route to fixing it is how
                  the old registry page left people stuck. */}
              {e.drift === 'unprovisioned' && e.id && (
                <Link
                  to={`/admin/knowledge-bases/${e.id}`}
                  className="shrink-0 px-2.5 py-1 rounded-md border border-border bg-surface text-[11px] font-semibold text-text-secondary no-underline hover:border-primary hover:text-primary transition-colors"
                >
                  set it up →
                </Link>
              )}

              {e.drift === 'unregistered' && e.liveKbId && adopters.length > 0 && (
                <div className="flex gap-1.5 shrink-0">
                  {adopters.map((target) => (
                    <button
                      key={target.slug}
                      disabled={busy === target.slug}
                      onClick={() => void adopt(target.slug as string, e.liveKbId as string)}
                      className="px-2.5 py-1 rounded-md border border-primary/50 bg-surface text-[11px] font-semibold text-primary cursor-pointer hover:bg-primary hover:text-white transition-colors disabled:opacity-50"
                    >
                      {busy === target.slug ? 'repointing…' : `point “${target.slug}” here`}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </Card>
      )}

      {/* ── The one state the pipeline gets stuck in ─────────────────────── */}
      {/* Documents sitting in storage that the knowledge base has never read
          is invisible in every per-stage view: storage looks healthy (objects
          are there), the knowledge base looks healthy (it exists and is
          ACTIVE), and only the seam between them is broken. It is also the
          state a fresh environment starts in, so it is worth an action rather
          than a number. */}
      {behind && syncTarget && (
        <Card padding="md" className="mb-5 border-primary/40">
          <div className="flex items-start gap-3">
            <div className="flex-1 min-w-0">
              <div className="text-[13px] font-semibold text-text-primary">
                {neverRan
                  ? `${stored.toLocaleString()} documents are in storage but have never been indexed`
                  : `The knowledge base is behind storage — it last indexed ${(scanned ?? 0).toLocaleString()} of ${stored.toLocaleString()} documents`}
              </div>
              <div className="text-[12px] text-text-secondary mt-1 leading-snug">
                Agents can only cite what the knowledge base has read. Syncing starts a Bedrock ingestion
                job over <span className="font-mono">{syncTarget.name}</span>; it runs in the background and
                costs embedding tokens once per document that changed.
              </div>
            </div>
            <button
              disabled={busy === 'sync'}
              onClick={() => void startSync(syncTarget.id as string, syncTarget.name)}
              className="shrink-0 px-3 py-1.5 rounded-md border-none bg-primary text-white text-[12px] font-semibold cursor-pointer hover:opacity-90 disabled:opacity-50"
            >
              {busy === 'sync' ? 'starting…' : 'Sync now'}
            </button>
          </div>
        </Card>
      )}

      {/* ── The pipeline, in the order it happens ────────────────────────── */}
      <Card padding="none" className="overflow-hidden">
        <div className="px-3.5 py-3 border-b border-border flex items-center gap-2">
          <span className="text-xs font-semibold text-text-secondary tracking-wide select-none">THE PIPELINE</span>
          <span className="text-[11px] text-text-tertiary">source → storage → knowledge base → agents</span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 divide-y md:divide-y-0 md:divide-x divide-border">
          <Stage
            title="Sources"
            value={targets ? String(targets.targets?.length ?? 0) : '—'}
            unit="crawl targets"
            detail={
              (targets?.targets ?? []).filter((t) => t.enabled !== false).length > 0
                ? `${(targets?.targets ?? []).filter((t) => t.enabled !== false).length} enabled`
                : 'Nothing is configured to pull content in.'
            }
            to="/admin/ingest/crawl"
            cta="Manage sources"
          />
          <Stage
            title="Ingestion"
            value={jobs ? String(jobs.jobs?.length ?? 0) : '—'}
            unit="recent jobs"
            detail={
              jobs?.jobs?.[0]?.status
                ? `Last job ${jobs.jobs[0].status.toLowerCase()} ${when(jobs.jobs[0].startedAt)}`
                : 'No ingestion has run.'
            }
            to="/admin/ingest/sources"
            cta="Run history"
          />
          <Stage
            title="Storage"
            value={storage?.totalObjects != null ? storage.totalObjects.toLocaleString() : '—'}
            unit="objects in S3"
            detail={storage?.totalBytes ? bytes(storage.totalBytes) : 'Nothing stored yet.'}
            to="/admin/ingest/storage"
            cta="Browse storage"
          />
          <Stage
            title="Knowledge base"
            value={recError ? '—' : String(live.length)}
            unit={live.length === 1 ? 'in the account' : 'in the account'}
            detail={
              dataSources === 0
                ? 'No data source attached — nothing can sync into it.'
                : `${dataSources} data source${dataSources === 1 ? '' : 's'} · last sync ${when(lastSync)}`
            }
            to="/admin/knowledge/registry"
            cta="Registry detail"
          />
        </div>

        {/* Who consumes it — the connection that was missing entirely. */}
        <div className="px-3.5 py-3 border-t border-border bg-surface-hover/40 text-[12px] text-text-secondary leading-relaxed">
          Agents retrieve from these knowledge bases on every answer in{' '}
          <Link to="/iq/invoke" className="text-primary no-underline hover:underline">Ask</Link>, and the
          documents they contain are what the{' '}
          <Link to="/iq/work" className="text-primary no-underline hover:underline">stale-document sweep</Link>{' '}
          reads when it looks for knowledge nothing references.
        </div>
      </Card>
      {/* ── Getting documents in ──────────────────────────────────────────
          Below the pipeline, because the pipeline is what explains where an
          upload lands. Sources/crawling is one way in; these are the other
          two, and until now neither existed in working form. */}
      <div className="grid gap-4 mt-5 grid-cols-1 lg:grid-cols-2">
        <DocumentDropzone
          target={syncTarget && syncTarget.id
            ? { id: syncTarget.id, slug: syncTarget.slug ?? '', name: syncTarget.name }
            : null}
          onUploaded={() => refreshRec()}
        />
        <ShareLinks kbSlug={syncTarget?.slug ?? null} />
      </div>

    </PageSection>
  );
}

function Stage({ title, value, unit, detail, to, cta }: {
  title: string; value: string; unit: string; detail: string; to: string; cta: string;
}) {
  return (
    <div className="px-3.5 py-3 flex flex-col">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-text-tertiary">{title}</div>
      <div className="flex items-baseline gap-1.5 mt-1">
        <span className="text-[20px] font-bold text-text-primary leading-none">{value}</span>
        <span className="text-[11px] text-text-secondary">{unit}</span>
      </div>
      <div className="text-[11px] text-text-tertiary mt-1.5 leading-snug flex-1">{detail}</div>
      <Link to={to} className="text-[11px] text-primary no-underline hover:underline mt-2">{cta} →</Link>
    </div>
  );
}
