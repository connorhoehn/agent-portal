// One agent, the way you'd look at a running instance.
//
// Architecture showed the fleet and, on click, a drawer with four numbers whose
// "view invocation history" link went to the chat page. There was nowhere to
// answer the questions you actually have about a single agent when it is
// behaving oddly: is it up, what prompt is it running *right now*, how long did
// recent calls take, and what does its log say.
//
// The prompt panel is the one that matters most and was hardest to get before.
// Agents resolve their system prompt from Bedrock Prompt Management on every
// invocation, so the prompt in the repo is only a fallback — reading main.py
// tells you what runs when Bedrock is unreachable, not what ran this morning.

import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { PageSection, Card } from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { UnavailableNotice } from '../../components/UnavailableNotice';

interface Runtime {
  id: string; name: string; status: string; protocol?: string; model?: string;
  endpoint?: string; tools?: string[]; guardrails?: string[];
  latencyP50Ms?: number; latencyP99Ms?: number;
  invocationsLast24h?: number; errorsLast24h?: number; tokensLast24h?: number;
}
interface LivePrompt {
  source: 'managed' | 'unavailable';
  name: string; promptId: string | null; version: string | null;
  updatedAt: string | null; sha: string | null; characters: number | null;
  excerpt: string | null; modelId: string | null; problem?: string;
}
interface Invocation {
  invocationId: string; startedAt: string; durationMs: number; status: string;
  promptVersion: string | null; promptSnippet: string | null;
  totalTokens: number; modelId: string | null; sessionId: string | null;
}
interface LogPane { logGroup: string; events: Array<{ at: string; message: string }>; problem?: string }
interface Detail {
  runtime: Runtime; prompt: LivePrompt;
  metrics: { successRate?: string } | null;
  invocations: Invocation[]; log: LogPane;
}

const STATUS_TONE: Record<string, string> = {
  healthy: 'bg-success-bg text-success',
  READY: 'bg-success-bg text-success',
  degraded: 'bg-warning-bg text-warning',
  unhealthy: 'bg-danger-bg text-danger',
};

