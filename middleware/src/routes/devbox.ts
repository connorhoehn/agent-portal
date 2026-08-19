// Devbox routes — API surface over the orgiq-devbox runtime (Claude Code in
// an AgentCore Runtime microVM). Shaped for a future portal page; today it is
// exercised by tests and curl only. No portal UI ships with this module.
//
//   POST   /api/devbox/sessions              mint a compliant runtime session id
//   POST   /api/devbox/:sessionId/task       Claude Code headless run (SSE)
//   POST   /api/devbox/:sessionId/command    allowlisted read-only shell (SSE)
//   DELETE /api/devbox/:sessionId            stop the runtime session
//   GET    /api/devbox/status                resolved runtime ARN + config
//
// ⚠️ SDK NAMING TRAP — read before editing the imports:
// The class `InvokeAgentRuntimeCommand` used elsewhere in this codebase is the
// SDK v3 wrapper for the plain InvokeAgentRuntime *operation* (every operation
// `Foo` becomes a class `FooCommand`). The command-execution API used here is
// a *different operation* literally named `InvokeAgentRuntimeCommand`, whose
// class is therefore `InvokeAgentRuntimeCommandCommand` — aliased below as
// `RunRuntimeCommand` so the two can never be confused at a call site.

import { Router } from 'express';
import type { Response } from 'express';
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand as InvokeRuntime,
  InvokeAgentRuntimeCommandCommand as RunRuntimeCommand,
  StopRuntimeSessionCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import {
  BedrockAgentCoreControlClient,
  GetAgentRuntimeCommand,
  ListAgentRuntimesCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';

import { asyncHandler } from '../lib/async-handler.js';
import { initSSE, writeSSE, endSSE } from '../lib/sse.js';
import {
  normalizeRuntimeSessionId,
  RUNTIME_SESSION_ID_MIN_LENGTH,
} from '../lib/runtime-session.js';
import { executeDevboxTask, type DevboxRunOutcome } from '../lib/devbox-runner.js';
import {
  registerBox,
  listBoxes,
  getBox,
  getBoxBySession,
  renameBox,
  markStopped,
  removeBox,
  replayEvents,
  subscribe as subscribeFleet,
  appendEvent,
} from '../lib/devbox-fleet.js';
import { presignShellUrl, isValidShellId, MAX_FRAME_BYTES } from '../lib/devbox-shell.js';

export const devboxRouter = Router();

// ─── Clients (lazy; overridable for tests via _internal) ─────────────────────

let _data: BedrockAgentCoreClient | null = null;
let _control: BedrockAgentCoreControlClient | null = null;

// Env-read directly (not via config.ts) so this module stays importable under
// the CJS jest config — config.ts uses import.meta. Same convention as
// gateway-proxy.ts.
const region = (): string => process.env['AWS_REGION'] ?? 'us-east-1';

function dataClient(): BedrockAgentCoreClient {
  if (!_data) _data = new BedrockAgentCoreClient({ region: region() });
  return _data;
}
function controlClient(): BedrockAgentCoreControlClient {
  if (!_control) _control = new BedrockAgentCoreControlClient({ region: region() });
  return _control;
}

// ─── Runtime ARN resolution ──────────────────────────────────────────────────
// DEVBOX_RUNTIME_ARN env wins (set by the middleware service stack from the
// `orgiq-devbox-runtime-arn` CFN export); otherwise resolve by runtime name
// via the control plane, cached.

const DEVBOX_RUNTIME_NAME = `${(process.env['PROJECT_PREFIX'] ?? 'orgiq')}_devbox`;
let _arnCache: { ts: number; arn: string | null } | null = null;
const ARN_CACHE_TTL_MS = 60_000;

async function resolveDevboxArn(): Promise<string | null> {
  const fromEnv = process.env['DEVBOX_RUNTIME_ARN'];
  if (fromEnv) return fromEnv;

  const now = Date.now();
  if (_arnCache && now - _arnCache.ts < ARN_CACHE_TTL_MS) return _arnCache.arn;

  try {
    let nextToken: string | undefined = undefined;
    do {
      const resp: import('@aws-sdk/client-bedrock-agentcore-control').ListAgentRuntimesCommandOutput =
        await controlClient().send(new ListAgentRuntimesCommand({ maxResults: 50, nextToken }));
      for (const rt of resp.agentRuntimes ?? []) {
        if (rt.agentRuntimeName === DEVBOX_RUNTIME_NAME && rt.agentRuntimeArn) {
          _arnCache = { ts: now, arn: rt.agentRuntimeArn };
          return rt.agentRuntimeArn;
        }
      }
      nextToken = resp.nextToken;
    } while (nextToken);
  } catch (err) {
    console.warn('[devbox] runtime ARN lookup failed:', (err as Error).message);
  }
  _arnCache = { ts: now, arn: null };
  return null;
}

// ─── Command execution modes ─────────────────────────────────────────────────
//
// Two modes, and the distinction is about accidents rather than authorization.
//
//   safe (default) — read-only inspection commands, matched by prefix, with
//                    shell metacharacters rejected. What you want when poking
//                    at a box you do not own.
//   full           — arbitrary shell. Explicitly opted into per request.
//
// `full` does NOT widen the blast radius. Every route in this file already
// sits behind Cedar's ManageDevbox, and the same principal can POST /task to
// have Claude Code run whatever it likes in the same container. So restricting
// the deterministic path never prevented anything — it only made the cheap,
// predictable way to run a command useless, and pushed people onto a slower,
// costlier, non-deterministic one to do things as ordinary as `grep`. The
// allowlist survives as a sane default, not as a security boundary.
//
// Deployments that genuinely want the capability gone can set
// DEVBOX_FULL_EXEC_DISABLED=1, which refuses full mode outright.

export type ExecMode = 'safe' | 'full';

const DEFAULT_ALLOWLIST = [
  'ls', 'cat ', 'head ', 'tail ', 'wc ', 'stat ', 'pwd', 'whoami',
  'df', 'du', 'uname',
  'git status', 'git log', 'git diff', 'git show', 'git branch',
  'pytest', 'python -m pytest',
  'node --version', 'python --version', 'claude --version',
];

function commandAllowlist(): string[] {
  const raw = process.env['DEVBOX_COMMAND_ALLOWLIST'];
  if (!raw) return DEFAULT_ALLOWLIST;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

export function fullExecEnabled(): boolean {
  return process.env['DEVBOX_FULL_EXEC_DISABLED'] !== '1';
}

// Safe mode only. In full mode the command never touches a shell as text — it
// is base64-encoded and decoded inside the container — so there is nothing for
// a metacharacter to escape.
const SHELL_META = /[;&|`$<>\\'"\n\r]/;

export function validateCommand(command: string, mode: ExecMode = 'safe'): string | null {
  if (!command || command.length > 4000) return 'command must be 1–4000 characters';
  if (mode === 'full') {
    if (!fullExecEnabled()) return 'full shell mode is disabled on this deployment (DEVBOX_FULL_EXEC_DISABLED=1)';
    return null;
  }
  if (SHELL_META.test(command)) {
    return 'shell metacharacters are not allowed in safe mode — switch to full shell to use pipes, quotes or redirection';
  }
  const allowed = commandAllowlist().some(
    (prefix) => command === prefix.trim() || command.startsWith(prefix),
  );
  if (!allowed) {
    return `not an allowlisted read-only command — switch to full shell to run it (allowed prefixes: ${commandAllowlist().join(', ')})`;
  }
  return null;
}

/** Marks the trailing line that reports the shell's final working directory. */
export const CWD_MARKER = '__ORGIQ_CWD__:';

/**
 * Build the container-side command.
 *
 * The user's text is base64-encoded and decoded inside the container, so
 * quoting is a non-problem: no amount of quotes, newlines or metacharacters in
 * the input can break out of the wrapper, because the input is never
 * interpolated into shell source. The decoded script is then SOURCED rather
 * than run as a child, which is what lets `cd` persist — the terminal reports
 * the resulting directory back so the next command starts where this one
 * finished.
 *
 * The exit code of the user's command is preserved: the marker is printed
 * after capturing $?, and the wrapper exits with the original status.
 */
export function buildContainerCommand(command: string, cwd: string): string {
  const b64 = Buffer.from(command, 'utf8').toString('base64');
  // cwd is validated by the caller; it is passed as an argument to sh rather
  // than spliced into the script text.
  // Every quote below is a DOUBLE quote on purpose: the whole script is
  // wrapped in single quotes when handed to `sh -c`, so a single quote here
  // would terminate the wrapper early.
  const script = [
    'export HOME=/mnt/workspace',
    'export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0=/mnt/workspace',
    'cd "$1" 2>/dev/null || cd /mnt/workspace',
    `echo ${b64} | base64 -d > /tmp/.orgiq-cmd`,
    // stdin from /dev/null so a command that waits on input (a bare `cat`, an
    // interactive prompt) returns immediately instead of hanging the terminal
    // until the runtime timeout — that failure mode has bitten this console
    // before, and arbitrary commands make it far easier to hit.
    '. /tmp/.orgiq-cmd < /dev/null',
    'rc=$?',
    `printf "\\n${CWD_MARKER}%s\\n" "$(pwd)"`,
    'exit $rc',
  ].join('; ');
  return `sh -c '${script}' orgiq ${shellQuote(cwd)}`;
}

/** Single-quote for the one value we do interpolate: the working directory. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Reject a cwd that could not have come from our own marker. */
export function validateCwd(cwd: string): string | null {
  if (!cwd) return null;
  if (cwd.length > 400) return 'working directory is too long';
  if (/[\n\r\0]/.test(cwd)) return 'working directory contains a control character';
  if (!cwd.startsWith('/')) return 'working directory must be absolute';
  return null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function requireSessionId(raw: string, res: Response): string | null {
  if (raw.length < RUNTIME_SESSION_ID_MIN_LENGTH) {
    res.status(400).json({
      error: `sessionId must be ≥ ${RUNTIME_SESSION_ID_MIN_LENGTH} characters (AgentCore Runtime constraint) — mint one via POST /api/devbox/sessions`,
    });
    return null;
  }
  return raw;
}

async function requireArn(res: Response): Promise<string | null> {
  const arn = await resolveDevboxArn();
  if (!arn) {
    res.status(503).json({
      error: 'devbox runtime not deployed — run agents/devbox/build.sh then deploy OrgIQ-Devbox with --context deployDevbox=true',
    });
    return null;
  }
  return arn;
}

// ─── Routes ──────────────────────────────────────────────────────────────────

/**
 * What the DEPLOYED runtime can actually do.
 *
 * Per-task model selection needs the container to understand a `model` field.
 * Reporting the capability from the deployed runtime's own environment — not
 * from what this middleware happens to support — is what stops the portal
 * offering a model picker that silently does nothing because the image
 * predates it. DEVBOX_ALLOWED_MODELS is the marker: it ships with the same
 * change that taught main.py to honour --model.
 */
async function deployedModelCapability(arn: string | null): Promise<{
  defaultModel: string | null; allowedModels: string[]; perTaskModel: boolean;
}> {
  if (!arn) return { defaultModel: null, allowedModels: [], perTaskModel: false };
  try {
    const out = await controlClient().send(new GetAgentRuntimeCommand({
      agentRuntimeId: arn.split('/').pop() ?? '',
    }));
    const env = (out as { environmentVariables?: Record<string, string> }).environmentVariables ?? {};
    const allowed = (env['DEVBOX_ALLOWED_MODELS'] ?? '').split(',').map((m) => m.trim()).filter(Boolean);
    return {
      defaultModel: env['ANTHROPIC_MODEL'] ?? null,
      allowedModels: allowed,
      perTaskModel: allowed.length > 0,
    };
  } catch (err) {
    // Not fatal — the page still works, it just cannot promise model switching.
    // Logged rather than swallowed: the way this fails in practice is a stale
    // DEVBOX_RUNTIME_ARN pinning the service to a runtime that no longer
    // exists, and a silent empty result makes that look like "the image is
    // too old" instead of "you are pointed at the wrong box".
    console.warn('[devbox] could not read runtime capability:', (err as Error).message);
    return { defaultModel: null, allowedModels: [], perTaskModel: false };
  }
}

devboxRouter.get('/status', asyncHandler(async (_req, res) => {
  const arn = await resolveDevboxArn();
  const models = await deployedModelCapability(arn);
  res.json({
    ...models,
    deployed: Boolean(arn),
    runtimeArn: arn,
    runtimeName: DEVBOX_RUNTIME_NAME,
    commandAllowlist: commandAllowlist(),
    fullExecEnabled: fullExecEnabled(),
    workspace: '/mnt/workspace',
  });
}));

devboxRouter.post('/sessions', asyncHandler(async (req, res) => {
  const requested = (req.body as { sessionId?: string } | undefined)?.sessionId;
  const sessionId = normalizeRuntimeSessionId(requested);
  res.status(201).json({ sessionId });
}));

// ─── Fleet registry — server-side source of truth for the herd ───────────────
// Registered BEFORE the /:sessionId routes so /boxes never matches as a
// sessionId. Boxes carry live status (idle/running/waiting/stopped/error)
// derived from the task-event tee below, and any client can tail any box.

devboxRouter.get('/boxes', asyncHandler(async (_req, res) => {
  res.json({ boxes: listBoxes() });
}));

devboxRouter.post('/boxes', asyncHandler(async (req, res) => {
  const body = (req.body ?? {}) as { label?: string; sessionId?: string; createdAt?: string };
  const sessionId = normalizeRuntimeSessionId(body.sessionId);
  const box = registerBox({
    sessionId,
    ...(body.label ? { label: body.label } : {}),
    ...(body.createdAt ? { createdAt: body.createdAt } : {}),
  });
  res.status(201).json(box);
}));

devboxRouter.patch('/boxes/:boxId', asyncHandler(async (req, res) => {
  const label = String((req.body as { label?: string } | undefined)?.label ?? '').trim();
  if (!label) { res.status(400).json({ error: 'label is required' }); return; }
  const box = renameBox(String(req.params['boxId'] ?? ''), label);
  if (!box) { res.status(404).json({ error: 'box not found' }); return; }
  res.json(box);
}));

devboxRouter.delete('/boxes/:boxId', asyncHandler(async (req, res) => {
  const boxId = String(req.params['boxId'] ?? '');
  const box = getBox(boxId);
  if (!box) { res.status(404).json({ error: 'box not found' }); return; }
  // Best-effort session stop — the workspace persists server-side regardless.
  const arn = await resolveDevboxArn();
  if (arn) {
    try {
      await dataClient().send(new StopRuntimeSessionCommand({
        agentRuntimeArn: arn,
        runtimeSessionId: box.sessionId,
      }));
    } catch (err) {
      console.warn('[devbox] stop on remove failed:', (err as Error).message);
    }
  }
  markStopped(boxId);
  removeBox(boxId);
  res.json({ removed: true, boxId });
}));

// Read-only live tail: replay the box's event buffer, then stream new events
// as they land. This is what lets a second browser (or an operator who
// reloaded) watch a run some other actor started.
devboxRouter.get('/boxes/:boxId/tail', (req, res) => {
  const boxId = String(req.params['boxId'] ?? '');
  if (!getBox(boxId)) { res.status(404).json({ error: 'box not found' }); return; }
  initSSE(res);
  for (const ev of replayEvents(boxId)) writeSSE(res, ev);
  const unsubscribe = subscribeFleet(boxId, (ev) => writeSSE(res, ev));
  req.on('close', () => { unsubscribe(); endSSE(res); });
});

// Task mode: Claude Code headless run in /mnt/workspace, stream-json events
// forwarded as SSE. The devbox wrapper emits devbox_start/devbox_end envelope
// events around Claude Code's own stream.
devboxRouter.post('/:sessionId/task', asyncHandler(async (req, res) => {
  const sessionId = requireSessionId(String(req.params['sessionId'] ?? ''), res);
  if (!sessionId) return;
  const arn = await requireArn(res);
  if (!arn) return;

  const body = (req.body ?? {}) as { prompt?: string; resume?: boolean; timeout?: number; model?: string };
  const prompt = (body.prompt ?? '').trim();
  if (!prompt) { res.status(400).json({ error: 'prompt is required' }); return; }

  const payload = JSON.stringify({
    prompt,
    resume: Boolean(body.resume),
    ...(body.model ? { model: body.model } : {}),
    ...(body.timeout ? { timeout: Math.min(Number(body.timeout), 3300) } : {}),
  });

  // Fleet tee: auto-register unknown sessions (curl/notebook starts show up in
  // the herd too), flip status to running, and mirror every event into the
  // box's server-side log so other clients can tail this run.
  const fleetBox = getBoxBySession(sessionId) ?? registerBox({ sessionId });
  appendEvent(fleetBox.id, { type: 'task_started', prompt, ts: new Date().toISOString() });

  const resp = await dataClient().send(new InvokeRuntime({
    agentRuntimeArn: arn,
    qualifier: 'DEFAULT',
    runtimeSessionId: sessionId,
    accept: 'text/event-stream',
    payload: new TextEncoder().encode(payload),
  }));

  initSSE(res);
  try {
    const stream = resp.response as AsyncIterable<Uint8Array> | undefined;
    if (!stream) { writeSSE(res, { type: 'devbox_error', error: 'empty response stream' }); return; }

    // Forward the wrapper's SSE lines: re-frame each JSON event line as our
    // own data frame so consumers see one clean SSE stream regardless of how
    // the upstream body was chunked.
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        let line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line.startsWith('data:')) line = line.slice(5).trim();
        // Unwrap double-encoded frames (`data: "{\"type\"..."`) — produced
        // when a wrapper yields pre-serialised strings instead of dicts.
        if (line.startsWith('"')) {
          try {
            const inner: unknown = JSON.parse(line);
            if (typeof inner === 'string') line = inner.trim();
          } catch { /* fall through — not valid JSON, skip below */ }
        }
        if (!line.startsWith('{')) continue;
        if (!res.writableEnded) res.write(`data: ${line}\n\n`);
        try { appendEvent(fleetBox.id, JSON.parse(line) as Record<string, unknown>); } catch { /* malformed frame — forwarded raw above, skip tee */ }
      }
    }
  } catch (err) {
    writeSSE(res, { type: 'devbox_error', error: (err as Error).message });
    appendEvent(fleetBox.id, { type: 'devbox_error', error: (err as Error).message });
  } finally {
    endSSE(res);
  }
}));

// Command mode: deterministic shell via the InvokeAgentRuntimeCommand
// operation — no LLM in the loop. Allowlisted + metacharacter-banned; the cwd
// prefix below is composed server-side AFTER validation.
devboxRouter.post('/:sessionId/command', asyncHandler(async (req, res) => {
  const sessionId = requireSessionId(String(req.params['sessionId'] ?? ''), res);
  if (!sessionId) return;

  const body = (req.body ?? {}) as { command?: string; mode?: string; cwd?: string };
  const command = String(body.command ?? '').trim();
  const mode: ExecMode = body.mode === 'full' ? 'full' : 'safe';
  const cwd = String(body.cwd ?? '/mnt/workspace').trim() || '/mnt/workspace';

  const cwdError = validateCwd(cwd);
  if (cwdError) { res.status(400).json({ error: cwdError }); return; }
  const validationError = validateCommand(command, mode);
  if (validationError) { res.status(400).json({ error: validationError, mode }); return; }

  const arn = await requireArn(res);
  if (!arn) return;

  const resp = await dataClient().send(new RunRuntimeCommand({
    agentRuntimeArn: arn,
    runtimeSessionId: sessionId,
    body: {
      command: buildContainerCommand(command, cwd),
      timeout: Number(process.env['DEVBOX_COMMAND_TIMEOUT_S'] ?? 120),
    },
  }));

  initSSE(res);
  // The marker can be split across stream chunks, so buffer stdout until a
  // newline before deciding whether a line is output or the cwd report.
  let pending = '';
  const flush = (final: boolean): void => {
    for (;;) {
      const nl = pending.indexOf('\n');
      if (nl < 0) break;
      const line = pending.slice(0, nl);
      pending = pending.slice(nl + 1);
      if (line.startsWith(CWD_MARKER)) writeSSE(res, { type: 'cwd', cwd: line.slice(CWD_MARKER.length) });
      else writeSSE(res, { type: 'stdout', text: `${line}\n` });
    }
    if (final && pending) {
      if (pending.startsWith(CWD_MARKER)) writeSSE(res, { type: 'cwd', cwd: pending.slice(CWD_MARKER.length) });
      else writeSSE(res, { type: 'stdout', text: pending });
      pending = '';
    }
  };

  try {
    for await (const event of resp.stream ?? []) {
      const chunk = (event as { chunk?: Record<string, unknown> }).chunk;
      if (!chunk) continue;
      const delta = chunk['contentDelta'] as { stdout?: string; stderr?: string } | undefined;
      if (delta?.stdout) { pending += delta.stdout; flush(false); }
      if (delta?.stderr) writeSSE(res, { type: 'stderr', text: delta.stderr });
      const stop = chunk['contentStop'] as { exitCode?: number; status?: string } | undefined;
      if (stop) { flush(true); writeSSE(res, { type: 'exit', exitCode: stop.exitCode, status: stop.status }); }
    }
    flush(true);
  } catch (err) {
    writeSSE(res, { type: 'devbox_error', error: (err as Error).message });
  } finally {
    endSSE(res);
  }
}));

/**
 * Mint a short-lived presigned WebSocket URL for an interactive terminal.
 *
 * The browser opens the socket itself with this URL — terminal frames never
 * pass through here, which is what keeps a 250 frames/sec stream off the
 * Node event loop. The URL is a bearer credential for a shell inside the
 * microVM, so it is deliberately short-lived and never logged.
 *
 * `shellId` is the reattachment handle: pass the same one back to land in the
 * same PTY with its working directory, environment and running processes
 * intact, and up to 256 KB of missed output replayed.
 */
devboxRouter.post('/:sessionId/shell-url', asyncHandler(async (req, res) => {
  const sessionId = requireSessionId(String(req.params['sessionId'] ?? ''), res);
  if (!sessionId) return;
  const arn = await requireArn(res);
  if (!arn) return;

  const body = (req.body ?? {}) as { shellId?: string; expiresIn?: number };
  // A stable default per session means a plain reload reattaches instead of
  // stranding the old shell against the 10-per-runtime limit.
  const shellId = (body.shellId ?? `portal-${sessionId.slice(-12)}`).trim();
  if (!isValidShellId(shellId)) {
    res.status(400).json({ error: `invalid shellId '${shellId}' — 1-128 chars of [A-Za-z0-9_-]` });
    return;
  }

  try {
    const minted = await presignShellUrl(arn, {
      shellId,
      sessionId,
      region: region(),
      ...(body.expiresIn ? { expiresIn: body.expiresIn } : {}),
    });
    res.json({ ...minted, maxFrameBytes: MAX_FRAME_BYTES });
  } catch (err) {
    res.status(502).json({ error: `could not mint a shell URL: ${(err as Error).message}` });
  }
}));

devboxRouter.delete('/:sessionId', asyncHandler(async (req, res) => {
  const sessionId = requireSessionId(String(req.params['sessionId'] ?? ''), res);
  if (!sessionId) return;
  const arn = await requireArn(res);
  if (!arn) return;

  await dataClient().send(new StopRuntimeSessionCommand({
    agentRuntimeArn: arn,
    runtimeSessionId: sessionId,
  }));
  const box = getBoxBySession(sessionId);
  if (box) markStopped(box.id);
  res.json({ stopped: true, sessionId });
}));

// ─── Test hooks ──────────────────────────────────────────────────────────────

export const _internal = {
  setDataClient(client: BedrockAgentCoreClient | null): void { _data = client; },
  setControlClient(client: BedrockAgentCoreControlClient | null): void { _control = client; },
  resetArnCache(): void { _arnCache = null; },
  validateCommand,
  buildContainerCommand,
  validateCwd,
};

// ─── Reusable task runner for the job dispatcher ─────────────────────────────
// The dispatcher must run queue work through the exact path the portal uses.
// Exported here (rather than in devbox-runner.ts) because ARN resolution and
// the SDK client — including the test hooks — live in this module.

export async function runDevboxTask(opts: {
  sessionId: string;
  prompt: string;
  resume?: boolean;
  model?: string;
  onEvent?: (event: Record<string, unknown>) => void;
}): Promise<DevboxRunOutcome> {
  const arn = await resolveDevboxArn();
  if (!arn) {
    return {
      ok: false, summary: '', turns: 0, durationMs: 0, costUsd: 0, toolCalls: 0,
      exitCode: null, error: 'devbox runtime not deployed', transcript: [],
    };
  }
  return executeDevboxTask({
    sessionId: opts.sessionId,
    prompt: opts.prompt,
    ...(opts.resume !== undefined ? { resume: opts.resume } : {}),
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
    runtimeArn: arn,
    client: dataClient(),
  });
}
