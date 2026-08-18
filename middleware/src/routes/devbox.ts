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
  ListAgentRuntimesCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';

import { asyncHandler } from '../lib/async-handler.js';
import { initSSE, writeSSE, endSSE } from '../lib/sse.js';
import {
  normalizeRuntimeSessionId,
  RUNTIME_SESSION_ID_MIN_LENGTH,
} from '../lib/runtime-session.js';
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

// ─── Command allowlist ───────────────────────────────────────────────────────
// The command API executes arbitrary shell in the agent container. A notebook
// user already holds AWS credentials; a future portal user may not — so the
// HTTP surface allows only read-only inspection commands, matched by prefix,
// with shell metacharacters banned outright (no chaining past the allowlist).

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

// Quotes are banned alongside the classic metacharacters: the validated
// command is embedded in a single-quoted `sh -c '...'` wrapper below, and a
// quote in user input could escape it.
const SHELL_META = /[;&|`$<>\\'"\n\r]/;

export function validateCommand(command: string): string | null {
  if (!command || command.length > 500) return 'command must be 1–500 characters';
  if (SHELL_META.test(command)) return 'shell metacharacters are not allowed';
  const allowed = commandAllowlist().some(
    (prefix) => command === prefix.trim() || command.startsWith(prefix),
  );
  if (!allowed) return `command not in allowlist (allowed prefixes: ${commandAllowlist().join(', ')})`;
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

devboxRouter.get('/status', asyncHandler(async (_req, res) => {
  const arn = await resolveDevboxArn();
  res.json({
    deployed: Boolean(arn),
    runtimeArn: arn,
    runtimeName: DEVBOX_RUNTIME_NAME,
    commandAllowlist: commandAllowlist(),
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

  const body = (req.body ?? {}) as { prompt?: string; resume?: boolean; timeout?: number };
  const prompt = (body.prompt ?? '').trim();
  if (!prompt) { res.status(400).json({ error: 'prompt is required' }); return; }

  const payload = JSON.stringify({
    prompt,
    resume: Boolean(body.resume),
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

  const command = String((req.body as { command?: string } | undefined)?.command ?? '').trim();
  const validationError = validateCommand(command);
  if (validationError) { res.status(400).json({ error: validationError }); return; }

  const arn = await requireArn(res);
  if (!arn) return;

  // The command API exec's argv directly — no shell. It DOES apply
  // shell-style word splitting (quotes respected; verified live), so wrap in
  // `sh -c '...'` to get shell semantics. The cwd prefix is composed
  // server-side AFTER validation; quotes in user input are rejected above so
  // the single-quoted wrapper cannot be escaped.
  const resp = await dataClient().send(new RunRuntimeCommand({
    agentRuntimeArn: arn,
    runtimeSessionId: sessionId,
    body: {
      // HOME matches task mode's (the wrapper pins HOME to the workspace) so
      // shared dotfiles line up, and GIT_CONFIG_* injects safe.directory for
      // this invocation only — the mount is root-owned while commands run as
      // UID 1000, so git otherwise fails with "dubious ownership" (found live).
      command: `sh -c 'export HOME=/mnt/workspace GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0=/mnt/workspace; cd /mnt/workspace 2>/dev/null || true; ${command}'`,
      timeout: Number(process.env['DEVBOX_COMMAND_TIMEOUT_S'] ?? 120),
    },
  }));

  initSSE(res);
  try {
    for await (const event of resp.stream ?? []) {
      const chunk = (event as { chunk?: Record<string, unknown> }).chunk;
      if (!chunk) continue;
      const delta = chunk['contentDelta'] as { stdout?: string; stderr?: string } | undefined;
      if (delta?.stdout) writeSSE(res, { type: 'stdout', text: delta.stdout });
      if (delta?.stderr) writeSSE(res, { type: 'stderr', text: delta.stderr });
      const stop = chunk['contentStop'] as { exitCode?: number; status?: string } | undefined;
      if (stop) writeSSE(res, { type: 'exit', exitCode: stop.exitCode, status: stop.status });
    }
  } catch (err) {
    writeSSE(res, { type: 'devbox_error', error: (err as Error).message });
  } finally {
    endSSE(res);
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
};
