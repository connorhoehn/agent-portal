// /access/configuration — durations, steward rules and sensitive items
// (docs/access-tenant-design.md A4, A6; §6). access-admin only (rail, palette
// and route agree). Read-only in A0: the values come from the catalog the
// server seeds (GET /api/access/catalog) and the steward rule the approval
// resolver applies live; Save stays disabled until the catalog writes land,
// and the page says so rather than pretending to persist anything.

import {
  Button,
  CheckIcon,
  Chip,
  FormField,
  Inline,
  InlineAlert,
  KeyValue,
  LoadingState,
  PageHeader,
  PageSection,
  Select,
  Stack,
  Tooltip,
} from '@connorhoehnslalom/ui-components/shared';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { useFetch } from '../../hooks/useFetch';
import { ACCESS_API, DURATIONS, DURATION_LABELS, TENANT_LABELS, type AccessTenant, type CatalogItem, type ItemsResponse } from '../../lib/accessRequests';
import { ACCESS_SURFACES } from './accessSurfaces';

/** Who stewards a workspace role (design A4): resolved live at decision time, never copied onto a request. */
export const TENANT_STEWARDS: Readonly<Record<AccessTenant, string>> = {
  orgiq: 'hr-admin', assessment: 'program-lead', social: 'community-admin', pipelines: 'pipeline-admin',
};

const READ_ONLY = 'Read-only in lane A0. Editing arrives with the catalog writes; nothing on this page is saved.';

export default function ConfigurationPage() {
  const { data, error, isLoading, refresh } = useFetch<ItemsResponse<CatalogItem>>(`${ACCESS_API}/catalog`);
  const page = ACCESS_SURFACES.configuration;
  const items = data?.items ?? [];
  const sensitive = items.filter((i) => i.sensitive);
  return (
    <Stack gap="md" className="min-w-0" data-testid="access-configuration">
      <PageHeader density="compact" title={page.title} description={page.description} badge={<Chip tone="neutral" size="xs">Read-only</Chip>} />
      <InlineAlert tone="info">{READ_ONLY}</InlineAlert>
      {error ? (
        <UnavailableNotice error={error} what="the access configuration" source="Durations and stewards are read from the access catalog" onRetry={refresh} />
      ) : !data ? (
        <LoadingState label={isLoading ? 'Loading configuration…' : 'Loading…'} />
      ) : (
        <Stack gap="lg" data-testid="access-configuration-form">
            <PageSection title="Durations" description="Every request is time-bound unless the requester chooses standing access and gives a second reason. Expiry revokes through the same path as provisioning.">
              <Stack gap="md">
                <KeyValue items={[
                  { label: 'Offered', value: DURATIONS.map((d) => DURATION_LABELS[d]).join(', ') },
                  { label: 'Standing', value: 'Needs its own justification of at least 20 characters' },
                ]} />
                <FormField label="Default for a new catalog item" hint="Each item below carries its own default.">
                  {({ id }) => <Select id={id} size="sm" className="w-full max-w-56" value="24h" disabled
                    options={DURATIONS.map((d) => ({ value: d, label: DURATION_LABELS[d] }))} data-testid="access-config-default-duration" />}
                </FormField>
              </Stack>
            </PageSection>
            <PageSection title="Stewards" description="Who approves after the manager, resolved from the directory at decision time.">
              <KeyValue items={[
                ...(Object.entries(TENANT_STEWARDS) as Array<[AccessTenant, string]>).map(([tenant, role]) => ({ label: `${TENANT_LABELS[tenant]} roles`, value: `Holders of ${role} in ${TENANT_LABELS[tenant]}` })),
                { label: 'Initiatives', value: 'The initiative’s owner' },
                { label: 'Sensitive items', value: 'An access admin, as a final step' },
              ]} />
            </PageSection>
            <PageSection title="Catalog items" description={`${items.length} requestable items, ${sensitive.length} sensitive.`}>
              <KeyValue data-testid="access-config-items" items={items.map((i) => ({
                label: i.title,
                value: `${DURATION_LABELS[i.defaultDuration]} by default · ${i.stewardRule === 'initiative-owner' ? 'initiative owner' : 'workspace steward'}${i.sensitive ? ' · sensitive' : ''}`,
              }))} />
            </PageSection>
            <Inline gap="sm">
              <Tooltip content={READ_ONLY}>
                <Button size="sm" variant="primary" disabled data-testid="access-configuration-save"><CheckIcon />Save</Button>
              </Tooltip>
            </Inline>
        </Stack>
      )}
    </Stack>
  );
}
