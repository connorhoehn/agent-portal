// The shared core of `/summarize` (docs/agentic-flows-migration.md slice 2 and
// its multi-tenant extension): one private, durable run per request that reads
// what the requester may read of ONE conversation, asks Nova for a grounded
// summary, checks every quote against that transcript, and hands back a
// message only when the requester explicitly posts it.
//
// Each tenant defines its flow with `defineSummarizeFlow` (id prefix, kind,
// tenant). WHO may read a conversation is not decided here: the caller passes
// only lines it has already filtered through that conversation's own read
// authority (Social: chatAccess; tenant families: the gateway's history
// authority; huddles: the call-chat participant authority —
// routes/conversation-summarize.ts `conversationLines`; stored channels are read
// through routes/chat-pins.ts `readChatLines`).
//
// The reference is platform-api's `conversation-summarize` pipeline
// (src/documents/conversationSummarizePipeline.ts: read-history -> plan ->
// apply -> publish, `conversationText` at :37, the 200-message default at :28).
// Differences, on purpose:
//   - the model is Nova, through the drafter's `summarize-conversation`
//     document command (agents/assessment-drafter/document_commands.py);
//   - the model's output is validated HERE as well: every source span must be a
//     verbatim quote of one message the requester could read, or the
//     deterministic digest stands in (`fallback: true`);
//   - the run is private and DURABLE (lib/flow-runs): a restart or another node
//     resumes it, and only the requester can read it.
//
// The drafter's in-agent tenant guard (agents/_shared/tenant_guard.py) serves
// only `assessment`. Flows of other tenants still call it (so widening the
// guard is the only change needed later), and its refusal lands as the
// deterministic digest with `unavailable` naming why — the decks' rule.

import type { ChatMessage } from '@connorhoehn/realtime-modules/chat';
import { config } from '../config.js';
import { agentcore } from '../providers/index.js';
import { flowRunStore, kickFlowRun, registerFlowExecutor, type FlowExecutionContext, type FlowRunRow, type FlowRunStep } from './flow-runs/index.js';
import { SpendRefusedError } from './async-handler.js';
import {
  holdAgentInvoke, bindAgentInvokeHold, releaseAgentInvokeHold, recordAgentInvoke, usageFromEvent,
} from './agent-invoke-spend.js';

export const SUMMARIZE_AGENT_ID = 'orgiq-assessment-drafter';
export const SUMMARIZE_MODE = 'summarize-conversation';
export const HISTORY_LIMIT = 200;
export const MAX_TRANSCRIPT_CHARS = 60_000;
export const MAX_ACTIVE_RUNS_PER_USER = 3;
export const RUN_TTL_MS = 2 * 3_600_000;
export const MAX_SPANS = 12;
export const MAX_CONTENT = 4000;
const MAX_SUMMARY = 800;

export interface SummarizeSpan { text: string; messageId: string; author: string }
export interface SummarizeResult {
  title: string;
  summary: string;
  /** Markdown the requester reviews, and posts only by an explicit act. */
  content: string;
  sourceSpans: SummarizeSpan[];
  messageCount: number;
  /** True when the agent's output failed validation (or was unavailable) and the deterministic digest stands in. */
  fallback: boolean;
  /** Why the agent was not used, when it refused or failed (non-Social flows report it). */
  unavailable?: string;
}
export type SummarizePhase = 'received' | 'running' | 'completed' | 'failed';

export interface TranscriptLine { messageId: string; author: string; text: string; at: string }

/** One flat line per message. Run cards, posted summaries and empty messages are not conversation. */
export function transcriptLines(
  messages: ReadonlyArray<{ message: ChatMessage; author: string }>, sinceMs: number | null,
): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  for (const { message, author } of [...messages].sort((a, b) => a.message.timestamp.localeCompare(b.message.timestamp))) {
    const text = message.message.replace(/\s+/g, ' ').trim();
    if (!text || message.metadata?.['kind'] === 'agent-run' || message.metadata?.['summaryOf'] || message.metadata?.['artifactOf']) continue;
    if (sinceMs !== null && Date.parse(message.timestamp) < sinceMs) continue;
    lines.push({ messageId: message.id, author, text, at: message.timestamp });
  }
  return lines.slice(-HISTORY_LIMIT);
}