function ms(n: number | null | undefined): string {
  if (n == null || n === 0) return '—';
  return n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(1)} s`;
}

function when(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (Number.isNaN(mins)) return iso;
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return d.toLocaleString();
}

/**
 * Agent logs arrive as OpenTelemetry envelopes — one line is a whole JSON
 * document with the actual message buried in it. Rendered raw the pane is
 * unreadable, so the body and severity are lifted out when the shape matches
 * and the raw line is kept otherwise.
 */
function readable(message: string): { level: string | null; text: string } {
  const trimmed = message.trim();
  if (!trimmed.startsWith('{')) return { level: null, text: message };
  try {
    const o = JSON.parse(trimmed) as Record<string, unknown>;
    const body = o['body'];
    const sev = o['severityText'] ?? o['severity_text'] ?? o['level'];
    if (typeof body === 'string') {
      return { level: typeof sev === 'string' ? sev : null, text: body };
    }
    // A span export, not a log line — say what it is instead of dumping it.
    if (o['resource'] || o['scopeSpans'] || o['resourceSpans']) {
      return { level: 'TRACE', text: '(telemetry span export)' };
    }
    return { level: typeof sev === 'string' ? sev : null, text: trimmed };
  } catch {
    return { level: null, text: message };
  }
}

const LEVEL_TONE: Record<string, string> = {
  ERROR: 'text-[#f85149]', WARN: 'text-[#f0883e]', WARNING: 'text-[#f0883e]',
  INFO: 'text-[#8b949e]', DEBUG: 'text-[#6e7681]', TRACE: 'text-[#6e7681]',
};

export default function AgentDetailPage() {
  const { agentId = '' } = useParams();
  const { data, error, refresh } = useFetch<Detail>(
    `/api/agent-detail/${encodeURIComponent(agentId)}`, 20_000,
  );
  const [showPrompt, setShowPrompt] = useState(false);
  const [hideTelemetry, setHideTelemetry] = useState(true);

  const rt = data?.runtime;
  const prompt = data?.prompt;

  const logLines = useMemo(() => {
    const events = data?.log.events ?? [];
    const parsed = events.map((e) => ({ at: e.at, ...readable(e.message) }));
    const visible = hideTelemetry ? parsed.filter((l) => l.level !== 'TRACE') : parsed;

    // The runtime emits each line twice — once as raw stdout and once wrapped
    // in an OpenTelemetry envelope — so every message appeared in the pane
    // twice, the second copy padded with trace_id/span_id noise. Keep the
    // parsed one (it carries a level) and drop the raw line that contains it.
    const bodies = new Set(
      visible.filter((l) => l.level && l.text.length > 12).map((l) => l.text),
    );
    return visible.filter((l) => {
      if (l.level) return true;
      for (const b of bodies) if (l.text.includes(b)) return false;
      return true;
    });
  }, [data?.log.events, hideTelemetry]);

  const telemetryCount = useMemo(() => (data?.log.events ?? [])
    .filter((e) => readable(e.message).level === 'TRACE').length, [data?.log.events]);

  return (
    <PageSection
      title={rt?.name ?? agentId}
      description="What this agent is running, how it has been behaving, and what its log says."
    >
      <div className="mb-4">
        <Link to="/iq/agents" className="text-[12px] text-primary no-underline hover:underline">
          ← Architecture
        </Link>
      </div>

      {error && (
        <UnavailableNotice
          error={error}
          what="this agent"
          source="Composed from the runtime list, Prompt Management, invocation traces and CloudWatch"
          onRetry={refresh}
          className="mb-4"
        />
      )}

      {rt && (
        <>
          {/* ── Identity ────────────────────────────────────────────────── */}
          <Card padding="md" className="mb-4">
            <div className="flex items-center gap-2.5 flex-wrap">
              <span className={`text-[10px] font-semibold px-2 py-0.5 rounded ${
                STATUS_TONE[rt.status] ?? 'bg-surface-hover text-text-tertiary'}`}>
                {rt.status}
              </span>
              <span className="text-[12px] font-mono text-text-secondary">{rt.id}</span>
              {rt.protocol && (
                <span className="text-[11px] text-text-tertiary">· {rt.protocol}</span>
              )}
              <div className="flex-1" />
              <Link
                to={`/iq/invoke?agentId=${encodeURIComponent(rt.name)}`}
                className="text-[11px] px-2.5 py-1 rounded-md border border-border bg-surface text-text-secondary no-underline hover:border-primary hover:text-primary transition-colors"
              >
                Invoke →
              </Link>
            </div>
            {rt.endpoint && (
              <div className="text-[11px] text-text-tertiary font-mono mt-2 break-all">{rt.endpoint}</div>
            )}
          </Card>

          {/* ── Behaviour ───────────────────────────────────────────────── */}
          <div className="grid gap-4 mb-4 grid-cols-2 md:grid-cols-5">
            <Metric label="Calls (24h)" value={String(rt.invocationsLast24h ?? 0)} />
            <Metric label="Errors (24h)" value={String(rt.errorsLast24h ?? 0)}
              tone={(rt.errorsLast24h ?? 0) > 0 ? 'text-danger' : undefined} />
            <Metric label="p50" value={ms(rt.latencyP50Ms)} />
            <Metric label="p99" value={ms(rt.latencyP99Ms)} />
            <Metric label="Tokens (24h)" value={(rt.tokensLast24h ?? 0).toLocaleString()} />
          </div>

          {/* ── What it is running ──────────────────────────────────────── */}
          <Card padding="none" className="mb-4 overflow-hidden">
            <div className="px-3.5 py-3 border-b border-border flex items-center gap-2">
              <span className="text-xs font-semibold text-text-secondary tracking-wide select-none">
                RUNNING NOW
              </span>
              <span className="text-[11px] text-text-tertiary">
                resolved at invocation time, not from the repo
              </span>
            </div>

            {prompt?.source === 'managed' ? (
              <div className="px-3.5 py-3">
                <div className="grid gap-x-6 gap-y-2 grid-cols-2 md:grid-cols-4">
                  <Kv label="Prompt" value={prompt.name} mono />
                  <Kv label="Version" value={prompt.version ?? '—'} />
                  <Kv label="Prompt sha" value={prompt.sha ?? '—'} mono />
                  <Kv label="Changed" value={when(prompt.updatedAt)} />
                  <Kv label="Model" value={prompt.modelId || rt.model || '—'} mono />
                  <Kv label="Length" value={prompt.characters != null ? `${prompt.characters} chars` : '—'} />
                </div>
                {prompt.excerpt && (
                  <>
                    <button
                      onClick={() => setShowPrompt((v) => !v)}
                      className="mt-3 text-[11px] text-primary bg-transparent border-none cursor-pointer p-0 hover:underline"
                    >
                      {showPrompt ? 'Hide prompt' : 'Show prompt'}
                    </button>
                    {showPrompt && (
                      <pre className="mt-2 p-3 rounded-md bg-surface-hover text-[11px] text-text-secondary whitespace-pre-wrap font-mono overflow-x-auto">
                        {prompt.excerpt}
                        {(prompt.characters ?? 0) > prompt.excerpt.length ? '\n…' : ''}
                      </pre>
                    )}
                  </>
                )}
                <div className="text-[11px] text-text-tertiary mt-3 leading-snug">
                  Edit this in{' '}
                  <Link to="/iq/prompts" className="text-primary no-underline hover:underline">Prompts</Link>
                  {' '}— deployed agents pick up a change within about a minute, with no rebuild.
                </div>
              </div>
            ) : (
              <div className="px-3.5 py-3">
                <div className="text-[12px] text-warning font-semibold">Running its built-in fallback prompt</div>
                <div className="text-[12px] text-text-secondary mt-1 leading-snug">
                  {prompt?.problem ?? 'The managed prompt could not be read.'}
                </div>
                <div className="text-[11px] text-text-tertiary mt-2 leading-snug">
                  The agent still works — it falls back to the literal compiled into its image so a Bedrock
                  outage cannot take the fleet down — but edits in Prompt Studio are not reaching it.
                </div>
              </div>
            )}
          </Card>

          {/* ── Recent calls ────────────────────────────────────────────── */}
          <Card padding="none" className="mb-4 overflow-hidden">
            <div className="px-3.5 py-3 border-b border-border flex items-center gap-2">
              <span className="text-xs font-semibold text-text-secondary tracking-wide select-none">
                RECENT INVOCATIONS
              </span>
              <div className="flex-1" />
              <Link to={`/admin/observability/invocations?agentId=${encodeURIComponent(rt.name)}`}
                className="text-[11px] text-primary no-underline hover:underline">
                All invocations →
              </Link>
            </div>
            {(data?.invocations.length ?? 0) === 0 ? (
              <div className="px-3.5 py-4 text-[12px] text-text-tertiary leading-snug">
                No invocations recorded. Traces reach Aurora through the CloudWatch poller, so a call made in
                the last minute may not be here yet.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-[12px]">
                  <thead>
                    <tr className="text-[10px] uppercase tracking-wide text-text-tertiary">
                      <th className="text-left font-semibold px-3.5 py-2">When</th>
                      <th className="text-left font-semibold px-3.5 py-2">Status</th>
                      <th className="text-right font-semibold px-3.5 py-2">Duration</th>
                      <th className="text-right font-semibold px-3.5 py-2">Tokens</th>
                      <th className="text-left font-semibold px-3.5 py-2">Prompt</th>
                      <th className="text-left font-semibold px-3.5 py-2">Ask</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data?.invocations.map((iv) => (
                      <tr key={iv.invocationId} className="border-t border-border">
                        <td className="px-3.5 py-2 whitespace-nowrap">
                          <Link to={`/admin/observability/invocations/${iv.invocationId}`}
                            className="text-primary no-underline hover:underline">
                            {when(iv.startedAt)}
                          </Link>
                        </td>
                        <td className="px-3.5 py-2">
                          <span className={iv.status === 'error' ? 'text-danger' : 'text-text-secondary'}>
                            {iv.status}
                          </span>
                        </td>
                        <td className="px-3.5 py-2 text-right font-mono">{ms(iv.durationMs)}</td>
                        <td className="px-3.5 py-2 text-right font-mono">{iv.totalTokens || '—'}</td>
                        <td className="px-3.5 py-2 font-mono text-text-tertiary">
                          {iv.promptVersion?.slice(0, 12) ?? '—'}
                        </td>
                        <td className="px-3.5 py-2 text-text-tertiary truncate max-w-[280px]">
                          {iv.promptSnippet ?? '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {/* ── Log ─────────────────────────────────────────────────────── */}
          <Card padding="none" className="overflow-hidden">
            <div className="px-3.5 py-3 border-b border-border flex items-center gap-2 flex-wrap">
              <span className="text-xs font-semibold text-text-secondary tracking-wide select-none">LOG</span>
              <span className="text-[11px] text-text-tertiary font-mono truncate">{data?.log.logGroup}</span>
              <div className="flex-1" />
              {telemetryCount > 0 && (
                <label className="flex items-center gap-1.5 text-[11px] text-text-tertiary cursor-pointer">
                  <input
                    type="checkbox"
                    checked={hideTelemetry}
                    onChange={(e) => setHideTelemetry(e.target.checked)}
                  />
                  hide {telemetryCount} span exports
                </label>
              )}
              <button onClick={refresh}
                className="text-[11px] px-2 py-1 rounded-md border border-border bg-surface text-text-secondary cursor-pointer hover:border-primary hover:text-primary transition-colors">
                refresh
              </button>
            </div>
            {data?.log.problem ? (
              <div className="px-3.5 py-4 text-[12px] text-text-tertiary">{data.log.problem}</div>
            ) : logLines.length === 0 ? (
              <div className="px-3.5 py-4 text-[12px] text-text-tertiary">
                Nothing in the last 6 hours{telemetryCount > 0 ? ' other than span exports' : ''}.
              </div>
            ) : (
              <div className="max-h-[420px] overflow-auto bg-[#0d1117]">
                {logLines.map((l, i) => (
                  <div key={i} className="px-3.5 py-1 flex gap-3 text-[11px] font-mono border-b border-[#161b22] last:border-b-0">
                    <span className="text-[#6e7681] shrink-0 tabular-nums">
                      {l.at ? new Date(l.at).toLocaleTimeString() : ''}
                    </span>
                    {l.level && (
                      <span className={`shrink-0 w-11 ${LEVEL_TONE[l.level] ?? 'text-[#8b949e]'}`}>{l.level}</span>
                    )}
                    <span className="text-[#c9d1d9] whitespace-pre-wrap break-all">{l.text}</span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </>
      )}
    </PageSection>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <Card padding="md">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-text-tertiary">{label}</div>
      <div className={`text-[20px] font-bold leading-none mt-1.5 ${tone ?? ''}`}>{value}</div>
    </Card>
  );
}

function Kv({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-text-tertiary">{label}</div>
      <div className={`text-[12px] text-text-primary mt-0.5 truncate ${mono ? 'font-mono' : ''}`} title={value}>
        {value}
      </div>
    </div>
  );
}
