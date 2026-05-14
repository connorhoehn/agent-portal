import {
  ResponsiveContainer,
  LineChart,
  Line,
  Tooltip,
} from 'recharts';

export interface HistorySample {
  ts: string;
  score: number;
}

export interface HistoryResponse {
  personId: string;
  samples: HistorySample[];
  deltaVs7d: number | null;
}

export interface TrendLineProps {
  history: HistoryResponse | null | undefined;
}

export function TrendLine({ history }: TrendLineProps) {
  if (history === undefined) {
    return (
      <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)', padding: '8px 0' }}>
        Loading trend...
      </div>
    );
  }

  if (history === null || history.samples.length === 0) {
    return (
      <div
        style={{
          padding: '12px 0',
          borderRadius: 6,
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: 4 }}>
          No trend data
        </div>
        <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>
          Run the scoring agent to start tracking scores over time.
        </div>
      </div>
    );
  }

  const { samples, deltaVs7d } = history;

  const deltaColor =
    deltaVs7d === null
      ? 'var(--color-text-tertiary)'
      : deltaVs7d >= 0
      ? '#16a34a'
      : '#dc2626';

  const deltaLabel =
    deltaVs7d === null
      ? '—'
      : `${deltaVs7d >= 0 ? '↑' : '↓'} ${Math.abs(Math.round(deltaVs7d))}`;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <div style={{ flex: '0 0 200px', height: 60 }}>
        <ResponsiveContainer width="100%" height={60}>
          <LineChart data={samples} margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
            <Tooltip
              contentStyle={{ fontSize: 11 }}
              formatter={(value: unknown) => [(value as number).toFixed(1), 'Score']}
              labelFormatter={(label: unknown) => String(label).slice(0, 10)}
            />
            <Line
              type="monotone"
              dataKey="score"
              stroke="var(--color-primary, #6366f1)"
              dot={false}
              strokeWidth={1.5}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
        <span
          style={{
            fontSize: 14,
            fontWeight: 700,
            color: deltaColor,
            lineHeight: 1,
          }}
        >
          {deltaLabel}
        </span>
        <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)' }}>vs 7d ago</span>
      </div>
    </div>
  );
}
