import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { useNavigate } from 'react-router';

interface KBHealthEntry {
  id: string;
  slug: string;
  tenant: string;
  status: string;
  /** True only when Bedrock confirmed the knowledge base exists. */
  reachable?: boolean;
  awsStatus?: string | null;
  dataSourceCount?: number | null;
  lastSyncStatus: string | null;
  /** Human-readable diagnosis when something is wrong. */
  problem?: string | null;
}

interface KBHealthResponse {
  healthy: number;
  degraded: number;
  /** KBs registered here but unreachable in AWS. */
  broken?: number;
  /** Legacy field name, kept so an older middleware still renders sensibly. */
  failed?: number;
  pending: number;
  kbs: KBHealthEntry[];
}

type Severity = 'healthy' | 'degraded' | 'failed';

function derive(data: KBHealthResponse): { severity: Severity; count: number; label: string } {
  const broken = data.broken ?? data.failed ?? 0;
  if (broken > 0) return { severity: 'failed', count: broken, label: `${broken} KB${broken > 1 ? 's' : ''} broken` };
  if (data.degraded > 0) return { severity: 'degraded', count: data.degraded, label: `${data.degraded} degraded` };
  if (data.healthy > 0) return { severity: 'healthy', count: data.healthy, label: `${data.healthy} healthy` };
  // Nothing healthy and nothing broken — everything is still pending setup.
  return { severity: 'degraded', count: data.pending, label: data.pending > 0 ? `${data.pending} pending` : 'no KBs' };
}

const PALETTE: Record<Severity, { bg: string; border: string; text: string; dot: string }> = {
  healthy:  { bg: 'var(--color-success-bg)', border: 'var(--color-success-border)', text: 'var(--color-success)', dot: 'var(--color-success)' },
  degraded: { bg: 'var(--color-warning-bg)', border: 'var(--color-warning-border)', text: 'var(--color-warning)', dot: 'var(--color-warning)' },
  failed:   { bg: 'var(--color-danger-bg)',  border: 'var(--color-danger-border)',  text: 'var(--color-danger)',  dot: 'var(--color-danger)'  },
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

  const { severity, label } = derive(data);
  const c = PALETTE[severity];
  // Name the actual problems in the tooltip — "1 broken" is only useful if the
  // operator can see which KB and why without navigating.
  const problems = data.kbs
    .filter((k) => k.problem)
    .map((k) => `${k.slug}: ${k.problem}`)
    .join('\n');
  const tooltip = problems ? `KB health — ${label}\n${problems}` : `KB health: ${label} — click to view`;

  return (
    <button
      type="button"
      onClick={() => navigate('/admin/knowledge-bases')}
      title={tooltip}
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
