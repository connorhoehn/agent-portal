// Capabilities — what the platform provides, and where this app uses it.
//
// This section used to be a menu of AWS service names — Browser, Code
// Interpreter, Memory, Guardrails — each opening a demo surface with no
// connection to anything the product does. You could drive a headless browser
// and get a screenshot; nothing explained why, or what it had to do with the
// org graph. The honest complaint about it was that there was no use case.
//
// There are use cases now, so the page states them: each capability names the
// feature that depends on it and links there. What is left over — ad-hoc
// execution, raw session admin — is diagnostics, and sits behind a drill-in
// rather than being the front door.
//
// The status column exists because of a specific afternoon. Every capability
// id lives in .env.aws, those ids are reminted whenever the stack is rebuilt,
// and nothing regenerates the file. Three separate failures — a "not found"
// naming an unknown id, a bare 500 from a dead browser profile, and a survey
// fallback that failed soft — all traced back to it, each diagnosed on its
// own. One line here would have replaced all three.

import { ofTotal } from '../../lib/plural';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import {
  Card,
  CollectionToolbar,
  CardHeader,
  Chip,
  DataTable,
  EntityCell,
  Inline,
  LoadingState,
  MetaLine,
  Stack,
  type DataTableColumn, T,
} from '@connorhoehn/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { useSession, type SessionRole } from '../../lib/auth';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { relativeTime } from '../../lib/relativeTime';
import { CollectionCommandPage } from '../../components/collections/CollectionCommandPage';
import { CollectionCommandHost } from '../../components/collections/CollectionCommandHost';
import { capabilitiesAdapter, matchesCapability } from './capabilitiesCommands';

/** Everything under `/admin/ingest` — including `/admin/ingest/crawl`, which
 *  "Surveying a site" and the footer's "Knowledge → Sources" point at — is
 *  RequireRole-gated to hr-admin in App.tsx. Kept here, exported, so a link
 *  to that route can check before rendering instead of sending a role there
 *  to bounce silently (DEFECTS.md #19). 'admin' always passes RequireRole
 *  regardless of this list, same as the route guard. */
export const INGEST_ROLES: SessionRole[] = ['hr-admin'];

type CapabilityState = 'ok' | 'missing' | 'unconfigured' | 'unknown';

interface CapabilityStatus {
  key: 'browser' | 'browserProfile' | 'codeInterpreter' | 'memory'
     | 'guardrailMember' | 'guardrailOrgLeader' | 'guardrailHrAdmin';
  label: string;
  configuredId: string | null;
  state: CapabilityState;
  awsStatus: string | null;
  detail: string;
  envVar: string;
}

interface CapabilityEvent { kind?: string; startedAt?: string; ok?: boolean }

const STATE_TONE: Record<CapabilityState, 'success' | 'danger' | 'neutral' | 'warning'> = {
  ok: 'success',
  missing: 'danger',
  unconfigured: 'neutral',
  unknown: 'warning',
};

const STATE_LABEL: Record<CapabilityState, string> = {
  ok: 'available',
  missing: 'points at nothing',
  unconfigured: 'not set up',
  unknown: 'could not check',
};

/**
 * What each capability is actually for, in this app.
 *
 * `usedBy` is the whole point of the page. A capability with no answer here is
 * a capability nobody has found a job for, and saying so is more useful than
 * a demo that implies otherwise.
 */
/** The three guardrails differ only by which role they apply to. */
function GUARDRAIL_ROLE(role: string) {
  return {
    purpose: `Blocks PII and disallowed content for ${role} requests.`,
    usedBy: {
      label: 'Every agent answer',
      to: '/iq/invoke',
      description: 'The supervisor attaches this when it builds the model for a request in this role.',
    },
    tools: { label: 'Policy & blocked-content log', to: '/admin/capabilities/guardrails' },
  };
}

