import { Button, Card, Checkbox, Chip, DataTable, EntityCell, Inline, MetaLine, Stack } from '@connorhoehnslalom/ui-components/shared';
import type { DataTableColumn } from '@connorhoehnslalom/ui-components/shared';
import { ScoreEntry } from './types';
import { formatScore } from './scoresFormat';

/** A stable id for a row's name button, independent of DOM node identity —
 * see ScoresPage.tsx's focus-restore effect (DEFECTS.md org-leader #12). */
export function scoreRowButtonId(personId: string): string {
  return `score-row-${personId}`;
}

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
      render: (s) => {
        const selected = s.personId === selectedId;
        return (
          // A real interactive element in the row, not just the row's own
          // onClick — that left Tab landing on the compare checkbox with no
          // way to open the row from the keyboard (DEFECTS.md #4).
          // stopPropagation so a click here doesn't also fire the row's
          // onRowClick with the same (idempotent but redundant) toggle.
          <Button
            id={scoreRowButtonId(s.personId)}
            variant="ghost"
            size="sm"
            className={`!h-auto !justify-start !border-0 !bg-transparent !p-0 font-inherit text-inherit hover:!bg-transparent hover:underline focus-visible:underline ${selected ? '' : ''}`}
            onClick={(e) => { e.stopPropagation(); onSelect(selected ? null : s.personId); }}
          >
            {s.name}
          </Button>
        );
      },
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
        size="sm"
        onRowClick={(s) => onSelect(s.personId === selectedId ? null : s.personId)}
      />
    </Card>
  );
}
