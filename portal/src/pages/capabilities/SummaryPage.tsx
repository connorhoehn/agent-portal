import { Link } from 'react-router';
import { Card, Chip, PageSection, StatCard } from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';

// ─── Types ────────────────────────────────────────────────────────────────────

interface CodeSession {
  sessionId: string;
  status: 'ACTIVE' | 'IDLE' | 'TERMINATED';
}

interface BrowserSession {
  sessionId: string;
  status: 'ACTIVE' | 'IDLE' | 'CLOSED';
}

interface GuardrailLite {
  name: string;
  status: string;
  version: string;
}

interface CapabilityEvent {
  id: string;
  kind: string;
  startedAt: string;
}

// ─── Page ─────────────────────────────────────────────────────────────────────

function SummaryPage() {
  // Use the same intervals as the sub-pages so cached responses are reused
  // across navigation rather than re-fetched.
  const { data: codeData } = useFetch<{ sessions: CodeSession[] }>(
    '/api/capabilities/code-sessions',
    10000,
  );
  const { data: browserData } = useFetch<{ sessions: BrowserSession[] }>(
    '/api/capabilities/browser-sessions',
    10000,
  );
  const { data: guardrail } = useFetch<GuardrailLite>(
    '/api/capabilities/guardrail',
    30000,
  );
  const { data: eventsData } = useFetch<{ events: CapabilityEvent[] }>(
    '/api/observability/capability-events?limit=50',
    10000,
  );

  const activeCode = (codeData?.sessions ?? []).filter(s => s.status !== 'TERMINATED').length;
  const activeBrowser = (browserData?.sessions ?? []).filter(s => s.status !== 'CLOSED').length;
  const recentEventCount = eventsData?.events.length ?? 0;
  const guardrailStatus = guardrail?.status ?? 'UNKNOWN';
  const guardrailReady = guardrailStatus === 'READY';

  return (
    <PageSection
      title="Capabilities Overview"
      description="Live health of guardrails, the code-interpreter sandbox, headless browsers, and the agent memory store."
    >
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16 }}>
          <StatCard
            label="Active Browser Sessions"
            value={String(activeBrowser)}
            to="/admin/capabilities/browser"
            as={Link}
            accent={activeBrowser > 0}
          />
          <StatCard
            label="Active Code Sessions"
            value={String(activeCode)}
            to="/admin/capabilities/code-interpreter"
            as={Link}
            accent={activeCode > 0}
          />
          <Card padding="md">
            <Link to="/admin/capabilities/guardrails" style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}>
              <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>Guardrail</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                <Chip tone={guardrailReady ? 'success' : 'warning'} size="xs">{guardrailStatus}</Chip>
                {guardrail?.version && (
                  <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>v{guardrail.version}</span>
                )}
              </div>
              <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginTop: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {guardrail?.name ?? '(no guardrail configured)'}
              </div>
            </Link>
          </Card>
          <StatCard
            label="Recent Capability Events"
            value={String(recentEventCount)}
            to="/admin/observability"
            as={Link}
            hint="last 50 events in the ring buffer"
          />
        </div>

        <Card padding="md">
          <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>What lives here</h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, color: 'var(--color-text-secondary)' }}>
            <div><b>Guardrails</b> — manage Bedrock PII filters, content policies, and denied topics.</div>
            <div><b>Code Interpreter</b> — run Python in isolated AgentCore sandboxes; replay every execution.</div>
            <div><b>Browser</b> — Web Q&amp;A, recorded journeys, doc crawls, and raw session admin.</div>
            <div><b>Memory</b> — inspect AgentCore Memory sessions powering each conversation.</div>
          </div>
        </Card>
    </PageSection>
  );
}

export default SummaryPage;
