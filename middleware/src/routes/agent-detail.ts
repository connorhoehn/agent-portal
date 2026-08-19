// One agent, in depth — the page you want when an agent is misbehaving.
//
// Architecture could show the fleet and drill into a drawer of four numbers,
// and its "view invocation history" link went to the chat page. So there was
// nowhere to answer the questions you actually have about a single agent: what
// prompt is it running right now, is it up, what did the last calls cost and
// how long did they take, and what is in its log.
//
// Everything here is composed rather than stored: the prompt comes from
// Bedrock Prompt Management (which is what the agent itself resolves at run
// time), the status from the runtime list, the timings from invocation traces,
// the log from CloudWatch. Nothing is cached, because a diagnostics page that
// shows you a stale answer is worse than one that is slow.

import { Router } from 'express';
import { createHash } from 'node:crypto';
import {
  BedrockAgentClient, GetPromptCommand, ListPromptsCommand,
} from '@aws-sdk/client-bedrock-agent';
import {
  CloudWatchLogsClient, FilterLogEventsCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import { asyncHandler, NotFoundError } from '../lib/async-handler.js';
import { agentcore } from '../providers/index.js';
import { exec } from '../providers/aurora.js';
import { config } from '../config.js';
import { type SqlParameter } from '@aws-sdk/client-rds-data';

export const agentDetailRouter: Router = Router();

let _bedrock: BedrockAgentClient | null = null;
const bedrock = (): BedrockAgentClient => (_bedrock ??= new BedrockAgentClient({ region: config.region }));
let _logs: CloudWatchLogsClient | null = null;
const logs = (): CloudWatchLogsClient => (_logs ??= new CloudWatchLogsClient({ region: config.region }));

function toStr(v: unknown, f = ''): string { return typeof v === 'string' ? v : v == null ? f : String(v); }
function toNum(v: unknown): number { return typeof v === 'number' ? v : Number(v ?? 0); }

/**
 * Runtime names are `orgiq_supervisor`; prompts are `orgiq-supervisor-system-prompt`.
 * Both spellings of the same agent exist because AgentCore runtime names cannot
 * contain hyphens and Bedrock prompt names conventionally do.
 */
function agentSlug(runtimeName: string): string {
  return runtimeName.replace(/^orgiq[-_]/, '').replace(/_/g, '-');
}

export interface LivePrompt {
  /** Where the text actually came from on the last resolution. */
  source: 'managed' | 'unavailable';
  name: string;
  promptId: string | null;
  version: string | null;
  updatedAt: string | null;
  /** First 12 of the sha-256 — the same identity traces record as promptVersion. */
  sha: string | null;
  characters: number | null;
  excerpt: string | null;
  modelId: string | null;
  problem?: string;
}

/**
 * The prompt this agent resolves at run time.
 *
 * Agents read `orgiq-<agent>-system-prompt` from Prompt Management on every
 * invocation (cached ~60s) and fall back to a literal in their image when it
 * is unreachable — so "which prompt is it running" genuinely has two possible
 * answers and the page has to say which one is in force.
 */
async function livePrompt(runtimeName: string): Promise<LivePrompt> {
  const name = `orgiq-${agentSlug(runtimeName)}-system-prompt`;
  try {
    // ListPrompts must be paginated — the un-paginated call returns only the
    // first page and silently misses prompts.
    let promptId: string | null = null;
    let nextToken: string | undefined;
    do {
      const page = await bedrock().send(new ListPromptsCommand({
        maxResults: 100, ...(nextToken ? { nextToken } : {}),
      }));
      const hit = (page.promptSummaries ?? []).find((p) => p.name === name);
      if (hit?.id) { promptId = hit.id; break; }
      nextToken = page.nextToken;
    } while (nextToken);

    if (!promptId) {
      return {
        source: 'unavailable', name, promptId: null, version: null, updatedAt: null,
        sha: null, characters: null, excerpt: null, modelId: null,
        problem: `No managed prompt named ${name} — this agent is running the literal compiled into its image.`,
      };
    }

    const got = await bedrock().send(new GetPromptCommand({ promptIdentifier: promptId }));
    const variant = got.variants?.[0];
    const text = variant?.templateConfiguration?.text?.text ?? '';
    return {
      source: 'managed',
      name,
      promptId,
      version: got.version ?? 'DRAFT',
      updatedAt: got.updatedAt ? new Date(got.updatedAt).toISOString() : null,
      sha: text ? createHash('sha256').update(text).digest('hex').slice(0, 12) : null,
      characters: text.length,
      excerpt: text.slice(0, 600),
      modelId: variant?.modelId ?? null,
    };
  } catch (err) {
    return {
      source: 'unavailable', name, promptId: null, version: null, updatedAt: null,
      sha: null, characters: null, excerpt: null, modelId: null,
      problem: `Prompt Management unreachable (${(err as Error).name}) — the agent falls back to its built-in prompt.`,
    };
  }
}

/** Recent calls, newest first. Empty is a real answer, not a failure. */
async function recentInvocations(runtimeName: string): Promise<Array<Record<string, unknown>>> {
  if (config.mock.aurora) return [];
  const slug = agentSlug(runtimeName);
  const params: SqlParameter[] = [
    { name: 'a1', value: { stringValue: runtimeName } },
    { name: 'a2', value: { stringValue: `orgiq-${slug}` } },
    { name: 'a3', value: { stringValue: slug } },
  ];
  try {
    const rows = await exec(
      `SELECT invocation_id, started_at, duration_ms, status, prompt_version,
              prompt_snippet, total_tokens, model_id, session_id
         FROM invocation_traces
        WHERE agent_id IN (:a1, :a2, :a3)
        ORDER BY started_at DESC
        LIMIT 25`,
      params,
    );
    return rows.map((r) => ({
      invocationId: toStr(r['invocation_id']),
      startedAt: toStr(r['started_at']),
      durationMs: toNum(r['duration_ms']),
      status: toStr(r['status']),
      promptVersion: r['prompt_version'] ? toStr(r['prompt_version']) : null,
      promptSnippet: r['prompt_snippet'] ? toStr(r['prompt_snippet']) : null,
      totalTokens: toNum(r['total_tokens']),
      modelId: r['model_id'] ? toStr(r['model_id']) : null,
      sessionId: r['session_id'] ? toStr(r['session_id']) : null,
    }));
  } catch {
    return [];
  }
}

/** Tail of the runtime's own log. */
async function recentLogs(runtimeId: string, limit: number): Promise<{
  logGroup: string; events: Array<{ at: string; message: string }>; problem?: string;
}> {
  const logGroup = `/aws/bedrock-agentcore/runtimes/${runtimeId}-DEFAULT`;
  try {
    const out = await logs().send(new FilterLogEventsCommand({
      logGroupName: logGroup,
      limit,
      // A diagnostics tail, not an archive search: the last few hours is what
      // you want when something is wrong now.
      startTime: Date.now() - 6 * 60 * 60 * 1000,
    }));
    const events = (out.events ?? [])
      .map((e) => ({
        at: e.timestamp ? new Date(e.timestamp).toISOString() : '',
        message: (e.message ?? '').trimEnd(),
      }))
      .reverse();
    return { logGroup, events };
  } catch (err) {
    const name = (err as { name?: string }).name ?? 'UnknownError';
    return {
      logGroup,
      events: [],
      problem: name === 'ResourceNotFoundException'
        ? 'No log group yet — this runtime has not produced logs.'
        : `Logs unavailable (${name}).`,
    };
  }
}

// ─── GET /:agentId ────────────────────────────────────────────────────────────

agentDetailRouter.get('/:agentId', asyncHandler(async (req, res) => {
  const wanted = String(req.params['agentId'] ?? '');
  const runtimes = await agentcore.listRuntimes();

  // Accept the runtime id, its name, or the hyphenated slug, because all three
  // appear in links across the app and guessing wrong lands on a 404 that
  // looks like the agent is gone.
  const runtime = runtimes.find((r: { id: string; name: string }) =>
    r.id === wanted || r.name === wanted || agentSlug(r.name) === agentSlug(wanted));
  if (!runtime) throw new NotFoundError(`No agent runtime matching "${wanted}"`);

  const logLimit = Math.min(Number(req.query['logLimit'] ?? 100) || 100, 500);

  // Independent reads, so one slow or broken source does not hold the others.
  const [prompt, metrics, invocations, log] = await Promise.all([
    livePrompt(runtime.name),
    agentcore.getRuntimeMetrics(runtime.id).catch(() => null),
    recentInvocations(runtime.name),
    recentLogs(runtime.id, logLimit),
  ]);

  res.json({ runtime, prompt, metrics, invocations, log });
}));
