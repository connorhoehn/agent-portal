// /interviews/settings — what this deployment runs the tenant with (gap audit 2026-11-20, minor; GET /api/interviews/settings):
// the retention periods, the consents a call needs, the code runner and the rest, one row each, read only. The recruiter
// and the admin read it (ManageCandidates); it is reached from the Openings header, as the tenant's rail has no admin
// group. A setting changes in the deployment's environment, never here.

import { Chip, CollectionToolbar, DataTable, Stack, T, type DataTableColumn } from '@connorhoehn/ui-components/shared';
import { useState } from 'react';
import { CollectionCommandHost } from '../../components/collections/CollectionCommandHost';
import { CollectionCommandPage } from '../../components/collections/CollectionCommandPage';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { useFetch } from '../../hooks/useFetch';
import { matches, type ItemsResponse } from '../../lib/interviews';
import { ofTotal } from '../../lib/plural';
import {
  SETTINGS_PATH, SETTING_GROUP_LABELS, SETTING_GROUP_ORDER, orderedSettings, settingChanged, settingValueLabel, type SettingRow,
} from '../../lib/interviewsSettings';
import { interviewsCollectionAdapter } from './interviewsCollectionCommands';

const COLUMNS: DataTableColumn<SettingRow>[] = [
  {
    key: 'about', header: 'Setting',
    render: (r) => (
      <Stack gap="none">
        <T size="sm">{r.about}</T>
        <T size="xs" tone="tertiary">{r.name}</T>
      </Stack>
    ),
  },
  { key: 'group', header: 'Group', width: '144px', render: (r) => <T size="sm">{SETTING_GROUP_LABELS[r.group]}</T> },
  {
    key: 'value', header: 'In force', width: '208px',
    render: (r) => (settingChanged(r)
      ? <Chip size="sm" tone="info" title="Set by this deployment">{settingValueLabel(r.value)}</Chip>
      : <T size="sm">{settingValueLabel(r.value)}</T>),
  },
  { key: 'default', header: 'Default', width: '176px', render: (r) => <T size="sm" tone="secondary">{settingValueLabel(r.default)}</T> },
];

export default function SettingsPage() {
  const { data, error, isLoading, refresh } = useFetch<ItemsResponse<SettingRow>>(SETTINGS_PATH);
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState('');
  const all = orderedSettings(data?.items ?? []);
  const rows = all.filter((r) => (!group || r.group === group) && matches(query, r.about, r.name, SETTING_GROUP_LABELS[r.group], settingValueLabel(r.value)));
  const adapter = interviewsCollectionAdapter('settings', { setQuery, setFilter: setGroup, refresh });

  return (
    <CollectionCommandPage data-testid="interviews-settings" title="Settings"
      description="What this deployment runs Candidates with: how long records are kept, the consents a call needs and who runs the code pad. Read only; they change in the deployment's environment.">
      <Stack gap="none" className="min-h-0 min-w-0 flex-1">
        <Stack gap="md" className="min-h-0 flex-1 overflow-auto px-[var(--ui-page-gutter)]">
          <CollectionToolbar {...{
            label: 'Setting filters',
            search: { value: query, onChange: setQuery, placeholder: 'Search settings', 'aria-label': 'Search settings' },
            filters: [
              { id: 'group', label: 'Group', value: group, onChange: setGroup, options: [{ value: '', label: 'Every group' }, ...SETTING_GROUP_ORDER.map((g) => ({ value: g, label: SETTING_GROUP_LABELS[g] }))] },
            ],
            summary: data ? ofTotal(rows.length, all.length, 'setting') : undefined,
            onRefresh: refresh, refreshing: isLoading,
          }} />
          {error ? (
            <UnavailableNotice error={error} what="settings" source="Settings are read from this deployment's environment" onRetry={refresh} />
          ) : (
            <DataTable narrow
              data-testid="interviews-settings-table"
              aria-label="Settings"
              data={rows}
              columns={COLUMNS}
              keyField={(r) => r.name}
              loading={isLoading && !data}
              rowHeight="content"
              emptyMessage={query.trim() || group ? 'No setting matches this search and this filter.' : 'No settings to show.'}
            />
          )}
        </Stack>
        <CollectionCommandHost adapter={adapter} />
      </Stack>
    </CollectionCommandPage>
  );
}
