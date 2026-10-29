// Bedrock Nova-Pro LLM-as-a-judge wrapper for the observability data plane.
//
// AWS-native only — `amazon.nova-pro-v1:0`. We use the Converse API so we get
// a stable structured response shape regardless of how Nova formats internals.
//
// The judge is asked to return JSON `{"score": 0..1, "rationale": "..."}`. We
// parse defensively; any malformed response or invoke failure returns `null`
// so the trace-sink can skip persisting the score without blocking anything
// upstream.
//
// OFFLINE (`MOCK_AGENTCORE`) it does not call Bedrock at all: it reads the
// answer with `mock/answer-check.ts` and returns a derived verdict. See the
// branch in `judgeResponse` for what that measures and, more importantly, for
// why it is allowed to score badly.

import {
  BedrockRuntimeClient,
  ConverseCommand,
  type Message,
} from '@aws-sdk/client-bedrock-runtime';
import { recordBffCall } from '../providers/spend-ledger.js';
import { config } from '../config.js';
import { measureAnswer, offlineVerdict } from '../mock/answer-check.js';

export const NOVA_PRO_MODEL_ID = 'amazon.nova-pro-v1:0';

export interface JudgeUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface JudgeResult {
  score: number;     // 0..1, clamped
  rationale: string; // free-form, trimmed
  usage: JudgeUsage; // token counts from the Converse response; zeros if missing
}

let _client: BedrockRuntimeClient | null = null;
function client(): BedrockRuntimeClient {
  if (!_client) _client = new BedrockRuntimeClient({ region: config.region });
  return _client;
}

const SYSTEM_PROMPT = `You are an automated quality judge for an organizational-intelligence \
agent system (OrgIQ). You will be shown an end-user prompt and the agent's response. \
Score the response from 0 (terrible) to 1 (excellent) considering:

- correctness & groundedness (no hallucinations about people, projects, scores),
- relevance to the user's prompt,
- conciseness and actionability for a business user.

You MUST reply with a single JSON object of the form:
{"score": <number between 0 and 1>, "rationale": "<one short sentence>"}

No prose outside the JSON. No code fences.`;

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * Extract the first JSON object substring. Nova occasionally wraps its answer
 * in stray whitespace or trailing commentary; we slice between the first `{`
 * and the matching `}` and try to parse that.
 */
function extractJson(text: string): unknown | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  const slice = text.slice(start, end + 1);
  try {
    return JSON.parse(slice);
  } catch {
    return null;
  }
}

/**
 * Score a single (prompt, response) pair with Nova-Pro.
 *
 * Returns `null` on any failure. The caller logs and proceeds — judge failures
 * must NOT propagate to the agent invocation path.
 */
export async function judgeResponse(
  prompt: string,
  response: string,
): Promise<JudgeResult | null> {
  // OFFLINE. A real reading of this answer, not a canned score and not the
  // Bedrock failure below dressed up as one. `mock/answer-check.ts` measures
  // how much of the prompt the answer addresses, how many checkable anchors
  // (names, numbers, ids) it contains, whether it reads as a refusal or an
  // error string, its length band and its shape — then blends those into the
  // same 0–1 the Converse path returns, and records itself as
  // `offline/lexical-answer-check` so a judged row is never mistaken for one
  // Nova scored. The score flows into the real thresholds unchanged: a case
  // below its `pass_threshold` still fails, exactly as it would live.
  //
  // A judge that returned a fixed high score would be strictly worse than the
  // 500 it replaces — it would make every harness run green — so this one can
  // and does score badly: an empty answer is `null` ("nothing to judge", which
  // is not the same row as "judged badly"), and a refusal or an error string
  // is capped near zero however well-formatted it is.
  //
  // USAGE IS ZERO because no tokens were bought. `estimateCost` then reports a
  // judge cost of 0, which is the truth about an offline run rather than a
  // fabricated spend.
  //
  // NOTE the placement: above the `try`, so in real mode a thrown Converse
  // still resolves to `null` and the caller still records an unjudged row.
  if (config.mock.agentcore) {
    const verdict = offlineVerdict(measureAnswer(prompt ?? '', response ?? ''));
    if (!verdict) return null;
    return {
      score: clamp01(verdict.score),
      rationale: verdict.rationale,
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }

  const userPrompt = `User prompt:
"""
${(prompt ?? '').slice(0, 4000)}
"""

Agent response:
"""
${(response ?? '').slice(0, 4000)}
"""

Reply with the JSON object only.`;

  const messages: Message[] = [
    { role: 'user', content: [{ text: userPrompt }] },
  ];

  try {
    const resp = await client().send(
      new ConverseCommand({
        modelId: NOVA_PRO_MODEL_ID,
        system: [{ text: SYSTEM_PROMPT }],
        messages,
        inferenceConfig: {
          temperature: 0,
          maxTokens: 200,
        },
      }),
    );

    void recordBffCall({ feature: 'judge', model: NOVA_PRO_MODEL_ID, usage: resp.usage });

    const text = resp.output?.message?.content
      ?.map((c) => c.text ?? '')
      .join('')
      .trim() ?? '';

    // Always extract usage from the Converse response, even on parse failure,
    // so cost accounting reflects what the API actually charged us.
    const usage: JudgeUsage = {
      inputTokens: typeof resp.usage?.inputTokens === 'number' ? resp.usage.inputTokens : 0,
      outputTokens: typeof resp.usage?.outputTokens === 'number' ? resp.usage.outputTokens : 0,
    };

    if (!text) return null;

    const parsed = extractJson(text);
    if (!parsed || typeof parsed !== 'object') return null;
    const obj = parsed as Record<string, unknown>;
    const rawScore = typeof obj['score'] === 'number'
      ? (obj['score'] as number)
      : typeof obj['score'] === 'string'
        ? Number(obj['score'])
        : NaN;
    if (!Number.isFinite(rawScore)) return null;
    const rationale = typeof obj['rationale'] === 'string'
      ? (obj['rationale'] as string).trim().slice(0, 500)
      : '';
    return { score: clamp01(rawScore), rationale, usage };
  } catch (err) {
    console.warn('[judge] nova-pro invoke failed:', (err as Error).message);
    return null;
  }
}
