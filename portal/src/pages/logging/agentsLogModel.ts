// Logging's Agents source (G37): bot runs (GET /api/bots, then
// GET /api/bots/runs?botIds=…, the bot runs page's read gate) and the agent
// runtime's invocation traces (GET /api/observability/invocations/search and
// /:invocationId, ViewObservability). Each becomes a rail row and the page's
// one record shape: facts with the cost, its tool calls and its events.

import {
  lifecycleEvents, newestFirst, plural, took, tookMs, usd4, when,
  type LogCall, type LogRecord, type LogRow,
} from './loggingModel.ts';

export const BOTS_API = '/api/bots';
export const botRunsApi = (botIds: readonly string[]): string => `/api/bots/runs?botIds=${encodeURIComponent(botIds.join(','))}`;
export const INVOCATIONS_API = '/api/observability/invocations/search?limit=50';
export const invocationApi = (id: string): string => `/api/observability/invocations/${encodeURIComponent(id)}`;

export interface BotRow { id: string; name: string }

/** providers/bots.ts BotRun, as GET /api/bots/runs answers it. */
export interface BotRunRow {
  id: string;
  botId: string | null;
  trigger: string;
  runId: string | null;
  jobId: string | null;
  workItemId: string | null;
  status: string;
  costUsd: number | null;
  modelProvider: string | null;
  startedAt: string;
  finishedAt: string | null;
  outcome: Record<string, unknown>;
  dispatchedBy: string | null;
}

/** routes/invocations.ts InvocationSearchRow (the fields this page reads). */
export interface InvocationRow {
  invocationId: string;
  agentId: string;
  agentName: string;
  promptSnippet: string;
  judgeScore: number | null;
  durationMs: number | null;
  totalCostUsd: number | null;
  modelId: string | null;
  ts: string;
}

export interface InvocationDetail {
  invocation: InvocationRow & {
    templateId: string | null;
    responseSnippet: string;
    schemaValid: boolean | null;
    guardrailAction: string | null;
    inputTokens: number | null;
    outputTokens: number | null;
    estCostUsd: number | null;
    judgeCostUsd: number | null;
    promptVersion: string | null;
    parentInvocationId: string | null;
    userId: string | null;
    sessionId: string | null;
  };
  toolCalls: Array<{ toolCallId: string; toolName: string; startedAt: string; durationMs: number | null; errored: boolean; errorMessage: string | null; estCostUsd: number | null }>;
  parent: { invocationId: string; agentName: string; ts: string } | null;
  children: Array<{ invocationId: string; agentName: string; durationMs: number | null; ts: string }>;
}

/** The job behind a bot run (GET /api/work/jobs/:id), when it has one and it could be read. */
export interface RunJob {
  id: string;
  status: string;
  createdAt: string;
  claimedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  boxId: string | null;
  error: string | null;
  result: Record<string, unknown> | null;
}

export const BOT_RUN = 'bot-runs';
export const INVOCATION = 'invocations';

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

/** The rail: bot runs and invocations together, newest first. */
export function agentRows(bots: readonly BotRow[], runs: readonly BotRunRow[], invocations: readonly InvocationRow[]): LogRow[] {
  const names = new Map(bots.map((b) => [b.id, b.name]));
  return newestFirst([
    ...runs.map((r): LogRow => ({
      source: 'agents', kind: BOT_RUN, id: r.id, at: r.startedAt,
      subline: [(r.botId && names.get(r.botId)) || 'a bot', `bot run, ${r.trigger}`, r.status, r.costUsd == null ? null : usd4(r.costUsd)].filter(Boolean).join(' · '),
    })),
    ...invocations.map((i): LogRow => ({
      source: 'agents', kind: INVOCATION, id: i.invocationId, at: i.ts,
      subline: [i.agentName || i.agentId, 'invocation', i.durationMs == null ? null : took(i.durationMs), i.totalCostUsd == null ? null : usd4(i.totalCostUsd)].filter(Boolean).join(' · '),
    })),
  ]);
}

