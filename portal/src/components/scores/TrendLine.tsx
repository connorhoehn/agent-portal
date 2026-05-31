import { Sparkline } from '@connorhoehnslalom/ui-components/shared';

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
      <div className="text-xs text-text-tertiary py-2">
        Loading trend...
      </div>
    );
  }

  if (history === null || history.samples.length === 0) {
    return (
      <div className="py-3 rounded-md">
        <div className="text-[13px] font-semibold text-text-primary mb-1">
          No trend data
        </div>
        <div className="text-xs text-text-secondary leading-relaxed">
          Run the scoring agent to start tracking scores over time.
        </div>
      </div>
    );
  }

  const { samples, deltaVs7d } = history;
  const series = samples.map((s) => s.score);

  const deltaClass =
    deltaVs7d === null
      ? 'text-text-tertiary'
      : deltaVs7d >= 0
      ? 'text-success'
      : 'text-danger';

  const deltaLabel =
    deltaVs7d === null
      ? '—'
      : `${deltaVs7d >= 0 ? '↑' : '↓'} ${Math.abs(Math.round(deltaVs7d))}`;

  return (
    <div className="flex items-center gap-3">
      <div className="flex-[0_0_200px] h-[60px]">
        <Sparkline data={series} width={200} height={60} color="var(--color-primary, #6366f1)" />
      </div>

      <div className="flex flex-col items-start gap-0.5">
        <span className={`text-sm font-bold leading-none ${deltaClass}`}>
          {deltaLabel}
        </span>
        <span className="text-[10px] text-text-tertiary">vs 7d ago</span>
      </div>
    </div>
  );
}
