import { ofTotal } from '../../lib/plural';
import { useState } from 'react';
import {
  Button, Card, CardHeader, Chip, CollectionToolbar, ConfirmDialog, FormField, FormRow, IconButton,
  Input, LoadingState, PageSection, Select, Stack, Switch, T, Table, TableBody, TableHead,
  TableRow, TableTd, TableTh, TrashIcon,
} from '@connorhoehn/ui-components/shared';
import { useCapabilities } from '../../lib/capabilities';
import { useFetch } from '../../hooks/useFetch';
import { EmptyState } from '../../components/ingest/ui';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { toastError, toastPending, toastSuccess } from '../../lib/toastStore';
import { writeJson } from '../../lib/writeJson';
import { JOB_STATUS_TONE } from './ingestFormat';
import { CollectionCommandHost } from '../../components/collections/CollectionCommandHost';
import { matchesSchedule, schedulesAdapter } from './ingestCommands';

interface DataSource {
  id: string; name: string; status: string; description: string;
  type: string; sourceUri: string; updatedAt: string;
}

interface IngestSchedule {
  id: string; dataSourceId: string; dataSourceName: string;
  cronExpr: string; label: string; enabled: boolean;
  createdAt: string; lastRunAt: string | null; lastJobId: string | null; lastStatus: string | null;
}

const CRON_PRESETS = [
  { label: 'Every hour',       expr: '0 * * * *'   },
  { label: 'Every 6 hours',    expr: '0 */6 * * *'  },
  { label: 'Daily midnight',   expr: '0 0 * * *'    },
  { label: 'Daily 9 AM UTC',   expr: '0 9 * * *'    },
  { label: 'Weekly Mon 9 AM',  expr: '0 9 * * 1'    },
  { label: 'Custom…',          expr: '__custom__'   },
];

// What a FormField's render-prop wiring may be spread onto a library
// control. The library hands `labelId` along for controls that take
// `aria-labelledby`; spreading it onto Select/Input makes React warn "does
// not recognize the `labelId` prop" on every load. Keep the id + aria
// wiring, drop the label id — same gap `bots/botsFormat.ts` and
// `identity/identityFormat.ts` work around locally.
function inputWiring<W extends { labelId: string }>(wiring: W): Omit<W, 'labelId'> {
  const { labelId: _labelId, ...rest } = wiring;
  void _labelId;
  return rest;
}

function SchedulesPage() {
  const { data: sourcesData } = useFetch<{ sources: DataSource[] }>('/api/ingest/data-sources', 30_000);
  const sources = sourcesData?.sources ?? [];

  return (
    <PageSection
      title="Schedule"
      description="How often the knowledge base re-syncs. Without a schedule it only updates when someone presses Sync now."
    >
      <SchedulesPanel sources={sources} />
    </PageSection>
  );
}

