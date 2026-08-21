// Live audit log of AVP authorization decisions. Pulls the recent buffer on
// mount, then streams new events via SSE. Filters are client-side over the
// buffered + streamed events.

import { useEffect, useMemo, useState } from 'react';
import { Chip, PageSection } from '@connorhoehnslalom/ui-components/shared';

interface AuthzEvent {
  decision: 'ALLOW' | 'DENY';
  action: string;
  sub: string;
  role: string;
  tenant?: string;
  /** Real identity when the event was produced under masquerade. */
  actor?: string;
  reason?: string;
  path?: string;
  ts: string;
}

const ROLE_FILTERS = ['', 'member', 'org-leader', 'hr-admin', 'reporter', 'editor', 'admin'] as const;
const TENANT_FILTERS = ['', 'orgiq', 'newsroom'] as const;
const DECISION_FILTERS = ['', 'ALLOW', 'DENY'] as const;
const MAX_EVENTS = 500;

function AuthzLogPage() {
  const [events, setEvents] = useState<AuthzEvent[]>([]);
  const [decision, setDecision] = useState<typeof DECISION_FILTERS[number]>('');
  const [role, setRole] = useState<typeof ROLE_FILTERS[number]>('');
  const [tenant, setTenant] = useState<typeof TENANT_FILTERS[number]>('');
  const [actionQ, setActionQ] = useState('');
  const [streaming, setStreaming] = useState(false);

  // Open SSE on mount; reconnect on disconnect via the EventSource browser API.
  useEffect(() => {
    const es = new EventSource('/api/observability/authz/stream', { withCredentials: true });
    es.onopen = () => setStreaming(true);
    es.onerror = () => setStreaming(false);
    es.onmessage = (ev) => {
      try {
        const obj = JSON.parse(ev.data) as AuthzEvent & { type?: string };
        if (obj.type !== 'authz') return;
        setEvents(prev => {
          const next = [obj, ...prev];
          if (next.length > MAX_EVENTS) next.length = MAX_EVENTS;
          return next;
        });
      } catch {
        // ignore malformed
      }
    };
    return () => es.close();
  }, []);

  const filtered = useMemo(() => {
    return events.filter(e => {
      if (decision && e.decision !== decision) return false;
      if (role && e.role !== role) return false;
      if (tenant && e.tenant !== tenant) return false;
      if (actionQ && !e.action.toLowerCase().includes(actionQ.toLowerCase())) return false;
      return true;
    });
  }, [events, decision, role, tenant, actionQ]);

  const allowCount = events.filter(e => e.decision === 'ALLOW').length;
  const denyCount = events.length - allowCount;

  return (
    <PageSection
      title="Authorization Log"
      description={`Live AVP decisions. Updates over SSE. Buffer holds last ${MAX_EVENTS} events; restart middleware to reset.`}
      actions={
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 11 }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: streaming ? 'var(--color-success, #10b981)' : 'var(--color-text-tertiary)' }} />
            {streaming ? 'live' : 'reconnecting…'}
          </span>
          <span style={{ color: 'var(--color-text-tertiary)' }}>·</span>
          <span><strong style={{ color: '#10b981' }}>{allowCount}</strong> allow</span>
          <span><strong style={{ color: '#ef4444' }}>{denyCount}</strong> deny</span>
        </div>
      }
    >
      <div style={filterBar}>
        <FilterField label="Decision">
          <select value={decision} onChange={e => setDecision(e.target.value as typeof DECISION_FILTERS[number])} style={selectStyle}>
            {DECISION_FILTERS.map(d => <option key={d || 'any'} value={d}>{d || 'Any'}</option>)}
          </select>
        </FilterField>
        <FilterField label="Role">
          <select value={role} onChange={e => setRole(e.target.value as typeof ROLE_FILTERS[number])} style={selectStyle}>
            {ROLE_FILTERS.map(r => <option key={r || 'any'} value={r}>{r || 'Any'}</option>)}
          </select>
        </FilterField>
        <FilterField label="Tenant">
          <select value={tenant} onChange={e => setTenant(e.target.value as typeof TENANT_FILTERS[number])} style={selectStyle}>
            {TENANT_FILTERS.map(t => <option key={t || 'any'} value={t}>{t || 'Any'}</option>)}
          </select>
        </FilterField>
        <FilterField label="Action">
          <input
            type="text"
            value={actionQ}
            onChange={e => setActionQ(e.target.value)}
            placeholder="search action…"
            style={{ ...selectStyle, minWidth: 180 }}
          />
        </FilterField>
        {(decision || role || tenant || actionQ) && (
          <button onClick={() => { setDecision(''); setRole(''); setTenant(''); setActionQ(''); }} style={btnSecondary}>Clear</button>
        )}
        <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--color-text-tertiary)' }}>
          showing {filtered.length} of {events.length}
        </span>
      </div>

      <div style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ background: 'var(--color-surface-hover)' }}>
              <th style={th}>Time</th>
              <th style={th}>Decision</th>
              <th style={th}>Identity</th>
              <th style={th}>Tenant</th>
              <th style={th}>Role</th>
              <th style={th}>Action</th>
              <th style={th}>Path</th>
              <th style={th}>Reason</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr>
                <td colSpan={8} style={{ padding: 16, textAlign: 'center', color: 'var(--color-text-tertiary)' }}>
                  {events.length === 0 ? 'Waiting for events… try clicking around the app.' : 'No events match the filters.'}
                </td>
              </tr>
            )}
            {filtered.map((e, i) => (
              <tr key={i} style={{ borderTop: '1px solid var(--color-border)' }}>
                <td style={{ ...td, color: 'var(--color-text-tertiary)', fontFamily: 'ui-monospace, monospace', whiteSpace: 'nowrap' }}>
                  {new Date(e.ts).toLocaleTimeString()}
                </td>
                <td style={td}>
                  <Chip tone={e.decision === 'ALLOW' ? 'success' : 'danger'} size="xs">
                    {e.decision}
                  </Chip>
                </td>
                <td style={{ ...td, fontFamily: 'ui-monospace, monospace' }}>
                  {e.sub}
                  {e.actor && (
                    <span title={`Masquerade — real identity: ${e.actor}`} style={{ marginLeft: 6, fontSize: 10, color: 'var(--color-warning, #d97706)' }}>
                      via {e.actor}
                    </span>
                  )}
                </td>
                <td style={{ ...td, fontFamily: 'ui-monospace, monospace', color: 'var(--color-text-secondary)' }}>{e.tenant ?? ''}</td>
                <td style={{ ...td, fontFamily: 'ui-monospace, monospace' }}>{e.role}</td>
                <td style={{ ...td, fontWeight: 500 }}>{e.action}</td>
                <td style={{ ...td, color: 'var(--color-text-secondary)', fontFamily: 'ui-monospace, monospace' }}>{e.path ?? ''}</td>
                <td style={{ ...td, color: 'var(--color-text-tertiary)', fontSize: 11 }}>{e.reason ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </PageSection>
  );
}

function FilterField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
      {label} {children}
    </label>
  );
}

const filterBar: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: 12,
  background: 'var(--color-surface)',
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-md)',
};

const selectStyle: React.CSSProperties = {
  padding: '4px 8px',
  fontSize: 12,
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-sm, 4px)',
  background: 'var(--color-surface)',
  color: 'var(--color-text-primary)',
};

const btnSecondary: React.CSSProperties = {
  padding: '4px 10px',
  fontSize: 12,
  background: 'var(--color-surface-hover)',
  color: 'var(--color-text-primary)',
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-sm, 4px)',
  cursor: 'pointer',
};

const th: React.CSSProperties = {
  textAlign: 'left',
  padding: '8px 12px',
  fontWeight: 600,
  fontSize: 11,
  color: 'var(--color-text-secondary)',
  textTransform: 'uppercase',
  letterSpacing: 0.5,
};

const td: React.CSSProperties = {
  padding: '6px 12px',
  verticalAlign: 'top',
};

export default AuthzLogPage;
