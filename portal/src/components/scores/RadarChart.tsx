import {
  Radar,
  RadarChart as RechartsRadarChart,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
  ResponsiveContainer,
  Tooltip,
} from 'recharts';

export interface RadarAxes {
  influence: number;
  expertise: number;
  collaborationBreadth: number;
  decisionImpact: number;
  crossTeamReach: number;
  recency: number;
}

export interface RadarChartProps {
  radar:
    | {
        person: RadarAxes;
        peerMax: RadarAxes;
      }
    | null
    | undefined;
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

const PRIMARY = 'var(--color-primary, #6366f1)';

// One data point per axis — recharts RadarChart pattern
interface RadarDataPoint {
  subject: string;
  pct: number;
  raw: number;
}

function buildChartData(person: RadarAxes, peerMax: RadarAxes): RadarDataPoint[] {
  return AXIS_ORDER.map(({ key, label }) => {
    const raw = person[key];
    const max = peerMax[key];
    const pct = max === 0 ? 0 : Math.min((raw / max) * 100, 100);
    return { subject: label, pct, raw };
  });
}

function CustomTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload?: RadarDataPoint }>;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const entry = payload[0]?.payload;
  if (!entry) return null;
  return (
    <div
      style={{
        background: 'var(--color-surface, #1e1e2e)',
        border: '1px solid var(--color-border, #3f3f5f)',
        borderRadius: 6,
        padding: '6px 10px',
        fontSize: 12,
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 2 }}>{entry.subject}</div>
      <div style={{ color: 'var(--color-text-secondary, #a0a0c0)' }}>
        {Math.round(entry.pct)}% of peer max
      </div>
      <div style={{ color: 'var(--color-text-tertiary, #6b6b8a)', fontSize: 10 }}>
        raw: {entry.raw}
      </div>
    </div>
  );
}

export function RadarChart({ radar }: RadarChartProps) {
  if (!radar) {
    return (
      <div
        style={{
          height: 220,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--color-text-tertiary)',
          fontSize: 12,
        }}
      >
        No radar data
      </div>
    );
  }

  const chartData = buildChartData(radar.person, radar.peerMax);

  return (
    <ResponsiveContainer width="100%" height={220}>
      <RechartsRadarChart data={chartData} margin={{ top: 10, right: 20, bottom: 10, left: 20 }}>
        <PolarGrid stroke="var(--color-border, #3f3f5f)" />
        <PolarAngleAxis
          dataKey="subject"
          tick={{ fontSize: 10, fill: 'var(--color-text-secondary, #a0a0c0)' }}
        />
        <PolarRadiusAxis
          angle={90}
          domain={[0, 100]}
          tick={{ fontSize: 9, fill: 'var(--color-text-tertiary, #6b6b8a)' }}
          tickCount={4}
        />
        <Radar
          name="Score"
          dataKey="pct"
          stroke={PRIMARY}
          fill={PRIMARY}
          fillOpacity={0.3}
        />
        <Tooltip content={<CustomTooltip />} />
      </RechartsRadarChart>
    </ResponsiveContainer>
  );
}
