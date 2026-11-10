// `/summarize` on any conversation — the client half of the shared summarize
// core (middleware lib/conversation-summarize.ts). One implementation, two
// mounts: Social conversations at /api/chat/commands/summarize
// (routes/social-summarize.ts) and tenant conversations + huddles at
// /api/conversations/summarize (routes/conversation-summarize.ts). Pure and
// fetch-injectable so node:test covers it without a DOM. Reference:
// realtime-examples frontend/src/chat/commands/summarizeCommand.ts (the
// command) and MessagesPage.tsx:2115 (the private card that waits for "Post to
// conversation").

import type { AgentRunStatus, ChatCommand } from '@connorhoehn/ui-components/social';
import { assertTenantConversation } from './channelPlane.ts';

export interface SummarizeSpan { text: string; messageId: string; author: string }
export interface SummarizeResult {
  title: string; summary: string; content: string; sourceSpans: SummarizeSpan[]; messageCount: number; fallback: boolean;
  /** Why the agent was not used (tenant conversations report it). */
  unavailable?: string;
}
export type SummarizePhase = 'received' | 'running' | 'completed' | 'failed';
export interface SummarizeRunStatus {
  runId: string; channel: string; phase: SummarizePhase;
  steps: Array<{ id: string; label: string; status: 'pending' | 'running' | 'completed' | 'failed' }>;
  error: string | null; posted: boolean; result: SummarizeResult | null; since?: string;
}
export interface PostedSummary { channel: string; text: string; metadata: Record<string, unknown> }
export interface SummarizeStarted { runId: string; pipelineId: string; card: Record<string, unknown> }

type Fetch = typeof fetch;

export const SOCIAL_SUMMARIZE_BASE = '/api/chat/commands/summarize';
export const CONVERSATION_SUMMARIZE_BASE = '/api/conversations/summarize';

async function json<T>(response: Response, fallback: string): Promise<T> {
  let body: unknown = null;
  try { body = await response.json(); } catch { /* an empty error body falls back to the status text */ }
  if (!response.ok) {
    const message = body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
      ? (body as { error: string }).error : fallback;
    throw new Error(message);
  }
  return body as T;
}

export interface SummarizeApi {
  start(channel: string, argumentText: string, doFetch?: Fetch): Promise<SummarizeStarted>;
  status(runId: string, doFetch?: Fetch): Promise<SummarizeRunStatus>;
  /** Asks the server for the message to send. Sending it is the caller's explicit act. */
  requestPost(runId: string, doFetch?: Fetch): Promise<PostedSummary>;
}

/** The three calls against one mount (`base`). */
export function summarizeApi(base: string): SummarizeApi {
  return {
    async start(channel, argumentText, doFetch = fetch) {
      // The tenant mount never receives a Social channel (channelPlane.ts).
      if (base === CONVERSATION_SUMMARIZE_BASE) assertTenantConversation(channel);
      return json(await doFetch(`${base}/run`, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channel, text: argumentText }) }), 'The summary could not be started.');
    },
    async status(runId, doFetch = fetch) {
      return json(await doFetch(`${base}/runs/${encodeURIComponent(runId)}`, { credentials: 'include' }), 'The summary could not be read.');
    },
    async requestPost(runId, doFetch = fetch) {
      return json(await doFetch(`${base}/runs/${encodeURIComponent(runId)}/post`, { method: 'POST', credentials: 'include' }), 'The summary could not be posted.');
    },
  };
}

export const conversationSummarizeApi = summarizeApi(CONVERSATION_SUMMARIZE_BASE);

export const isTerminal = (s: Pick<SummarizeRunStatus, 'phase'>): boolean => s.phase === 'completed' || s.phase === 'failed';

/** Poll quickly at first, then back off; bounded so a lost run stops asking. */
export const MAX_POLLS = 90;
export const pollDelayMs = (attempt: number): number => Math.min(2500, 400 + attempt * 300);

/** What `AgentRunCard` reads. */
export function agentRunStatusOf(s: SummarizeRunStatus): AgentRunStatus {
  const running = s.steps.find(step => step.status === 'running');
  const noop = s.phase === 'completed' && s.result?.messageCount === 0;
  return {
    phase: s.phase,
    details: { steps: s.steps.map(({ id, label, status }) => ({ id, label, status })), ...(s.error ? { error: s.error } : {}) },
    ...(running ? { stepLabel: running.label } : {}),
    ...(noop ? { noop: true, detail: 'There were no messages you can read in that range.' } : {}),
    ...(s.phase === 'failed' ? { detail: s.error ?? 'The summary failed.' } : {}),
    ...(s.phase === 'completed' && s.result?.fallback ? { detail: s.result.unavailable
      ? `Nova is not available for this conversation (${s.result.unavailable}), so this is a plain digest of the thread.`
      : 'The model\'s answer could not be verified, so this is a plain digest of the thread.' } : {}),
  };
}

/** What the requester reviews: the summary and the verbatim quotes behind it. */
export function reviewMarkdown(result: SummarizeResult): string {
  const quotes = result.sourceSpans.map(span => `> "${span.text}" — ${span.author}`).join('\n>\n');
  return quotes ? `${result.content}\n\n**Sources**\n\n${quotes}` : result.content;
}

/** Post is offered only for a finished, non-empty, not-yet-posted summary. */
export const canPost = (s: SummarizeRunStatus): boolean =>
  s.phase === 'completed' && !s.posted && !!s.result && s.result.messageCount > 0;

/** `/summarize` or `/summarize last 24h` against `api` — the private card, not a message. */
export function summarizeCommand(api: SummarizeApi): ChatCommand {
  return {
    trigger: '/summarize',
    label: 'Summarize this conversation',
    hint: 'Optionally a range: 24h, last 2 days, today',
    description: 'Nova reads what you can see of this conversation and writes a summary with verbatim quotes. Only you see it until you post it.',
    scope: 'always',
    async run(ctx) {
      const started = await api.start(ctx.channel, ctx.argumentText);
      return { kind: 'run', runId: started.runId, pipelineId: started.pipelineId, card: started.card,
        echo: ctx.text.trim() || '/summarize', visibility: 'private' };
    },
  };
}

/** Tenant conversations and huddles: the shared mount. */
export const conversationSummarizeCommand: ChatCommand = summarizeCommand(conversationSummarizeApi);
