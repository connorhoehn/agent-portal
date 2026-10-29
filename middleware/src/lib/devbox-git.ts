// Credentialed git in a devbox, with the token out of every shell string (DE-45).
//
// `InvokeAgentRuntimeCommand` (the shell API) takes only a command and a
// timeout, so a clone or push through it had nowhere to put a repository
// token except the command text: in `ps`, in the probe file the wrapper
// writes, in git's own `fatal: unable to access '<url>'` output, and readable
// by the Claude Code agent sharing the microVM. This module uses the other
// channel instead: the agent-invoke API (`InvokeAgentRuntime`) with a JSON
// payload `{ op, repo, target, token }` that agents/devbox/main.py's git
// entrypoint hands to git as an HTTP auth header through the CHILD's
// environment (GIT_CONFIG_* → `http.https://github.com/.extraheader`). Nothing
// touches argv, `.git/config` or disk, and the remote URL stays clean.
//
// The token comes from lib/repo-token-provider.ts (one repository, the
// permissions the op needs, an audit row per mint). Clone asks for
// `contents: read`; push for `contents: write` + `pull_requests: write`.
//
// Rollout switch: the entrypoint needs the rebuilt image, and a rebuild rolls
// the runtime (wiping /mnt/workspace). `DEVBOX_GIT_ENTRYPOINT=on|off` picks
// the path; the default is ON under MOCK_AGENTCORE (the fake microVM speaks
// it) and OFF against a real runtime, where the legacy shell clone
// (providers/agent-projects.ts buildCloneCommand) keeps working unchanged
// until the deploy machine turns it on (docs/github-app-tokens-runbook.md).

import {
  type BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand as InvokeRuntime,
} from '@aws-sdk/client-bedrock-agentcore';
import { mintAuditedRepoToken, assertRepoFullName, type RepoPermissions } from './repo-token-provider.js';
import { runDevboxShell } from './project-runner.js';
import { buildCloneCommand, checkoutPath, type AgentProject } from '../providers/agent-projects.js';

export type GitOpName = 'clone' | 'push';

export interface GitOp {
  op: GitOpName;
  /** owner/name */
  repo: string;
  /** Absolute path in the microVM (the checkout). */
  target: string;
  /** push: the branch to create/update. */
  branch?: string;
  /** push: branch from this commit. */
  commit?: string;
  /** clone: shallow depth (default 50, as the shell clone used). */
  depth?: number;
}

export interface GitOpResult {
  ok: boolean;
  exitCode: number | null;
  /** git's own output, with any URL credential scrubbed (belt and braces: git never saw one). */
  output: string;
  error?: string;
}

const SAFE_REF = /^[\w./-]{1,200}$/;
const SAFE_SHA = /^[0-9a-f]{7,40}$/;

/** The permissions an op needs, and no more. */
export function permissionsFor(op: GitOpName): RepoPermissions {
  return op === 'clone' ? { contents: 'read' } : { contents: 'write', pull_requests: 'write' };
}

/**
 * The invoke payload for one git op. The token is a FIELD of a JSON body the
 * entrypoint reads — never part of a command, an argv or a URL. Validates the
 * same things main.py validates so a bad op fails here, before a token is
 * minted for it.
 */
export function buildGitOpPayload(op: GitOp, token: string | null): Record<string, unknown> {
  assertRepoFullName(op.repo);
  if (!op.target.startsWith('/') || /[\n\r\0]/.test(op.target)) throw new Error('target must be an absolute path');
  if (op.op === 'push') {
    if (!op.branch || !SAFE_REF.test(op.branch)) throw new Error('branch is required for push');
    if (op.commit && !SAFE_SHA.test(op.commit)) throw new Error('commit must be a sha');
  }
  return {
    op: op.op,
    repo: op.repo,
    target: op.target,
    ...(op.branch ? { branch: op.branch } : {}),
    ...(op.commit ? { commit: op.commit } : {}),
    ...(op.op === 'clone' ? { depth: op.depth ?? 50 } : {}),
    ...(token ? { token } : {}),
  };
}

/** Whether git ops go through the image's entrypoint (see the header). */
export function gitEntrypointEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env['DEVBOX_GIT_ENTRYPOINT'] ?? '').trim().toLowerCase();
  if (v === 'on' || v === 'true' || v === '1') return true;
  if (v === 'off' || v === 'false' || v === '0') return false;
  return env['MOCK_AGENTCORE'] === 'true';
}

/** `https://user:token@host` → `https://***@host`, anywhere in the text. */
export function redactUrlCredentials(text: string): string {
  return text.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@'"]+@/gi, '$1***@');
}

/** Scrub a known token from text as well as URL credentials (git error output, thrown messages). */
function scrub(text: string, token: string | null): string {
  const t = token && token.length >= 8 ? text.split(token).join('***') : text;
  return redactUrlCredentials(t);
}

/**
 * Run one git op through the entrypoint and collect its result. The payload
 * goes in the invoke body and is never logged or teed anywhere; only git's
 * output comes back, scrubbed.
 */
