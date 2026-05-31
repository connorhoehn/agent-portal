import React, { useId, useState } from 'react';
import {
  Card, Table, TableHead, TableBody, TableRow, TableTh, TableTd, Chip,
  PageSection,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import {
  Button, EmptyState, Toggle, labelStyle,
} from '../../components/ingest/ui';

interface DataSource {
  id: string; name: string; status: string; description: string;
  type: string; sourceUri: string; updatedAt: string;
}

interface IngestSchedule {
  id: string; dataSourceId: string; dataSourceName: string;
  cronExpr: string; label: string; enabled: boolean;
  createdAt: string; lastRunAt: string | null; lastJobId: string | null; lastStatus: string | null;
}

const JOB_STATUS_TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  COMPLETE: 'success', IN_PROGRESS: 'warning', STARTING: 'warning', FAILED: 'danger', STOPPED: 'neutral',
};

const CRON_PRESETS = [
  { label: 'Every hour',       expr: '0 * * * *'   },
  { label: 'Every 6 hours',    expr: '0 */6 * * *'  },
  { label: 'Daily midnight',   expr: '0 0 * * *'    },
  { label: 'Daily 9 AM UTC',   expr: '0 9 * * *'    },
  { label: 'Weekly Mon 9 AM',  expr: '0 9 * * 1'    },
  { label: 'Custom…',          expr: '__custom__'   },
];

function SchedulesPage() {
  const { data: sourcesData } = useFetch<{ sources: DataSource[] }>('/api/ingest/data-sources', 30_000);
  const sources = sourcesData?.sources ?? [];

  return (
    <PageSection title="Schedules">
      <SchedulesPanel sources={sources} />
    </PageSection>
  );
}

function SchedulesPanel({ sources }: { sources: DataSource[] }) {
  const { data, refresh } = useFetch<{ schedules: IngestSchedule[] }>('/api/ingest/schedules', 30_000);
  const schedules = data?.schedules ?? [];
  const [showForm, setShowForm] = useState(false);

  async function onDelete(id: string) {
    await fetch(`/api/ingest/schedules/${id}`, { method: 'DELETE' });
    refresh();
  }

  async function onToggle(id: string, enabled: boolean) {
    await fetch(`/api/ingest/schedules/${id}/toggle`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    refresh();
  }

  return (
    <Card padding="md">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h3 style={{ fontSize: 13, fontWeight: 600 }}>KB Sync Schedules</h3>
        <Button variant="secondary" onClick={() => setShowForm(v => !v)}>
          {showForm ? 'Cancel' : '+ New Schedule'}
        </Button>
      </div>

      {showForm && (
        <ScheduleForm
          sources={sources}
          onCreated={() => { setShowForm(false); refresh(); }}
        />
      )}

      {schedules.length === 0 && !showForm ? (
        <EmptyState title="No schedules configured" body={'Ingestion runs only on manual "Sync now" trigger.'} />
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
            {schedules.map(s => (
              <TableRow key={s.id}>
                <TableTd style={{ fontWeight: 500 }}>{s.label}</TableTd>
                <TableTd style={{ fontSize: 11, fontFamily: 'monospace', color: 'var(--color-text-secondary)' }}>{s.cronExpr}</TableTd>
                <TableTd style={{ fontSize: 12 }}>{s.dataSourceName}</TableTd>
                <TableTd style={{ fontSize: 11, color: 'var(--color-text-tertiary)', whiteSpace: 'nowrap' }}>
                  {s.lastRunAt ? new Date(s.lastRunAt).toLocaleString() : '—'}
                </TableTd>
                <TableTd>
                  {s.lastStatus
                    ? <Chip tone={JOB_STATUS_TONE[s.lastStatus] ?? 'neutral'} size="xs">{s.lastStatus}</Chip>
                    : <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>—</span>}
                </TableTd>
                <TableTd>
                  <Toggle
                    checked={s.enabled}
                    onChange={v => onToggle(s.id, v)}
                    aria-label={`Enable schedule ${s.label}`}
                  />
                </TableTd>
                <TableTd>
                  <Button variant="danger" size="sm" onClick={() => onDelete(s.id)}>
                    Remove
                  </Button>
                </TableTd>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : null}
    </Card>
  );
}

function ScheduleForm({ sources, onCreated }: { sources: DataSource[]; onCreated: () => void }) {
  const [dsId, setDsId] = useState(sources[0]?.id ?? '');
  const [preset, setPreset] = useState(CRON_PRESETS[1]!.expr);
  const [custom, setCustom] = useState('');
  const [label, setLabel] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const dsId_id = useId();
  const preset_id = useId();
  const label_id = useId();
  const custom_id = useId();

  const cronExpr = preset === '__custom__' ? custom : preset;

  async function submit() {
    if (!dsId) { setError('Select a data source.'); return; }
    if (!cronExpr) { setError('Enter a cron expression.'); return; }
    setError('');
    setSaving(true);
    try {
      const ds = sources.find(s => s.id === dsId);
      const resolvedLabel = label || CRON_PRESETS.find(p => p.expr === cronExpr)?.label || cronExpr;
      const r = await fetch('/api/ingest/schedules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataSourceId: dsId, dataSourceName: ds?.name ?? dsId, cronExpr, label: resolvedLabel, enabled: true }),
      });
      const body = await r.json() as { error?: string };
      if (!r.ok) { setError(body.error ?? 'Failed to create schedule'); return; }
      onCreated();
    } finally {
      setSaving(false);
    }
  }

  const inputStyle: React.CSSProperties = {
    fontSize: 12, padding: '5px 8px', border: '1px solid var(--color-border)',
    borderRadius: 'var(--radius-sm)', width: '100%', boxSizing: 'border-box',
  };

  return (
    <div style={{ background: 'var(--color-surface-raised)', borderRadius: 'var(--radius-md)', padding: 16, marginBottom: 16 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 12 }}>
        <div>
          <label htmlFor={dsId_id} style={labelStyle}>Data Source</label>
          <select id={dsId_id} value={dsId} onChange={e => setDsId(e.target.value)} style={inputStyle}>
            {sources.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor={preset_id} style={labelStyle}>Schedule</label>
          <select id={preset_id} value={preset} onChange={e => setPreset(e.target.value)} style={inputStyle}>
            {CRON_PRESETS.map(p => <option key={p.expr} value={p.expr}>{p.label}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor={label_id} style={labelStyle}>Label (optional)</label>
          <input id={label_id} value={label} onChange={e => setLabel(e.target.value)} placeholder="e.g. Nightly sync" style={inputStyle} />
        </div>
      </div>

      {preset === '__custom__' && (
        <div style={{ marginBottom: 12 }}>
          <label htmlFor={custom_id} style={labelStyle}>Cron Expression (UTC)</label>
          <input
            id={custom_id}
            value={custom} onChange={e => setCustom(e.target.value)}
            placeholder="e.g. 0 */4 * * *"
            style={{ ...inputStyle, fontFamily: 'monospace' }}
          />
          <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)', marginTop: 3 }}>
            Format: minute hour day month weekday — all times UTC
          </div>
        </div>
      )}

      {error && (
        <div style={{ fontSize: 12, color: 'var(--color-danger)', marginBottom: 8 }}>{error}</div>
      )}

      <Button variant="primary" onClick={submit} disabled={saving}>
        {saving ? 'Saving…' : 'Create Schedule'}
      </Button>
    </div>
  );
}

export default SchedulesPage;
