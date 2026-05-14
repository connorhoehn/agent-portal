import { Card, Table, TableHead, TableBody, TableRow, TableTh, TableTd } from '@connorhoehnslalom/ui-components/shared';
import { ScoreEntry } from './types';

interface Props {
  entries: ScoreEntry[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  deptColors: Record<string, string>;
  rankedBy?: string | null;
}

export function Leaderboard({ entries, selectedId, onSelect, deptColors, rankedBy }: Props) {
  return (
    <Card padding="md">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <h2 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>
          Leaderboard
        </h2>
        {rankedBy ? (
          <span style={{
            fontSize: 11,
            padding: '2px 8px',
            borderRadius: 999,
            background: 'var(--color-primary-soft, #eef2ff)',
            color: 'var(--color-primary, #6366f1)',
            fontWeight: 500,
          }}>
            Ranked by: {rankedBy}
          </span>
        ) : (
          <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--color-text-tertiary)' }}>
            composite = 0.55 × influence (PageRank) + 0.45 × expertise (skill-weighted in-degree)
          </span>
        )}
      </div>
      <Table>
        <TableHead>
          <TableRow>
            <TableTh>#</TableTh>
            <TableTh>Name</TableTh>
            <TableTh>Department</TableTh>
            <TableTh style={{ textAlign: 'right' }}>Influence</TableTh>
            <TableTh style={{ textAlign: 'right' }}>Expertise</TableTh>
            <TableTh style={{ textAlign: 'right' }}>Composite</TableTh>
          </TableRow>
        </TableHead>
        <TableBody>
          {entries.map((s, i) => {
            const selected = s.personId === selectedId;
            const inf01 = Math.min(1, Math.max(0, s.influence > 1 ? s.influence / 100 : s.influence));
            const exp01 = Math.min(1, Math.max(0, s.expertise > 1 ? s.expertise / 100 : s.expertise));
            const infW = 60 * 0.55 * inf01;
            const expW = 60 * 0.45 * exp01;
            const tooltip = `55% influence (${Math.round(0.55 * inf01 * 100)}) + 45% expertise (${Math.round(0.45 * exp01 * 100)})`;
            return (
              <TableRow
                key={s.personId}
                onClick={() => onSelect(selected ? null : s.personId)}
                style={{ cursor: 'pointer', background: selected ? 'var(--color-surface-hover)' : undefined }}
              >
                <TableTd style={{ color: 'var(--color-text-tertiary)' }}>{i + 1}</TableTd>
                <TableTd style={{ fontWeight: selected ? 600 : 500 }}>{s.name}</TableTd>
                <TableTd>
                  <span style={{ color: deptColors[s.department] ?? '#64748b', fontSize: 12 }}>
                    {s.department}
                  </span>
                </TableTd>
                <TableTd style={{ textAlign: 'right', fontSize: 12, color: 'var(--color-text-secondary)' }}>
                  {Math.round(s.influence)}
                </TableTd>
                <TableTd style={{ textAlign: 'right', fontSize: 12, color: 'var(--color-text-secondary)' }}>
                  {Math.round(s.expertise)}
                </TableTd>
                <TableTd style={{ textAlign: 'right', fontWeight: 600 }}>
                  {s.composite}
                  <div title={tooltip} style={{ marginTop: 4 }}>
                    <svg width={60} height={6} style={{ display: 'block', marginLeft: 'auto' }}>
                      <rect x={0}    y={0} width={infW} height={6} rx={2} fill="var(--color-primary, #6366f1)" />
                      <rect x={infW} y={0} width={expW} height={6} rx={2} fill="#16a34a" />
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
