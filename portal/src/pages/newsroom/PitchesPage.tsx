import type { CSSProperties } from 'react';
import { useState } from 'react';
import { PageSection, Card, FilterChip } from '@connorhoehnslalom/ui-components/shared';
import { useCapabilities } from '../../lib/capabilities';
import { useFetch } from '../../hooks/useFetch';

// The story backlog — the desk view behind the home page's "Open pitches"
// card. Every pitch with its beat, proposer, assignee and cluster, filterable
// by status, with the desk decisions (approve / kill / file / reopen) inline.

// ─── Types (match middleware getPitchBoard) ───────────────────────────────────

interface PitchBoardItem {
  id: string;
  title: string;
  body: string | null;
  beat: string | null;
  status: string;
  proposedBy: { id: string; name: string } | null;
  assignedTo: { id: string; name: string } | null;
  cluster: { id: string; title: string } | null;
  createdAt: string;
  updatedAt: string;
}

interface PitchBoard {
  counts: Record<string, number>;
  pitches: PitchBoardItem[];
}

// ─── Status treatment ─────────────────────────────────────────────────────────

const STATUS_ORDER = ['open', 'approved', 'assigned', 'filed', 'killed'] as const;

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  open:     { bg: '#dbeafe', text: '#1e40af' },
  approved: { bg: '#dcfce7', text: '#166534' },
  assigned: { bg: '#fef9c3', text: '#854d0e' },
  filed:    { bg: '#f3f4f6', text: '#6b7280' },
  killed:   { bg: '#fee2e2', text: '#991b1b' },
};

function StatusChip({ status }: { status: string }) {
  const colors = STATUS_COLORS[status] ?? { bg: '#f3f4f6', text: '#374151' };
  return (
    <span style={{
      display: 'inline-block', padding: '2px 10px', borderRadius: 9999,
      fontSize: 11, fontWeight: 600, background: colors.bg, color: colors.text,
      textTransform: 'capitalize', flexShrink: 0,
    }}>
      {status}
    </span>
  );
}

// The desk decisions available from each state. `filed` is terminal; a killed
// pitch can come back to the board.
const TRANSITIONS: Record<string, Array<{ to: string; label: string; danger?: boolean }>> = {
  open:     [{ to: 'approved', label: 'Approve' }, { to: 'killed', label: 'Kill', danger: true }],
  approved: [{ to: 'assigned', label: 'Mark assigned' }, { to: 'filed', label: 'File' }, { to: 'killed', label: 'Kill', danger: true }],
  assigned: [{ to: 'filed', label: 'File' }, { to: 'killed', label: 'Kill', danger: true }],
  killed:   [{ to: 'open', label: 'Reopen' }],
  filed:    [],
};

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return iso;
  }
}

// ─── Page ─────────────────────────────────────────────────────────────────────

