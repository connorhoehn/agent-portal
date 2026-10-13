// Every change an agent proposed to the org graph, and what you decided.
//
// The write-back path's whole premise is that nothing reaches the graph
// without a human approving it. That promise is only checkable if the record
// of what WAS approved is visible — otherwise "nothing gets through without
// you" is an assertion rather than something you can audit. Eight mentions had
// already been written into the graph by approved proposals with no page that
// showed them, and a failed apply sat with its error readable only via the API.
//
// Ordered by decision time, newest first, because the question this answers is
// "what changed recently?" — not "what is pending", which is the Work page's job.

import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import {
  Button, Card, Chip, EmptyState, FilterChip, Inline, MetaLine, PageSection, SearchInput, Stack, Toolbar, ToolbarGroup,
} from '@connorhoehnslalom/ui-components/shared';
import { CollectionCommandHost } from '../../components/collections/CollectionCommandHost';
import { collectionCommandAdapter } from '../../components/collections/collectionCommands';
import { GRAPH_UPDATES_GRAMMAR, graphUpdatesFilterValue, matchesText } from './workCollectionCommands';
import { useFetch } from '../../hooks/useFetch';
import { useCapabilities } from '../../lib/capabilities';
import { absoluteTime } from '../../lib/relativeTime';
import { toastPending, toastSuccess, toastError } from '../../lib/toastStore';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { writeJson } from '../../lib/writeJson';
import { PROPOSAL_STATUS_CHIP, T } from './workShared';

interface Proposal {
  id: string;
  source: string;
  jobId: string | null;
  findingId: string | null;
  kind: string;
  targetType: string;
  targetId: string;
  payload: Record<string, unknown>;
  rationale: string | null;
  evidence: Record<string, unknown> | null;
  confidence: number | null;
  status: string;
  reviewer: string | null;
  reviewNote: string | null;
  applyError: string | null;
  createdAt: string;
  decidedAt: string | null;
  appliedAt: string | null;
}

const KIND_LABELS: Record<string, string> = {
  link_document_mention: 'Linked a document to an entity',
  add_person_skill: 'Gave a person a skill',
  update_person_title: 'Changed a title',
  add_collaboration: 'Recorded a collaboration',
  add_skill: 'Added a skill',
};

type Filter = 'all' | 'applied' | 'pending' | 'rejected' | 'failed';

/** What actually changed, in the graph's own vocabulary. */
function describe(p: Proposal): string {
  const pl = p.payload;
  switch (p.kind) {
    case 'link_document_mention':
      return `${String(pl['documentId'] ?? p.targetId)} → ${String(pl['entityType'] ?? '?')} ${String(pl['entityId'] ?? '?')}`;
    case 'add_person_skill':
      return `${String(pl['personId'] ?? '?')} → skill ${String(pl['skillId'] ?? '?')}`;
    case 'update_person_title':
      return `${String(pl['personId'] ?? '?')} → "${String(pl['title'] ?? '?')}"`;
    case 'add_collaboration':
      return `${String(pl['personAId'] ?? '?')} ↔ ${String(pl['personBId'] ?? '?')}`;
    case 'add_skill':
      return `${String(pl['skillId'] ?? '?')} (${String(pl['name'] ?? '?')})`;
    default:
      return JSON.stringify(pl);
  }
}