export function transcriptText(lines: readonly TranscriptLine[]): string {
  let out = lines.map(l => `${l.author}: ${l.text}`).join('\n');
  if (out.length > MAX_TRANSCRIPT_CHARS) out = out.slice(out.length - MAX_TRANSCRIPT_CHARS).replace(/^[^\n]*\n/, '');
  return out;
}

const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s);

/** Deterministic, model-free digest: facts counted from the lines, quotes verbatim. */
export function digestEnvelope(lines: readonly TranscriptLine[]): { summary: string; content: string; format: 'markdown'; source_spans: string[] } {
  const people = new Set(lines.map(l => l.author));
  const picks = [...new Set([0, Math.floor((lines.length - 1) / 2), lines.length - 1])].filter(i => i >= 0).map(i => lines[i]!);
  const quotes = picks.map(l => ({ author: l.author, text: clip(l.text, 200) }));
  const summary = `${lines.length} message${lines.length === 1 ? '' : 's'} from ${people.size} ${people.size === 1 ? 'person' : 'people'}.`;
  const content = ['## Summary', summary, '', '## Highlights', ...quotes.map(q => `- ${q.author}: "${q.text}"`)].join('\n');
  return { summary, content, format: 'markdown', source_spans: quotes.map(q => q.text) };
}

/**
 * Accepts the agent's envelope only if every quote is verbatim in ONE message
 * line. Returns null otherwise (the caller falls back to the digest).
 */
export function acceptEnvelope(raw: unknown, lines: readonly TranscriptLine[]): SummarizeResult | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = raw as Record<string, unknown>;
  const { summary, content, source_spans: spans } = v;
  if (typeof summary !== 'string' || !summary.trim() || summary.length > MAX_SUMMARY) return null;
  if (typeof content !== 'string' || !content.trim() || content.length > MAX_CONTENT) return null;
  if (v['format'] !== 'markdown') return null;
  if (!Array.isArray(spans) || spans.length < 1 || spans.length > MAX_SPANS) return null;
  const sourceSpans: SummarizeSpan[] = [];
  for (const span of spans) {
    if (typeof span !== 'string' || !span || span.includes('\n')) return null;
    const line = lines.find(l => l.text.includes(span));
    if (!line) return null;
    sourceSpans.push({ text: span, messageId: line.messageId, author: line.author });
  }
  return { title: 'Conversation summary', summary: summary.trim(), content: content.trim(), sourceSpans, messageCount: lines.length, fallback: false };
}

// ─── Durable run (lib/flow-runs) ─────────────────────────────────────────────

const INITIAL_STEPS: FlowRunStep[] = [
  { id: 'read-history', label: 'Read the conversation', status: 'completed' },
  { id: 'summarize', label: 'Write the summary (Nova)', status: 'pending' },
  { id: 'check', label: 'Check every quote against the thread', status: 'pending' },
];

const PHASE: Record<FlowRunRow['status'], SummarizePhase> = { queued: 'received', running: 'running', 'waiting-approval': 'running', completed: 'completed', failed: 'failed' };

export interface SummarizeView {
  id: string; channel: string; phase: SummarizePhase; steps: FlowRunStep[]; result: SummarizeResult | null;
  error: string | null; postedAt: string | null; updatedAt: string; since: string | null;
}

/** The caller's view of a run row. */
export function summarizeView(run: FlowRunRow): SummarizeView {
  const posted = run.meta['postedAt'];
  const since = run.meta['since'];
  return {
    id: run.id, channel: run.scope, phase: PHASE[run.status], steps: run.progress, result: (run.result as SummarizeResult | null) ?? null,
    error: run.error, postedAt: typeof posted === 'string' ? posted : null, updatedAt: run.updatedAt, since: typeof since === 'string' ? since : null,
  };
}

/** The wire status both summarize routers answer. */
export function summarizeStatus(run: FlowRunRow): Record<string, unknown> {
  const v = summarizeView(run);
  return {
    runId: v.id, channel: v.channel, phase: v.phase, steps: v.steps, error: v.error,
    posted: v.postedAt !== null, result: v.result, updatedAt: v.updatedAt,
    ...(v.since ? { since: v.since } : {}),
  };
}

export type SummarizeTenant = 'social' | 'orgiq' | 'assessment' | 'pipelines';

