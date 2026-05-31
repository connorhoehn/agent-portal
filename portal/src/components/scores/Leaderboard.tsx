import { Card, Table, TableHead, TableBody, TableRow, TableTh, TableTd } from '@connorhoehnslalom/ui-components/shared';
import { ScoreEntry } from './types';

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
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <h2 className="text-sm font-semibold m-0">Leaderboard</h2>
        {rankedBy ? (
          <span className="text-[11px] py-0.5 px-2 rounded-full bg-primary-soft text-primary font-medium">
            Ranked by: {rankedBy}
          </span>
        ) : (
          <span className="text-[11px] font-normal text-text-tertiary">
            composite = {Math.round(weight * 100)}% × influence + {Math.round((1 - weight) * 100)}% × expertise
          </span>
        )}
      </div>
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
            const inf01 = Math.min(1, Math.max(0, s.influence > 1 ? s.influence / 100 : s.influence));
            const exp01 = Math.min(1, Math.max(0, s.expertise > 1 ? s.expertise / 100 : s.expertise));
            const compositeFromWeight = Math.round(weight * inf01 * 100 + (1 - weight) * exp01 * 100);
            const infW = 60 * weight * inf01;
            const expW = 60 * (1 - weight) * exp01;
            const tooltip = `${Math.round(weight * 100)}% influence (${Math.round(weight * inf01 * 100)}) + ${Math.round((1 - weight) * 100)}% expertise (${Math.round((1 - weight) * exp01 * 100)})`;
            return (
              <TableRow
                key={s.personId}
                onClick={() => onSelect(selected ? null : s.personId)}
                className={`cursor-pointer ${selected ? 'bg-surface-hover' : ''}`}
              >
                <TableTd
                  className="w-8 pr-0"
                  onClick={(e: React.MouseEvent) => {
                    e.stopPropagation();
                    if (!checkboxDisabled) onToggleCompare(s.personId);
                  }}
                >
                  <input
                    type="checkbox"
                    checked={inComparison}
                    disabled={checkboxDisabled}
                    onChange={() => {/* controlled via onClick above */}}
                    className={`accent-primary ${checkboxDisabled ? 'cursor-not-allowed' : 'cursor-pointer'}`}
                  />
                </TableTd>
                <TableTd className="text-text-tertiary">{i + 1}</TableTd>
                <TableTd className={selected ? 'font-semibold' : 'font-medium'}>{s.name}</TableTd>
                <TableTd>
                  <span className="text-xs" style={{ color: deptColors[s.department] ?? 'var(--color-text-secondary)' }}>
                    {s.department}
                  </span>
                </TableTd>
                <TableTd className="text-right text-xs text-text-secondary">
                  {Math.round(s.influence)}
                </TableTd>
                <TableTd className="text-right text-xs text-text-secondary">
                  {Math.round(s.expertise)}
                </TableTd>
                <TableTd className="text-right font-semibold">
                  {compositeFromWeight}
                  <div title={tooltip} className="mt-1">
                    <svg width={60} height={6} className="block ml-auto">
                      <rect x={0}    y={0} width={infW} height={6} rx={2} fill="var(--color-primary, #6366f1)" />
                      <rect x={infW} y={0} width={expW} height={6} rx={2} fill="var(--color-success)" />
                    </svg>
                  </div>
                </TableTd>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </Card>
  );
}
