import { RadarBatchEntry, RadarAxes } from './OverlayRadar';

const AXIS_ORDER: Array<{ key: keyof RadarAxes; label: string }> = [
  { key: 'influence', label: 'Influence' },
  { key: 'expertise', label: 'Expertise' },
  { key: 'collaborationBreadth', label: 'Breadth' },
  { key: 'decisionImpact', label: 'Decisions' },
  { key: 'crossTeamReach', label: 'Cross-team' },
  { key: 'recency', label: 'Recency' },
];

const FALLBACK_COLORS = ['#6366f1', '#16a34a', '#d97706', '#dc2626'];

interface CompareDeltaTableProps {
  entries: RadarBatchEntry[];
}

export function CompareDeltaTable({ entries }: CompareDeltaTableProps) {
  if (entries.length === 0) return null;

  const colorFor = (index: number): string =>
    FALLBACK_COLORS[index % FALLBACK_COLORS.length] ?? '#6366f1';

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr>
            <th style={{ textAlign: 'left', padding: '6px 12px', fontWeight: 600, color: 'var(--color-text-secondary)', borderBottom: '1px solid var(--color-border, #3f3f5f)', minWidth: 100 }}>
              Axis
            </th>
            {entries.map((e, i) => (
              <th key={e.personId} style={{ textAlign: 'right', padding: '6px 12px', fontWeight: 600, color: colorFor(i), borderBottom: '1px solid var(--color-border, #3f3f5f)', minWidth: 80 }}>
                {e.name}
              </th>
            ))}
            <th style={{ textAlign: 'right', padding: '6px 12px', fontWeight: 600, color: 'var(--color-text-tertiary)', borderBottom: '1px solid var(--color-border, #3f3f5f)', minWidth: 70 }}>
              &#916; (max-min)
            </th>
          </tr>
        </thead>
        <tbody>
          {AXIS_ORDER.map(({ key, label }) => {
            const values = entries.map(e => e.person[key]);
            const maxVal = Math.max(...values);
            const minVal = Math.min(...values);
            const delta = maxVal - minVal;

            return (
              <tr key={key} style={{ borderBottom: '1px solid var(--color-border-subtle, #2a2a3f)' }}>
                <td style={{ padding: '6px 12px', color: 'var(--color-text-secondary)', fontWeight: 500 }}>
                  {label}
                </td>
                {entries.map((e, i) => {
                  const val = e.person[key];
                  const isMax = val === maxVal && delta > 0;
                  const isMin = val === minVal && delta > 0;
                  return (
                    <td
                      key={e.personId}
                      style={{
                        textAlign: 'right',
                        padding: '6px 12px',
                        fontWeight: isMax ? 700 : 400,
                        color: isMax
                          ? colorFor(i)
                          : isMin
                          ? 'var(--color-text-tertiary, #6b6b8a)'
                          : 'var(--color-text-primary)',
                      }}
                    >
                      {Math.round(val)}
                    </td>
                  );
                })}
                <td style={{ textAlign: 'right', padding: '6px 12px', fontSize: 11, color: 'var(--color-text-tertiary, #6b6b8a)' }}>
                  {Math.round(delta)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
