import { Card } from '@connorhoehnslalom/ui-components/shared';
import { PersonDetail, formatRelativeTime } from './types';
import { RadarChart, type RadarAxes } from './RadarChart';
import { TrendLine } from './TrendLine';
import { useFetch } from '../../hooks/useFetch';

interface RadarResponse {
  personId: string;
  person: RadarAxes;
  peerMax: RadarAxes;
}

interface HistoryResponse {
  personId: string;
  samples: Array<{ ts: string; score: number }>;
  deltaVs7d: number | null;
}

interface Props {
  detail: PersonDetail;
  deptColors: Record<string, string>;
  onClose: () => void;
  onSelectConnection: (id: string) => void;
}

export function PersonDetailCard({ detail, deptColors, onClose, onSelectConnection }: Props) {
  const { data: radar } = useFetch<RadarResponse>(
    detail.id ? `/api/scores/${encodeURIComponent(detail.id)}/radar` : '',
  );
  const { data: history } = useFetch<HistoryResponse>(
    detail.id ? `/api/scores/${encodeURIComponent(detail.id)}/history?days=30` : '',
  );
  return (
    <Card padding="md">
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 8 }}>
        <div>
          <h2 style={{ fontSize: 16, fontWeight: 600 }}>{detail.name}</h2>
          <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>{detail.title}</div>
          <div style={{ fontSize: 11, color: deptColors[detail.department] ?? 'var(--color-text-tertiary)', marginTop: 2 }}>
            {detail.department}
          </div>
        </div>
        <button
          onClick={onClose}
          style={{ fontSize: 11, padding: '2px 8px', background: 'none', border: '1px solid var(--color-border)', borderRadius: 4, cursor: 'pointer', color: 'var(--color-text-secondary)' }}
        >
          Close
        </button>
      </div>

      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: 16, marginBottom: 6 }}>
        Skills
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {detail.skills.length === 0 ? (
          <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>none recorded</span>
        ) : (
          detail.skills.map(s => (
            <span key={s} style={{ fontSize: 11, padding: '2px 8px', background: 'var(--color-surface-hover)', borderRadius: 4 }}>{s}</span>
          ))
        )}
      </div>

      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: 16, marginBottom: 6 }}>
        Radar
      </div>
      <RadarChart radar={radar} />

      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: 16, marginBottom: 6 }}>
        Trend
      </div>
      <TrendLine history={history} />

      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: 16, marginBottom: 6 }}>
        Top Connections ({detail.connections.length} total)
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 280, overflowY: 'auto' }}>
        {detail.connections
          .slice()
          .sort((a, b) => b.strength - a.strength)
          .slice(0, 12)
          .map((c, i) => (
            <div
              key={`${c.source}-${c.target}-${i}`}
              onClick={() => c.otherPerson && onSelectConnection(c.otherPerson.id)}
              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, padding: '4px 8px', borderRadius: 3, cursor: c.otherPerson ? 'pointer' : 'default' }}
            >
              <span>{c.otherPerson?.name ?? c.target}</span>
              <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)' }}>
                {c.type.replace(/_/g, ' ')} · {Math.round(c.strength * 100)}%
              </span>
            </div>
          ))}
      </div>

      <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginTop: 12 }}>
        Scored {formatRelativeTime(detail.scoredAt)}
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--color-border)', fontSize: 13 }}>
        <span style={{ color: 'var(--color-text-secondary)' }}>Influence (PageRank)</span>
        <span style={{ fontWeight: 600 }}>{Math.round(detail.influenceScore * 100)}</span>
      </div>
    </Card>
  );
}
