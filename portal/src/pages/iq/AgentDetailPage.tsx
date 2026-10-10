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
import {
  Button, Card, CardHeader, CatalogGrid, Chip, CodeBlock, CollapsibleSection,
  DataTable, Inline, InlinePlaceholder, LogStream, PageSection, Stack, StatStrip,
  Switch, T,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { useCrumbLabel } from '../../lib/crumbLabels';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { KeyValue } from '../../components/KeyValue';
import { STATUS_CHIP_TONE, countTelemetryLines, ms, toLogLevel, visibleLogLines, when } from './agentDetailFormat';

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
  invocationId: string; startedAt: string; durationMs: number;
  promptVersion: string | null; promptSnippet: string | null;
  totalTokens: number; costUsd: number | null; judgeScore: number | null;
  guardrailAction: string | null; modelId: string | null; sessionId: string | null;
}
interface LogPane { logGroup: string; events: Array<{ at: string; message: string }>; problem?: string }
interface Detail {
  runtime: Runtime; prompt: LivePrompt;
  metrics: { successRate?: string } | null;
  invocations: Invocation[]; invocationsProblem?: string; log: LogPane;
}

export default function AgentDetailPage() {
  const { agentId = '' } = useParams();
  const { data, error, refresh } = useFetch<Detail>(
    `/api/agent-detail/${encodeURIComponent(agentId)}`, 20_000,
  );
  const [hideTelemetry, setHideTelemetry] = useState(true);

  const rt = data?.runtime;
  const prompt = data?.prompt;
  // The trail reads "Supervisor", not "orgiq-supervisor", once the runtime loads.
  useCrumbLabel(agentId, rt?.name);

  const logLines = useMemo(
    () => visibleLogLines(data?.log.events ?? [], hideTelemetry),
    [data?.log.events, hideTelemetry],
  );
  const telemetryCount = useMemo(
    () => countTelemetryLines(data?.log.events ?? []),
    [data?.log.events],
  );

  return (
    <PageSection
      title={rt?.name ?? agentId}
      description="What this agent is running, how it has been behaving, and what its log says."
    >
      <Stack gap="none" className="mb-4">
        <Link to="/iq/agents" className="text-[12px] text-primary no-underline hover:underline">
          ← Architecture
        </Link>
      </Stack>

      {error && (
        <UnavailableNotice
          error={error}
          what="this agent"
          source="This page is composed from the runtime list, Prompt Management, invocation traces and CloudWatch"
          onRetry={refresh}
          className="mb-4"
        />
      )}

      {rt && (
        <>
          {/* ── Identity ────────────────────────────────────────────────── */}
          <Card padding="md" className="mb-4">
            <Stack gap="sm">
              <Inline justify="between" align="center" wrap>
                <Inline gap="sm" align="center" wrap>
                  <Chip tone={STATUS_CHIP_TONE[rt.status] ?? 'neutral'} size="xs">{rt.status}</Chip>
                  <T className="font-mono text-[12px] text-text-secondary">{rt.id}</T>
                  {rt.protocol && (
                    <T className="text-[11px] text-text-tertiary">· {rt.protocol}</T>
                  )}
                </Inline>
                <Link
                  to={`/iq/invoke?agentId=${encodeURIComponent(rt.name)}`}
                  className="rounded-md border border-border bg-surface px-2.5 py-1 text-[11px] text-text-secondary no-underline transition-colors hover:border-primary hover:text-primary"
                >
                  Invoke →
                </Link>
              </Inline>
              {rt.endpoint && (
                <T className="break-all font-mono text-[11px] text-text-tertiary">{rt.endpoint}</T>
              )}
            </Stack>
          </Card>

          {/* ── Behaviour ───────────────────────────────────────────────── */}
          <StatStrip
            className="mb-4"
            aria-label="Agent behaviour"
            items={[
              { label: 'Calls (24h)', value: rt.invocationsLast24h ?? 0 },
              {
                label: 'Errors (24h)', value: rt.errorsLast24h ?? 0,
                tone: (rt.errorsLast24h ?? 0) > 0 ? 'danger' : 'default',
              },
              { label: 'p50', value: ms(rt.latencyP50Ms) },
              { label: 'p99', value: ms(rt.latencyP99Ms) },
              { label: 'Tokens (24h)', value: (rt.tokensLast24h ?? 0).toLocaleString() },
            ]}
          />

          {/* ── What it is running ──────────────────────────────────────── */}
          <Card padding="none" className="mb-4 overflow-hidden">
            <CardHeader inset title="Running now" subtitle="resolved at invocation time, not from the repo" />

            {prompt?.source === 'managed' ? (
              <Stack gap="sm" className="px-3.5 py-3">
                <CatalogGrid columns={4} dense>
                  <KeyValue label="Prompt" value={prompt.name} mono />
                  <KeyValue label="Version" value={prompt.version ?? '—'} />
                  <KeyValue label="Prompt sha" value={prompt.sha ?? '—'} mono />
                  <KeyValue label="Changed" value={when(prompt.updatedAt)} />
                  <KeyValue label="Model" value={prompt.modelId || rt.model || '—'} mono />
                  <KeyValue label="Length" value={prompt.characters != null ? `${prompt.characters} chars` : '—'} />
                </CatalogGrid>
                {prompt.excerpt && (
                  <CollapsibleSection title="Prompt text">
                    <CodeBlock
                      code={prompt.excerpt + ((prompt.characters ?? 0) > prompt.excerpt.length ? '\n…' : '')}
                      language="text"
                      theme="light"
                    />
                  </CollapsibleSection>
                )}
                <T className="text-[11px] leading-snug text-text-tertiary" wrap>
                  Edit this in{' '}
                  <Link to="/iq/prompts" className="text-primary no-underline hover:underline">Prompts</Link>
                  {' '}— deployed agents pick up a change within about a minute, with no rebuild.
                </T>
              </Stack>
            ) : (
              <Stack gap="xs" className="px-3.5 py-3">
                <T className="text-[12px] font-semibold text-warning">Running its built-in fallback prompt</T>
                <T className="text-[12px] leading-snug text-text-secondary" wrap>
                  {prompt?.problem ?? 'The managed prompt could not be read.'}
                </T>
                <T className="text-[11px] leading-snug text-text-tertiary" wrap>
                  The agent still works — it falls back to the literal compiled into its image so a Bedrock
                  outage cannot take the fleet down — but edits in Prompt Studio are not reaching it.
                </T>
              </Stack>
            )}
          </Card>

          {/* ── Recent calls ────────────────────────────────────────────── */}
          <Card padding="none" className="mb-4 overflow-hidden">
            <CardHeader
              inset
              title="Recent invocations"
              action={(
                <Link to={`/admin/observability/invocations?agentId=${encodeURIComponent(rt.name)}`}
                  className="text-[11px] text-primary no-underline hover:underline">
                  All invocations →
                </Link>
              )}
            />
            <DataTable<Invocation>
              data={data?.invocationsProblem ? [] : (data?.invocations ?? [])}
              keyField={(iv) => iv.invocationId}
              frameless
              emptyMessage={(
                <InlinePlaceholder size="sm">
                  {data?.invocationsProblem ?? (
                    'No invocations recorded. Traces reach Aurora through the CloudWatch poller, so a call made in the last minute may not be here yet.'
                  )}
                </InlinePlaceholder>
              )}
              columns={[
                {
                  key: 'startedAt', header: 'When', render: (iv) => (
                    <Link to={`/admin/observability/invocations/${iv.invocationId}`}
                      className="text-primary no-underline hover:underline">
                      {when(iv.startedAt)}
                    </Link>
                  ),
                },
                { key: 'durationMs', header: 'Duration', align: 'right', render: (iv) => <T className="font-mono">{ms(iv.durationMs)}</T> },
                { key: 'totalTokens', header: 'Tokens', align: 'right', render: (iv) => <T className="font-mono">{iv.totalTokens || '—'}</T> },
                {
                  key: 'costUsd', header: 'Cost', align: 'right', render: (iv) => (
                    <T className="font-mono">{iv.costUsd == null ? '—' : `$${iv.costUsd.toFixed(4)}`}</T>
                  ),
                },
                {
                  key: 'judgeScore', header: 'Score', align: 'right', render: (iv) => (
                    <T className={`font-mono ${iv.guardrailAction && iv.guardrailAction !== 'NONE' ? 'text-warning' : ''}`}>
                      {iv.guardrailAction && iv.guardrailAction !== 'NONE'
                        ? iv.guardrailAction
                        : iv.judgeScore == null ? '—' : iv.judgeScore.toFixed(2)}
                    </T>
                  ),
                },
                {
                  key: 'promptVersion', header: 'Prompt', render: (iv) => (
                    <T className="font-mono text-text-tertiary">{iv.promptVersion?.slice(0, 12) ?? '—'}</T>
                  ),
                },
                // title=, matching every other promptSnippet cell in the portal
                // (InvocationsPage, InvocationSearchPage). Without it the question
                // that was actually asked is unrecoverable, and this page offers
                // nowhere else to read it.
                {
                  key: 'promptSnippet', header: 'Ask', render: (iv) => (
                    <T className="block max-w-[280px] truncate text-text-tertiary" title={iv.promptSnippet ?? undefined}>{iv.promptSnippet ?? '—'}</T>
                  ),
                },
              ]}
            />
          </Card>

          {/* ── Log ─────────────────────────────────────────────────────── */}
          <Card padding="none" className="overflow-hidden">
            <CardHeader inset
              title="Log"
              subtitle={data?.log.logGroup}
              action={(
                <Inline gap="sm" align="center">
                  {telemetryCount > 0 && (
                    <Inline gap="xs" align="center">
                      <Switch
                        checked={hideTelemetry}
                        onChange={setHideTelemetry}
                        size="sm"
                        aria-label={`hide ${telemetryCount} span exports`}
                      />
                      <T className="text-[11px] text-text-tertiary">hide {telemetryCount} span exports</T>
                    </Inline>
                  )}
                  <Button size="sm" variant="ghost" onClick={refresh}>refresh</Button>
                </Inline>
              )}
            />
            {data?.log.problem ? (
              <InlinePlaceholder size="sm">{data.log.problem}</InlinePlaceholder>
            ) : (
              <LogStream
                title={null}
                showSource={false}
                maxHeight="420px"
                emptyMessage={`Nothing in the last 6 hours${telemetryCount > 0 ? ' other than span exports' : ''}.`}
                lines={logLines.map((l, i) => ({
                  id: String(i),
                  timestamp: l.at ? new Date(l.at).toLocaleTimeString() : undefined,
                  level: toLogLevel(l.level),
                  message: l.text,
                }))}
              />
            )}
          </Card>
        </>
      )}
    </PageSection>
  );
}

