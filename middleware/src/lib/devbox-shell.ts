// Interactive shell (PTY) access to a devbox, via InvokeAgentRuntimeCommandShell.
//
// This is the real terminal: a bidirectional WebSocket carrying raw terminal
// I/O, so colors, cursor control, Ctrl-C, resize and full-screen applications
// all work. The one-shot `InvokeAgentRuntimeCommand` path we use elsewhere is
// not a lesser version of this — it is the right tool for deterministic,
// scripted work (the job dispatcher, `git status`), and the AWS docs recommend
// it for exactly that. This is the other half.
//
// Two things are hand-rolled here, both deliberately:
//
//   1. The URL and the signature. `@aws-sdk/client-bedrock-agentcore` does not
//      expose this operation as of 3.1113.0. AWS does publish a TypeScript SDK
//      that does — `bedrock-agentcore` (aws/bedrock-agentcore-sdk-typescript) —
//      and the URL shape, the `X-Amzn-...-Session-Id` query parameter and the
//      SigV4 presigning below are all verified against its `client.ts`
//      (`connectShellPresigned`). We do not take the dependency: it
//      peer-depends on `@strands-agents/sdk`, a whole agent framework, which
//      conflicts with the OpenTelemetry versions this service pins — a large
//      graph to pull in for what amounts to signing a URL. If that peer
//      constraint relaxes, replace this file with the SDK call.
//   2. Query-string presigning rather than signed headers. The CLI signs
//      headers, which is fine from Node. A browser cannot set headers on a
//      WebSocket, so for the portal terminal the URL itself has to carry the
//      signature — this is the `PresignedAuth` mode the AWS docs describe.
//      The browser then holds the socket directly and terminal frames never
//      pass through this process, which matters at 250 frames/sec.

import { HttpRequest } from '@smithy/protocol-http';
import { SignatureV4 } from '@aws-sdk/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';
import { defaultProvider } from '@aws-sdk/credential-provider-node';

/**
 * Frame channels, kept for reference only — nothing server-side speaks frames.
 * The live implementation is the portal's DevboxTerminal, which holds the
 * socket. Documented here because this is where someone looks first.
 */
const SHELL_FRAME_REFERENCE = {
  /** client → server: raw keystrokes */
  STDIN: 0x00,
  /** server → client */
  STDOUT: 0x01,
  STDERR: 0x02,
  /** server → client: JSON — shellId confirmation, or termination */
  STATUS: 0x03,
  /** client → server: JSON {width, height} */
  RESIZE: 0x04,
  /** client → server: keepalive */
  HEARTBEAT: 0x05,
  /**
   * Permanent kill (SIGHUP → SIGKILL), NOT detach. The server echoes it back
   * and closes with 1000, and the shell cannot be reconnected to. To detach
   * and leave the shell running — the Ctrl-] behaviour — just drop the socket.
   */
  CLOSE: 0xff,
} as const;

/** A frame larger than this is rejected by the service (close code 1009). */
export const MAX_FRAME_BYTES = 65_536;
/** Ctrl-] — the CLI's detach key. Closes the socket, leaves the shell running. */
const DETACH_BYTE_REFERENCE = 0x1d;

/**
 * Presigned URLs are deliberately short-lived. It is a bearer credential for a
 * shell: anyone holding it gets a terminal in the microVM until it expires.
 */
const DEFAULT_EXPIRY_S = 120;

// Region is passed in rather than read from config. That keeps this module
// free of app wiring — it is pure URL construction and signing — and avoids
// dragging config.ts (and its import.meta usage, which the test transform
// rejects) into every suite that touches a devbox route.
function agentcoreHost(region: string): string {
  return `bedrock-agentcore.${region}.amazonaws.com`;
}

/**
 * Build the shell WebSocket URL.
 *
 * Shape taken from the agentcore CLI:
 *   wss://{host}/runtimes/{uri-encoded arn}/ws/shells?qualifier=DEFAULT[&shellId=…]
 *
 * The ARN is URI-encoded into a single path segment — its colons and slashes
 * must not be read as path separators.
 */
function buildShellUrl(
  runtimeArn: string,
  opts: { shellId: string; sessionId: string; region: string; qualifier?: string },
): URL {
  const url = new URL(`wss://${agentcoreHost(opts.region)}/runtimes/${encodeURIComponent(runtimeArn)}/ws/shells`);
  url.searchParams.set('qualifier', opts.qualifier ?? 'DEFAULT');
  url.searchParams.set('shellId', opts.shellId);
  // Without the session id the service opens a NEW runtime session per
  // connection, so the terminal would land in a fresh microVM instead of the
  // box you are looking at — and /mnt/workspace would appear empty.
  url.searchParams.set('X-Amzn-Bedrock-AgentCore-Runtime-Session-Id', opts.sessionId);
  return url;
}

/** Shell ids are 1–128 chars of alphanum, underscore or hyphen (RuntimeClientError 424 otherwise). */
export function isValidShellId(shellId: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(shellId);
}

/**
 * Presign the shell URL so a browser can open it directly.
 *
 * Signed as a GET against https — the WebSocket upgrade is an HTTP GET, and
 * SigV4 signs the underlying request, not the eventual socket.
 */
export async function presignShellUrl(
  runtimeArn: string,
  opts: { shellId: string; sessionId: string; region: string; expiresIn?: number },
): Promise<{ url: string; expiresIn: number; shellId: string }> {
  if (!isValidShellId(opts.shellId)) {
    throw new Error(`invalid shellId '${opts.shellId}' — 1-128 chars of [A-Za-z0-9_-]`);
  }
  const wsUrl = buildShellUrl(runtimeArn, {
    shellId: opts.shellId, sessionId: opts.sessionId, region: opts.region,
  });
  const query: Record<string, string> = {};
  wsUrl.searchParams.forEach((v, k) => { query[k] = v; });

  const request = new HttpRequest({
    method: 'GET',
    protocol: 'https:',
    hostname: wsUrl.hostname,
    path: wsUrl.pathname,
    query,
    headers: { host: wsUrl.hostname },
  });

  const signer = new SignatureV4({
    service: 'bedrock-agentcore',
    region: opts.region,
    credentials: defaultProvider(),
    sha256: Sha256,
  });

  const expiresIn = Math.min(Math.max(opts.expiresIn ?? DEFAULT_EXPIRY_S, 30), 900);
  const signed = await signer.presign(request, { expiresIn });

  const out = new URL(`wss://${signed.hostname}${signed.path}`);
  for (const [k, v] of Object.entries(signed.query ?? {})) {
    out.searchParams.set(k, Array.isArray(v) ? (v[0] ?? '') : String(v));
  }
  return { url: out.toString(), expiresIn, shellId: opts.shellId };
}
