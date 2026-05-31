import {
  Radar,
  RadarChart as RechartsRadarChart,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
  ResponsiveContainer,
  Tooltip,
  Legend,
} from 'recharts';

export interface RadarAxes {
  influence: number;
  expertise: number;
  collaborationBreadth: number;
  decisionImpact: number;
  crossTeamReach: number;
  recency: number;
}

export interface RadarBatchEntry {
  personId: string;
  name: string;
  person: RadarAxes;
  peerMax: RadarAxes;
}

interface AxisDef {
  key: keyof RadarAxes;
  label: string;
}

const AXIS_ORDER: AxisDef[] = [
  { key: 'influence', label: 'Influence' },
  { key: 'expertise', label: 'Expertise' },
  { key: 'collaborationBreadth', label: 'Breadth' },
  { key: 'decisionImpact', label: 'Decisions' },
  { key: 'crossTeamReach', label: 'Cross-team' },
  { key: 'recency', label: 'Recency' },
];

const FALLBACK_COLORS = ['#6366f1', '#16a34a', '#d97706', '#dc2626'];

// Compute element-wise max across all peerMax entries.
function mergedPeerMax(entries: RadarBatchEntry[]): RadarAxes {
  const zero: RadarAxes = {
    influence: 0,
    expertise: 0,
    collaborationBreadth: 0,
    decisionImpact: 0,
    crossTeamReach: 0,
    recency: 0,
  };
  return entries.reduce<RadarAxes>((acc, e) => {
    const keys = Object.keys(acc) as Array<keyof RadarAxes>;
    const next = { ...acc };
    for (const k of keys) {
      next[k] = Math.max(acc[k], e.peerMax[k]);
    }
    return next;
  }, zero);
}

interface OverlayDataPoint {
  subject: string;
  [personId: string]: number | string;
}

function buildChartData(entries: RadarBatchEntry[], peerMax: RadarAxes): OverlayDataPoint[] {
  return AXIS_ORDER.map(({ key, label }) => {
    const point: OverlayDataPoint = { subject: label };
    for (const e of entries) {
      const raw = e.person[key];
      const max = peerMax[key];
      point[e.personId] = max === 0 ? 0 : Math.min((raw / max) * 100, 100);
    }
    return point;
  });
}

interface OverlayRadarProps {
  entries: RadarBatchEntry[];
  deptColors?: Record<string, string>;
}

export function OverlayRadar({ entries, deptColors = {} }: OverlayRadarProps) {
  if (entries.length === 0) {
    return (
      <div className="h-[380px] flex items-center justify-center text-text-tertiary text-xs">
        No radar data
      </div>
    );
  }

  const peerMax = mergedPeerMax(entries);
  const chartData = buildChartData(entries, peerMax);

  const colorFor = (entry: RadarBatchEntry, index: number): string => {
    // Try dept color first, then fallback palette.
    return deptColors[entry.name] ?? FALLBACK_COLORS[index % FALLBACK_COLORS.length] ?? '#6366f1';
  };

  return (
    <ResponsiveContainer width="100%" height={380}>
      <RechartsRadarChart data={chartData} margin={{ top: 20, right: 40, bottom: 20, left: 40 }}>
        <PolarGrid stroke="var(--color-border, #3f3f5f)" />
        <PolarAngleAxis
          dataKey="subject"
          tick={{ fontSize: 11, fill: 'var(--color-text-secondary, #a0a0c0)' }}
        />
        <PolarRadiusAxis
          angle={90}
          domain={[0, 100]}
          tick={{ fontSize: 9, fill: 'var(--color-text-tertiary, #6b6b8a)' }}
          tickCount={4}
        />
        {entries.map((e, i) => {
          const color = colorFor(e, i);
          return (
            <Radar
              key={e.personId}
              name={e.name}
              dataKey={e.personId}
              stroke={color}
              fill={color}
              fillOpacity={0.18}
              strokeWidth={2}
            />
          );
        })}
        <Tooltip
          contentStyle={{
            background: 'var(--color-surface, #1e1e2e)',
            border: '1px solid var(--color-border, #3f3f5f)',
            borderRadius: 6,
            fontSize: 12,
          }}
          formatter={(value) => {
            const v = typeof value === 'number' ? value : 0;
            return [`${Math.round(v)}%`];
          }}
        />
        <Legend
          wrapperStyle={{ fontSize: 12, paddingTop: 8 }}
        />
      </RechartsRadarChart>
    </ResponsiveContainer>
  );
}
