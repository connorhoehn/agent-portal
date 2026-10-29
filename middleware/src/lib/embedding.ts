// Bedrock Titan Text Embeddings V2 wrapper for the observability data plane.
//
// AWS-native only — we use `amazon.titan-embed-text-v2:0` at 1024 dimensions
// to match the `vector(1024)` column in observability.invocation_traces and the
// org-graph `node_embeddings` table. Both must agree on the dimensionality.
//
// All calls are best-effort: any failure (throttle, model error, bad payload)
// returns `null` so the trace-sink can drop the embedding without blocking
// the agent invocation path.

import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { recordBffCall } from '../providers/spend-ledger.js';
import { config } from '../config.js';

export const TITAN_V2_MODEL_ID = 'amazon.titan-embed-text-v2:0';
export const EMBEDDING_DIMENSIONS = 1024;

let _client: BedrockRuntimeClient | null = null;
function client(): BedrockRuntimeClient {
  if (!_client) _client = new BedrockRuntimeClient({ region: config.region });
  return _client;
}

/**
 * Embed a single piece of text with Titan V2 at 1024 dimensions.
 *
 * Returns `null` on any error. Caller is expected to log and continue —
 * embedding failures must never propagate to the agent invocation path.
 */
export async function embedText(text: string): Promise<number[] | null> {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return null;

  try {
    const body = JSON.stringify({
      inputText: trimmed,
      dimensions: EMBEDDING_DIMENSIONS,
      normalize: true,
    });

    const resp = await client().send(
      new InvokeModelCommand({
        modelId: TITAN_V2_MODEL_ID,
        contentType: 'application/json',
        accept: 'application/json',
        body,
      }),
    );

    const decoded = new TextDecoder().decode(resp.body);
    const parsed = JSON.parse(decoded) as { embedding?: unknown; inputTextTokenCount?: unknown };
    if (typeof parsed.inputTextTokenCount === 'number') {
      void recordBffCall({ feature: 'embedding', model: TITAN_V2_MODEL_ID, usage: { inputTokens: parsed.inputTextTokenCount, outputTokens: 0 } });
    }
    const arr = parsed.embedding;
    if (!Array.isArray(arr) || arr.length !== EMBEDDING_DIMENSIONS) return null;
    // Ensure all entries are finite numbers — defensive against partial responses.
    const out = new Array<number>(EMBEDDING_DIMENSIONS);
    for (let i = 0; i < EMBEDDING_DIMENSIONS; i++) {
      const v = arr[i];
      if (typeof v !== 'number' || !Number.isFinite(v)) return null;
      out[i] = v;
    }
    return out;
  } catch (err) {
    console.warn('[embedding] titan v2 invoke failed:', (err as Error).message);
    return null;
  }
}

/**
 * Convert a 1024-dim embedding into the pgvector text literal `[v1,v2,...]`.
 * RDS Data API has no native array binding for vectors, so we send the value
 * as a string and cast on the server with `::vector`.
 */
export function toPgVectorLiteral(vec: number[]): string {
  // pgvector parses this exact textual form.
  return `[${vec.map((v) => (Number.isFinite(v) ? v.toString() : '0')).join(',')}]`;
}

/**
 * Cosine distance in [0, 2]. `0` = identical, `1` = orthogonal, `2` = opposite.
 * The drift score we publish is the distance to a rolling centroid.
 */
export function cosineDistance(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 1;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 1;
  const sim = dot / denom;
  // Numerical drift can push sim slightly outside [-1, 1].
  const clamped = sim > 1 ? 1 : sim < -1 ? -1 : sim;
  return 1 - clamped;
}