const ROLES: Record<CapabilityStatus['key'], {
  purpose: string;
  usedBy: { label: string; to: string; description: string } | null;
  /** The capability's own page — where a row opens. */
  tools: { label: string; to: string };
}> = {
  browser: {
    purpose: 'Renders pages that plain HTTP cannot read — anything that only exists after JavaScript runs.',
    usedBy: {
      label: 'Surveying a site',
      to: '/admin/ingest/crawl',
      description: 'Reads the handful of pages a fetch sees as empty, so the survey can map the whole site.',
    },
    tools: { label: 'Browser tools & sessions', to: '/admin/capabilities/browser' },
  },
  browserProfile: {
    purpose: 'Persistent browser state — cookies and logins that outlive a single session.',
    usedBy: null,
    // Every browser session is created with this profile when it is set, so
    // the browser page is where its status and its effect are seen.
    tools: { label: 'Browser sessions', to: '/admin/capabilities/browser' },
  },
  codeInterpreter: {
    purpose: 'Runs real computation on real data: fits, correlations, concentration measures.',
    usedBy: {
      label: 'Score analysis',
      to: '/iq/scores',
      description: 'Fits the composite against its inputs to show what it weights and where it disagrees.',
    },
    tools: { label: 'Ad-hoc execution', to: '/admin/capabilities/code-interpreter' },
  },
  memory: {
    purpose: 'Conversation state across turns, so a session can be resumed rather than restarted.',
    usedBy: {
      label: 'Ask',
      to: '/iq/invoke',
      description: 'Multi-turn conversations survive reloads and resume where they left off.',
    },
    tools: { label: 'Session store', to: '/admin/observability/sessions' },
  },
  guardrailMember: GUARDRAIL_ROLE('member'),
  guardrailOrgLeader: GUARDRAIL_ROLE('org leader'),
  guardrailHrAdmin: GUARDRAIL_ROLE('HR admin'),
};

/** Capability event kinds, mapped to the capability they belong to. */
const EVENT_KIND_BY_KEY: Record<string, CapabilityStatus['key']> = {
  browser_launch: 'browser',
  browser_navigate: 'browser',
  code_execute: 'codeInterpreter',
};

/** The capabilities that emit capability events at all. Only these can have a
 *  "last used" — for the rest an empty cell means nothing is recorded, which
 *  is a different claim from "it has never run". */
const OBSERVED_KEYS = new Set<CapabilityStatus['key']>(Object.values(EVENT_KIND_BY_KEY));

