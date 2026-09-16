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
// The registry list sits above the fold — it is the thing this page exists to
// show — with a single filter row above it. Everything else (the "right now"
// numbers, the pipeline stages) is a stat strip, not a stack of cards: they
// are context for the list, not content in their own right. The order below
// that is the order things actually happen: sources produce documents,
// documents land in storage, storage syncs into a knowledge base, and agents
// retrieve from it.

import { useCallback, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import {
  Banner, Button, Chip, DataTable, Inline, InlineAlert, MetaLine, PageSection,
  SearchInput, SegmentedControl, StatStrip, Toolbar,
  type DataTableColumn,
} from '@connorhoehnslalom/ui-components/shared';
import { useCapabilities } from '../../lib/capabilities';
import { useFetch } from '../../hooks/useFetch';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import {
  toastPending, toastSuccess, toastError, toastInfo, dismissToast,
} from '../../lib/toastStore';
import { DocumentDropzone } from '../../components/knowledge/DocumentDropzone';
import { ShareLinks } from '../../components/knowledge/ShareLinks';
import {
  DRIFT_LABEL, DRIFT_TONE, adoptableEntries, bytes, computeSyncGap, filterEntries,
  lastSyncLabel, summarizeEntries, when, type EntryStatusFilter, type Reconciled,
} from './knowledgeFormat';

interface IngestJob { jobId?: string; status?: string; startedAt?: string }
interface CrawlTarget { id: string; name?: string; url?: string; enabled?: boolean }
interface StorageBreakdown { totalObjects?: number; totalBytes?: number; chunks?: number }

const STATUS_OPTIONS = [
  { label: 'All', value: 'all' },
  { label: 'Needs attention', value: 'attention' },
];

/** An ACTIONS cell with no control still needs to say something — an empty
 *  cell on a row that says "broken" reads as a dead end (DEFECTS.md #17). */
function actionHint(text: string) {
  return <Inline as="span" gap="none" className="text-[11px] text-text-tertiary">{text}</Inline>;
}

export default function KnowledgeHomePage() {
  const navigate = useNavigate();

  // Reading the knowledge surface is open to org-leaders; changing it (adopt,
  // sync, upload, share links) requires the ManageKB capability — the same
  // Cedar decision the /api/admin/kb-registry mutations enforce — so those
  // controls are hidden for anyone who would only get a 403 on click. The
  // ingest drill-ins ride the ManageIngest capability (the /api/ingest gate).
  const { can, ready } = useCapabilities();
  const canManage = ready && can('ManageKB');
  const canIngest = ready && can('ManageIngest');

  const { data: rec, isLoading: recLoading, error: recError, refresh: refreshRec } =
    useFetch<{ entries: Reconciled[]; problem?: string }>('/api/admin/kb-registry/reconcile', 30_000);
  const { data: jobs } = useFetch<{ jobs: IngestJob[] }>('/api/ingest/jobs?limit=10', 30_000);
  const { data: targets } = useFetch<{ targets: CrawlTarget[] }>('/api/ingest/crawl-targets', 60_000);
  const { data: storage } = useFetch<StorageBreakdown>('/api/ingest/storage', 60_000);

  const [busy, setBusy] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<EntryStatusFilter>('all');

  const entries = rec?.entries ?? [];
  const { live, problems, docs, dataSources, dataSourcesKnown } = summarizeEntries(entries);
  const adopters = adoptableEntries(entries);
  const filtered = useMemo(
    () => filterEntries(entries, { search, status: statusFilter }),
    [entries, search, statusFilter],
  );

  const stored = storage?.totalObjects ?? 0;
  const {
    syncTarget, behind, neverRan, syncUnknown, running, failed, lastSyncStatus, lastSync,
  } = computeSyncGap(entries, stored);

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

  const startSync = useCallback(async (id: string, name: string) => {
    setBusy('sync');
    const tid = toastPending('Starting ingestion', name);
    try {
      const res = await fetch(`/api/admin/kb-registry/${id}/sync`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: 'Manual sync from Knowledge' }),
      });
      const body = await res.json() as { jobId?: string; error?: string; conflict?: boolean };
      // A 409 with `conflict` means Bedrock refused because a sync is ALREADY
      // running on this data source. That is not a failed action — the indexing
      // the operator wanted is under way — and "Could not start ingestion" in
      // red is the false flag this page exists to stop telling. Resolve the
      // pending toast as information and refresh, so the running banner appears.
      if (res.status === 409 && body.conflict) {
        dismissToast(tid);
        toastInfo('A sync is already running', body.error ?? 'Wait for the current job to finish.');
        refreshRec();
        return;
      }
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      toastSuccess(tid, 'Ingestion started', `Job ${body.jobId} — this runs in the background.`);
      refreshRec();
    } catch (err) {
      toastError(tid, 'Could not start ingestion', (err as Error).message);
    } finally { setBusy(null); }
  }, [refreshRec]);

  const columns: DataTableColumn<Reconciled>[] = [
    {
      key: 'name',
      header: 'Knowledge base',
      sortable: true,
      render: (e) => (
        <Inline gap="xs" align="center" wrap={false}>
          {e.id ? (
            <Link
              to={`/admin/knowledge/registry/${e.id}`}
              onClick={(ev) => ev.stopPropagation()}
              className="text-[13px] font-semibold text-text-primary no-underline hover:text-primary hover:underline truncate"
            >
              {e.name}
            </Link>
          ) : (
            <Inline as="span" gap="none" className="text-[13px] font-semibold text-text-primary truncate">
              {e.name}
            </Inline>
          )}
          {e.slug && (
            <Inline as="span" gap="none" className="text-[11px] text-text-tertiary truncate">· {e.slug}</Inline>
          )}
        </Inline>
      ),
    },
    {
      key: 'drift',
      header: 'Status',
      sortable: true,
      render: (e) => <Chip tone={DRIFT_TONE[e.drift]} size="xs">{DRIFT_LABEL[e.drift]}</Chip>,
    },
    {
      key: 'detail',
      header: 'Detail',
      render: (e) => (
        <Inline as="span" gap="none" className="text-[12px] text-text-secondary">{e.detail}</Inline>
      ),
    },
    {
      key: 'ids',
      header: 'Registry ↔ account',
      render: (e) => (
        <MetaLine
          size="xs" tone="tertiary"
          items={[e.registryKbId ?? '—', e.liveKbId ? `${e.liveKbId}${e.liveStatus ? ` (${e.liveStatus})` : ''}` : '—']}
        />
      ),
    },
    {
      key: 'lastSyncAt',
      header: 'Last sync',
      sortable: true,
      // `lastSyncLabel`, not `when` — see its doc comment. `lastSyncAt` is the
      // newest job's timestamp regardless of outcome, so a bare "2m ago" here
      // rendered a failed sync as a successful one.
      render: (e) => (
        <MetaLine
          size="xs" tone="tertiary"
          items={[lastSyncLabel(e), e.documentCount != null ? `${e.documentCount.toLocaleString()} docs` : null]}
        />
      ),
    },
  ];

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

      {/* ── One filter row, then the registry list — above the fold ──────── */}
      <Toolbar
        className="mb-2 rounded-lg"
        end={(
          <MetaLine
            size="xs" tone="tertiary"
            items={[`${filtered.length} of ${entries.length} knowledge bases`, 'registry vs. the live account']}
          />
        )}
      >
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search by name, slug or id…"
          className="max-w-xs"
        />
        <SegmentedControl options={STATUS_OPTIONS} value={statusFilter} onChange={(v) => setStatusFilter(v as EntryStatusFilter)} size="sm" />
      </Toolbar>

      <DataTable<Reconciled>
        data={filtered}
        columns={columns}
        keyField={(e) => e.id ?? e.slug ?? e.liveKbId ?? e.name}
        loading={recLoading && entries.length === 0}
        emptyMessage={entries.length === 0 ? 'No knowledge bases registered yet.' : 'No knowledge bases match the current filters.'}
        rowActions={(e) => {
          // The only automatic repair offered. Creating, deleting or syncing
          // are decisions; repointing a row at a knowledge base that
          // demonstrably exists is not.
          if (e.drift === 'unprovisioned' && e.id) {
            return (
              <Button
                variant="secondary" size="sm"
                onClick={() => navigate(`/admin/knowledge/registry/${e.id}`)}
              >
                set it up →
              </Button>
            );
          }
          if (e.drift === 'unregistered' && e.liveKbId && adopters.length > 0) {
            if (!canManage) {
              return actionHint('Repointing needs Manage KB — an HR admin can do it from Knowledge.');
            }
            return (
              <Inline gap="xs" wrap={false}>
                {adopters.map((target) => (
                  <Button
                    key={target.slug}
                    variant="secondary" size="sm"
                    disabled={busy === target.slug}
                    onClick={() => void adopt(target.slug as string, e.liveKbId as string)}
                  >
                    {busy === target.slug ? 'repointing…' : `point "${target.slug}" here`}
                  </Button>
                ))}
              </Inline>
            );
          }
          // Nothing renders here for `ok` — there's nothing to explain. Every
          // other drift is a row a person came here worried about (DEFECTS.md
          // #17: an empty ACTIONS cell on a row that says "broken" reads as a
          // dead end); the remedy — if one exists at all — is either not
          // available to this role or lives on a different row (adopting
          // happens from the unregistered knowledge base's row, once one
          // shows up), so say so instead of leaving the cell blank.
          if (e.drift === 'missing') {
            return actionHint(
              canManage
                ? 'Repoint this from the matching unregistered knowledge base’s row, once one appears.'
                : 'Repointing needs Manage KB — an HR admin can do it from Knowledge.',
            );
          }
          if (e.drift === 'status-drift') {
            return actionHint(
              canManage
                ? 'Re-sync to refresh the account status.'
                : 'Needs Manage KB — an HR admin can do it from Knowledge.',
            );
          }
          return null;
        }}
        className="mb-5"
      />

      {/* ── Right now ────────────────────────────────────────────────────── */}
      <StatStrip
        aria-label="Knowledge, right now"
        className="mb-5"
        items={[
          {
            label: 'Knowledge bases',
            value: recError ? '—' : live.length,
            hint: recError ? 'unknown' : `${live.filter((e) => e.liveStatus === 'ACTIVE').length} active in AWS — counted from the account`,
          },
          {
            label: 'Documents indexed',
            value: recError ? '—' : docs.toLocaleString(),
            hint: <>in the graph — what <Link to="/iq/work" className="text-primary no-underline hover:underline">sweeps</Link> read and agents cite</>,
          },
          {
            label: 'Needs attention',
            value: recError ? '—' : problems.length,
            tone: problems.length ? 'danger' : 'default',
            hint: `${problems.length === 1 ? 'disagreement' : 'disagreements'} between the registry and the account`,
          },
        ]}
      />

      {/* ── The one state the pipeline gets stuck in ─────────────────────── */}
      {/* Documents sitting in storage that the knowledge base has never read
          is invisible in every per-stage view: storage looks healthy (objects
          are there), the knowledge base looks healthy (it exists and is
          ACTIVE), and only the seam between them is broken. It is also the
          state a fresh environment starts in, so it is worth an action rather
          than a number. */}
      {/* The same seam, when we could not see it. This case used to render as
          the banner below with `neverRan` true — "never been indexed" — which
          was the most alarming reading of a failed read and, against a
          knowledge base holding 157 documents, simply false. An unreadable
          sync history is its own state and says so; `problem` above carries
          the reason and the permission. */}
      {syncUnknown && stored > 0 && (
        <Banner variant="warning" className="mb-5">
          {stored.toLocaleString()} documents are in storage, but the knowledge base&apos;s
          ingestion history could not be read — so this page cannot tell you whether they
          have been indexed. Treat the sync figures below as unknown, not as zero.
        </Banner>
      )}

      {/* A sync is in flight. This had no representation at all: starting one
          made the "behind" banner disappear (a running job reports no scanned
          count, so the gap could not be computed) and the page then looked
          settled while nothing had been indexed yet. Worse, the operator's next
          reading of a still-empty index was "behind" again, and the offered
          action was to start a SECOND ingestion job over the same documents —
          embedding tokens spent twice for one sync. */}
      {running && syncTarget && (
        <Banner variant="info" className="mb-5">
          A sync is running over <strong>{syncTarget.name}</strong>
          {lastSyncStatus ? ` (${lastSyncStatus.replace(/_/g, ' ').toLowerCase()})` : ''} — started{' '}
          {when(syncTarget.lastSyncAt)}. Bedrock reports coverage only when the job finishes, so the
          figures below still describe the previous run. Nothing to do but wait; starting another job
          now would re-embed the same documents.
        </Banner>
      )}

      {/* A run that ended without finishing. Previously this was rendered by
          the banner below as plain "behind", whose copy reads as "nobody has
          synced yet" and whose button is the one that just failed. The status
          is the whole difference between "press sync" and "find out why sync
          does not work", so it is named rather than paraphrased. */}
      {failed && syncTarget && (
        <Banner variant="error" className="mb-5">
          The last sync of <strong>{syncTarget.name}</strong> ended{' '}
          <strong>{(lastSyncStatus ?? 'unsuccessfully').replace(/_/g, ' ').toLowerCase()}</strong>{' '}
          {when(syncTarget.lastSyncAt)}, so the index holds whatever the run before it left. Retrying
          without a cause will most likely fail the same way — check the job's failure reasons in{' '}
          {canIngest
            ? <Link to="/admin/ingest/sources" className="text-primary no-underline hover:underline">ingestion history</Link>
            : <>ingestion history</>}{' '}
          first.
          {canManage && (
            <Inline className="mt-2">
              <Button
                variant="secondary" size="sm"
                disabled={busy === 'sync'}
                onClick={() => void startSync(syncTarget.id as string, syncTarget.name)}
              >
                {busy === 'sync' ? 'starting…' : 'Retry sync'}
              </Button>
            </Inline>
          )}
        </Banner>
      )}

      {behind && syncTarget && (
        <Banner variant="warning" className="mb-5">
          {neverRan
            ? `${stored.toLocaleString()} documents are in storage but have never been indexed.`
            : `The knowledge base is behind storage — it last indexed ${(syncTarget.lastSyncScanned ?? 0).toLocaleString()} of ${stored.toLocaleString()} documents.`}
          {' '}Agents can only cite what the knowledge base has read. Syncing starts a Bedrock ingestion job over{' '}
          <strong>{syncTarget.name}</strong>; it runs in the background and costs embedding tokens once per document
          that changed.
          {canManage && (
            <Inline className="mt-2">
              <Button
                variant="primary" size="sm"
                disabled={busy === 'sync'}
                onClick={() => void startSync(syncTarget.id as string, syncTarget.name)}
              >
                {busy === 'sync' ? 'starting…' : 'Sync now'}
              </Button>
            </Inline>
          )}
        </Banner>
      )}

      {/* ── The pipeline, in the order it happens ────────────────────────── */}
      <StatStrip
        aria-label="The pipeline"
        className="mb-3"
        items={[
          {
            label: 'Sources',
            value: targets ? String(targets.targets?.length ?? 0) : '—',
            hint: (
              <>
                {(targets?.targets ?? []).filter((t) => t.enabled !== false).length > 0
                  ? `${(targets?.targets ?? []).filter((t) => t.enabled !== false).length} enabled`
                  : 'nothing configured to pull content in'}
                {canIngest && <> · <Link to="/admin/ingest/crawl" className="text-primary no-underline hover:underline">manage →</Link></>}
              </>
            ),
          },
          {
            label: 'Ingestion',
            value: jobs ? String(jobs.jobs?.length ?? 0) : '—',
            hint: (
              <>
                {jobs?.jobs?.[0]?.status ? `last ${jobs.jobs[0].status.toLowerCase()} ${when(jobs.jobs[0].startedAt)}` : 'no ingestion has run'}
                {canIngest && <> · <Link to="/admin/ingest/sources" className="text-primary no-underline hover:underline">history →</Link></>}
              </>
            ),
          },
          {
            label: 'Storage',
            value: storage?.totalObjects != null ? storage.totalObjects.toLocaleString() : '—',
            hint: (
              <>
                {storage?.totalBytes ? bytes(storage.totalBytes) : 'nothing stored yet'}
                {canIngest && <> · <Link to="/admin/ingest/storage" className="text-primary no-underline hover:underline">browse →</Link></>}
              </>
            ),
          },
          {
            label: 'Knowledge base',
            value: recError ? '—' : String(live.length),
            hint: (
              <>
                {/* Three states, not two. A null count and a counted zero used
                    to collapse into "no data source attached" — the flat
                    falsehood the reconcile fix was about — and `when(null)`
                    renders an unreadable history as the equally confident
                    "never". */}
                {!dataSourcesKnown
                  ? 'data sources unreadable'
                  : dataSources === 0
                    ? 'no data source attached'
                    : `${dataSources} data source${dataSources === 1 ? '' : 's'} · last sync ${syncUnknown ? 'unreadable' : when(lastSync)}`}
                {' '}· <Link to="/admin/knowledge/registry" className="text-primary no-underline hover:underline">registry →</Link>
              </>
            ),
          },
        ]}
      />

      {/* Who consumes it — the connection that was missing entirely. */}
      <InlineAlert tone="info" className="mb-5">
        Agents retrieve from these knowledge bases on every answer in{' '}
        <Link to="/iq/invoke" className="text-primary no-underline hover:underline">Ask</Link>, and the documents
        they contain are what the{' '}
        <Link to="/iq/work" className="text-primary no-underline hover:underline">stale-document sweep</Link>{' '}
        reads when it looks for knowledge nothing references.
      </InlineAlert>

      {/* ── Getting documents in ──────────────────────────────────────────
          Below the pipeline, because the pipeline is what explains where an
          upload lands. Sources/crawling is one way in; these are the other
          two. Uploading and minting share links are writes — hr-admin only. */}
      {canManage && (
        <Inline wrap gap="md" className="items-stretch [&>*]:flex-1 [&>*]:min-w-[320px]">
          <DocumentDropzone
            target={syncTarget && syncTarget.id
              ? { id: syncTarget.id, slug: syncTarget.slug ?? '', name: syncTarget.name }
              : null}
            onUploaded={() => refreshRec()}
          />
          <ShareLinks kbSlug={syncTarget?.slug ?? null} />
        </Inline>
      )}
    </PageSection>
  );
}