export async function runDevboxGit(
  client: BedrockAgentCoreClient, arn: string, sessionId: string, op: GitOp, token: string | null,
): Promise<GitOpResult> {
  const payload = buildGitOpPayload(op, token);
  let output = '';
  let exitCode: number | null = null;
  let error: string | undefined;
  try {
    const resp = await client.send(new InvokeRuntime({
      agentRuntimeArn: arn,
      qualifier: 'DEFAULT',
      runtimeSessionId: sessionId,
      accept: 'text/event-stream',
      payload: new TextEncoder().encode(JSON.stringify(payload)),
    }));
    const stream = resp.response as AsyncIterable<Uint8Array> | undefined;
    if (!stream) return { ok: false, exitCode: null, output: '', error: 'empty response stream' };
    const decoder = new TextDecoder();
    let buffer = '';
    const take = (raw: string): void => {
      let line = raw.trim();
      if (line.startsWith('data:')) line = line.slice(5).trim();
      if (line.startsWith('"')) {
        try { const inner: unknown = JSON.parse(line); if (typeof inner === 'string') line = inner.trim(); } catch { /* skipped */ }
      }
      if (!line.startsWith('{')) return;
      let ev: Record<string, unknown>;
      try { ev = JSON.parse(line) as Record<string, unknown>; } catch { return; }
      if (ev['type'] === 'git_output' && typeof ev['text'] === 'string') output += ev['text'];
      else if (ev['type'] === 'git_end') {
        exitCode = Number.isFinite(Number(ev['exit_code'])) ? Number(ev['exit_code']) : null;
        if (typeof ev['error'] === 'string') error = ev['error'];
      } else if (typeof ev['error'] === 'string') {
        // An image without the entrypoint answers the git payload as a task
        // with no prompt: `{"error": "missing prompt"}`.
        error = ev['error'] === 'missing prompt'
          ? 'the devbox image has no git entrypoint yet — rebuild it, or set DEVBOX_GIT_ENTRYPOINT=off'
          : ev['error'];
      }
    };
    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) { take(buffer.slice(0, idx)); buffer = buffer.slice(idx + 1); }
    }
    if (buffer.trim()) take(buffer);
  } catch (err) {
    return { ok: false, exitCode: null, output: scrub(output, token), error: scrub((err as Error).message, token) };
  }
  return {
    ok: exitCode === 0 && !error,
    exitCode,
    output: scrub(output, token).slice(-8000),
    ...(error ? { error: scrub(error, token) } : {}),
  };
}

/** The clone's own failure markers (same set the bot runner's workspace clone uses). */
export const CLONE_FAILURE = /fatal: (?!detected dubious ownership)|repository not found|authentication failed|could not read username|could not resolve host|permission denied/i;

export interface CloneOutcome {
  ok: boolean;
  output: string;
  /** What ran, safe to show: `git clone --depth 50 https://github.com/o/r.git <target>`. */
  redacted: string;
  checkout: string;
  via: 'entrypoint' | 'shell';
  error?: string;
}

/**
 * Put a codebase in a box. The one function both clone callers use (the
 * clone route and lib/bot-runner.ts ensureWorkspace). Entrypoint path: mint a per-run read token (only for a repo
 * with a connection — a public repo carries no credential at all), run the
 * clone through the payload channel. Shell path: the legacy command, unchanged.
 */
export async function cloneIntoBox(opts: {
  client: BedrockAgentCoreClient;
  arn: string;
  sessionId: string;
  project: AgentProject;
  runRef: string;
  callerSub: string | null;
  /** Injectable for tests; defaults to gitEntrypointEnabled(). */
  useEntrypoint?: boolean;
}): Promise<CloneOutcome> {
  const project = opts.project;
  const target = checkoutPath(project);
  const redacted = `git clone --depth 50 https://github.com/${opts.project.repoFullName}.git ${target}`;
  const entry = opts.useEntrypoint ?? gitEntrypointEnabled();

  if (entry) {
    let token: string | null = null;
    if (opts.project.connectionName) {
      try {
        token = (await mintAuditedRepoToken(opts.project.repoFullName, permissionsFor('clone'), {
          runRef: opts.runRef, callerSub: opts.callerSub, connectionName: opts.project.connectionName,
        })).token;
      } catch (err) {
        return { ok: false, output: '', redacted, checkout: target, via: 'entrypoint', error: scrub((err as Error).message, null) };
      }
    }
    const r = await runDevboxGit(opts.client, opts.arn, opts.sessionId, { op: 'clone', repo: opts.project.repoFullName, target }, token);
    token = null;
    const ok = r.ok && !CLONE_FAILURE.test(r.output);
    return { ok, output: r.output.slice(-4000), redacted, checkout: target, via: 'entrypoint', ...(r.error ? { error: r.error } : {}) };
  }

  const { command } = await buildCloneCommand(project);
  try {
    const output = redactUrlCredentials(await runDevboxShell(opts.client, opts.arn, opts.sessionId, command));
    return { ok: !CLONE_FAILURE.test(output), output: output.slice(-4000), redacted, checkout: target, via: 'shell' };
  } catch (err) {
    return { ok: false, output: '', redacted, checkout: target, via: 'shell', error: `clone failed: ${redactUrlCredentials((err as Error).message)}` };
  }
}

/**
 * Push a branch from a box with a per-run write token (delivery).
 * lib/change-delivery.ts uses it when gitEntrypointEnabled(), and keeps the
 * env-prefixed shell script otherwise.
 */
export async function pushFromBox(opts: {
  client: BedrockAgentCoreClient;
  arn: string;
  sessionId: string;
  repo: string;
  target: string;
  branch: string;
  commit?: string;
  runRef: string;
  callerSub: string | null;
  connectionName: string | null;
}): Promise<GitOpResult> {
  const minted = await mintAuditedRepoToken(opts.repo, permissionsFor('push'), {
    runRef: opts.runRef, callerSub: opts.callerSub, connectionName: opts.connectionName,
  });
  return runDevboxGit(opts.client, opts.arn, opts.sessionId, {
    op: 'push', repo: opts.repo, target: opts.target, branch: opts.branch, ...(opts.commit ? { commit: opts.commit } : {}),
  }, minted.token);
}
