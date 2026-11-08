import { Card, Checkbox, Chip, DataTable, EntityCell, Inline, MetaLine, Stack } from '@connorhoehn/ui-components/shared';
import type { DataTableColumn } from '@connorhoehn/ui-components/shared';
import { ScoreEntry } from './types';
import { formatScore } from './scoresFormat';

interface Props {
  entries: ScoreEntry[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  deptColors: Record<string, string>;
  rankedBy?: string | null;
  weight?: number;
  comparisonIds: Set<string>;
  onToggleCompare: (id: string) => void;
  compareDisabled: boolean;
}

export function Leaderboard({ entries, selectedId, onSelect, deptColors, rankedBy, weight = 0.55, comparisonIds, onToggleCompare, compareDisabled }: Props) {
  const columns: DataTableColumn<ScoreEntry>[] = [
    {
      key: 'rank',
      header: '#',
      className: 'text-text-tertiary',
      // Rank reflects display order, not a sortable value — the table is
      // never sorted or filtered here, so `rowIndex` is exactly `entries`'
      // own index.
      render: (_s, rowIndex) => rowIndex + 1,
    },
    {
      key: 'name',
      header: 'Name',
      getFilterText: (s) => s.name,
      // The row itself is the keyboard control (DataTable's onRowClick rows are
      // focusable and activate on Enter/Space), so the name is plain text.
      render: (s) => s.name,
    },
    {
      key: 'compare',
      header: '',
      width: '32px',
      render: (s) => {
        const inComparison = comparisonIds.has(s.personId);
        const checkboxDisabled = compareDisabled && !inComparison;
        return (
          <Checkbox
            checked={inComparison}
            disabled={checkboxDisabled}
            onChange={() => onToggleCompare(s.personId)}
            onClick={(e) => e.stopPropagation()}
            aria-label={`Compare ${s.name}`}
          />
        );
      },
    },
    {
      key: 'department',
      header: 'Department',
      getFilterText: (s) => s.department,
      render: (s) => (
        // Department colour is graph data, not a design token, so it stays a
        // style — Tailwind cannot build a class from a runtime key.
        <MetaLine
          size="sm"
          items={[<Inline as="span" gap="none" key="d" style={{ color: deptColors[s.department] ?? 'var(--color-text-secondary)' }}>{s.department}</Inline>]}
        />
      ),
    },
    {
      key: 'influence',
      header: 'Influence',
      numeric: true,
      className: 'text-text-secondary',
      render: (s) => formatScore(s.influence),
    },
    {
      key: 'expertise',
      header: 'Expertise',
      numeric: true,
      className: 'text-text-secondary',
      render: (s) => formatScore(s.expertise),
    },
    {
      key: 'composite',
      header: 'Composite',
      numeric: true,
      render: (s) => {
        // Influence/expertise/composite all pass through the one
        // `formatScore` normalizer — DEFECTS.md org-leader #11 was three
        // different scales for one score because this row used to re-derive
        // its own influence/expertise fractions independently of the
        // composite computed upstream in ScoresPage.
        const infScore = formatScore(s.influence);
        const expScore = formatScore(s.expertise);
        const compositeScore = formatScore(s.composite);
        const infW = 60 * (weight * infScore) / 100;
        const expW = 60 * ((1 - weight) * expScore) / 100;
        const tooltip = `${Math.round(weight * 100)}% influence (${infScore}) + ${Math.round((1 - weight) * 100)}% expertise (${expScore})`;
        return (
          <Inline gap="sm" align="center" justify="end" wrap={false} title={tooltip}>
            {compositeScore}
            <svg width={60} height={6} className="block shrink-0" aria-hidden="true">
              <rect x={0}    y={0} width={infW} height={6} rx={2} fill="var(--color-primary, #6366f1)" />
              <rect x={infW} y={0} width={expW} height={6} rx={2} fill="var(--color-success)" />
            </svg>
          </Inline>
        );
      },
    },
  ];

  return (
    <Card padding="md">
      <Inline gap="sm" align="center" wrap className="mb-3">
        <EntityCell label="Leaderboard" labelClassName="" />
        {rankedBy ? (
          <Chip size="xs" tone="accent">Ranked by: {rankedBy}</Chip>
        ) : (
          <MetaLine
            size="xs"
            items={[`composite = ${Math.round(weight * 100)}% × influence + ${Math.round((1 - weight) * 100)}% × expertise`]}
          />
        )}
      </Inline>
      <DataTable<ScoreEntry>
        data={entries}
        columns={columns}
        keyField={(s) => s.personId}
        onRowClick={(s) => onSelect(s.personId === selectedId ? null : s.personId)}
      />
    </Card>
  );
}
