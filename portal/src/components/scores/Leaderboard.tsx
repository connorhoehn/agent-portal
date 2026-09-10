import { Button, Card, Checkbox, Chip, EntityCell, Inline, MetaLine, Stack, Table, TableBody, TableHead, TableRow, TableTd, TableTh } from '@connorhoehnslalom/ui-components/shared';
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
  return (
    <Card padding="md">
      <Inline gap="sm" align="center" wrap className="mb-3">
        <EntityCell label="Leaderboard" labelClassName="text-sm" />
        {rankedBy ? (
          <Chip size="xs" tone="accent">Ranked by: {rankedBy}</Chip>
        ) : (
          <MetaLine
            size="xs"
            items={[`composite = ${Math.round(weight * 100)}% × influence + ${Math.round((1 - weight) * 100)}% × expertise`]}
          />
        )}
      </Inline>
      <Table>
        <TableHead>
          <TableRow>
            <TableTh className="w-8" />
            <TableTh>#</TableTh>
            <TableTh>Name</TableTh>
            <TableTh>Department</TableTh>
            <TableTh className="text-right">Influence</TableTh>
            <TableTh className="text-right">Expertise</TableTh>
            <TableTh className="text-right">Composite</TableTh>
          </TableRow>
        </TableHead>
        <TableBody>
          {entries.map((s, i) => {
            const selected = s.personId === selectedId;
            const inComparison = comparisonIds.has(s.personId);
            const checkboxDisabled = compareDisabled && !inComparison;
            // Influence/expertise/composite all pass through the one
            // `formatScore` normalizer — DEFECTS.md org-leader #11 was three
            // different scales for one score because this row used to
            // re-derive its own influence/expertise fractions independently
            // of the composite computed upstream in ScoresPage.
            const infScore = formatScore(s.influence);
            const expScore = formatScore(s.expertise);
            const compositeScore = formatScore(s.composite);
            const infW = 60 * (weight * infScore) / 100;
            const expW = 60 * ((1 - weight) * expScore) / 100;
            const tooltip = `${Math.round(weight * 100)}% influence (${infScore}) + ${Math.round((1 - weight) * 100)}% expertise (${expScore})`;
            return (
              <TableRow
                key={s.personId}
                onClick={() => onSelect(selected ? null : s.personId)}
                className={`cursor-pointer ${selected ? 'bg-surface-hover' : ''}`}
              >
                <TableTd className="w-8 pr-0">
                  <Checkbox
                    checked={inComparison}
                    disabled={checkboxDisabled}
                    onChange={() => onToggleCompare(s.personId)}
                    onClick={(e) => e.stopPropagation()}
                    aria-label={`Compare ${s.name}`}
                  />
                </TableTd>
                <TableTd className="text-text-tertiary">{i + 1}</TableTd>
                <TableTd className={selected ? 'font-semibold' : 'font-medium'}>
                  {/* A real interactive element in the row, not just the <tr>
                      onClick above — that left Tab landing on the compare
                      checkbox with no way to open the row from the keyboard
                      (DEFECTS.md #4). stopPropagation so a click here doesn't
                      also fire the row's own onClick with the same (idempotent
                      but redundant) toggle. */}
                  <Button
                    id={scoreRowButtonId(s.personId)}
                    variant="ghost"
                    size="sm"
                    className="!h-auto !justify-start !border-0 !bg-transparent !p-0 font-inherit text-inherit hover:!bg-transparent hover:underline focus-visible:underline"
                    onClick={(e) => { e.stopPropagation(); onSelect(selected ? null : s.personId); }}
                  >
                    {s.name}
                  </Button>
                </TableTd>
                <TableTd>
                  {/* Department colour is graph data, not a design token, so
                      it stays a style — Tailwind cannot build a class from a
                      runtime key. */}
                  <MetaLine
                    size="sm"
                    items={[<Inline as="span" gap="none" key="d" style={{ color: deptColors[s.department] ?? 'var(--color-text-secondary)' }}>{s.department}</Inline>]}
                  />
                </TableTd>
                <TableTd className="text-right text-xs text-text-secondary">
                  {infScore}
                </TableTd>
                <TableTd className="text-right text-xs text-text-secondary">
                  {expScore}
                </TableTd>
                <TableTd className="text-right font-semibold">
                  {compositeScore}
                  <Stack gap="none" title={tooltip} className="mt-1">
                    <svg width={60} height={6} className="block ml-auto">
                      <rect x={0}    y={0} width={infW} height={6} rx={2} fill="var(--color-primary, #6366f1)" />
                      <rect x={infW} y={0} width={expW} height={6} rx={2} fill="var(--color-success)" />
                    </svg>
                  </Stack>
                </TableTd>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </Card>
  );
}