function PitchesPage() {
  // Desk decisions PATCH /api/newsroom/pitches/:id (ManagePitches — reporters
  // and editors). Without it the board is read-only.
  const { can, ready } = useCapabilities();
  const canDecide = ready && can('ManagePitches');
  const [statusFilter, setStatusFilter] = useState<string>('open');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const { data, isLoading, error, refresh } = useFetch<PitchBoard>('/api/newsroom/pitches/board', 30_000);

  const pitches = (data?.pitches ?? []).filter(
    (p) => statusFilter === 'All' || p.status === statusFilter,
  );

  async function decide(pitch: PitchBoardItem, to: string) {
    setBusyId(pitch.id);
    setActionError(null);
    try {
      const res = await fetch(`/api/newsroom/pitches/${encodeURIComponent(pitch.id)}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: to }),
      });
      if (res.status === 403) throw new Error('Your role cannot decide pitches — only reporters and editors hold ManagePitches.');
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
      }
      refresh();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div style={{ padding: '24px 32px' }}>
      <PageSection title="Pitches">
        {/* Status filter with live counts */}
        <div style={filterRowStyle}>
          <FilterChip active={statusFilter === 'All'} onClick={() => setStatusFilter('All')}>
            All
          </FilterChip>
          {STATUS_ORDER.map((s) => (
            <FilterChip key={s} active={statusFilter === s} onClick={() => setStatusFilter(s)}>
              {`${s[0]?.toUpperCase()}${s.slice(1)}${data?.counts[s] ? ` (${data.counts[s]})` : ''}`}
            </FilterChip>
          ))}
        </div>

        {actionError && (
          <div role="alert" style={alertStyle}>{actionError}</div>
        )}

        {isLoading && <div style={mutedStyle}>Loading pitches…</div>}
        {error && !isLoading && (
          <div style={mutedStyle}>Could not load the pitch board ({error}).</div>
        )}
        {!isLoading && !error && pitches.length === 0 && (
          <div style={mutedStyle}>
            {statusFilter === 'All'
              ? 'No pitches yet — the synth corpus pipeline seeds the backlog, and the researcher agent proposes new ones.'
              : `No ${statusFilter} pitches right now.`}
          </div>
        )}

        <div style={listStyle}>
          {pitches.map((p) => {
            const actions = TRANSITIONS[p.status] ?? [];
            return (
              <Card key={p.id} padding="md" style={cardStyle}>
                <div style={cardTopStyle}>
                  <span style={titleStyle}>{p.title}</span>
                  <StatusChip status={p.status} />
                </div>
                {p.body && <p style={bodyStyle}>{p.body}</p>}
                <div style={metaRowStyle}>
                  {p.beat && <span style={metaStyle}>Beat: <b>{p.beat}</b></span>}
                  {p.proposedBy && <span style={metaStyle}>Proposed by <b>{p.proposedBy.name}</b></span>}
                  {p.assignedTo && <span style={metaStyle}>Assigned to <b>{p.assignedTo.name}</b></span>}
                  {p.cluster && <span style={metaStyle}>Cluster: <b>{p.cluster.title}</b></span>}
                  <span style={metaStyle}>{formatDate(p.createdAt)}</span>
                </div>
                {canDecide && actions.length > 0 && (
                  <div style={actionRowStyle}>
                    {actions.map((a) => (
                      <button
                        key={a.to}
                        type="button"
                        disabled={busyId === p.id}
                        onClick={() => void decide(p, a.to)}
                        style={a.danger ? dangerButtonStyle : actionButtonStyle}
                      >
                        {a.label}
                      </button>
                    ))}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      </PageSection>
    </div>
  );
}

export default PitchesPage;

// ─── Styles ───────────────────────────────────────────────────────────────────

const filterRowStyle: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 16,
};

const alertStyle: CSSProperties = {
  fontSize: 12, color: '#991b1b', background: '#fee2e2',
  border: '1px solid #fecaca', borderRadius: 6, padding: '8px 12px', marginBottom: 12,
};

const mutedStyle: CSSProperties = {
  fontSize: 13, color: 'var(--color-text-tertiary)', padding: '12px 0',
};

const listStyle: CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 12,
};

const cardStyle: CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 8,
};

const cardTopStyle: CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
};

const titleStyle: CSSProperties = {
  fontSize: 14, fontWeight: 600, color: 'var(--color-text-primary)',
};

const bodyStyle: CSSProperties = {
  margin: 0, fontSize: 12.5, lineHeight: 1.5, color: 'var(--color-text-secondary)',
  display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden',
};

const metaRowStyle: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap',
};

const metaStyle: CSSProperties = {
  fontSize: 11.5, color: 'var(--color-text-tertiary)',
};

const actionRowStyle: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8, marginTop: 2,
};

const actionButtonStyle: CSSProperties = {
  fontSize: 12, padding: '4px 12px', borderRadius: 6,
  border: '1px solid var(--color-border)', background: 'var(--color-surface)',
  color: 'var(--color-text-primary)', cursor: 'pointer',
};

const dangerButtonStyle: CSSProperties = {
  ...actionButtonStyle,
  color: '#991b1b', borderColor: '#fecaca',
};
