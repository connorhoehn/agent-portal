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
import { PageSection, Card } from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { UnavailableNotice } from '../../components/UnavailableNotice';

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

const STATE_TONE: Record<CapabilityState, string> = {
  ok: 'bg-success-bg text-success',
  missing: 'bg-danger-bg text-danger',
  unconfigured: 'bg-surface-hover text-text-tertiary',
  unknown: 'bg-warning-bg text-warning',
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
    tools: { label: 'Session store', to: '/admin/capabilities/memory' },
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
          <div className="px-3.5 py-3 border-b border-border">
            <span className="text-xs font-semibold text-danger tracking-wide select-none">NEEDS ATTENTION</span>
            <span className="text-[11px] text-text-tertiary ml-2">
              configured ids checked against the account
            </span>
          </div>
          {problems.map((c) => (
            <div key={c.key} className="px-3.5 py-3 border-b border-border last:border-b-0">
              <div className="text-[13px] font-semibold text-text-primary">{c.label}</div>
              <div className="text-[12px] text-text-secondary mt-1 leading-snug">{c.detail}</div>
            </div>
          ))}
        </Card>
      )}

      <div className="grid gap-4 grid-cols-1 lg:grid-cols-2">
        {caps.map((c) => {
          const role = ROLES[c.key];
          const used = lastUse(c.key);
          return (
            <Card key={c.key} padding="none" className="overflow-hidden">
              <div className="px-3.5 py-2.5 border-b border-border flex items-center gap-2">
                <span className="text-[13px] font-semibold text-text-primary">{c.label}</span>
                <span className={`text-[10px] font-semibold px-2 py-0.5 rounded ${STATE_TONE[c.state]}`}>
                  {STATE_LABEL[c.state]}
                </span>
                <div className="flex-1" />
                {used && <span className="text-[11px] text-text-tertiary">used {when(used)}</span>}
              </div>

              <div className="px-3.5 py-3">
                <div className="text-[12px] text-text-secondary leading-snug">{role.purpose}</div>

                <div className="mt-3">
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-text-tertiary">
                    What uses it here
                  </div>
                  {role.usedBy ? (
                    <div className="mt-1">
                      <Link to={role.usedBy.to} className="text-[12px] font-semibold text-primary no-underline hover:underline">
                        {role.usedBy.label} →
                      </Link>
                      <div className="text-[11px] text-text-tertiary mt-0.5 leading-snug">
                        {role.usedBy.description}
                      </div>
                    </div>
                  ) : (
                    // Stated plainly rather than dressed up with a demo. A
                    // capability nobody has found a job for is worth knowing
                    // about — it is a candidate to use or to stop paying for.
                    <div className="text-[11px] text-text-tertiary mt-1 leading-snug">
                      Nothing in this app uses it yet.
                    </div>
                  )}
                </div>

                {c.configuredId && (
                  <div className="text-[11px] text-text-tertiary font-mono mt-3 truncate" title={c.configuredId}>
                    {c.configuredId}
                  </div>
                )}
              </div>

              {role.tools && (
                <div className="px-3.5 py-2 border-t border-border bg-surface-hover/40">
                  <Link to={role.tools.to} className="text-[11px] text-primary no-underline hover:underline">
                    {role.tools.label} →
                  </Link>
                </div>
              )}
            </Card>
          );
        })}

      </div>

      <div className="mt-4 text-[11px] text-text-tertiary leading-snug">
        Prompts moved to <Link to="/iq/prompts" className="text-primary no-underline hover:underline">Prompts</Link>,
        which is the same page this section used to render a second copy of. Crawling moved to{' '}
        <Link to="/admin/ingest/crawl" className="text-primary no-underline hover:underline">Knowledge → Sources</Link>,
        where a crawl can be scoped to what a survey found instead of started blind.
      </div>
    </PageSection>
  );
}
