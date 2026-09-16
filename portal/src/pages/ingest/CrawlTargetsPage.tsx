import { useMemo, useState } from 'react';
import {
  Button, Card, CardHeader, Chip, ConfirmDialog, EmptyState, Inline, InlineAlert, LoadingState,
  PageSection, Stack,
} from '@connorhoehnslalom/ui-components/shared';
import { useCapabilities } from '../../lib/capabilities';
import { sendJson, writeJson } from '../../lib/writeJson';
import { SiteSurveyPanel } from '../../components/ingest/SiteSurveyPanel';
import { ConnectedSources } from '../../components/ingest/ConnectedSources';
import { useFetch } from '../../hooks/useFetch';
import type { CrawlSession, CrawlTarget } from '../../components/ingest/types';
import { TargetsTable } from '../../components/ingest/TargetsTable';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { ActiveRunsStrip } from '../../components/ingest/ActiveRunsStrip';
import { RunDetailDrawer } from '../../components/ingest/RunDetailDrawer';
import { NewTargetModal } from '../../components/ingest/NewTargetModal';
import type { TargetDraft } from '../../components/ingest/NewTargetModal';
import { StatusDot } from '../../components/ingest/ui';
import { T } from './Text';

function CrawlTargetsPage() {
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

  const [targetBusy, setTargetBusy] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  const [drawerCrawlId, setDrawerCrawlId] = useState<string | null>(null);
  const [drawerInitial, setDrawerInitial] = useState<CrawlSession | null>(null);

  const [showNewTarget, setShowNewTarget] = useState(false);
  const [editTarget, setEditTarget] = useState<CrawlTarget | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<CrawlTarget | null>(null);

  const activeCrawls = useMemo(() => crawls.filter(c => c.status === 'running'), [crawls]);

  async function saveTarget(draft: TargetDraft) {
    setActionMessage(null);
    const url = editTarget
      ? `/api/ingest/crawl-targets/${encodeURIComponent(editTarget.id)}`
      : '/api/ingest/crawl-targets';
    const method = editTarget ? 'PATCH' : 'POST';
    await sendJson(url, method, draft);
    setActionMessage({
      tone: 'ok',
      text: editTarget ? `Target "${draft.label}" updated` : `Target "${draft.label}" created`,
    });
    setShowNewTarget(false);
    setEditTarget(null);
    refreshTargets();
  }

  async function runTarget(t: CrawlTarget) {
    setTargetBusy(t.id);
    setActionMessage(null);
    const res = await writeJson<{ session: CrawlSession }>(`/api/ingest/crawl-targets/${encodeURIComponent(t.id)}/run`, 'POST');
    if (!res.ok || !res.data?.session) {
      setActionMessage({ tone: 'err', text: res.error ?? 'Failed to start crawl' });
    } else {
      setActionMessage({ tone: 'ok', text: `Crawl started for "${t.label}"` });
      refreshCrawls();
      setDrawerCrawlId(res.data.session.id);
      setDrawerInitial(res.data.session);
    }
    setTargetBusy(null);
    refreshTargets();
  }

  async function runDeleteTarget(t: CrawlTarget) {
    const res = await writeJson(`/api/ingest/crawl-targets/${encodeURIComponent(t.id)}`, 'DELETE');
    if (!res.ok) {
      setActionMessage({ tone: 'err', text: res.error ?? 'Failed to delete target' });
      return;
    }
    setActionMessage({ tone: 'ok', text: `Target "${t.label}" deleted` });
    refreshTargets();
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

  function openCrawl(id: string) {
    const initial = crawls.find(c => c.id === id) ?? null;
    setDrawerInitial(initial);
    setDrawerCrawlId(id);
  }

  return (
    <PageSection
      title="Sources"
      description="What content gets pulled in. Each target is a site the crawler reads and turns into documents."
    >
      <Stack gap="md">
        {actionMessage && (
          <InlineAlert tone={actionMessage.tone === 'ok' ? 'success' : 'error'}>
            {actionMessage.text}
          </InlineAlert>
        )}

        <ConnectedSources />

        <SiteSurveyPanel onTargetCreated={refreshTargets} />

        {/* Crawl Targets */}
        <Card padding="md">
          {canManage && (
            <Inline justify="end" className="mb-3">
              <Button variant="primary" onClick={() => setShowNewTarget(true)}>
                + New Target
              </Button>
            </Inline>
          )}
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
          ) : (
            <TargetsTable
              targets={targets}
              busyId={targetBusy}
              readOnly={!canManage}
              onRun={runTarget}
              onEdit={(t) => setEditTarget(t)}
              onDelete={(t) => setDeleteTarget(t)}
              onToggle={toggleTarget}
            />
          )}
        </Card>

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

        {/* Right-side drawer for crawl run details (uses PageDetailModal internally) */}
        <RunDetailDrawer
          crawlId={drawerCrawlId}
          initialSession={drawerInitial}
          onClose={() => { setDrawerCrawlId(null); setDrawerInitial(null); }}
        />

        {/* Target create/edit modal */}
        {(showNewTarget || editTarget) && (
          <NewTargetModal
            existing={editTarget}
            onSave={saveTarget}
            onCancel={() => { setShowNewTarget(false); setEditTarget(null); }}
          />
        )}

        <ConfirmDialog
          open={!!deleteTarget}
          onConfirm={() => {
            if (deleteTarget) {
              const t = deleteTarget;
              setDeleteTarget(null);
              void runDeleteTarget(t);
            }
          }}
          onCancel={() => setDeleteTarget(null)}
          tone="destructive"
          title={deleteTarget ? `Delete "${deleteTarget.label}"?` : 'Delete target?'}
          body="Run history is preserved. This cannot be undone."
        />
      </Stack>
    </PageSection>
  );
}

export default CrawlTargetsPage;
