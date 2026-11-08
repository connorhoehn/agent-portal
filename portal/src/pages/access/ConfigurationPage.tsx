// /access/configuration — durations, steward rules and sensitive items
// (docs/access-tenant-design.md A4, A6; §6). access-admin only (rail, palette
// and route agree). Read from GET /api/access/configuration. The durations on
// offer and who stewards each kind of item are fixed by decisions A4 / A6 and
// shown as facts; each catalog item's default duration and sensitive flag are
// stored settings an access admin (ManageAccessPolicy) edits here and saves
// with PUT /api/access/configuration. A sensitive item adds the access-admin
// step to requests submitted after the save; requests already open keep the
// chain computed when they were submitted.

import {
  Button,
  CheckIcon,
  Chip,
  DataTable,
  Inline,
  KeyValue,
  LoadingState,
  PageFrame,
  PageSection,
  Select,
  Stack,
  Switch,
  T,
  type DataTableColumn,
} from '@connorhoehn/ui-components/shared';
import { useState } from 'react';
import { useFlushTrailItems } from '../../components/shell/FlushPage';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { useFetch } from '../../hooks/useFetch';
import { useCapabilities } from '../../lib/capabilities';
import { toastError, toastSuccess } from '../../lib/toastStore';
import { writeJson } from '../../lib/writeJson';
import { ACCESS_API, DURATION_LABELS, KIND_LABELS, STEWARD_LABELS, TENANT_LABELS, configurationPatch, type AccessConfiguration, type AccessDuration, type AccessTenant, type ConfigurationEdits as Edits } from '../../lib/accessRequests';
import { ACCESS_SURFACES } from './accessSurfaces';

type ConfigItem = AccessConfiguration['items'][number];

function stewardLine(s: AccessConfiguration['stewards'][number]): { label: string; value: string } {
  if (s.scope === 'initiative-membership') return { label: 'Initiatives', value: 'The initiative’s owner' };
  if (s.scope === 'sensitive') return { label: 'Sensitive items', value: 'An access admin, as a final step' };
  if (s.scope === 'capability') {
    const tenant = TENANT_LABELS[s.tenant as AccessTenant] ?? s.tenant ?? '';
    return { label: `${tenant} capabilities`, value: `The budget owner: holders of ${s.role} in ${tenant}` };
  }
  const tenant = TENANT_LABELS[s.tenant as AccessTenant] ?? s.tenant ?? '';
  return { label: `${tenant} roles`, value: `Holders of ${s.role} in ${tenant}` };
}