/** A bot run: its row, and the job it dispatched (tool calls and lifecycle) when that was read. */
export function botRunRecord(run: BotRunRow, botName: string | null, job: RunJob | null): LogRecord {
  const o = run.outcome ?? {};
  const listed = Array.isArray(job?.result?.['toolCallList']) ? job!.result!['toolCallList'] as Array<{ name?: unknown; done?: unknown }> : [];
  const calls: LogCall[] = listed.map((c, i) => ({
    id: `${i}`, at: null, name: str(c.name) ?? 'tool', outcome: c.done === false ? 'running' : 'done', detail: '', tookMs: null,
  }));
  const error = str(o['error']);
  return {
    source: 'agents', kind: BOT_RUN, id: run.id, label: `${botName ?? 'Bot'} run ${when(run.startedAt)}`,
    facts: [
      { label: 'Run', value: run.id, mono: true },
      { label: 'Bot', value: botName ?? run.botId ?? 'marketplace (no bot)' },
      { label: 'Trigger', value: run.trigger },
      { label: 'Status', value: run.status },
      { label: 'Started', value: when(run.startedAt) },
      { label: 'Finished', value: run.finishedAt ? when(run.finishedAt) : 'not yet' },
      { label: 'Took', value: took(tookMs(run.startedAt, run.finishedAt)) || 'open' },
      { label: 'Cost', value: usd4(run.costUsd) },
      { label: 'Served by', value: run.modelProvider ?? 'not recorded' },
      ...(str(o['reason']) ? [{ label: 'Reason', value: str(o['reason'])! }] : []),
      ...(num(o['turns']) != null ? [{ label: 'Turns', value: String(num(o['turns'])) }] : []),
      ...(num(o['toolCalls']) != null ? [{ label: 'Tool calls', value: String(num(o['toolCalls'])) }] : []),
      ...(error ? [{ label: 'Error', value: error }] : []),
      ...(run.jobId ? [{ label: 'Job', value: run.jobId, mono: true }] : []),
      ...(run.dispatchedBy ? [{ label: 'Dispatched by', value: run.dispatchedBy }] : []),
    ],
    callsTitle: 'Tool calls',
    calls,
    events: lifecycleEvents([
      { at: run.startedAt, kind: 'started', data: { trigger: run.trigger } },
      { at: job?.createdAt, kind: 'job queued', data: { job: job?.id } },
      { at: job?.claimedAt, kind: 'job claimed', data: job?.boxId ? { box: job.boxId } : undefined },
      { at: job?.startedAt, kind: 'job running' },
      { at: job?.finishedAt, kind: `job ${job?.status ?? ''}`.trim(), data: job?.error ? { error: job.error } : undefined },
      { at: run.finishedAt, kind: run.status, data: error ? { error } : (run.costUsd != null ? { costUsd: run.costUsd } : undefined) },
    ]),
    raw: { run, job },
  };
}

/** An invocation trace: the trace, its tool calls, and its parent and children as events. */
export function invocationRecord(d: InvocationDetail): LogRecord {
  const i = d.invocation;
  const tokens = i.inputTokens == null && i.outputTokens == null ? 'not recorded' : `${i.inputTokens ?? '?'} in, ${i.outputTokens ?? '?'} out`;
  const end = (() => { const t = Date.parse(i.ts); return Number.isFinite(t) && i.durationMs != null ? new Date(t + i.durationMs).toISOString() : null; })();
  return {
    source: 'agents', kind: INVOCATION, id: i.invocationId, label: `${i.agentName || i.agentId} ${when(i.ts)}`,
    facts: [
      { label: 'Invocation', value: i.invocationId, mono: true },
      { label: 'Agent', value: i.agentName || i.agentId },
      { label: 'At', value: when(i.ts) },
      { label: 'Took', value: took(i.durationMs) || 'not recorded' },
      { label: 'Model', value: [i.modelId, i.promptVersion].filter(Boolean).join(' · ') || 'not recorded', mono: true },
      { label: 'Tokens', value: tokens },
      { label: 'Cost', value: `${usd4(i.totalCostUsd)}${i.judgeCostUsd != null ? ` (judge ${usd4(i.judgeCostUsd)})` : ''}` },
      { label: 'Judge score', value: i.judgeScore == null ? 'not scored' : i.judgeScore.toFixed(2) },
      ...(i.guardrailAction ? [{ label: 'Guardrail', value: i.guardrailAction }] : []),
      ...(i.sessionId ? [{ label: 'Session', value: i.sessionId, mono: true }] : []),
      { label: 'Tool calls', value: plural(d.toolCalls.length, 'call') },
    ],
    callsTitle: 'Tool calls',
    calls: d.toolCalls.map((c) => ({
      id: c.toolCallId, at: c.startedAt, name: c.toolName, outcome: c.errored ? 'errored' : 'ok',
      detail: [c.errorMessage, c.estCostUsd != null ? usd4(c.estCostUsd) : null].filter(Boolean).join(' · '), tookMs: c.durationMs,
    })),
    events: lifecycleEvents([
      ...(d.parent ? [{ at: d.parent.ts, kind: 'parent', data: { invocation: d.parent.invocationId, agent: d.parent.agentName } }] : []),
      { at: i.ts, kind: 'invoked', data: { agent: i.agentName || i.agentId, ...(i.templateId ? { template: i.templateId } : {}) } },
      ...d.toolCalls.map((c) => ({ at: c.startedAt, kind: c.errored ? 'tool errored' : 'tool call', data: { tool: c.toolName, ...(c.durationMs != null ? { ms: c.durationMs } : {}) } })),
      ...d.children.map((c) => ({ at: c.ts, kind: 'child', data: { invocation: c.invocationId, agent: c.agentName } })),
      { at: end, kind: 'answered', data: { ...(i.schemaValid != null ? { schemaValid: i.schemaValid } : {}), ...(i.totalCostUsd != null ? { costUsd: i.totalCostUsd } : {}) } },
    ]),
    raw: d,
  };
}