export interface SummarizeFlowSpec {
  tenant: SummarizeTenant;
  kind: string;
  /** The run id prefix; lib/flow-runs/channel.ts maps it to the tenant's private push channel. */
  idPrefix: string;
  /**
   * Send the drafter an `auth` block for the run's tenant and report a refusal
   * as `unavailable`. Social's original call sends neither, and keeps doing so.
   */
  agentAuth: boolean;
}

export interface SummarizeFlow {
  spec: SummarizeFlowSpec;
  /** A run is the requester's alone: another user's id answers exactly like an unknown one. */
  getRunFor(userId: string, id: string): Promise<FlowRunRow | null>;
  /** Existence only (for re-checking access to its conversation); callers must still call getRunFor. */
  findRun(id: string): Promise<FlowRunRow | null>;
  activeRunCount(userId: string): Promise<number>;
  /** Persists the run (with the lines the requester may read) and starts it on this node. */
  startRun(input: { userId: string; channel: string; instruction: string; sinceMs: number | null; lines: readonly TranscriptLine[]; recordingId?: string }): Promise<FlowRunRow>;
  /** Atomic once-only claim of the post; false when it was already posted. */
  markPosted(run: FlowRunRow): Promise<boolean>;
  executor(ctx: FlowExecutionContext): Promise<{ result: SummarizeResult; progress: FlowRunStep[] }>;
}

const withStatus = (steps: readonly FlowRunStep[], id: string, status: FlowRunStep['status']): FlowRunStep[] =>
  steps.map(s => (s.id === id ? { ...s, status } : s));

async function draft(spec: SummarizeFlowSpec, run: FlowRunRow, lines: readonly TranscriptLine[], instruction: string): Promise<{ envelope: unknown; unavailable?: string }> {
  if (config.mock.agentcore) {
    // No runtime is called, so nothing is spent: the start's hold goes back.
    await releaseAgentInvokeHold(holdIdOf(run));
    return { envelope: digestEnvelope(lines) };
  }
  // The ledger row for this run's drafter call (work item 16), keyed by the
  // run id the start's hold was bound to, so writing it settles that hold. A
  // retried attempt writes the same key: the ledger keeps the first.
  let raw: unknown = null;
  try {
    return await invoke();
  } finally {
    await recordAgentInvoke({
      sourceId: run.id, actorId: run.requestedBy, initiativeId: null,
      feature: `summarize:${spec.tenant}`, usage: usageFromEvent(raw),
    });
  }

  async function invoke(): Promise<{ envelope: unknown; unavailable?: string }> {
    try {
      const out = await agentcore.invokeAgent(SUMMARIZE_AGENT_ID, {
        message: `Execute ${spec.tenant} command ${SUMMARIZE_MODE}`,
        structuredInput: { tenant: spec.tenant, command: SUMMARIZE_MODE, mode: SUMMARIZE_MODE, run_id: run.id,
          document: { text: transcriptText(lines) }, ...(instruction ? { instruction } : {}),
          ...(spec.agentAuth ? { auth: { tenant: spec.tenant, sub: run.requestedBy } } : {}) },
        timeoutMs: 120_000,
      });
      raw = out.raw;
      if (out.raw && typeof out.raw === 'object' && 'error' in out.raw) {
        return { envelope: null, unavailable: String((out.raw as { detail?: unknown; error: unknown }).detail ?? (out.raw as { error: unknown }).error) };
      }
      return { envelope: JSON.parse(out.text) };
    } catch (error) {
      return { envelope: null, unavailable: error instanceof Error ? error.message : 'the drafter failed' };
    }
  }
}

/** The spend hold the run's start took, kept in its meta so any node that resumes it can release it. */
function holdIdOf(run: FlowRunRow): string | null {
  const id = run.meta['spendHoldId'];
  return typeof id === 'string' && id ? id : null;
}

