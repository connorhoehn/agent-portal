import type { ReactElement } from 'react';
import { useNavigate } from 'react-router';
import { Button, StatusPill } from '@connorhoehn/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';

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

const TONE: Record<Severity, 'success' | 'warning' | 'danger'> = {
  healthy: 'success',
  degraded: 'warning',
  failed: 'danger',
};

const SYMBOL: Record<Severity, string> = {
  healthy:  '●',
  degraded: '⚠',
  failed:   '✕',
};

const POLL_MS = 60_000;

export function KBHealthBadge(): ReactElement | null {
  const navigate = useNavigate();
  // Fail silent, same as the old hand-rolled poll: this is a glanceable
  // chip over the knowledge pages, not a page that owes anyone an error
  // state — `error` is simply ignored and the badge renders nothing.
  const { data } = useFetch<KBHealthResponse>('/api/admin/kb-registry/health', POLL_MS);

  if (!data) return null;

  const { severity, label } = derive(data);
  // Name the actual problems in the tooltip — "1 broken" is only useful if the
  // operator can see which KB and why without navigating.
  const problems = data.kbs
    .filter((k) => k.problem)
    .map((k) => `${k.slug}: ${k.problem}`)
    .join('\n');
  const tooltip = problems ? `KB health — ${label}\n${problems}` : `KB health: ${label} — click to view`;

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => navigate('/admin/knowledge')}
      title={tooltip}
      className="p-0 border-0 whitespace-nowrap"
    >
      <StatusPill tone={TONE[severity]} label={label} icon={SYMBOL[severity]} size="md" />
    </Button>
  );
}
