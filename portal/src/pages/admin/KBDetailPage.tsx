// One knowledge base: where it is in its lifecycle, and the four concerns you
// might have opened it for.
//
// This file is the page SHELL only — the fetch, which tab is showing, and
// whether the provision dialog is open. The pipeline chain, the dialog, each
// of the four tabs, the action buttons and every pure derivation live in ./kb.
//
// Two layout decisions that removed most of the clutter here:
//
//  • The page printed its name THREE times: PageSection's title, an <h2>
//    directly under it, and the browser tab. The <h2> and its hand-rolled
//    round back-button are gone; PageSection's own title and a breadcrumb do
//    that job.
//
//  • A row of six bordered "info pills" (Bedrock KB ID, Aurora table,
//    embedding, chunking…) sat between the title and the pipeline chain,
//    repeating the Configuration tab verbatim one screen above it. Those
//    fields now live on that tab only; the header keeps a single muted line
//    with the two facts that identify the KB rather than configure it.

import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import {
  Button,
  Chip,
  DetailHeader,
  ErrorState,
  Inline,
  InlineAlert,
  LoadingState,
  MetaLine,
  SegmentedControl,
  Stack,
} from '@connorhoehnslalom/ui-components/shared';
import { useCapabilities } from '../../lib/capabilities';
import { useFetch } from '../../hooks/useFetch.js';
import { useCrumbLabel } from '../../lib/crumbLabels';
import { useUrlState } from '../../lib/useUrlState';
import type { Reconciled } from '../knowledge/knowledgeFormat';
import { ConfigurationTab } from './kb/ConfigurationTab';
import { DeleteButton } from './kb/DeleteButton';
import { DocumentsTab } from './kb/DocumentsTab';
import { IngestionJobsTab } from './kb/IngestionJobsTab';
import { KbPipelineChain } from './kb/KbPipelineChain';
import { LandingZoneTab } from './kb/LandingZoneTab';
import { ProvisionModal } from './kb/ProvisionModal';
import { SyncButton } from './kb/SyncButton';
import { canDelete, canProvision, canSync, effectiveStatus, shortModel } from './kb/kbFormat';
import type { KbDetailResponse, KbTabId } from './kb/types';

const REGISTRY_PATH = '/admin/knowledge/registry';

const TABS: { value: KbTabId; label: string }[] = [
  { value: 'landing-zone', label: 'Landing zone' },
  { value: 'documents', label: 'Documents' },
  { value: 'ingestion-jobs', label: 'Ingestion jobs' },
  { value: 'configuration', label: 'Configuration' },
];

export function KBDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  // Provision/sync/delete ride /api/admin/kb-registry (ManageKB).
  const { can, ready } = useCapabilities();
  const canManage = ready && can('ManageKB');

  // ?tab= — one of KbTabId, defaulting to landing-zone.
  const [activeTab, setActiveTab] = useUrlState<KbTabId>(
    'tab',
    (raw) => (TABS.some((t) => t.value === raw) ? (raw as KbTabId) : 'landing-zone'),
    (v) => (v === 'landing-zone' ? null : v),
  );
  const [provisionOpen, setProvisionOpen] = useState(false);

  // Polls fast: CREATING and PENDING rows change under you.
  const { data, isLoading, error, refresh } = useFetch<KbDetailResponse>(
    id ? `/api/admin/kb-registry/${id}` : null,
    10_000,
  );

  // The registry row's own `status` only reflects the last provisioning
  // call — it does not know whether the Bedrock KB it names still exists.
  // The reconcile API actually checked; the detail header, the pipeline
  // chain and the Sync hint all read that instead (DEFECTS.md #18).
  const { data: reconcileData } = useFetch<{ entries: Reconciled[] }>(
    '/api/admin/kb-registry/reconcile',
    30_000,
  );

  const kb = data?.kb;
  // The trail reads the knowledge base's name, not its shortened id.
  useCrumbLabel(id, kb?.name);
  const reconciled = kb ? (reconcileData?.entries.find((e) => e.id === kb.id) ?? null) : null;

  // No breadcrumb row here: the app shell already renders one above this page.
  if (isLoading && !kb) {
    return <LoadingState label="Loading knowledge base…" />;
  }

  if (error || !kb) {
    return (
      <ErrorState
        title="Knowledge base unavailable"
        description={error ?? `No knowledge base found with id ${id}.`}
        actionLabel="Back to knowledge bases"
        onAction={() => navigate(REGISTRY_PATH)}
      />
    );
  }

  const eff = effectiveStatus(kb, reconciled);

  return (
    <Stack gap="lg" as="section">
      <DetailHeader
        title={kb.name}
        badge={<Chip tone={eff.tone} size="xs" dot="static">{eff.label}</Chip>}
        description={kb.description}
        // Identity, not configuration: what this KB IS, not how it is tuned.
        // The tuning fields moved to the Configuration tab, which is where
        // they already were — this header used to repeat them as six pills.
        meta={(
          <MetaLine
            size="sm"
            items={[
              <Chip key="tenant" tone={kb.tenant === 'orgiq' ? 'success' : 'warning'} size="xs">{kb.tenant}</Chip>,
              kb.purpose,
              shortModel(kb.embeddingModel),
              `${kb.chunkingStrategy} / ${kb.maxTokens} tok`,
            ]}
          />
        )}
        aside={(
          <Inline gap="sm" justify="end" align="start">
            {canManage && canProvision(kb) && (
              <Button
                variant={kb.status === 'FAILED' ? 'danger-solid' : 'secondary'}
                size="md"
                onClick={() => setProvisionOpen(true)}
              >
                {kb.status === 'FAILED' ? 'Re-provision' : 'Provision'}
              </Button>
            )}
            {canDelete(kb) && (
              <DeleteButton
                kbId={kb.id}
                kbName={kb.name}
                size="md"
                onDone={() => navigate(REGISTRY_PATH)}
              />
            )}
            {canSync(kb) && (
              <SyncButton kbId={kb.id} dataSourceId={kb.dataSourceId} size="md" onDone={refresh} />
            )}
          </Inline>
        )}
      />

      {kb.status === 'FAILED' && kb.errorMessage && (
        <InlineAlert tone="error">
          <strong>Provisioning failed:</strong> {kb.errorMessage}
        </InlineAlert>
      )}

      <KbPipelineChain kb={kb} reconciled={reconciled} />

      <Stack gap="md">
        <SegmentedControl
          value={activeTab}
          onChange={(v) => setActiveTab(v as KbTabId)}
          options={TABS.map((t) => ({ value: t.value, label: t.label }))}
        />
        {activeTab === 'landing-zone' && <LandingZoneTab kb={kb} showSyncHint={canManage && canSync(kb)} />}
        {activeTab === 'documents' && <DocumentsTab kb={kb} />}
        {activeTab === 'ingestion-jobs' && <IngestionJobsTab kb={kb} />}
        {activeTab === 'configuration' && <ConfigurationTab kb={kb} />}
      </Stack>

      <ProvisionModal
        kb={kb}
        open={provisionOpen}
        onClose={() => setProvisionOpen(false)}
        onComplete={refresh}
      />
    </Stack>
  );
}

export default KBDetailPage;
