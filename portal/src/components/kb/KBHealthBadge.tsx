import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { useNavigate } from 'react-router';

interface KBHealthResponse {
  healthy: number;
  degraded: number;
  failed: number;
  pending: number;
  kbs: Array<{ id: string; slug: string; tenant: string; status: string; lastSyncStatus: string | null }>;
}

type Severity = 'healthy' | 'degraded' | 'failed';

function derive(data: KBHealthResponse): { severity: Severity; count: number } {
  if (data.failed > 0)   return { severity: 'failed',   count: data.failed };
  if (data.degraded > 0) return { severity: 'degraded', count: data.degraded };
  return { severity: 'healthy', count: data.healthy };
}

const PALETTE: Record<Severity, { bg: string; border: string; text: string; dot: string }> = {
  healthy:  { bg: '#f0fdf4', border: '#bbf7d0', text: '#15803d', dot: '#22c55e' },
  degraded: { bg: '#fffbeb', border: '#fde68a', text: '#b45309', dot: '#f59e0b' },
  failed:   { bg: '#fef2f2', border: '#fecaca', text: '#b91c1c', dot: '#ef4444' },
};

const SYMBOL: Record<Severity, string> = {
  healthy:  '●',
  degraded: '⚠',
  failed:   '✕',
};

export function KBHealthBadge(): ReactElement | null {
  const [data, setData] = useState<KBHealthResponse | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;

    async function fetch_() {
      try {
        const res = await fetch('/api/admin/kb-registry/health');
        if (!res.ok) return;
        const json = (await res.json()) as KBHealthResponse;
        if (!cancelled) setData(json);
      } catch {
        // fail silent
      }
    }

    fetch_();
    const id = setInterval(fetch_, 60_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  if (!data) return null;

  const { severity, count } = derive(data);
  const c = PALETTE[severity];
  const label = `${count} ${severity}`;

  return (
    <button
      type="button"
      onClick={() => navigate('/admin/knowledge-bases')}
      title={`KB health: ${label} — click to view`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '3px 8px',
        borderRadius: 12,
        border: `1px solid ${c.border}`,
        background: c.bg,
        color: c.text,
        fontSize: 11,
        fontWeight: 600,
        cursor: 'pointer',
        lineHeight: 1.4,
        letterSpacing: '0.01em',
        whiteSpace: 'nowrap',
      }}
    >
      <span style={{ color: c.dot, fontSize: 10, lineHeight: 1 }}>{SYMBOL[severity]}</span>
      <span>{label}</span>
    </button>
  );
}
