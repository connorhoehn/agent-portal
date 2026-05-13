// Bedrock Nova-Pro LLM-as-a-judge wrapper for the observability data plane.
//
// AWS-native only — `amazon.nova-pro-v1:0`. We use the Converse API so we get
// a stable structured response shape regardless of how Nova formats internals.
//
// The judge is asked to return JSON `{"score": 0..1, "rationale": "..."}`. We
// parse defensively; any malformed response or invoke failure returns `null`
// so the trace-sink can skip persisting the score without blocking anything
// upstream.

import {
  BedrockRuntimeClient,
  ConverseCommand,
  type Message,
} from '@aws-sdk/client-bedrock-runtime';
import { config } from '../config.js';

export const NOVA_PRO_MODEL_ID = 'amazon.nova-pro-v1:0';

export interface JudgeResult {
  score: number;     // 0..1, clamped
  rationale: string; // free-form, trimmed
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

    const text = resp.output?.message?.content
      ?.map((c) => c.text ?? '')
      .join('')
      .trim() ?? '';
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
    return { score: clamp01(rawScore), rationale };
  } catch (err) {
    console.warn('[judge] nova-pro invoke failed:', (err as Error).message);
    return null;
  }
}
