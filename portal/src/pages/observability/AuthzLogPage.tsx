// Live audit log of AVP authorization decisions. Pulls the recent buffer on
// mount, then streams new events via SSE. Filters are client-side over the
// buffered + streamed events.

import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Button,
  Card,
  Chip,
  Inline,
  Input,
  PageSection,
  SectionLabel,
  Select,
  StatusDot,
  Table,
  TableBody,
  TableHead,
  TableRow,
  TableTd,
  TableTh, T,
} from '@connorhoehnslalom/ui-components/shared';
import { streamStatusLabel } from '../../lib/streamStatus';

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

const ROLE_FILTERS = ['', 'member', 'sme', 'program-owner', 'org-leader', 'hr-admin', 'admin'] as const;
const TENANT_FILTERS = ['', 'orgiq', 'assessment', 'social', 'pipelines'] as const;
const DECISION_FILTERS = ['', 'ALLOW', 'DENY'] as const;
const MAX_EVENTS = 500;

function AuthzLogPage() {
  const [events, setEvents] = useState<AuthzEvent[]>([]);
  const [decision, setDecision] = useState<typeof DECISION_FILTERS[number]>('');
  const [role, setRole] = useState<typeof ROLE_FILTERS[number]>('');
  const [tenant, setTenant] = useState<typeof TENANT_FILTERS[number]>('');
  const [actionQ, setActionQ] = useState('');
  const [streaming, setStreaming] = useState(false);
  /** So the first wait is not reported as a reconnect. See lib/streamStatus. */
  const [connectedOnce, setConnectedOnce] = useState(false);

  // Open SSE on mount; reconnect on disconnect via the EventSource browser API.
  useEffect(() => {
    const es = new EventSource('/api/observability/authz/stream', { withCredentials: true });
    es.onopen = () => { setStreaming(true); setConnectedOnce(true); };
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
        <Inline gap="sm" align="center">
          <StatusDot
            color={streaming ? 'var(--color-success)' : 'var(--color-text-tertiary)'}
            label={streamStatusLabel(streaming, connectedOnce)}
            size="sm"
          />
          <T size="sm" className="text-text-tertiary">·</T>
          <T size="sm"><T weight="semibold" className="text-success">{allowCount}</T> allow</T>
          <T size="sm"><T weight="semibold" className="text-danger">{denyCount}</T> deny</T>
        </Inline>
      }
    >
      <Card padding="sm">
        <Inline gap="md" align="center" wrap>
          <FilterField label="Decision">
            <Select
              size="sm"
              value={decision}
              onChange={e => setDecision(e.target.value as typeof DECISION_FILTERS[number])}
              options={DECISION_FILTERS.map(d => ({ value: d, label: d || 'Any' }))}
            />
          </FilterField>
          <FilterField label="Role">
            <Select
              size="sm"
              value={role}
              onChange={e => setRole(e.target.value as typeof ROLE_FILTERS[number])}
              options={ROLE_FILTERS.map(r => ({ value: r, label: r || 'Any' }))}
            />
          </FilterField>
          <FilterField label="Tenant">
            <Select
              size="sm"
              value={tenant}
              onChange={e => setTenant(e.target.value as typeof TENANT_FILTERS[number])}
              options={TENANT_FILTERS.map(t => ({ value: t, label: t || 'Any' }))}
            />
          </FilterField>
          <FilterField label="Action">
            <Input
              size="sm"
              type="text"
              value={actionQ}
              onChange={e => setActionQ(e.target.value)}
              placeholder="search action…"
              className="min-w-[180px]"
            />
          </FilterField>
          {(decision || role || tenant || actionQ) && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => { setDecision(''); setRole(''); setTenant(''); setActionQ(''); }}
            >
              Clear
            </Button>
          )}
          <T size="xs" className="ml-auto text-text-tertiary">
            showing {filtered.length} of {events.length}
          </T>
        </Inline>
      </Card>

      <Card padding="md">
        <Table size="sm">
          <TableHead>
            <TableRow>
              <TableTh>Time</TableTh>
              <TableTh>Decision</TableTh>
              <TableTh>Identity</TableTh>
              <TableTh>Tenant</TableTh>
              <TableTh>Role</TableTh>
              <TableTh>Action</TableTh>
              <TableTh>Path</TableTh>
              <TableTh>Reason</TableTh>
            </TableRow>
          </TableHead>
          <TableBody>
            {filtered.length === 0 && (
              <TableRow>
                <TableTd colSpan={8} className="p-4 text-center text-text-tertiary">
                  {events.length === 0 ? 'Waiting for events… try clicking around the app.' : 'No events match the filters.'}
                </TableTd>
              </TableRow>
            )}
            {filtered.map((e, i) => (
              <TableRow key={i}>
                <TableTd
                  className="text-text-tertiary font-mono whitespace-nowrap"
                  title={new Date(e.ts).toLocaleString()}
                >
                  {new Date(e.ts).toLocaleTimeString()}
                </TableTd>
                <TableTd>
                  <Chip tone={e.decision === 'ALLOW' ? 'success' : 'danger'} size="xs">
                    {e.decision}
                  </Chip>
                </TableTd>
                <TableTd className="font-mono">
                  {e.sub}
                  {e.actor && (
                    <T size="xs" title={`Masquerade — real identity: ${e.actor}`} className="ml-1.5 text-warning">
                      via {e.actor}
                    </T>
                  )}
                </TableTd>
                <TableTd className="font-mono text-text-secondary">{e.tenant ?? ''}</TableTd>
                <TableTd className="font-mono">{e.role}</TableTd>
                <TableTd>{e.action}</TableTd>
                <TableTd className="font-mono text-text-secondary">{e.path ?? ''}</TableTd>
                <TableTd className="text-text-tertiary">{e.reason ?? ''}</TableTd>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </PageSection>
  );
}

function FilterField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Inline as="label" gap="xs" align="center">
      <SectionLabel>{label}</SectionLabel>
      {children}
    </Inline>
  );
}

export default AuthzLogPage;
