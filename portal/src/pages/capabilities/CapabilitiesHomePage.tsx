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

import { Link } from 'react-router';
import {
  Card,
  CardHeader,
  CatalogGrid,
  Chip,
  MetaLine,
  PageSection,
  SectionLabel,
  Stack,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { useSession, type SessionRole } from '../../lib/auth';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { T } from './Text';

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
  tools: { label: string; to: string } | null;
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
    tools: null,
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

function when(iso: string | undefined): string {
  if (!iso) return 'never';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (Number.isNaN(mins)) return 'never';
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}

/** Capability event kinds, mapped to the capability they belong to. */
const EVENT_KIND_BY_KEY: Record<string, CapabilityStatus['key']> = {
  browser_launch: 'browser',
  browser_navigate: 'browser',
  code_execute: 'codeInterpreter',
};

export default function CapabilitiesHomePage() {
  const { session } = useSession();
  const canOpenIngest = !!session && (session.role === 'admin' || INGEST_ROLES.includes(session.role));

  const { data, error, refresh } = useFetch<{ capabilities: CapabilityStatus[] }>(
    '/api/capabilities/reconcile', 60_000,
  );
  const { data: events } = useFetch<{ events: CapabilityEvent[] }>(
    '/api/observability/capability-events?limit=100', 30_000,
  );
  const caps = data?.capabilities ?? [];
  const problems = caps.filter((c) => c.state === 'missing' || c.state === 'unknown');

  const lastUse = (key: CapabilityStatus['key']): string | undefined => (events?.events ?? [])
    .filter((e) => EVENT_KIND_BY_KEY[e.kind ?? ''] === key)
    .map((e) => e.startedAt)
    .filter(Boolean)
    .sort()
    .reverse()[0];

  return (
    <PageSection
      title="Capabilities"
      description="What the AgentCore platform provides, whether it is really there, and what in this app depends on it."
    >
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
                <T className="text-[13px] font-semibold text-text-primary">{c.label}</T>
                <T className="text-[12px] leading-snug text-text-secondary" wrap>{c.detail}</T>
              </Stack>
            ))}
          </Stack>
        </Card>
      )}

      <CatalogGrid columns={2}>
        {caps.map((c) => {
          const role = ROLES[c.key];
          const used = lastUse(c.key);
          return (
            <Card key={c.key} padding="none" className="overflow-hidden">
              <CardHeader
                inset
                title={c.label}
                meta={<Chip tone={STATE_TONE[c.state]} size="xs">{STATE_LABEL[c.state]}</Chip>}
                action={used ? <T className="text-[11px] text-text-tertiary">used {when(used)}</T> : undefined}
              />

              <Stack gap="sm" className="px-3.5 py-3">
                <T className="text-[12px] leading-snug text-text-secondary" wrap>{role.purpose}</T>

                <Stack gap="xs">
                  <SectionLabel as="div">What uses it here</SectionLabel>
                  {role.usedBy ? (
                    <Stack gap="none">
                      {role.usedBy.to === '/admin/ingest/crawl' && !canOpenIngest ? (
                        <T className="text-[12px] font-semibold text-text-tertiary">
                          {role.usedBy.label} (HR admin)
                        </T>
                      ) : (
                        <Link to={role.usedBy.to} className="text-[12px] font-semibold text-primary no-underline hover:underline">
                          {role.usedBy.label} →
                        </Link>
                      )}
                      <T className="mt-0.5 text-[11px] leading-snug text-text-tertiary" wrap>
                        {role.usedBy.description}
                      </T>
                    </Stack>
                  ) : (
                    // Stated plainly rather than dressed up with a demo. A
                    // capability nobody has found a job for is worth knowing
                    // about — it is a candidate to use or to stop paying for.
                    <T className="text-[11px] leading-snug text-text-tertiary" wrap>
                      Nothing in this app uses it yet.
                    </T>
                  )}
                </Stack>

                {c.configuredId && (
                  <MetaLine items={[<T className="truncate font-mono" title={c.configuredId}>{c.configuredId}</T>]} />
                )}
              </Stack>

              {role.tools && (
                <Stack gap="none" className="border-t border-border bg-surface-hover/40 px-3.5 py-2">
                  <Link to={role.tools.to} className="text-[11px] text-primary no-underline hover:underline">
                    {role.tools.label} →
                  </Link>
                </Stack>
              )}
            </Card>
          );
        })}
      </CatalogGrid>

      <T className="mt-4 text-[11px] leading-snug text-text-tertiary" wrap>
        Prompts moved to <Link to="/iq/prompts" className="text-primary no-underline hover:underline">Prompts</Link>,
        which is the same page this section used to render a second copy of. Crawling moved to{' '}
        {canOpenIngest ? (
          <Link to="/admin/ingest/crawl" className="text-primary no-underline hover:underline">Knowledge → Sources</Link>
        ) : (
          'Knowledge → Sources (HR admin)'
        )}
        , where a crawl can be scoped to what a survey found instead of started blind.
      </T>
    </PageSection>
  );
}
