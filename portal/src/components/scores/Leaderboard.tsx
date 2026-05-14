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
                <TableTd style={{ textAlign: 'right', fontWeight: 600 }}>{s.composite}</TableTd>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </Card>
  );
}
