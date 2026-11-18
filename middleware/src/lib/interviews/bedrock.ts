// The one Bedrock seam for the interviews tenant's small model callers (O-182): the coach (coach/model.ts), Milo's private
// questions (milo-notes/model.ts), the recap (recap/model.ts) and the question plan (plan/model.ts, through Milo's
// model). Each caller builds its own Converse request as data and hands it here with its timeout and its log label.
//
// Rules kept for every caller (pinned by __tests__/model-seam.test.ts):
//   * one shared client per process, for the region, with at most one retry (the SDK's attempts count the first try);
//   * a timeout aborts the call; a failure is a code, never an exception to the caller;
//   * nothing of the request, the transcript or the answer is logged: one line with the error's name (or "timeout");
//   * `sent` says the request may have cost something. A caller that books nothing for a refusal (the coach) asks for
//     `refusalBooksNothing`; the others book every failure at the estimate, as they did before the fold.
// Speech does not go through here: lib/interviews/speak and the meeting assistant keep their own providers.
import { BedrockRuntimeClient, ConverseCommand, type ConverseCommandInput, type ConverseCommandOutput } from '@aws-sdk/client-bedrock-runtime';
import { config } from '../../config.js';

export type ConverseSend = (cmd: ConverseCommand, opts: { abortSignal: AbortSignal }) => Promise<ConverseCommandOutput>;

export interface ConverseResult {
  /** The model's text, or null when nothing came back. */
  raw: string | null;
  code: 'ok' | 'timeout' | 'error';
  /** The request reached the provider (so it may have cost something). */
  sent: boolean;
  /** The provider's own counts, when it gave them. */
  usage: { inputTokens: number; outputTokens: number } | null;
}

export interface ConverseOptions {
  /** A fake in tests; the shared client otherwise. */
  send?: ConverseSend;
  timeoutMs: number;
  /** The caller's name in its one log line: `[interviews] <label> call failed`. */
  label: string;
  /** A refusal ran no model and bills nothing, so it is not `sent`. */
  refusalBooksNothing?: boolean;
}

/** Errors that mean the provider refused the request without running the model (nothing billed). */
const REFUSED_NAMES = new Set(['AccessDeniedException', 'UnrecognizedClientException', 'ValidationException', 'ThrottlingException',
  'ServiceQuotaExceededException', 'ResourceNotFoundException', 'ExpiredTokenException', 'InvalidSignatureException',
  'CredentialsProviderError', 'IncompleteSignatureException', 'MissingAuthenticationTokenException']);

/** Did the provider (or the SDK, before sending) refuse the call outright: a client fault, a 4xx, or a known refusal? */
export function refusedBeforeRunning(e: unknown): boolean {
  const err = e as { name?: unknown; $fault?: unknown; $metadata?: { httpStatusCode?: unknown } } | null;
  if (!err || typeof err !== 'object') return false;
  if (typeof err.name === 'string' && REFUSED_NAMES.has(err.name)) return true;
  if (err.$fault === 'client') return true;
  const status = Number(err.$metadata?.httpStatusCode);
  return Number.isFinite(status) && status >= 400 && status < 500;
}

let client: BedrockRuntimeClient | null = null;
const defaultSend: ConverseSend = (cmd, opts) => {
  client ??= new BedrockRuntimeClient({ region: config.region, maxAttempts: 2 });
  return client.send(cmd, opts);
};

/** Send one Converse request built as data; the answer's text, its usage, or a code. */
export async function converseOnce(request: ConverseCommandInput, opts: ConverseOptions): Promise<ConverseResult> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), opts.timeoutMs);
  timer.unref?.();
  try {
    const resp = await (opts.send ?? defaultSend)(new ConverseCommand(request), { abortSignal: abort.signal });
    const usage = resp.usage && Number.isFinite(resp.usage.inputTokens) && Number.isFinite(resp.usage.outputTokens)
      ? { inputTokens: Number(resp.usage.inputTokens), outputTokens: Number(resp.usage.outputTokens) } : null;
    const text = (resp.output?.message?.content ?? []).map((c) => ('text' in c && typeof c.text === 'string' ? c.text : '')).join('');
    return { raw: text || null, code: 'ok', sent: true, usage };
  } catch (e) {
    // The error's name only: its message could quote the request.
    const timedOut = abort.signal.aborted;
    console.warn(`[interviews] ${opts.label} call failed`, timedOut ? 'timeout' : (e as Error)?.name ?? 'error');
    const sent = timedOut || !opts.refusalBooksNothing || !refusedBeforeRunning(e);
    return { raw: null, code: timedOut ? 'timeout' : 'error', sent, usage: null };
  } finally {
    clearTimeout(timer);
  }
}