/** One tenant's `/summarize` flow on the shared durable store. Registers its executor. */
export function defineSummarizeFlow(spec: SummarizeFlowSpec): SummarizeFlow {
  const executor = async (ctx: FlowExecutionContext): Promise<{ result: SummarizeResult; progress: FlowRunStep[] }> => {
    const { run } = ctx;
    const lines = (Array.isArray(run.input?.['lines']) ? run.input!['lines'] : []) as TranscriptLine[];
    const instruction = typeof run.input?.['instruction'] === 'string' ? run.input['instruction'] as string : '';
    let steps = withStatus(run.progress.length ? run.progress : INITIAL_STEPS, 'summarize', 'running');
    await ctx.report(steps);
    if (lines.length === 0) {
      steps = withStatus(withStatus(steps, 'summarize', 'completed'), 'check', 'completed');
      return { result: { title: 'Conversation summary', summary: 'Nothing to summarize.', content: 'There are no messages you can read in that range.',
        sourceSpans: [], messageCount: 0, fallback: false }, progress: steps };
    }
    const drafted = await draft(spec, run, lines, instruction);
    steps = withStatus(withStatus(steps, 'summarize', 'completed'), 'check', 'running');
    await ctx.report(steps);
    let result = acceptEnvelope(drafted.envelope, lines);
    if (!result) {
      const digest = acceptEnvelope(digestEnvelope(lines), lines);
      if (!digest) throw new Error('The summary could not be verified against the conversation.');
      result = { ...digest, fallback: true, ...(spec.agentAuth && drafted.unavailable ? { unavailable: drafted.unavailable } : {}) };
    }
    return { result, progress: withStatus(steps, 'check', 'completed') };
  };
  registerFlowExecutor(spec.kind, executor);
  return {
    spec,
    executor,
    getRunFor: (userId, id) => flowRunStore.getFor(spec.tenant, userId, id),
    async findRun(id) {
      const run = await flowRunStore.get(id);
      return run && run.tenant === spec.tenant && run.kind === spec.kind ? run : null;
    },
    activeRunCount: userId => flowRunStore.countActive(spec.tenant, spec.kind, userId),
    async startRun(input) {
      await flowRunStore.prune(spec.kind, RUN_TTL_MS);
      // Money first (work item 16): a run with lines calls the drafter, so it
      // is judged and held against the requester's budget before anything is
      // stored. A refusal is the spend refusal every other path answers. A
      // conversation names no initiative, so the hold is the user's alone.
      let holdId: string | null = null;
      if (input.lines.length > 0) {
        const held = await holdAgentInvoke({ actorId: input.userId, initiativeId: null });
        if (held.kind !== 'held') {
          const { spendRefusalResponse } = await import('./spend-refusal.js');
          const out = spendRefusalResponse(held);
          throw new SpendRefusedError(out.status, out.body, out.headers);
        }
        holdId = held.holdId;
      }
      let run: FlowRunRow;
      try {
        run = await flowRunStore.create({
          tenant: spec.tenant, kind: spec.kind, requestedBy: input.userId, scope: input.channel, idPrefix: spec.idPrefix,
          maxAttempts: 2, progress: INITIAL_STEPS,
          input: { lines: input.lines, instruction: input.instruction },
        });
        if (holdId) {
          await bindAgentInvokeHold(holdId, run.id);
          await flowRunStore.setMetaOnce(run.id, input.userId, 'spendHoldId', holdId);
        }
      } catch (err) {
        await releaseAgentInvokeHold(holdId);
        throw err;
      }
      if (input.sinceMs !== null) await flowRunStore.setMetaOnce(run.id, input.userId, 'since', new Date(input.sinceMs).toISOString());
      // Kept in meta (the private input is dropped at the terminal write): a room-recording run re-asks participation with it.
      if (input.recordingId) await flowRunStore.setMetaOnce(run.id, input.userId, 'recordingId', input.recordingId);
      kickFlowRun(run.id, spec.kind);
      return run;
    },
    markPosted: run => flowRunStore.setMetaOnce(run.id, run.requestedBy, 'postedAt', new Date().toISOString()),
  };
}

/** The message "Post to conversation" sends. Built from the stored result, never from the request. */
export function postMessageFor(run: FlowRunRow): { text: string; metadata: Record<string, unknown> } | null {
  const r = run.result as SummarizeResult | null;
  if (!r || r.messageCount === 0) return null;
  const quotes = r.sourceSpans.map(s => `> "${s.text}" — ${s.author}`).join('\n');
  return {
    text: `${r.content}${quotes ? `\n\nSources\n${quotes}` : ''}`,
    metadata: { summaryOf: { runId: run.id, messageCount: r.messageCount, sourceMessageIds: r.sourceSpans.map(s => s.messageId), fallback: r.fallback } },
  };
}