export default function ConfigurationPage() {
  const { can, ready } = useCapabilities();
  const mayEdit = ready && can('ManageAccessPolicy');
  const { data, error, isLoading, refresh } = useFetch<AccessConfiguration>(`${ACCESS_API}/configuration`);
  const [edits, setEdits] = useState<Edits>({});
  const [busy, setBusy] = useState(false);
  const page = ACCESS_SURFACES.configuration;
  const trail = useFlushTrailItems();
  const items = data?.items ?? [];
  const patch = configurationPatch(items, edits);
  const value = <K extends 'defaultDuration' | 'sensitive'>(i: ConfigItem, k: K): ConfigItem[K] => (edits[i.id]?.[k] ?? i[k]) as ConfigItem[K];
  const edit = (id: string, change: Edits[string]) => setEdits((e) => ({ ...e, [id]: { ...e[id], ...change } }));

  async function save() {
    setBusy(true);
    const res = await writeJson<AccessConfiguration>(`${ACCESS_API}/configuration`, 'PUT', patch);
    setBusy(false);
    if (res.ok) { toastSuccess(null, 'Configuration saved', `${patch.items.length} catalog item${patch.items.length === 1 ? '' : 's'} updated. Open requests keep their chain.`); setEdits({}); refresh(); }
    else toastError(null, 'Could not save the configuration', res.error ?? undefined);
  }

  const columns: DataTableColumn<ConfigItem>[] = [
    { key: 'title', header: 'Item', render: (i) => <T size="sm" title={i.title} className="block max-w-[18rem] truncate">{i.title}</T> },
    { key: 'kind', header: 'Kind', render: (i) => KIND_LABELS[i.kind] },
    { key: 'tenant', header: 'Workspace', width: '120px', render: (i) => TENANT_LABELS[i.tenant] ?? i.tenant },
    { key: 'steward', header: 'Steward', render: (i) => STEWARD_LABELS[i.stewardRule].replace(/^the /, '').replace(/^./, (c) => c.toUpperCase()) },
    {
      key: 'defaultDuration', header: 'Default duration', width: '168px',
      render: (i) => mayEdit
        ? <Select size="sm" aria-label={`Default duration for ${i.title}`} value={value(i, 'defaultDuration')} disabled={busy}
            onChange={(e) => edit(i.id, { defaultDuration: e.target.value as AccessDuration })}
            options={(data?.durations.offered ?? []).map((d) => ({ value: d, label: DURATION_LABELS[d] }))} data-testid={`access-config-duration-${i.id}`} />
        : DURATION_LABELS[i.defaultDuration],
    },
    {
      key: 'sensitive', header: 'Sensitive', width: '104px',
      render: (i) => mayEdit
        ? <Switch size="sm" aria-label={`${i.title} is sensitive`} checked={value(i, 'sensitive')} disabled={busy}
            onChange={(v) => edit(i.id, { sensitive: v })} data-testid={`access-config-sensitive-${i.id}`} />
        : (i.sensitive ? <Chip tone="caution" size="xs">sensitive</Chip> : <T size="xs" tone="tertiary">—</T>),
    },
  ];

  return (
    <PageFrame title={page.title} description={page.description} breadcrumbs={trail} data-testid="access-configuration"
        {...(mayEdit ? {
          actions: <Button size="sm" variant="primary" disabled={busy || patch.items.length === 0} onClick={() => void save()} data-testid="access-configuration-save"><CheckIcon />Save</Button>,
        } : { badge: <Chip tone="neutral" size="xs">Read-only</Chip> })}>
      {error ? (
        <UnavailableNotice error={error} what="the access configuration" source="Durations, stewards and catalog defaults are read from GET /api/access/configuration" onRetry={refresh} />
      ) : !data ? (
        <LoadingState label={isLoading ? 'Loading configuration…' : 'Loading…'} />
      ) : (
        <Stack gap="lg" data-testid="access-configuration-form">
          <PageSection size="sm" title="Durations" description="Every request is time-bound unless the requester chooses standing access and gives a second reason. Expiry revokes through the same path as provisioning. Set by the product, not edited here.">
            <KeyValue layout="grid" items={[
              { label: 'Offered', value: <T size="sm">{data.durations.offered.map((d) => DURATION_LABELS[d]).join(', ')}</T> },
              { label: 'Standing', value: <T size="sm">{`Needs its own reason of at least ${data.durations.standingReasonMin} characters`}</T> },
            ]} />
          </PageSection>
          <PageSection size="sm" title="Stewards" description="Who approves after the manager, resolved from the directory at decision time. Set by the product, not edited here.">
            <KeyValue layout="grid" items={data.stewards.map((s) => { const l = stewardLine(s); return { label: l.label, value: <T size="sm">{l.value}</T> }; })} />
          </PageSection>
          {data.escalation && (
            <PageSection size="sm" title="Escalation and delegation" description="A step nobody decides in time reaches the next tier of deciders; its own deciders keep the right. Approvers hand their decisions on while away under Settings. The wait is set when the service is deployed.">
              <KeyValue layout="grid" data-testid="access-configuration-escalation" items={[
                { label: 'Time limit', value: <T size="sm">{`${data.escalation.stepSlaHours} hours per step, counted from when it starts waiting`}</T> },
                { label: 'Then', value: <T size="sm">{`The access admins, then after another ${data.escalation.stepSlaHours} hours the platform admins (an access-admin step goes straight to the platform admins)`}</T> },
                ...(data.delegation ? [{ label: 'Delegation', value: <T size="sm">{`Up to ${data.delegation.maxDays} days, to another approver; never on their own requests, and an access-admin step only to an access admin`}</T> }] : []),
              ]} />
            </PageSection>
          )}
          <PageSection size="sm" title="Catalog items"
            description={mayEdit ? 'Each item’s default duration and whether it is sensitive (adds an access-admin step). Saved changes apply to requests submitted afterwards.' : 'Each item’s default duration and whether it is sensitive. Only an access admin changes them.'}>
            <DataTable data-testid="access-config-items" data={items} columns={columns} keyField={(i) => i.id} emptyMessage="The catalog offers no items."
              staticRows="Each item's settings are edited in its row and saved together below; an item has no page of its own." />
          </PageSection>
          {mayEdit && patch.items.length > 0 && (
            <Inline gap="sm" align="center">
              <T size="xs" tone="secondary">{`${patch.items.length} unsaved change${patch.items.length === 1 ? '' : 's'}.`}</T>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEdits({})} data-testid="access-configuration-discard">Discard</Button>
            </Inline>
          )}
        </Stack>
      )}
    </PageFrame>
  );
}
