// Bedrock-driven session title cache.
//
// When a user starts a new session by sending their first message, the chat
// sidebar shows the raw UUID. Awful. Instead, fire a tiny Nova Lite call to
// summarize the first message in 3–5 words and cache the result keyed by
// sessionId. Subsequent /api/sessions reads merge the title in.
//
// Cost per title: ~$0.0001 (Nova Lite, ~100 tokens). Pure fire-and-forget;
// titles arrive on the next sidebar poll. Lost on middleware restart by
// design — it's a UX nicety, not durable state.

import {
  BedrockRuntimeClient,
  ConverseCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { config } from '../config.js';

const _titles = new Map<string, string>();
const _inFlight = new Set<string>();

let _client: BedrockRuntimeClient | null = null;
function client(): BedrockRuntimeClient {
  if (!_client) _client = new BedrockRuntimeClient({ region: config.region });
  return _client;
}

const TITLE_MODEL = 'amazon.nova-lite-v1:0';

export function getSessionTitle(sessionId: string): string | undefined {
  return _titles.get(sessionId);
}

export function getSessionTitleMap(): Record<string, string> {
  return Object.fromEntries(_titles.entries());
}

// Trigger a title generation if we don't already have one for this session.
// Fire-and-forget — never throws to callers.
export function maybeGenerateTitle(sessionId: string, firstUserMessage: string): void {
  if (!sessionId || !firstUserMessage) return;
  if (_titles.has(sessionId) || _inFlight.has(sessionId)) return;
  _inFlight.add(sessionId);
  void generateTitle(sessionId, firstUserMessage).catch((err) => {
    console.warn('[session-titles] generate failed:', (err as Error).message);
  }).finally(() => {
    _inFlight.delete(sessionId);
  });
}

async function generateTitle(sessionId: string, firstUserMessage: string): Promise<void> {
  const truncated = firstUserMessage.slice(0, 500);
  const resp = await client().send(
    new ConverseCommand({
      modelId: TITLE_MODEL,
      system: [{
        text: 'You produce 3-5 word session titles. Output ONLY the title — no quotes, no punctuation, no preamble. Match the language and tone of the user message. Examples:\n- User: "Who knows kubernetes?" → Kubernetes Experts\n- User: "Show me the data platform team" → Data Platform Roster\n- User: "What is everyone\'s influence?" → Org Influence Snapshot',
      }],
      messages: [{
        role: 'user',
        content: [{ text: truncated }],
      }],
      inferenceConfig: { maxTokens: 24, temperature: 0.2 },
    }),
  );
  const blocks = resp.output?.message?.content ?? [];
  const raw = blocks.map((c) => ('text' in c ? c.text : '')).join('').trim();
  // Strip leading/trailing quotes/punctuation and limit to ~50 chars.
  const cleaned = raw
    .replace(/^["'`*]+/, '')
    .replace(/["'`*.,!?]+$/, '')
    .replace(/\s+/g, ' ')
    .slice(0, 50);
  if (cleaned) _titles.set(sessionId, cleaned);
}