export default function CapabilitiesHomePage() {
  const { session } = useSession();
  const navigate = useNavigate();
  const canOpenIngest = !!session && (session.role === 'admin' || INGEST_ROLES.includes(session.role));

  const { data, isLoading, error, refresh } = useFetch<{ capabilities: CapabilityStatus[] }>(
    '/api/capabilities/reconcile', 60_000,
  );
  const { data: events } = useFetch<{ events: CapabilityEvent[] }>(
    '/api/observability/capability-events?limit=100', 30_000,
  );
  const caps = data?.capabilities ?? [];
  const [query, setQuery] = useState('');
  const rows = caps.filter((c) => matchesCapability(c, query));
  const adapter = capabilitiesAdapter({ setQuery, refresh });
  const problems = caps.filter((c) => c.state === 'missing' || c.state === 'unknown');

  const lastUse = (key: CapabilityStatus['key']): string | undefined => (events?.events ?? [])
    .filter((e) => EVENT_KIND_BY_KEY[e.kind ?? ''] === key)
    .map((e) => e.startedAt)
    .filter(Boolean)
    .sort()
    .reverse()[0];

  const columns: DataTableColumn<CapabilityStatus>[] = [
    {
      key: 'label',
      header: 'Capability',
      sortable: true,
      render: (c) => (
        <Inline gap="none" align="center" wrap={false} title={ROLES[c.key].purpose}>
          <EntityCell label={c.label} />
        </Inline>
      ),
    },
    {
      key: 'state',
      header: 'Status',
      sortable: true,
      render: (c) => (
        <Chip tone={STATE_TONE[c.state]} size="xs" dot="static">{STATE_LABEL[c.state]}</Chip>
      ),
    },
    {
      key: 'usedBy',
      header: 'What uses it',
      render: (c) => {
        const used = ROLES[c.key].usedBy;
        // Stated plainly rather than dressed up. A capability nobody has found
        // a job for is worth knowing about — it is a candidate to adopt or to
        // stop paying for.
        if (!used) return <T size="xs" className="text-text-tertiary">Nothing uses it yet</T>;
        const gated = used.to === '/admin/ingest/crawl' && !canOpenIngest;
        return (
          <Inline gap="none" align="center" wrap={false} title={used.description}>
            {gated ? (
              <T size="xs" weight="semibold" className="text-text-tertiary">{used.label} (HR admin)</T>
            ) : (
              <Link to={used.to} className="text-xs text-primary no-underline hover:underline">
                {used.label} →
              </Link>
            )}
          </Inline>
        );
      },
    },
    {
      key: 'configuredId',
      header: 'Configured id',
      render: (c) => (
        c.configuredId
          ? <T size="xs" className="font-mono text-text-secondary" title={c.configuredId}>{c.configuredId}</T>
          : <T size="xs" className="text-text-tertiary">—</T>
      ),
    },
    {
      key: 'used',
      header: 'Last used',
      render: (c) => {
        const at = lastUse(c.key);
        // Absent is not "never": only three of the seven emit capability
        // events at all, so a blank here means nothing was recorded rather
        // than that nothing happened.
        if (!at) return <T size="xs" className="text-text-tertiary">{OBSERVED_KEYS.has(c.key) ? 'not in the last 100 events' : 'not recorded'}</T>;
        return <T size="xs" className="text-text-secondary">{relativeTime(at)}</T>;
      },
    },
    {
      key: 'tools',
      header: '',
      render: (c) => {
        const tools = ROLES[c.key].tools;
        return (
          <Link to={tools.to} className="text-xs whitespace-nowrap text-primary no-underline hover:underline">
            {tools.label} →
          </Link>
        );
      },
    },
  ];

  return (
    <CollectionCommandPage
      title="Capabilities"
      description="What the AgentCore platform provides, whether it is really there, and what in this app depends on it."
    >
      <Stack gap="none" className="min-h-0 min-w-0 flex-1">
      <Stack gap="md" className="min-h-0 flex-1 overflow-auto px-[var(--ui-page-gutter)] pb-[var(--ui-page-gutter)]">
      <CollectionToolbar label="Capability filters"
        search={{ value: query, onChange: setQuery, placeholder: 'Search capabilities', 'aria-label': 'Search capabilities' }}
        summary={data ? `${ofTotal(rows.length, caps.length, 'capability', 'capabilities')}` : undefined}
        onRefresh={refresh} refreshing={isLoading} />
      {error && (
        <UnavailableNotice
          error={error}
          what="capability status"
          source="Each configured id is checked against what exists in the account"
          onRetry={refresh}
          className="mb-4"
        />
      )}

      {problems.length > 0 && (
        <Card padding="none" className="mb-4 overflow-hidden border-danger/40">
          <CardHeader inset title="Needs attention" subtitle="configured ids checked against the account" />
          <Stack gap="none">
            {problems.map((c) => (
              <Stack key={c.key} gap="xs" className="border-b border-border px-3.5 py-3 last:border-b-0">
                <T size="sm" weight="semibold" className="text-text-primary">{c.label}</T>
                <T size="xs" className="leading-snug text-text-secondary" wrap>{c.detail}</T>
              </Stack>
            ))}
          </Stack>
        </Card>
      )}

      {isLoading && caps.length === 0 ? (
        <LoadingState label="Loading capability status…" />
      ) : (
        // A table, not a grid of cards.
        //
        // The content here was right and the shape was not: seven cards over a
        // screen and a half, with the status word — the one thing a person
        // comes to this page for — repeated seven times in seven different
        // places. Three of the seven were the guardrails, which differ only by
        // role and so read as the same card printed three times. As rows they
        // are seven lines with the status in one scannable column, all of it
        // above the fold, and the guardrails become what they are: one thing
        // configured three ways.
        <DataTable<CapabilityStatus>
          data={rows}
          keyField={(c) => c.key}
          // A row opens the capability's own page (its diagnostics); the
          // "What uses it" link in the row still goes to the feature.
          onRowClick={(c) => navigate(ROLES[c.key].tools.to)}
          striped
          columns={columns}
          emptyMessage={caps.length > 0
            ? 'No capability matches this search.'
            : 'No capabilities reported. The reconcile endpoint returned an empty list, which means the account has none configured rather than that the check failed.'}
        />
      )}

      <T size="xs" className="mt-4 leading-snug text-text-tertiary" wrap>
        Prompts moved to <Link to="/iq/prompts" className="text-primary no-underline hover:underline">Prompts</Link>,
        which is the same page this section used to render a second copy of. Crawling moved to{' '}
        {canOpenIngest ? (
          <Link to="/admin/ingest/crawl" className="text-primary no-underline hover:underline">Knowledge → Sources</Link>
        ) : (
          'Knowledge → Sources (HR admin)'
        )}
        , where a crawl can be scoped to what a survey found instead of started blind.
      </T>
      </Stack>
      <CollectionCommandHost adapter={adapter} />
      </Stack>
    </CollectionCommandPage>
  );
}
