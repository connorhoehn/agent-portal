// The microVM runner's transport (docs/microvm-runner-design.md §3).
//
// Three InvokeAgentRuntime calls on ONE runtime session — boot, task, push —
// and the S3 presigner for the transcript. Kept apart from lib/devbox-runner.ts
// on purpose: the fleet's payload contract (prompt/resume/lab) and the
// runner's (op/runner/…, agents/devbox/main.py `_mvm_*`) are different
// contracts, and the fleet path must stay byte-for-byte what it was.
//
// The stream framing is the fleet's (`data:` prefixes, double-encoded JSON
// strings, one event per line), read the same way.

import { InvokeAgentRuntimeCommand, type BedrockAgentCoreClient } from '@aws-sdk/client-bedrock-agentcore';
import { HttpRequest } from '@smithy/protocol-http';
import { SignatureV4 } from '@aws-sdk/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';
import type { AwsCredentialIdentity, Provider } from '@aws-sdk/types';

/** The parts of the AgentCore client the runner uses (so tests hand in a fake). */
export type AgentCoreSend = Pick<BedrockAgentCoreClient, 'send'>;

function unwrapLine(raw: string): Record<string, unknown> | null {
  let line = raw.trim();
  if (line.startsWith('data:')) line = line.slice(5).trim();
  if (line.startsWith('"')) {
    try {
      const inner: unknown = JSON.parse(line);
      if (typeof inner === 'string') line = inner.trim();
    } catch { /* not JSON */ }
  }
  if (!line.startsWith('{')) return null;
  try {
    const v: unknown = JSON.parse(line);
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
  } catch { return null; }
}

async function send(client: AgentCoreSend, runtimeArn: string, sessionId: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<AsyncIterable<Uint8Array> | null> {
  const resp = await client.send(new InvokeAgentRuntimeCommand({
    agentRuntimeArn: runtimeArn,
    qualifier: 'DEFAULT',
    runtimeSessionId: sessionId,
    accept: 'text/event-stream, application/json',
    payload: new TextEncoder().encode(JSON.stringify(payload)),
  }), ...(signal ? [{ abortSignal: signal }] : []));
  return (resp.response as AsyncIterable<Uint8Array> | undefined) ?? null;
}

/**
 * An op that answers one JSON object (boot, push). The whole body is read and
 * parsed; an SSE-framed body yields its last object. Throws on an empty or
 * unparseable answer — a step that cannot be read did not succeed.
 */
export async function invokeMicrovmJson(
  client: AgentCoreSend, runtimeArn: string, sessionId: string, payload: Record<string, unknown>, signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const stream = await send(client, runtimeArn, sessionId, payload, signal);
  if (!stream) throw new Error('empty response stream');
  const decoder = new TextDecoder();
  let body = '';
  for await (const chunk of stream) body += decoder.decode(chunk, { stream: true });
  body += decoder.decode();
  const whole = unwrapLine(body.replace(/\n/g, ' '));
  if (whole) return whole;
  let last: Record<string, unknown> | null = null;
  for (const line of body.split('\n')) last = unwrapLine(line) ?? last;
  if (!last) throw new Error('unreadable response');
  return last;
}

/**
 * The task op: every event as it arrives. A refusal (`{agent:'devbox', error}`,
 * main.py `_mvm_task`) arrives as a single object and is yielded like any
 * other event; the caller decides.
 */
export async function* invokeMicrovmStream(
  client: AgentCoreSend, runtimeArn: string, sessionId: string, payload: Record<string, unknown>, signal?: AbortSignal,
): AsyncGenerator<Record<string, unknown>> {
  const stream = await send(client, runtimeArn, sessionId, payload, signal);
  if (!stream) throw new Error('empty response stream');
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of stream) {
    signal?.throwIfAborted();
    buffer += decoder.decode(chunk, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const ev = unwrapLine(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 1);
      if (ev) yield ev;
    }
  }
  buffer += decoder.decode();
  const tail = unwrapLine(buffer);
  if (tail) yield tail;
}

// ─── Presigned transcript URLs (§8, §9) ───────────────────────────────────────

export const TRANSCRIPT_CONTENT_TYPE = 'application/x-ndjson';
/** 15 minutes: the PUT happens once, right after `claude` exits. */
export const PRESIGN_EXPIRES_S = 900;

export interface PresignInput {
  bucket: string;
  key: string;
  method: 'PUT' | 'GET';
  region: string;
  expiresIn?: number;
  credentials?: AwsCredentialIdentity | Provider<AwsCredentialIdentity>;
}

/**
 * A SigV4 query-string presigned S3 URL. The PUT signs `content-type`, so the
 * box's upload must send exactly `application/x-ndjson` (main.py
 * `_put_transcript` does). Virtual-hosted style; the key must be under `runs/`
 * (the BFF role's grant, infra/lib/middleware-service-stack.ts).
 */
export async function presignS3(input: PresignInput): Promise<string> {
  if (!input.key.startsWith('runs/') || input.key.includes('..')) throw new Error('transcript keys live under runs/');
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(input.bucket)) throw new Error('not an S3 bucket name');
  const hostname = `${input.bucket}.s3.${input.region}.amazonaws.com`;
  const path = '/' + input.key.split('/').map(encodeURIComponent).join('/');
  const headers: Record<string, string> = { host: hostname, 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' };
  if (input.method === 'PUT') headers['content-type'] = TRANSCRIPT_CONTENT_TYPE;
  const request = new HttpRequest({ method: input.method, protocol: 'https:', hostname, path, headers });
  const credentials = input.credentials ?? (await import('@aws-sdk/credential-provider-node')).defaultProvider();
  const signer = new SignatureV4({ service: 's3', region: input.region, credentials, sha256: Sha256, uriEscapePath: false, applyChecksum: false });
  const expiresIn = Math.min(Math.max(input.expiresIn ?? PRESIGN_EXPIRES_S, 60), PRESIGN_EXPIRES_S);
  const signed = await signer.presign(request, { expiresIn, unhoistableHeaders: new Set(['content-type']) });
  const url = new URL(`https://${signed.hostname}${signed.path}`);
  for (const [k, v] of Object.entries(signed.query ?? {})) url.searchParams.set(k, Array.isArray(v) ? (v[0] ?? '') : String(v));
  return url.toString();
}
