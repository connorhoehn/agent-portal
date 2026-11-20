// One text-model call that picks a tool (Milo's Decide step, docs/milo-rebuild/REBUILD-PLAN.md section 1).
//
// A Responses request (POST <base>/responses) with function tools and `store: false` on every request: the provider keeps nothing
// (REBUILD-REVIEW.md risk 10). Non-streaming: an argument-less tool's name and arguments arrive together, so "done" is the number
// that matters. The key is read here, as in the other provider modules, and goes nowhere else: not in a return value, an error or a
// log line. The request body (which carries what people said) is never logged.
import type { ResponsesFunctionTool } from './catalogue.js';

function apiKey(): string | null {
  const v = (process.env['OPENAI_API_KEY'] ?? '').trim();
  return v && !v.includes('REPLACE_ME') ? v : null;
}
const apiBase = (): string => ((process.env['OPENAI_BASE_URL'] ?? '').trim() || 'https://api.openai.com/v1').replace(/\/$/, '');

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) =>
  Promise<{ status: number; text(): Promise<string> }>;
let fetchImpl: FetchLike = (url, init) => fetch(url, init);
/** Tests: replace the transport. */
export function _setTextFetch(f: FetchLike | null): void { fetchImpl = f ?? ((url, init) => fetch(url, init)); }

export interface TextToolRequest {
  model: string;
  instructions: string;
  /** The user turn: the sentence and its context. */
  input: string;
  tools: readonly ResponsesFunctionTool[];
  /** `required`: exactly one tool, no words. `auto`: a tool or a short answer. */
  toolChoice: 'required' | 'auto';
  maxOutputTokens?: number;
}

export interface TextToolReply {
  /** The first function call, or null. `arguments` is the provider's JSON text, unparsed. */
  call: { name: string; arguments: string } | null;
  /** Output text (an answer), '' when none. */
  text: string;
  usage: { input: number; output: number } | null;
  ms: number;
}

/** The provider refused or failed the request. Carries the status only, never the body sent. */
export class TextToolError extends Error {
  constructor(message: string, readonly kind: 'no-key' | 'timeout' | 'network' | 'status' | 'malformed', readonly status?: number) { super(message); }
}

/** Reasoning models take an effort; the lowest one this model accepts is remembered after a refusal. */
const effortOf = new Map<string, 'none' | 'minimal' | null>();
const isReasoningModel = (model: string): boolean => /^(gpt-5|gpt-6|o\d)/.test(model);

/** The request body: `store: false` always, one tool call at most. */
export function textToolBody(req: TextToolRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model, store: false, instructions: req.instructions,
    input: [{ role: 'user', content: req.input }],
    tools: req.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters, strict: false })),
    tool_choice: req.toolChoice, parallel_tool_calls: false,
    max_output_tokens: req.maxOutputTokens ?? 400,
  };
  if (isReasoningModel(req.model)) {
    const effort = effortOf.has(req.model) ? effortOf.get(req.model)! : 'none';
    if (effort) body['reasoning'] = { effort };
  }
  return body;
}

/** Read the first function call and the output text out of a Responses reply. */
export function readTextToolReply(json: unknown): Omit<TextToolReply, 'ms'> {
  const r = json as { output?: Array<{ type?: string; name?: string; arguments?: string; content?: Array<{ type?: string; text?: string }> }>; usage?: { input_tokens?: number; output_tokens?: number } };
  if (!r || !Array.isArray(r.output)) throw new TextToolError('the reply has no output', 'malformed');
  let call: TextToolReply['call'] = null;
  let text = '';
  for (const item of r.output) {
    if (item.type === 'function_call' && !call && typeof item.name === 'string') call = { name: item.name, arguments: typeof item.arguments === 'string' ? item.arguments : '{}' };
    if (item.type === 'message') for (const c of item.content ?? []) if (c.type === 'output_text' && typeof c.text === 'string') text += c.text;
  }
  const usage = r.usage ? { input: r.usage.input_tokens ?? 0, output: r.usage.output_tokens ?? 0 } : null;
  return { call, text: text.trim(), usage };
}

/** One tool-choosing request. Throws TextToolError; never retries a timeout (the turn's own deadline is the caller's). */
export async function requestToolChoice(req: TextToolRequest, opts: { timeoutMs: number; now?: () => number }): Promise<TextToolReply> {
  const key = apiKey();
  if (!key) throw new TextToolError('no OpenAI key configured', 'no-key');
  const now = opts.now ?? (() => performance.now());
  const t0 = now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let res: { status: number; text(): Promise<string> };
      try {
        res = await fetchImpl(`${apiBase()}/responses`, {
          method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(textToolBody(req)), signal: controller.signal,
        });
      } catch {
        if (controller.signal.aborted) throw new TextToolError('the decide request timed out', 'timeout');
        throw new TextToolError('the decide request failed', 'network');
      }
      const raw = await res.text().catch(() => {
        if (controller.signal.aborted) throw new TextToolError('the decide request timed out', 'timeout');
        return '';
      });
      // A reasoning model that refuses effort 'none' is asked again once with 'minimal' (and then with none set).
      if (res.status === 400 && isReasoningModel(req.model) && /reasoning/i.test(raw) && attempt === 0) {
        effortOf.set(req.model, effortOf.get(req.model) === undefined || effortOf.get(req.model) === 'none' ? 'minimal' : null);
        continue;
      }
      if (res.status < 200 || res.status >= 300) throw new TextToolError(`the decide request was refused (${res.status})`, 'status', res.status);
      let json: unknown;
      try { json = JSON.parse(raw); } catch { throw new TextToolError('the reply is not JSON', 'malformed'); }
      return { ...readTextToolReply(json), ms: now() - t0 };
    }
    throw new TextToolError('the decide request was refused (reasoning effort)', 'status', 400);
  } finally { clearTimeout(timer); }
}
