// /admin/ingest/crawl — what content gets pulled in. A target row opens the
// target as a page, `/admin/ingest/crawl/:targetId` (`crawlTargetHref`), the
// targets as the flush list rail beside it, where its settings are edited in
// place and Run now / Delete live (docs/layout-cascade.md, "Records open as
// pages; selections stay put"). A crawl run opens its own page under
// /admin/ingest/history — never a drawer. "New target" stays a dialog: it
// creates, it does not open a record.
import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import {
  Button, Card, CardHeader, Chip, CollectionToolbar, EmptyState, Inline, InlineAlert, LoadingState,
  PageSection, Stack,
} from '@connorhoehnslalom/ui-components/shared';
import { CollectionCommandHost } from '../../components/collections/CollectionCommandHost';
import { CollectionRecordFrame } from '../../components/collections/CollectionRecordFrame';
import { RecordNotFound } from '../../components/UnavailableNotice';
import { useCrumbLabel } from '../../lib/crumbLabels';
import { crawlRunHref, crawlTargetHref, crawlTargetsAdapter, matchesTarget } from './ingestCommands';
import { useCapabilities } from '../../lib/capabilities';
import { sendJson, writeJson } from '../../lib/writeJson';
import { SiteSurveyPanel } from '../../components/ingest/SiteSurveyPanel';
import { ConnectedSources } from '../../components/ingest/ConnectedSources';
import { useFetch } from '../../hooks/useFetch';
import type { CrawlSession, CrawlTarget } from '../../components/ingest/types';
import { TargetsTable } from '../../components/ingest/TargetsTable';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { ActiveRunsStrip } from '../../components/ingest/ActiveRunsStrip';
import { TargetRecord } from '../../components/ingest/TargetRecord';
import { NewTargetModal } from '../../components/ingest/NewTargetModal';
import type { TargetDraft } from '../../components/ingest/NewTargetModal';
import { StatusDot } from '../../components/ingest/ui';

