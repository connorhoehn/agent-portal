// Knowledge base registry — the list of rows the platform keeps about Bedrock
// knowledge bases.
//
// This file is the page SHELL only: what is fetched, what the tenant filter is
// set to, and whether the create wizard is open. The table, the three
// capability-gated action buttons, the status badge and every pure derivation
// live in ./kb beside it.
//
// Layout note: the tenant filter used to sit in the page header next to the
// title, which put a filter and a create verb on the same line and left the
// count floating between them. Filters now sit in a Toolbar directly above the
// list they filter, and the header carries only the verb.

import { useState } from 'react';
import { useNavigate } from 'react-router';
import {
  Button,
  Card,
  FilterChip,
  InlineAlert,
  PageSection,
  Stack,
  Toolbar,
  ToolbarGroup,
  ToolbarLabel,
} from '@connorhoehnslalom/ui-components/shared';
import { KBCreateWizard } from '../../components/kb/KBCreateWizard.js';
import { useCapabilities } from '../../lib/capabilities';
import { useFetch } from '../../hooks/useFetch.js';
import { KbRegistryTable } from './kb/KbRegistryTable';
import type { KbListResponse, KbRegistryEntry, TenantFilter } from './kb/types';

// KBCreateWizard and components/kb/KBPipelineChain still name this type by
// importing it from the page. Re-exported so moving it did not become their
// problem.
export type { KbRegistryEntry } from './kb/types';

const TENANT_FILTERS: { value: TenantFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'orgiq', label: 'orgiq' },
  { value: 'newsroom', label: 'newsroom' },
];

export function KBRegistryPage() {
  const navigate = useNavigate();
  // Create/provision/sync/delete ride /api/admin/kb-registry (ManageKB).
  const { can, ready } = useCapabilities();
  const canManage = ready && can('ManageKB');

  const [tenantFilter, setTenantFilter] = useState<TenantFilter>('all');
  const [wizardOpen, setWizardOpen] = useState(false);

  const { data, isLoading, error, refresh } = useFetch<KbListResponse>(
    '/api/admin/kb-registry',
    30_000,
  );

  const allKbs = data?.kbs ?? [];
  const visible = tenantFilter === 'all'
    ? allKbs
    : allKbs.filter((kb) => kb.tenant === tenantFilter);

  const openKb = (kb: KbRegistryEntry) => navigate(`/admin/knowledge/registry/${kb.id}`);

  // Three different nothings: a filter that matched nothing, a failed read, and
  // an empty registry. Saying "no knowledge bases found" for the middle one is
  // how a 500 gets mistaken for an empty account.
  const emptyMessage = data
    ? 'No knowledge bases match this filter.'
    : error
      ? 'Could not read the registry — see the error above.'
      : 'No knowledge bases found.';

  const countLabel = error && !data
    ? ''
    : isLoading && !data
      ? 'Loading…'
      : `${visible.length} ${visible.length === 1 ? 'entry' : 'entries'}`;

  return (
    <PageSection
      title="Knowledge base registry"
      description="The rows the platform keeps about Bedrock knowledge bases. Whether they match the account is answered on Knowledge."
      actions={canManage && (
        <Button variant="primary" size="md" onClick={() => setWizardOpen(true)}>
          + New knowledge base
        </Button>
      )}
    >
      <Stack gap="lg">
        {/* No breadcrumb row here: the app shell already renders one
            (Operate › Knowledge › Registry) directly above this page. */}
        {error && (
          <InlineAlert tone="error">Failed to load knowledge bases: {error}</InlineAlert>
        )}

        <Stack gap="none">
          <Toolbar aria-label="Registry filters">
            <ToolbarGroup aria-label="Tenant">
              <ToolbarLabel>Tenant</ToolbarLabel>
              {TENANT_FILTERS.map((t) => (
                <FilterChip
                  key={t.value}
                  active={tenantFilter === t.value}
                  onClick={() => setTenantFilter(t.value)}
                >
                  {t.label}
                </FilterChip>
              ))}
            </ToolbarGroup>
            <ToolbarGroup divided>
              <ToolbarLabel>{countLabel}</ToolbarLabel>
            </ToolbarGroup>
          </Toolbar>

          <Card padding="md">
            <KbRegistryTable
              kbs={visible}
              isLoading={isLoading && !data}
              emptyMessage={emptyMessage}
              onOpen={openKb}
              onRefresh={refresh}
            />
          </Card>
        </Stack>
      </Stack>

      <KBCreateWizard
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        onCreated={(kb) => {
          setWizardOpen(false);
          refresh();
          navigate(`/admin/knowledge/registry/${kb.id}`);
        }}
      />
    </PageSection>
  );
}

export default KBRegistryPage;
