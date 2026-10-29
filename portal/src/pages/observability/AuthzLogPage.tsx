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
import { collectionCommandAdapter } from '../../components/collections/collectionCommands';
import { ObservabilityCommandSection } from './ObservabilityCommandSection';
import { OBSERVABILITY_GRAMMARS } from './observabilityCommands';
import { CROSS_TENANT_ROLES, ROLES_BY_TENANT, TENANTS } from '../../lib/tenants.generated.ts';

interface AuthzEvent {
  decision: 'ALLOW' | 'DENY';
  action: string;
  sub: string;
  /** The person behind `sub`, when the server knows them. */
  subName?: string | null;
  actorName?: string | null;
  role: string;
  tenant?: string;
  /** Real identity when the event was produced under masquerade. */
  actor?: string;
  reason?: string;
  path?: string;
  ts: string;
}

// From tenants/manifest.json (DE-29): the orgiq roles plus the cross-tenant
// ones, and every tenant (access was missing while this list was hand-kept).
const ROLE_FILTERS = ['', ...ROLES_BY_TENANT.orgiq, ...CROSS_TENANT_ROLES] as const;
const TENANT_FILTERS = ['', ...TENANTS] as const;
const DECISION_FILTERS = ['', 'ALLOW', 'DENY'] as const;
const MAX_EVENTS = 500;

/** A request path as words: `/people/p-030` reads "people record" (the id stays one hover away). */
function readablePath(path: string): string {
  const parts = path.split('?')[0]!.split('/').filter((seg) => seg && seg !== 'api');
  const isId = (seg: string) => /\d/.test(seg) || seg.split('-').length > 3 || /^(?:wi|des|d|p|u)-[a-z]/.test(seg);
  const words = parts.filter((seg) => !isId(seg)).map((seg) => seg.replace(/[-_]+/g, ' '));
  return parts.some(isId) ? [...words, 'record'].join(' ') : words.join(' ');
}

function AuthzLogPage() {
  const [events, setEvents] = useState<AuthzEvent[]>([]);
  const [decision, setDecision] = useState<typeof DECISION_FILTERS[number]>('');
  const [role, setRole] = useState<typeof ROLE_FILTERS[number]>('');
  const [tenant, setTenant] = useState<typeof TENANT_FILTERS[number]>('');
  const [actionQ, setActionQ] = useState('');
  const [streaming, setStreaming] = useState(false);
  /** So the first wait is not reported as a reconnect. See lib/streamStatus. */
  const [connectedOnce, setConnectedOnce] = useState(false);
  /** Bumped by the `refresh` command: reopen the stream, which replays the
   *  server's recent buffer. */
  const [streamKey, setStreamKey] = useState(0);

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
  }, [streamKey]);

  const filtered = useMemo(() => {
    return events.filter(e => {
      if (decision && e.decision !== decision) return false;
      if (role && e.role !== role) return false;
      if (tenant && e.tenant !== tenant) return false;
      if (actionQ && !e.action.toLowerCase().includes(actionQ.toLowerCase())) return false;
      return true;
    });
  }, [events, decision, role, tenant, actionQ]);

  const adapter = collectionCommandAdapter(OBSERVABILITY_GRAMMARS.authz, {
    setQuery: setActionQ,
    // The decision filter is the one the grammar names; clearing it clears
    // the role and tenant selectors too, so "reset filters" means all of them.
    setFilter: (value) => {
      if (value === 'ALLOW' || value === 'DENY') { setDecision(value); return; }
      setDecision(''); setRole(''); setTenant('');
    },
    refresh: () => { setEvents([]); setStreaming(false); setStreamKey(k => k + 1); },
    scopeNote: 'Search matches action names in the buffered decisions; the filter narrows to allowed or denied. Refresh reconnects the live stream, which reloads the server\'s last 50 decisions. Nothing here grants or revokes access.',
  });

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
      <ObservabilityCommandSection adapter={adapter}>
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
              aria-label="Search actions"
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
        <Table>
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
                {/* The cell stays system-ui (docs/layout-cascade.md "Tables");
                    an identifier is mono inside it, a time is tabular. */}
                <TableTd
                  className="text-text-tertiary whitespace-nowrap"
                  title={new Date(e.ts).toLocaleString()}
                >
                  <T tabular>{new Date(e.ts).toLocaleTimeString()}</T>
                </TableTd>
                <TableTd>
                  <Chip tone={e.decision === 'ALLOW' ? 'success' : 'danger'} size="xs">
                    {e.decision}
                  </Chip>
                </TableTd>
                <TableTd>
                  <Inline gap="xs" align="baseline" wrap={false}>
                    <T title={e.sub}>{e.subName ?? e.sub}</T>
                    {e.actor && (
                      <T size="xs" title={`Masquerade — real identity: ${e.actorName ?? e.actor}`} className="text-warning">
                        via {e.actorName ?? e.actor}
                      </T>
                    )}
                  </Inline>
                </TableTd>
                <TableTd className="text-text-secondary"><T className="font-mono">{e.tenant ?? ''}</T></TableTd>
                <TableTd><T className="font-mono">{e.role}</T></TableTd>
                <TableTd>{e.action}</TableTd>
                <TableTd className="text-text-secondary"><T title={e.path ?? ''}>{e.path ? readablePath(e.path) : ''}</T></TableTd>
                <TableTd className="text-text-tertiary">{e.reason ?? ''}</TableTd>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
      </ObservabilityCommandSection>
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