export default function GraphChangesPage() {
  const [filter, setFilter] = useState<Filter>('all');
  // One search state for the toolbar box and the composer.
  const [query, setQuery] = useState('');
  // Retry/reject POST /api/work/proposals/:id/decide (ManageDevbox).
  const { can, ready } = useCapabilities();
  const canManage = ready && can('ManageDevbox');
  // ?job=<id> narrows the audit log to one job's proposals — the landing view
  // for "what did this worker propose?" links from the job detail page.
  const [searchParams, setSearchParams] = useSearchParams();
  const jobFilter = searchParams.get('job');
  // A load that fails (Aurora unreachable, a 500) must not render as "no
  // agent has proposed a change" — that is the false-empty this page
  // dropped `error`/`degraded` on the floor to produce.
  const { data, error, degraded, refresh } = useFetch<{ proposals: Proposal[] }>(
    filter === 'all' ? '/api/work/proposals' : `/api/work/proposals?status=${filter}`,
    15_000,
  );
  const loadFailure = error ?? degraded;

  // A failed apply is actionable, not just history: retry it once its cause is
  // fixed, or reject it off the board. Without this a single bad row sat here
  // permanently with nothing a reviewer could do about it.
  async function decide(p: Proposal, decision: 'approve' | 'reject') {
    const tid = toastPending(decision === 'approve' ? 'Retrying' : 'Rejecting', p.rationale ?? p.kind);
    const res = await writeJson<Proposal>(`/api/work/proposals/${p.id}/decide`, 'POST', { decision });
    if (!res.ok || !res.data) { toastError(tid, 'Could not decide', res.error ?? 'unknown error'); return; }
    if (res.data.status === 'failed') toastError(tid, 'Still failing', res.data.applyError ?? 'unknown error');
    else toastSuccess(tid, res.data.status === 'applied' ? 'Applied to the graph' : 'Rejected');
    void refresh();
  }

  const proposals = useMemo(() => {
    const list = (data?.proposals ?? []).filter((p) => (!jobFilter || p.jobId === jobFilter)
      && matchesText([p.id, p.kind, KIND_LABELS[p.kind], describe(p), p.rationale, p.source, p.targetId, p.applyError], query));
    // Decided work first by recency; anything still undecided sorts by when it
    // was raised, so a pending row never hides below month-old history.
    return list.sort((a, b) =>
      (b.decidedAt ?? b.createdAt).localeCompare(a.decidedAt ?? a.createdAt));
  }, [data, jobFilter, query]);

  const adapter = collectionCommandAdapter(GRAPH_UPDATES_GRAMMAR, {
    setQuery, setFilter: (value) => setFilter(graphUpdatesFilterValue(value) as Filter), refresh, id: 'graph-updates-commands',
    scopeNote: 'Commands search the loaded graph updates and pick a status; they never approve, retry or reject a proposal.',
  });

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const p of data?.proposals ?? []) c[p.status] = (c[p.status] ?? 0) + 1;
    return c;
  }, [data]);

  // "Graph updates", not "Graph changes" — /admin/changes is the CODE review
  // queue, and two queues one word apart kept getting confused.
  return (
    <PageSection title="Graph updates">
      <T as="div" wrap className="text-[13px] text-text-secondary mt-1 mb-5 max-w-3xl leading-relaxed">
        Every change an agent proposed to the org graph and what you decided about it.
        Nothing here was written without an approval — this is the record that makes
        that checkable. Raise new ones from <Link to="/iq/work" className="text-primary no-underline hover:underline">Work</Link>.
      </T>

      {jobFilter && (
        <Inline align="center" gap="sm" className="mb-3 text-[12px] text-text-secondary">
          <T>
            Showing proposals from job&nbsp;
            <Link to={`/iq/work/${jobFilter}`} className="text-primary no-underline hover:underline font-mono">
              {jobFilter.slice(0, 8)}
            </Link>
          </T>
          <Button variant="ghost" size="sm" onClick={() => setSearchParams({}, { replace: true })}>
            clear
          </Button>
        </Inline>
      )}

      <Stack gap="sm" className="min-w-0" data-collection-command-boundary="embedded">
        <Toolbar wrap aria-label="Change filters">
          <ToolbarGroup aria-label="Status">
            {(['all', 'applied', 'pending', 'rejected', 'failed'] as const).map((f) => (
              <FilterChip key={f} active={filter === f} onClick={() => setFilter(f)} size="sm">
                {f}{filter === 'all' && f !== 'all' && counts[f] ? ` (${counts[f]})` : ''}
              </FilterChip>
            ))}
          </ToolbarGroup>
          <ToolbarGroup aria-label="Search">
            <SearchInput size="sm" value={query} onChange={setQuery} placeholder="Search graph updates…" aria-label="Search graph updates" className="w-56 max-w-full" />
          </ToolbarGroup>
        </Toolbar>

        {loadFailure && (
          <UnavailableNotice
            error={loadFailure}
            what="the graph change history"
            source="Proposals are read from Aurora"
            onRetry={refresh}
            className="mb-4"
          />
        )}

        {!loadFailure && (
        <Card padding="none" className="overflow-hidden">
          {proposals.length === 0 ? (
            <EmptyState
              title="Nothing here"
              description={query.trim() ? 'No loaded graph update matches this search.' : filter === 'all'
                ? 'No agent has proposed a graph change yet. Analyse a document finding in Work to produce some.'
                : `No ${filter} changes.`}
            />
          ) : proposals.map((p) => (
            <Inline key={p.id} align="start" gap="md" className="px-3.5 py-3 border-b border-border last:border-b-0 min-w-0">
              <Chip tone={PROPOSAL_STATUS_CHIP[p.status] ?? 'neutral'} size="xs" className="shrink-0">
                {p.status}
              </Chip>

              <Stack gap="xs" className="flex-1 min-w-0">
                <Inline align="center" gap="sm" wrap>
                  <T className="text-[13px] font-semibold text-text-primary">
                    {KIND_LABELS[p.kind] ?? p.kind}
                  </T>
                  <T className="text-[11.5px] text-text-secondary font-mono">{describe(p)}</T>
                </Inline>

                {p.rationale && (
                  <T className="text-[12px] text-text-secondary leading-snug">{p.rationale}</T>
                )}

                {typeof p.evidence?.['quote'] === 'string' && (
                  <T wrap className="text-[12px] text-text-primary pl-2.5 border-l-2 border-primary/40 italic">
                    “{String(p.evidence['quote'])}”
                  </T>
                )}

                {/* A failed apply is the most useful row on this page: it says
                    the graph did NOT change and exactly why. */}
                {p.applyError && (
                  <T className="text-[12px] text-danger">
                    Did not apply — {p.applyError}
                  </T>
                )}

                {canManage && p.status === 'failed' && (
                  <Inline gap="sm">
                    <Button size="sm" variant="secondary" onClick={() => void decide(p, 'approve')}>Retry</Button>
                    <Button size="sm" variant="danger" onClick={() => void decide(p, 'reject')}>Reject it out</Button>
                  </Inline>
                )}

                <MetaLine
                  items={[
                    p.source,
                    p.confidence != null ? `confidence ${(p.confidence * 100).toFixed(0)}%` : null,
                    p.reviewer ? `decided by ${p.reviewer}` : 'undecided',
                    absoluteTime(p.decidedAt ?? p.createdAt),
                    p.jobId && (
                      <Link to={`/iq/work/${p.jobId}`} className="text-primary no-underline hover:underline">
                        from a job →
                      </Link>
                    ),
                  ]}
                />
              </Stack>
            </Inline>
          ))}
        </Card>
        )}
        <CollectionCommandHost adapter={adapter} />
      </Stack>
    </PageSection>
  );
}
