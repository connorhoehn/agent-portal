// Step 2 of the Submissions wizard: preview the parsed rows, classified new/seen/unknown
// team, and match each unresolved row to a team before committing. Structure mirrors the
// source app's PreviewStep.tsx; re-expressed on the library's DataTable instead of a
// hand-rolled table.

import { useEffect, useMemo, useState } from 'react';
import { Button, Checkbox, Chip, DataTable, InlineAlert, MetaLine, Select, Stack, T, Toolbar, ToolbarGroup, ToolbarLabel } from '@connorhoehn/ui-components/shared';
import { formatRelativeTime, resolveRowStatusDisplay } from '../secondaryFormat';
import type { CommitResponse, CommitSelection, ParsedRow, ParseResponse, TeamOption } from '../secondaryTypes';
import { useCapabilities } from '../../../lib/capabilities';
import { toastError } from '../../../lib/toastStore';

interface PreviewStepProps {
  parse: ParseResponse;
  onCommitted: (commit: CommitResponse) => void;
  onBack: () => void;
}

export default function PreviewStep({ parse, onCommitted, onBack }: PreviewStepProps) {
  const { can, ready } = useCapabilities();
  const canManage = ready && can('ManageSubmissions');

  const [teamOptions, setTeamOptions] = useState<TeamOption[]>([]);
  const [selected, setSelected] = useState<Set<number>>(
    () => new Set(parse.rows.filter((r) => r.status === 'new' && r.team_id !== null).map((r) => r.row_index)),
  );
  const [assignments, setAssignments] = useState<Record<number, string>>({});
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/assessment/teams', { credentials: 'include' })
      .then((res) => (res.ok ? res.json() : []))
      .then((body: unknown) => {
        if (cancelled) return;
        const list = Array.isArray(body) ? body : Array.isArray((body as { teams?: unknown })?.teams) ? (body as { teams: unknown[] }).teams : [];
        setTeamOptions(list as TeamOption[]);
      })
      .catch(() => { /* team picker degrades to "type a team id" — nothing to guard here */ });
    return () => { cancelled = true; };
  }, []);

  const teamIdFor = (row: ParsedRow): string | null => row.team_id ?? assignments[row.row_index] ?? null;
  const isReady = (row: ParsedRow): boolean => Boolean(teamIdFor(row));

  const selectedRows = useMemo(() => parse.rows.filter((r) => selected.has(r.row_index)), [parse.rows, selected]);
  const blockedCount = selectedRows.filter((r) => !isReady(r)).length;

  function toggleRow(rowIndex: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(rowIndex)) next.delete(rowIndex);
      else next.add(rowIndex);
      return next;
    });
  }

  async function commit() {
    if (!canManage) return;
    const selections: CommitSelection[] = selectedRows
      .map((row) => {
        const teamId = teamIdFor(row);
        return teamId ? { row_index: row.row_index, team_id: teamId } : null;
      })
      .filter((s): s is CommitSelection => s !== null);
    if (selections.length === 0) return;
    setCommitting(true);
    setError(null);
    try {
      const res = await fetch('/api/assessment/submissions/commit', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ staging_token: parse.staging_token, selections }),
      });
      const body = (await res.json().catch(() => ({}))) as Partial<CommitResponse> & { error?: string };
      if (!res.ok) throw new Error(body.error ?? `Commit failed (HTTP ${res.status}).`);
      if (!Array.isArray(body.results)) throw new Error("The commit response didn't include any results.");
      onCommitted(body as CommitResponse);
    } catch (err) {
      setError((err as Error).message);
      toastError(null, 'Commit failed', (err as Error).message);
    } finally {
      setCommitting(false);
    }
  }

  return (
    <Stack gap="md">
      {parse.mapping_warnings.length > 0 && (
        <InlineAlert tone="warning">
          {parse.mapping_warnings.join(' ')}
        </InlineAlert>
      )}
      {error && <InlineAlert tone="error">{error}</InlineAlert>}

      <DataTable<ParsedRow>
        data={parse.rows}
        keyField={(row) => String(row.row_index)}
        striped
        emptyMessage="No data rows found in this file."
        // A bulk form export can carry far more rows than a screen — 25
        // keeps the review step scannable before committing them all.
        pageSize={25}
        columns={[
          {
            key: 'select',
            header: '',
            width: '40px',
            render: (row) => (
              <Checkbox
                checked={selected.has(row.row_index)}
                onChange={() => toggleRow(row.row_index)}
                disabled={!canManage}
                aria-label={`Select row ${row.form_id}`}
              />
            ),
          },
          { key: 'form_id', header: 'Form Id', render: (row) => <T size="sm" weight="medium">{row.form_id}</T> },
          {
            key: 'status',
            header: 'Status',
            render: (row) => {
              const { label, tone } = resolveRowStatusDisplay(row.status, isReady(row), (row.seen_team_ids ?? []).includes(teamIdFor(row) ?? ''));
              return <Chip tone={tone}>{label}</Chip>;
            },
          },
          {
            key: 'team',
            header: 'Team',
            render: (row) =>
              row.team_id ? (
                <Chip tone="neutral">{teamOptions.find((t) => t.id === row.team_id)?.name ?? row.team_id}</Chip>
              ) : (
                <Select
                  size="sm"
                  placeholder="Match a team…"
                  value={assignments[row.row_index] ?? ''}
                  onChange={(e) => {
                    const teamId = e.target.value;
                    setAssignments((prev) => ({ ...prev, [row.row_index]: teamId }));
                    if ((row.seen_team_ids ?? []).includes(teamId)) {
                      setSelected((prev) => { const next = new Set(prev); next.delete(row.row_index); return next; });
                    }
                  }}
                  options={teamOptions.map((t) => ({ value: t.id, label: t.name }))}
                  disabled={!canManage}
                />
              ),
          },
          {
            key: 'submitter',
            header: 'Submitter',
            render: (row) => <T size="sm" title={row.submitter_email}>{row.submitter_name}</T>,
          },
          { key: 'submitted_at', header: 'Submitted', numeric: true, render: (row) => formatRelativeTime(row.submitted_at) },
          { key: 'dimensions', header: 'Dimensions', numeric: true, render: (row) => `${row.dimensions_informed} informed` },
          { key: 'links', header: 'Links', numeric: true, render: (row) => `${row.links.length} link${row.links.length === 1 ? '' : 's'}` },
        ]}
      />

      <Toolbar
        aria-label="Selection actions"
        end={
          <ToolbarGroup>
            <Button variant="secondary" onClick={onBack}>
              ← Back
            </Button>
            {canManage && (
              <Button
                onClick={() => void commit()}
                disabled={selectedRows.length === 0 || blockedCount > 0 || committing}
              >
                {committing ? 'Committing…' : `Commit ${selectedRows.length} submission${selectedRows.length === 1 ? '' : 's'}`}
              </Button>
            )}
          </ToolbarGroup>
        }
      >
        <ToolbarLabel>
          {selectedRows.length} submission{selectedRows.length === 1 ? '' : 's'} selected
        </ToolbarLabel>
        {blockedCount > 0 && (
          <ToolbarLabel className="text-danger">({blockedCount} need a team)</ToolbarLabel>
        )}
      </Toolbar>
    </Stack>
  );
}
