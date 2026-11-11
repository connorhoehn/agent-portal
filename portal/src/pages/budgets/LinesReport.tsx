// Lines report — the organisation's money that belongs to no initiative
// (GET /api/budgets/lines, learning loop lane B), one row each:
//
//   Learning       server-side distillation of finished runs, spent and held
//                  this month against the organisation's monthly learning cap.
//                  An org leader sets the cap here (PUT /api/budgets/learning);
//                  at the cap the distiller skips and says so.
//   Local compute  runs on paired machines: billed $0 (the operator's own
//                  login pays), the figure their workers reported shown as
//                  "reported, not billed". It never counts toward any cap.

import { useEffect, useRef, useState } from 'react';
import {
  Button,
  Card,
  CardHeader,
  DataTable,
  type DataTableColumn,
  Input,
  T,
} from '@connorhoehn/ui-components/shared';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { toastError, toastSuccess } from '../../lib/toastStore';
import { writeJson } from '../../lib/writeJson';
import { usd } from './budgetsFormat';
import { ThresholdCell } from './ThresholdCell';
import type { BudgetLines, ThresholdMark } from './types';

interface LineRow {
  id: 'learning' | 'local';
  line: string;
  about: string;
  billedUsd: number;
  heldUsd: number | null;
  reportedUsd: number | null;
  runs: number | null;
  capUsd: number | null;
  capSource: 'set' | 'default' | null;
  threshold: ThresholdMark | null;
}

export function lineRows(lines: BudgetLines): LineRow[] {
  return [
    {
      id: 'learning', line: 'Learning', about: 'Server-side distillation of finished runs into runbook proposals',
      billedUsd: lines.learning.spentUsd, heldUsd: lines.learning.heldUsd, reportedUsd: null, runs: lines.learning.entries,
      capUsd: lines.learning.capUsd, capSource: lines.learning.capSource, threshold: lines.learning.threshold,
    },
    {
      id: 'local', line: 'Local compute', about: 'Runs on paired machines: the operator’s own login pays, so nothing is billed and nothing counts toward a cap',
      billedUsd: lines.local.billedUsd, heldUsd: null, reportedUsd: lines.local.reportedUsd, runs: lines.local.runs,
      capUsd: null, capSource: null, threshold: null,
    },
  ];
}

function LearningCapCell({ row, canEdit, onSaved }: { row: LineRow; canEdit: boolean; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (editing) { inputRef.current?.focus({ preventScroll: true }); inputRef.current?.select(); }
  }, [editing]);

  if (row.capUsd == null) return <T tone="tertiary" title="Reported, never billed: no cap applies">none</T>;
  const title = row.capSource === 'default' ? 'The deployment default (LEARNING_BUDGET_USD) until an org leader sets one' : 'Set by an org leader';
  async function save() {
    const value = Number(draft);
    if (draft.trim() === '' || !Number.isFinite(value) || value < 0) { setEditing(false); return; }
    setBusy(true);
    const res = await writeJson('/api/budgets/learning', 'PUT', { monthlyCapUsd: value });
    setBusy(false);
    setEditing(false);
    if (!res.ok) { toastError(null, 'Failed to set the learning budget', res.error ?? undefined); return; }
    toastSuccess(null, 'Learning budget set', `${usd(value)} / month`);
    onSaved();
  }
  if (editing) {
    return (
      <Input
        ref={inputRef}
        type="number"
        min={0}
        step={1}
        value={draft}
        disabled={busy}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void save();
          if (e.key === 'Escape') { e.preventDefault(); setEditing(false); }
        }}
        onBlur={() => { if (!busy) void save(); }}
        aria-label="Monthly learning budget in USD"
        className="ml-auto w-24"
      />
    );
  }
  if (!canEdit) return <T tabular title={title}>{usd(row.capUsd)}</T>;
  return (
    <Button
      variant="link"
      onClick={() => { setDraft(String(row.capUsd)); setEditing(true); }}
      title={`${title}. Click to change the monthly learning budget`}
      aria-label={`Edit the monthly learning budget: ${usd(row.capUsd)}`}
      data-testid="learning-cap-edit"
    >
      <T tabular>{usd(row.capUsd)}</T>
    </Button>
  );
}

export interface LinesReportProps {
  lines: BudgetLines | null;
  error: string | null;
  refresh: () => void;
  /** An org leader (ManageBudgets and an org-wide role) sets the learning cap. */
  canEditLearning: boolean;
  selectedKey?: string | null;
}

export function LinesReport({ lines, error, refresh, canEditLearning, selectedKey = null }: LinesReportProps) {
  if (error && !lines) {
    return <UnavailableNotice error={error} what="the organisation's lines" source="Lines are read from the spend ledger" onRetry={refresh} />;
  }
  const rows = lines ? lineRows(lines) : [];
  const columns: DataTableColumn<LineRow>[] = [
    { key: 'line', header: 'Line', render: (r) => <T weight="medium" title={r.about}>{r.line}</T> },
    { key: 'billed', header: 'Billed', numeric: true, render: (r) => <T tabular>{usd(r.billedUsd)}</T> },
    {
      key: 'held',
      header: 'Held',
      numeric: true,
      render: (r) => (r.heldUsd == null ? <T tone="tertiary">—</T> : <T tabular tone={r.heldUsd ? undefined : 'tertiary'} title="Reserved by distillations in flight">{r.heldUsd ? usd(r.heldUsd) : '—'}</T>),
    },
    {
      key: 'reported',
      header: 'Reported, not billed',
      label: 'Reported, not billed',
      numeric: true,
      render: (r) => (r.reportedUsd == null
        ? <T tone="tertiary">—</T>
        : <T tabular tone="secondary" title={`What ${r.runs ?? 0} local run${r.runs === 1 ? '' : 's'} reported this month. Never billed, never counted toward a cap.`}>{usd(r.reportedUsd)}</T>),
    },
    { key: 'runs', header: 'Runs', numeric: true, priority: 3, render: (r) => <T tabular tone="secondary">{r.runs ?? '—'}</T> },
    { key: 'cap', header: 'Monthly cap', label: 'Monthly cap', numeric: true, render: (r) => <LearningCapCell row={r} canEdit={canEditLearning} onSaved={refresh} /> },
    { key: 'threshold', header: 'Threshold', render: (r) => (r.threshold ? <ThresholdCell mark={r.threshold} what="cap" /> : <T tone="tertiary" title="Never counts toward a cap">—</T>) },
  ];
  return (
    <Card padding="none" className="overflow-x-auto">
      <CardHeader
        inset
        title="Lines"
        subtitle="The organisation's money that belongs to no initiative, this month: learning under its own cap, local compute as reported, not billed."
        action={lines ? <T size="xs" tone="tertiary" tabular>{lines.month}</T> : undefined}
      />
      <DataTable
        data-testid="budgets-lines-table"
        frameless
        narrow
        responsiveColumns
        loading={!lines}
        data={rows}
        columns={columns}
        keyField={(r) => r.id}
        selectedKey={selectedKey}
        emptyMessage="No lines."
      />
    </Card>
  );
}
