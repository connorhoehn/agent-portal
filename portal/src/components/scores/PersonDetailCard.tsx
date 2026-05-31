import { useState } from 'react';
import { Link } from 'react-router';
import { Button, Card } from '@connorhoehnslalom/ui-components/shared';
import { PersonDetail, formatRelativeTime } from './types';
import { RadarChart, type RadarAxes } from './RadarChart';
import { TrendLine } from './TrendLine';
import { WhyDrawer, type ContributionsResponse } from './WhyDrawer';
import { useFetch } from '../../hooks/useFetch';
import { useSession } from '../../lib/auth';

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

const SECTION_HEADER = 'text-[11px] font-semibold text-text-tertiary uppercase tracking-wider mt-4 mb-1.5';

export function PersonDetailCard({ detail, deptColors, onClose, onSelectConnection }: Props) {
  const { session } = useSession();
  const { data: radar } = useFetch<RadarResponse>(
    detail.id ? `/api/scores/${encodeURIComponent(detail.id)}/radar` : '',
  );
  const { data: history } = useFetch<HistoryResponse>(
    detail.id ? `/api/scores/${encodeURIComponent(detail.id)}/history?days=30` : '',
  );
  const [whyOpen, setWhyOpen] = useState(false);
  const { data: contributions } = useFetch<ContributionsResponse>(
    whyOpen && detail.id ? `/api/scores/${encodeURIComponent(detail.id)}/contributions` : '',
  );
  return (
    <Card padding="md">
      <div className="flex items-start justify-between mb-2">
        <div>
          <h2 className="text-base font-semibold">{detail.name}</h2>
          <div className="text-xs text-text-secondary">{detail.title}</div>
          <div
            className="text-[11px] mt-0.5"
            style={{ color: deptColors[detail.department] ?? 'var(--color-text-tertiary)' }}
          >
            {detail.department}
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
      </div>

      <div className={SECTION_HEADER}>Skills</div>
      <div className="flex flex-wrap gap-1">
        {detail.skills.length === 0 ? (
          <span className="text-xs text-text-tertiary">none recorded</span>
        ) : (
          detail.skills.map(s => (
            <span key={s} className="text-[11px] py-0.5 px-2 bg-surface-hover rounded">{s}</span>
          ))
        )}
      </div>

      <div className={SECTION_HEADER}>Radar</div>
      <RadarChart radar={radar} />

      <div className={SECTION_HEADER}>Trend</div>
      <TrendLine history={history} />

      <div className={SECTION_HEADER}>Top Connections ({detail.connections.length} total)</div>
      <div className="flex flex-col gap-1 max-h-[280px] overflow-y-auto">
        {detail.connections
          .slice()
          .sort((a, b) => b.strength - a.strength)
          .slice(0, 12)
          .map((c, i) => (
            <div
              key={`${c.source}-${c.target}-${i}`}
              onClick={() => c.otherPerson && onSelectConnection(c.otherPerson.id)}
              className={`flex justify-between items-center text-xs py-1 px-2 rounded-[3px] ${c.otherPerson ? 'cursor-pointer' : 'cursor-default'}`}
            >
              <span>{c.otherPerson?.name ?? c.target}</span>
              <span className="text-[10px] text-text-tertiary">
                {c.type.replace(/_/g, ' ')} · {Math.round(c.strength * 100)}%
              </span>
            </div>
          ))}
      </div>

      <div className="text-[11px] text-text-tertiary mt-3">
        Scored {formatRelativeTime(detail.scoredAt)}
      </div>

      <Button
        variant="ghost"
        size="sm"
        onClick={() => setWhyOpen(o => !o)}
        className="mt-2"
      >
        Why this score? {whyOpen ? '▴' : '▾'}
      </Button>
      <WhyDrawer open={whyOpen} onClose={() => setWhyOpen(false)} contributions={contributions} />
      {session?.tenant === 'orgiq' && (
        <Link
          to={`/newsroom/articles?byline=${encodeURIComponent(detail.id)}`}
          className="text-[11px] text-primary no-underline mt-2 inline-block"
        >
          Articles by this person → Newsroom
        </Link>
      )}

      <div className="flex justify-between items-center mt-3 pt-3 border-t border-border text-[13px]">
        <span className="text-text-secondary">Influence (PageRank)</span>
        <span className="font-semibold">{Math.round(detail.influenceScore * 100)}</span>
      </div>
    </Card>
  );
}