function SchedulesPanel({ sources }: { sources: DataSource[] }) {
  // Schedule CRUD rides /api/ingest/schedules (ManageIngest).
  const { can, ready } = useCapabilities();
  const canManage = ready && can('ManageIngest');
  const { data, isLoading, refresh, error, degraded } =
    useFetch<{ schedules: IngestSchedule[] }>('/api/ingest/schedules', 30_000);
  // "Ingestion runs only on manual Sync now" is a statement about what is
  // configured. A failed read cannot support it.
  const failure = error ?? degraded;
  const schedules = data?.schedules ?? [];
  const [showForm, setShowForm] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const shown = schedules.filter(s => matchesSchedule(s, query));
  const adapter = schedulesAdapter({ setQuery, refresh });

  async function onDelete(id: string) {
    const s = schedules.find(x => x.id === id);
    const tid = toastPending('Removing schedule', s?.label ?? id);
    const res = await writeJson(`/api/ingest/schedules/${id}`, 'DELETE');
    if (!res.ok) { toastError(tid, 'Could not remove schedule', res.error ?? 'unknown error'); return; }
    toastSuccess(tid, 'Schedule removed');
    refresh();
  }

  async function onToggle(id: string, enabled: boolean) {
    const s = schedules.find(x => x.id === id);
    const res = await writeJson(`/api/ingest/schedules/${id}/toggle`, 'PATCH', { enabled });
    if (!res.ok) {
      toastError(null, enabled ? 'Could not enable schedule' : 'Could not disable schedule', res.error ?? 'unknown error');
      return;
    }
    toastSuccess(null, enabled ? 'Schedule enabled' : 'Schedule disabled', s?.label);
    refresh();
  }

  return (
    <Stack gap="md" className="min-w-0">
    <Card padding="md">
      <CardHeader
        title="KB Sync Schedules"
        action={canManage
          ? (
            <Button variant="secondary" onClick={() => setShowForm(v => !v)}>
              {showForm ? 'Cancel' : '+ New Schedule'}
            </Button>
          )
          : undefined}
      />

      <Stack gap="md">
        {showForm && (
          <ScheduleForm
            sources={sources}
            onCreated={() => { setShowForm(false); refresh(); }}
          />
        )}

        <CollectionToolbar label="Schedule filters"
          search={{ value: query, onChange: setQuery, placeholder: 'Search schedules', 'aria-label': 'Search schedules' }}
          summary={data ? `${ofTotal(shown.length, schedules.length, 'schedule')}` : undefined}
          onRefresh={refresh} refreshing={isLoading} />

        {failure && !data ? (
          <UnavailableNotice
            error={failure}
            what="schedules"
            source="Schedules are read from the ingest service"
            onRetry={refresh}
          />
        ) : isLoading && schedules.length === 0 && !showForm ? (
          <LoadingState label="Loading schedules…" />
        ) : schedules.length === 0 && !showForm ? (
          <EmptyState title="No schedules configured" body={'Ingestion runs only on manual "Sync now" trigger.'} />
        ) : schedules.length > 0 && shown.length === 0 ? (
          <EmptyState title="No schedule matches this search" body="Clear the search to see every schedule." />
        ) : schedules.length > 0 ? (
          <Table>
            <TableHead>
              <TableRow>
                <TableTh>Label</TableTh><TableTh>Cron</TableTh><TableTh>Data Source</TableTh>
                <TableTh>Last Run</TableTh><TableTh>Last Status</TableTh>
                <TableTh>Enabled</TableTh><TableTh></TableTh>
              </TableRow>
            </TableHead>
            <TableBody>
              {shown.map(s => (
                <TableRow key={s.id}>
                  <TableTd><T as="span" size="sm" weight="semibold">{s.label}</T></TableTd>
                  <TableTd><T className="font-mono" as="span" size="xs" tone="secondary">{s.cronExpr}</T></TableTd>
                  <TableTd><T as="span" size="xs">{s.dataSourceName}</T></TableTd>
                  <TableTd className="whitespace-nowrap"><T as="span" size="xs" tone="tertiary">
                    {s.lastRunAt ? new Date(s.lastRunAt).toLocaleString() : '—'}
                  </T></TableTd>
                  <TableTd>
                    {s.lastStatus
                      ? <Chip tone={JOB_STATUS_TONE[s.lastStatus] ?? 'neutral'} size="xs">{s.lastStatus}</Chip>
                      : <T size="xs" tone="tertiary">—</T>}
                  </TableTd>
                  <TableTd>
                    {canManage ? (
                      <Switch
                        checked={s.enabled}
                        onChange={v => onToggle(s.id, v)}
                        aria-label={`Enable schedule ${s.label}`}
                      />
                    ) : (
                      <Chip tone={s.enabled ? 'success' : 'neutral'} size="xs">{s.enabled ? 'on' : 'off'}</Chip>
                    )}
                  </TableTd>
                  <TableTd>
                    {canManage && (
                      <IconButton
                        variant="danger"
                        size="sm"
                        icon={<TrashIcon />}
                        aria-label="Remove schedule"
                        title="Remove schedule"
                        onClick={() => setConfirmDeleteId(s.id)}
                      />
                    )}
                  </TableTd>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : null}
      </Stack>
      <ConfirmDialog
        open={confirmDeleteId !== null}
        onConfirm={() => {
          const id = confirmDeleteId;
          setConfirmDeleteId(null);
          if (id) void onDelete(id);
        }}
        onCancel={() => setConfirmDeleteId(null)}
        tone="destructive"
        title="Remove this schedule?"
        body={`"${schedules.find(s => s.id === confirmDeleteId)?.label ?? ''}" will stop syncing on its own — the data source still syncs on manual "Sync now".`}
      />
    </Card>
    <CollectionCommandHost adapter={adapter} />
    </Stack>
  );
}

function ScheduleForm({ sources, onCreated }: { sources: DataSource[]; onCreated: () => void }) {
  const [dsId, setDsId] = useState(sources[0]?.id ?? '');
  const [preset, setPreset] = useState(CRON_PRESETS[1]!.expr);
  const [custom, setCustom] = useState('');
  const [label, setLabel] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const cronExpr = preset === '__custom__' ? custom : preset;

  async function submit() {
    if (!dsId) { setError('Select a data source.'); return; }
    if (!cronExpr) { setError('Enter a cron expression.'); return; }
    setError('');
    setSaving(true);
    try {
      const ds = sources.find(s => s.id === dsId);
      const resolvedLabel = label || CRON_PRESETS.find(p => p.expr === cronExpr)?.label || cronExpr;
      const res = await writeJson('/api/ingest/schedules', 'POST', {
        dataSourceId: dsId, dataSourceName: ds?.name ?? dsId, cronExpr, label: resolvedLabel, enabled: true,
      });
      if (!res.ok) { setError(res.error ?? 'Failed to create schedule'); return; }
      onCreated();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card padding="md" className="bg-surface-raised">
      <Stack gap="md">
        <FormRow stackBelow="md">
          <FormField label="Data Source">
            {(wiring) => (
              <Select
                {...inputWiring(wiring)}
                value={dsId}
                onChange={e => setDsId(e.target.value)}
                options={sources.map(s => ({ value: s.id, label: s.name }))}
              />
            )}
          </FormField>
          <FormField label="Schedule">
            {(wiring) => (
              <Select
                {...inputWiring(wiring)}
                value={preset}
                onChange={e => setPreset(e.target.value)}
                options={CRON_PRESETS.map(p => ({ value: p.expr, label: p.label }))}
              />
            )}
          </FormField>
          <FormField label="Label (optional)">
            {(wiring) => (
              <Input
                {...inputWiring(wiring)}
                value={label}
                onChange={e => setLabel(e.target.value)}
                placeholder="e.g. Nightly sync"
              />
            )}
          </FormField>
        </FormRow>

        {preset === '__custom__' && (
          <FormField label="Cron Expression (UTC)" hint="Format: minute hour day month weekday — all times UTC">
            {(wiring) => (
              <Input
                {...inputWiring(wiring)}
                mono
                value={custom}
                onChange={e => setCustom(e.target.value)}
                placeholder="e.g. 0 */4 * * *"
              />
            )}
          </FormField>
        )}

        {error && <T size="xs" tone="inherit" className="text-danger">{error}</T>}

        <Button variant="primary" onClick={submit} disabled={saving}>
          {saving ? 'Saving…' : 'Create Schedule'}
        </Button>
      </Stack>
    </Card>
  );
}

export default SchedulesPage;