function CrawlTargetsPage() {
  const navigate = useNavigate();
  const { targetId } = useParams<{ targetId?: string }>();
  const openId = targetId ?? null;
  // Target CRUD, runs and cancels all ride /api/ingest (ManageIngest).
  const { can, ready } = useCapabilities();
  const canManage = ready && can('ManageIngest');
  // Same URL + interval as IngestLayout's nav-badge poll and RunHistoryPage
  // — `share: true` so the three collapse into one request per tick instead
  // of three.
  const {
    data: targetsData, isLoading: targetsLoading, refresh: refreshTargets,
    error: targetsError, degraded: targetsDegraded,
  } = useFetch<{ targets: CrawlTarget[] }>(
    '/api/ingest/crawl-targets',
    30_000,
    { share: true },
  );
  const { data: crawlsData, refresh: refreshCrawls } = useFetch<{ crawls: CrawlSession[] }>(
    '/api/ingest/crawls',
    10_000,
    { share: true },
  );

  const targets = targetsData?.targets ?? [];
  const crawls = crawlsData?.crawls ?? [];
  // "No crawl targets yet" is a claim about the server's state. Only make it
  // when the server actually answered.
  const targetsFailure = targetsError ?? targetsDegraded;

  const [actionMessage, setActionMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  const [showNewTarget, setShowNewTarget] = useState(false);

  const [query, setQuery] = useState('');
  const shownTargets = targets.filter(t => matchesTarget(t, query));
  const adapter = crawlTargetsAdapter({ setQuery, refresh: refreshTargets });

  const activeCrawls = useMemo(() => crawls.filter(c => c.status === 'running'), [crawls]);

  async function createTarget(draft: TargetDraft) {
    setActionMessage(null);
    const res = await sendJson<{ target?: CrawlTarget }>('/api/ingest/crawl-targets', 'POST', draft);
    setActionMessage({ tone: 'ok', text: `Target "${draft.label}" created` });
    setShowNewTarget(false);
    refreshTargets();
    if (res?.target?.id) void navigate(crawlTargetHref(res.target.id));
  }

  async function toggleTarget(t: CrawlTarget, enabled: boolean) {
    const res = await writeJson(`/api/ingest/crawl-targets/${encodeURIComponent(t.id)}`, 'PATCH', { enabled });
    if (!res.ok) {
      setActionMessage({ tone: 'err', text: res.error ?? 'Failed to toggle target' });
      return;
    }
    refreshTargets();
  }

  async function cancelCrawl(id: string) {
    const res = await writeJson(`/api/ingest/crawl/${encodeURIComponent(id)}`, 'DELETE');
    if (!res.ok) {
      setActionMessage({ tone: 'err', text: res.error ?? 'Failed to cancel crawl' });
      return;
    }
    setActionMessage({ tone: 'ok', text: 'Crawl cancellation requested' });
    refreshCrawls();
  }

  const openCrawl = (id: string) => void navigate(crawlRunHref(id));
  const openTarget = (id: string) => void navigate(crawlTargetHref(id));

  const openRecord = openId ? targets.find(t => t.id === openId) ?? null : null;
  useCrumbLabel(openId ?? undefined, openRecord?.label ?? null);

  if (openId) {
    const runsOf = crawls
      .filter(c => c.targetId === openId)
      .sort((a, b) => +new Date(b.startedAt) - +new Date(a.startedAt));
    return (
      <CollectionRecordFrame
        title="Sources"
        listTitle="Crawl targets"
        listLabel="crawl targets"
        {...(targetsData ? { count: shownTargets.length } : {})}
        search={{ value: query, onChange: setQuery, placeholder: 'Find a crawl target' }}
        groups={[{ id: 'enabled', title: 'Enabled' }, { id: 'paused', title: 'Paused' }].map(g => ({
          ...g, count: shownTargets.filter(t => (t.enabled ? 'enabled' : 'paused') === g.id).length,
        }))}
        rows={shownTargets.map(t => ({
          id: t.id, groupId: t.enabled ? 'enabled' : 'paused', title: t.label,
          subline: `${t.mode} · ${t.cronExpr ?? 'on-demand'}${t.lastStatus ? ` · last ${t.lastStatus}` : ''}`,
        }))}
        currentId={openId}
        onOpen={openTarget}
        loading={targetsLoading && !targetsData}
        error={targetsFailure && !targetsData ? targetsFailure : null}
        onRetry={refreshTargets}
        footer={<CollectionCommandHost adapter={adapter} />}
        data-testid="ingest-target-explorer"
      >
        {openRecord ? (
          <TargetRecord
            key={openRecord.id}
            target={openRecord}
            runs={runsOf}
            canManage={canManage}
            onChanged={() => { refreshTargets(); refreshCrawls(); }}
            onDeleted={() => { refreshTargets(); void navigate('/admin/ingest/crawl'); }}
          />
        ) : !targetsData ? (
          <LoadingState label="Loading crawl target…" />
        ) : (
          <RecordNotFound heading="Crawl target" title="Crawl target not found"
            body={`No crawl target has the id "${openId}" — it may have been deleted.`}
            backLabel="Sources" onBack={() => void navigate('/admin/ingest/crawl')} />
        )}
      </CollectionRecordFrame>
    );
  }

  return (
    <PageSection
      title="Sources"
      description="What content gets pulled in. Each target is a site the crawler reads and turns into documents."
    >
      <Stack gap="md" className="min-w-0">
        {actionMessage && (
          <InlineAlert tone={actionMessage.tone === 'ok' ? 'success' : 'error'}>
            {actionMessage.text}
          </InlineAlert>
        )}

        {/* Crawl Targets — the page's list comes first (the table-first density rule:
            docs/work-journeys-goal.md; the hr-admin ingest walk measured its first row at
            696px under the connected sources and the survey form). */}
        <Card padding="md">
          {canManage && (
            <Inline justify="end" className="mb-3">
              <Button variant="primary" onClick={() => setShowNewTarget(true)}>
                + New Target
              </Button>
            </Inline>
          )}
          <Stack gap="none" className="mb-3">
            <CollectionToolbar label="Crawl target filters"
              search={{ value: query, onChange: setQuery, placeholder: 'Search crawl targets', 'aria-label': 'Search crawl targets' }}
              summary={targetsData ? `${shownTargets.length} of ${targets.length} targets` : undefined}
              onRefresh={refreshTargets} refreshing={targetsLoading} />
          </Stack>
          {targetsLoading && targets.length === 0 ? (
            <LoadingState label="Loading crawl targets…" />
          ) : targetsFailure && !targetsData ? (
            <UnavailableNotice
              error={targetsFailure}
              what="crawl targets"
              source="Targets are read from the ingest service"
              onRetry={refreshTargets}
            />
          ) : targets.length === 0 ? (
            <EmptyState title="No crawl targets yet" body="Define a target to start ingesting public web content with vision-LLM extraction." />
          ) : shownTargets.length === 0 ? (
            <EmptyState title="No crawl target matches this search" body="Clear the search to see every target." />
          ) : (
            <TargetsTable
              targets={shownTargets}
              readOnly={!canManage}
              onOpen={(t) => openTarget(t.id)}
              onToggle={toggleTarget}
            />
          )}
        </Card>

        <ConnectedSources />

        <SiteSurveyPanel onTargetCreated={refreshTargets} />

        {/* Active Crawls — only when something is running */}
        {activeCrawls.length > 0 && (
          <Card padding="md" className="border-l-[3px] border-l-warning">
            <CardHeader
              className="mb-3"
              title="Active Crawls"
              meta={<StatusDot pulse color="var(--color-warning)" />}
              action={<Chip tone="warning" size="xs">{activeCrawls.length} running</Chip>}
            />
            <ActiveRunsStrip
              sessions={activeCrawls}
              onCancel={cancelCrawl}
              onOpen={openCrawl}
            />
          </Card>
        )}

        <CollectionCommandHost adapter={adapter} />

        {/* Target create dialog — a header action's form, not a record */}
        {showNewTarget && (
          <NewTargetModal
            onSave={createTarget}
            onCancel={() => setShowNewTarget(false)}
          />
        )}
      </Stack>
    </PageSection>
  );
}

export default CrawlTargetsPage;
