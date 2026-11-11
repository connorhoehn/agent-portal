// Devbox routes — API surface over the orgiq-devbox runtime (Claude Code in
// an AgentCore Runtime microVM). Shaped for a future portal page; today it is
// exercised by tests and curl only. No portal UI ships with this module.
//
//   POST   /api/devbox/sessions              mint a compliant runtime session id
//   POST   /api/devbox/:sessionId/task       Claude Code headless run (SSE)
//   POST   /api/devbox/:sessionId/command    allowlisted read-only shell (SSE)
//   DELETE /api/devbox/:sessionId            stop the runtime session
//   GET    /api/devbox/status                resolved runtime ARN + config
//   GET    /api/devbox/allowlist             the safe-mode command prefixes only
//
// `routes/internal-devbox.ts` mounts a second, HMAC-only router at
// `/internal/devbox` for platform-api's agent loop (chat `/agent`). It calls
// several of the functions exported below (`runTaskAndForward`,
// `streamBoxTail`, `mintShellUrl`, `respondStopSession`,
// `buildDevboxStatusPayload`, `requireArn`, `mockAgentCore`) rather than
// duplicating this router's bodies — same transport, different principal.
//
// ⚠️ SDK NAMING TRAP — read before editing the imports:
// The class `InvokeAgentRuntimeCommand` used elsewhere in this codebase is the
// SDK v3 wrapper for the plain InvokeAgentRuntime *operation* (every operation
// `Foo` becomes a class `FooCommand`). The command-execution API used here is
// a *different operation* literally named `InvokeAgentRuntimeCommand`, whose
// class is therefore `InvokeAgentRuntimeCommandCommand` — aliased below as
// `RunRuntimeCommand` so the two can never be confused at a call site.

import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand as InvokeRuntime,
  InvokeAgentRuntimeCommandCommand as RunRuntimeCommand,
  StopRuntimeSessionCommand,
  type InvokeAgentRuntimeCommandOutput,
} from '@aws-sdk/client-bedrock-agentcore';
import {
  BedrockAgentCoreControlClient,
  GetAgentRuntimeCommand,
  ListAgentRuntimesCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';

import { canSee, visibleBoxes, FLEET_WIDE_ROLES, requireBoxAccess } from '../lib/devbox-visibility.js';
import { requireAgentCapability, requireBoxAction } from '../lib/agent-actions.js';
// Type-only: authz.ts drags config.ts (import.meta) into the graph, which the
// suites that import this router cannot load (see lib/agent-actions.ts).
import type { CapabilityAction } from '../lib/authz.js';
import { stewardsInitiative } from '../lib/initiative-scope.js';
import { asyncHandler } from '../lib/async-handler.js';
import { initSSE, writeSSE, endSSE } from '../lib/sse.js';
import {
  normalizeRuntimeSessionId,
  RUNTIME_SESSION_ID_MIN_LENGTH,
} from '../lib/runtime-session.js';
import { executeDevboxTask, scheduleCutoffBackstop, type DevboxLabContext, type DevboxRunOutcome } from '../lib/devbox-runner.js';
import { anySignal, cutoffMessage, type RunMeter } from '../lib/run-meter.js';
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
  setBoxProfile,
  isReserved,
  changesHands,
  isFleetOwnedBox,
  setOccupant,
  type FleetBox,
} from '../lib/devbox-fleet.js';
import { presignShellUrl, isValidShellId, MAX_FRAME_BYTES } from '../lib/devbox-shell.js';
import { timeLeft, type ReaperDeps } from '../lib/devbox-reaper.js';
import {
  profileForBox, profileForInitiative, resolveTaskModel, lifetimeOf, profileStamp, lifetimePoliciesFor,
  type DevboxProfile,
} from '../lib/devbox-profile.js';
import { clampTaskTimeout, lifetimePolicy } from '../lib/devbox-lifetime.js';
import { mockDevboxClient } from '../mock/devbox-shell.js';
import { randomUUID } from 'node:crypto';
import { parseReportedCost, parseResultUsage, settleRunCost } from '../lib/run-cost.js';
import { reserveSpend, forecastP75ForModel, meterForHold, HOLD_GRACE_MS, type ReserveSpendResult } from '../lib/spend-holds.js';
import { spendRefusalResponse } from '../lib/spend-refusal.js';
import { releaseHold } from '../providers/spend-holds.js';
import { getBoxSpend, spendLedgerMode, ledgerIsFixture, type BoxSpend } from '../providers/spend-ledger.js';
import { estimateUsageCost } from '../lib/model-prices.js';
import type { TokenUsage } from '../lib/pricing.js';
import { recordSpend } from '../providers/spend-ledger.js';

export const devboxRouter = Router();

/**
 * What the devbox reaper needs from this router: the same client and ARN
 * resolver the routes use. The reaper itself is started from index.ts beside
 * the other sweepers, leader-elected across replicas (DE-47) — it used to start
 * on import of this module, in every process that loaded it.
 */
export function devboxReaperDeps(): ReaperDeps {
  return {
    client: dataClient, runtimeArn: resolveDevboxArn,
    // DE-50: a paused fleet stops its idle boxes; the leader frees dead run
    // slots, writes the stats line and announces budget crossings.
    fleetPaused: async () => (await import('../lib/fleet-switches.js')).fleetPaused(),
    housekeeping: async (boxes, decisions, now) => (await import('../lib/fleet-housekeeping.js')).fleetHousekeeping(boxes, decisions, now),
    // The microVM runner's sessions past task timeout + grace (design §7).
    microvmSweep: async () => {
      const m = await import('../lib/microvm-dispatcher.js');
      await m.sweepMicrovmOverruns(await m.defaultMicrovmDeps());
    },
    // Voice navigator sessions past their ceiling + grace (docs/voice-navigator-spec.md §7).
    voiceSweep: async () => {
      const v = await import('../lib/voice/reaper.js');
      await v.sweepVoiceSessions(await v.defaultVoiceReaperDeps());
      // The session event log's 30 days (lib/voice/session-log.ts).
      await (await import('../lib/voice/session-log.js')).sweepVoiceEventRetention();
    },
  };
}

// ─── Clients (lazy; overridable for tests via _internal) ─────────────────────

let _data: BedrockAgentCoreClient | null = null;
let _control: BedrockAgentCoreControlClient | null = null;

// Env-read directly (not via config.ts) so this module stays importable under
// the CJS jest config — config.ts uses import.meta. Same convention as
// gateway-proxy.ts.
const region = (): string => process.env['AWS_REGION'] ?? 'us-east-1';

/** Read straight off the environment, like every other flag in this file —
 *  importing config.ts drags import.meta into a CommonJS test build.
 *  Exported: `routes/internal-devbox.ts` needs the same read to decide
 *  between the real transport and its own loop-shaped mock frames. */
export const mockAgentCore = (): boolean => process.env['MOCK_AGENTCORE'] === 'true';

function dataClient(): BedrockAgentCoreClient {
  // Offline this is the same fake microVM `lib/devbox-arn.ts` hands every
  // other devbox caller. This file kept a private client and a private ARN
  // resolver, so the interactive terminal, the session list and the reaper
  // went on 503ing in dev:mock after the shared path was fixed.
  if (!_data) {
    _data = mockAgentCore()
      ? mockDevboxClient()
      : new BedrockAgentCoreClient({ region: region() });
  }
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

  // Offline the answer is "yes, there is a runtime" and it is a fake one, the
  // same shape `lib/devbox-arn.ts` builds. Not cached: the cache bounds a live
  // ListAgentRuntimes call and there is none to bound.
  if (mockAgentCore()) {
    const account = process.env['AWS_ACCOUNT_ID'] || '000000000000';
    return `arn:aws:bedrock-agentcore:${region()}:${account}:runtime/${DEVBOX_RUNTIME_NAME}-MOCK`;
  }

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

/**
 * The safe-mode prefixes this deployment runs (DEVBOX_COMMAND_ALLOWLIST, else
 * the default above). Exported for the voice mint, which drops the
 * computer run phrases these would refuse before the model is offered them
 * (docs/voice-navigator-gaps.md G9), and served as GET /allowlist for the
 * dock's planner, which checks the composed command again before its card.
 */
export function commandAllowlist(): string[] {
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
    // The decoded command is removed once it has run (DE-45): a file left
    // behind is readable by the agent that runs in the same microVM, and a
    // command may carry something it should not have to.
    'rm -f /tmp/.orgiq-cmd',
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

/**
 * 403 a caller who may not touch this computer.
 *
 * `ManageDevbox` got them onto the surface; this decides which computers on it
 * are theirs (lib/devbox-visibility.ts). Resolves by runtime session id, which
 * is what the /:sessionId routes carry.
 *
 * An UNREGISTERED session id is refused for anyone but a fleet-wide role. The
 * routes accept a session id straight from the path, so letting an unknown one
 * through would make the whole check optional — you would just pass an id the
 * registry has never seen. A fleet-wide role keeps the escape hatch, because
 * adopting a session the registry lost is a real operator move.
 *
 * Taking that hatch REGISTERS the session rather than merely waving it
 * through, and that is the point of it. The fleet registry is in memory, so
 * every middleware restart drops it while the AgentCore sessions themselves
 * carry on — verified on 2026-09-09, when a restart left `GET /boxes`
 * reporting an empty fleet and the orphaned microVM still answering commands
 * with its workspace intact. The reaper only ever sees `listBoxes()`
 * (lib/devbox-reaper.ts), so an unregistered session is outside BOTH the idle
 * timeout and the max-lifetime ceiling — permanently, since there is no
 * AgentCore API that enumerates live runtime sessions to reconcile against
 * (`list-sessions` is Memory, not Runtime). Waving the session through let an
 * operator work on a box that nothing would ever stop paying for. Registering
 * it puts it back under both timers, which is the whole reason they exist.
 *
 * `/task` already re-adopted this way (its own `getBoxBySession ?? registerBox`
 * line); doing it here means `/command` and `/shell-url` stop being the paths
 * where an orphan gets used but never reclaimed.
 */
// requireBoxAccess lives in lib/devbox-visibility.ts (shared with the
// agent-projects clone route); the rationale above applies there.

/** Exported for `routes/internal-devbox.ts` — the real (non-mock) transport
 *  path resolves the ARN the exact same way for either principal. */
export async function requireArn(res: Response): Promise<string | null> {
  const arn = await resolveDevboxArn();
  if (!arn) {
    res.status(503).json({
      error: 'devbox runtime not deployed — run agents/devbox/build.sh then deploy OrgIQ-Devbox with --context deployDevbox=true',
    });
    return null;
  }
  return arn;
}

// ─── What a write to the lab asks Cedar for ─────────────────────────────────
//
// The `/api/devbox` mount (index.ts) lets every role that directs agent work
// READ the fleet and asks this table before any write, instead of one action
// for every write. Three answers:
//
//   OperateDevbox   start, rename, stop and remove a computer — the lab's
//                   drive, split out of ManageDevbox (11 Nov 2026) so a leader
//                   who dispatches runs can also drive a lab computer by hand.
//                   Which computers stays the route's business (canSee,
//                   stewardsInitiative), as it does for every other write.
//   null            POST /:sessionId/task gates itself: requireBoxAction asks
//                   RunDevboxTask with the box's attributes, which the sme
//                   grant is conditioned on — a bare mount-level ask would
//                   refuse an SME on their own computer.
//   ManageDevbox    everything else: the shell (OpenDevboxShell at the route,
//                   on top), codebases, capabilities, session bundles.
//
// A route not listed here is ManageDevbox — the table can only widen a route
// by naming it, so a new write is gated the old way until someone decides
// otherwise. devbox-lab-drive.test.ts walks the router and pins the table.

const LAB_DRIVE: ReadonlyArray<{ method: string; path: RegExp; action: CapabilityAction | null }> = [
  { method: 'POST', path: /^\/sessions\/?$/, action: 'OperateDevbox' },
  { method: 'POST', path: /^\/boxes\/?$/, action: 'OperateDevbox' },
  { method: 'PATCH', path: /^\/boxes\/[^/]+\/?$/, action: 'OperateDevbox' },
  { method: 'DELETE', path: /^\/boxes\/[^/]+\/?$/, action: 'OperateDevbox' },
  { method: 'DELETE', path: /^\/[^/]+\/?$/, action: 'OperateDevbox' },   // DELETE /:sessionId
  { method: 'POST', path: /^\/[^/]+\/task\/?$/, action: null },           // its own RunDevboxTask gate
];

/** The Cedar action the `/api/devbox` mount asks for a write; null when the route gates itself. */
export function devboxWriteAction(req: { method: string; path: string }): CapabilityAction | null {
  const row = LAB_DRIVE.find((r) => r.method === req.method && r.path.test(req.path));
  return row ? row.action : 'ManageDevbox';
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

/**
 * Assembles the exact JSON `GET /status` answers with.
 *
 * Exported so `routes/internal-devbox.ts` reports the SAME resolved runtime —
 * same ARN cache, same client — rather than a second opinion that could drift
 * from what the browser-facing route sees.
 */
export async function buildDevboxStatusPayload(): Promise<{
  defaultModel: string | null; allowedModels: string[]; perTaskModel: boolean;
  deployed: boolean; runtimeArn: string | null; runtimeName: string;
  commandAllowlist: string[]; fullExecEnabled: boolean; workspace: string;
}> {
  const arn = await resolveDevboxArn();
  const models = await deployedModelCapability(arn);
  return {
    ...models,
    deployed: Boolean(arn),
    runtimeArn: arn,
    runtimeName: DEVBOX_RUNTIME_NAME,
    commandAllowlist: commandAllowlist(),
    fullExecEnabled: fullExecEnabled(),
    workspace: '/mnt/workspace',
  };
}

devboxRouter.get('/status', asyncHandler(async (_req, res) => {
  res.json(await buildDevboxStatusPayload());
}));

// The safe-mode prefixes, nothing else (no ARN, no full-exec flag): what the
// voice dock checks a composed computer run against before it shows the card,
// so the card never offers a command this server would refuse (G9). Gated like
// computer run itself (OpenDevboxShell, the box's own check in /command): a
// role that can read the fleet but never run a command reads 403, which the
// dock answers as "not with your role".
devboxRouter.get('/allowlist', requireAgentCapability('OpenDevboxShell'), (_req, res) => {
  res.json({ prefixes: commandAllowlist() });
});

devboxRouter.post('/sessions', asyncHandler(async (req, res) => {
  const requested = (req.body as { sessionId?: string } | undefined)?.sessionId;
  const sessionId = normalizeRuntimeSessionId(requested);
  res.status(201).json({ sessionId });
}));

// ─── Fleet registry — server-side source of truth for the herd ───────────────
// Registered BEFORE the /:sessionId routes so /boxes never matches as a
// sessionId. Boxes carry live status (idle/running/waiting/stopped/error)
// derived from the task-event tee below, and any client can tail any box.

devboxRouter.get('/boxes', asyncHandler(async (req, res) => {
  // Each box carries how long it has left. A workspace that disappears is
  // fine; a workspace that disappears without warning is not, and the client
  // should not have to re-derive the policy to say so.
  //
  // Filtered to what this caller may see, so an SME's fleet is their own
  // computers plus the ones shared on initiatives they are attached to. The
  // filter is here rather than in the client because a fleet the client has to
  // trim is a fleet the client was already sent.
  const mine = await visibleBoxes(req.session ?? null, listBoxes());
  // Meters are per box's own profile (DE-40), not the deployment default.
  const policies = await lifetimePoliciesFor(mine);
  const spend = await boxSpendFields(mine);
  const now = Date.now();
  res.json({ boxes: mine.map((b) => {
    const policy = policies.get(b.id);
    return { ...b, ...(policy ? timeLeft(b, now, policy) : timeLeft(b, now)), ...spend.get(b.id) };
  }) });
}));

/**
 * A box's spend as the wire carries it (DE-31), read for the whole list in
 * one ledger statement:
 *   spendUsd           — the box's known spend. From the ledger when
 *                        SPEND_LEDGER=ledger (and always offline, where the
 *                        fixtures are the ledger); otherwise the in-memory
 *                        lifetime figure, as before.
 *   spendUnknownCount  — the box's ledger entries with no recorded cost.
 *   spendLiveUsd       — the in-memory accrual: a live, in-flight estimate
 *                        between a task starting and its entry landing.
 * Under `dual` a box whose two figures differ by a cent or more is logged.
 */
async function boxSpendFields(boxes: readonly FleetBox[]): Promise<Map<string, { spendUsd?: number; spendUnknownCount: number; spendLiveUsd: number }>> {
  const out = new Map<string, { spendUsd?: number; spendUnknownCount: number; spendLiveUsd: number }>();
  let ledger = new Map<string, BoxSpend>();
  try {
    ledger = (await getBoxSpend(boxes.map((b) => b.id))) ?? new Map();
  } catch (err) {
    console.warn('[devbox] box spend not read from the ledger:', (err as Error).message);
  }
  const mode = spendLedgerMode();
  const fromLedger = mode === 'ledger' || ledgerIsFixture();
  for (const b of boxes) {
    const live = Math.round((b.spendUsd ?? 0) * 10_000) / 10_000;
    const l = ledger.get(b.id);
    if (mode === 'dual' && l && Math.abs(l.knownUsd - live) >= 0.01) {
      console.warn(`[devbox] box ${b.id} spend differs: ledger $${l.knownUsd.toFixed(4)}, in-memory $${live.toFixed(4)}`);
    }
    out.set(b.id, {
      ...(fromLedger && l ? { spendUsd: l.knownUsd } : b.spendUsd != null ? { spendUsd: b.spendUsd } : {}),
      spendUnknownCount: l?.unknownCount ?? 0,
      spendLiveUsd: live,
    });
  }
  return out;
}

/**
 * Resolve, record and apply the profile a task runs under (DE-40): the model
 * (an unlisted one is a 400 naming the allowed set, never a silent fallback)
 * and the timeout (clamped to the profile's ceiling through the one cap in
 * lib/devbox-lifetime.ts). Stamps the profile on the box the first time, so
 * the rules a box started under travel with it. Shared by the public and
 * internal task routes; returns null after answering the refusal.
 */
export async function applyTaskProfile(
  box: FleetBox | null,
  body: { model?: unknown; timeout?: unknown },
  res: Response,
): Promise<{ model: string; timeout: number; profile: DevboxProfile } | null> {
  const profile = await profileForBox(box);
  const resolved = resolveTaskModel(profile, body.model);
  if (!resolved.ok) {
    res.status(400).json({
      error: resolved.error, code: 'MODEL_NOT_ALLOWED', allowedModels: resolved.allowed,
      profile: { id: profile.id, version: profile.version },
    });
    return null;
  }
  if (box) setBoxProfile(box.id, profileStamp(profile));
  return { model: resolved.model, timeout: clampTaskTimeout(body.timeout, lifetimeOf(profile)), profile };
}

devboxRouter.post('/boxes', asyncHandler(async (req, res) => {
  const body = (req.body ?? {}) as {
    label?: string; sessionId?: string; createdAt?: string; projectId?: string;
  };
  const sessionId = normalizeRuntimeSessionId(body.sessionId);
  // Charging a computer to an initiative shares it with everyone on that
  // initiative, so it is a claim about access as much as about cost: check the
  // caller is actually on it rather than taking the body's word.
  const projectId = String(body.projectId ?? '').trim();
  if (projectId && !await stewardsInitiative(req.session ?? null, projectId)) {
    res.status(403).json({
      error: 'you can only charge a computer to an initiative you own or contribute to',
      projectId,
    });
    return;
  }
  // The rules this computer is created under (DE-40): its initiative's
  // profile, else `default`. Recorded on the box so a later profile edit
  // never changes a box mid-task.
  const profile = await profileForInitiative(projectId || null);
  const box = registerBox({
    sessionId,
    // From the session, never the body — an attribution a caller can set is
    // not an attribution.
    ...(req.session?.sub ? { ownerId: req.session.sub } : {}),
    ...(projectId ? { projectId } : {}),
    ...(body.label ? { label: body.label } : {}),
    ...(body.createdAt ? { createdAt: body.createdAt } : {}),
    profile: profileStamp(profile),
  });
  res.status(201).json(box);
}));

devboxRouter.patch('/boxes/:boxId', asyncHandler(async (req, res) => {
  const label = String((req.body as { label?: string } | undefined)?.label ?? '').trim();
  if (!label) { res.status(400).json({ error: 'label is required' }); return; }
  const existing = getBox(String(req.params['boxId'] ?? ''));
  if (!existing) { res.status(404).json({ error: 'computer not found' }); return; }
  if (!await canSee(req.session ?? null, existing)) {
    res.status(403).json({ error: 'that computer is not yours to rename' });
    return;
  }
  const box = renameBox(existing.id, label);
  res.json(box);
}));

devboxRouter.delete('/boxes/:boxId', asyncHandler(async (req, res) => {
  const boxId = String(req.params['boxId'] ?? '');
  const box = getBox(boxId);
  if (!box) { res.status(404).json({ error: 'computer not found' }); return; }
  if (!await canSee(req.session ?? null, box)) {
    res.status(403).json({ error: 'that computer is not yours to remove' });
    return;
  }
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
// Tailing is reading someone's work, so it is scoped like everything else, and
// the ORDER matters: the whole access check runs before `initSSE`, because
// after the SSE head goes out there is no status code left to refuse with.
//
// asyncHandler wraps this for the sake of that check and nothing else — the
// `canSee` call reaches Aurora to resolve initiative attachment, so it can
// reject, and at that point no head has been written and a JSON error is still
// the right answer. Everything AFTER `initSSE` must therefore not throw:
// `replayEvents` and `subscribeFleet` are pure map reads and `writeSSE`
// no-ops on an ended stream, so nothing there hands asyncHandler an error it
// would try to answer with a second set of headers.
/**
 * Replay-then-live tail of a box's event buffer, assuming the caller has
 * ALREADY decided this box is theirs to watch — the public route checks
 * `canSee` against a browser session first; `routes/internal-devbox.ts`
 * checks its own HMAC envelope first. Both then stream identically, which is
 * the property that matters: a tail must never diverge by principal, or an
 * operator watching a run started from chat sees a different log than one
 * started from the browser.
 */
export function streamBoxTail(boxId: string, req: Request, res: Response): void {
  initSSE(res);
  for (const ev of replayEvents(boxId)) writeSSE(res, ev);
  // `box_removed` is terminal: forward it so the client can say why the log
  // stopped, then end the response. Without this the stream stays open and
  // keeps heartbeating for a box that no longer exists (see removeBox).
  const unsubscribe = subscribeFleet(boxId, (ev) => {
    writeSSE(res, ev);
    if (ev['type'] === 'box_removed') endSSE(res);
  });
  req.on('close', () => { unsubscribe(); endSSE(res); });
}

devboxRouter.get('/boxes/:boxId/tail', asyncHandler(async (req, res) => {
  const boxId = String(req.params['boxId'] ?? '');
  const box = getBox(boxId);
  if (!box) { res.status(404).json({ error: 'computer not found' }); return; }
  if (!await canSee(req.session ?? null, box)) {
    res.status(403).json({ error: 'that computer is not yours to watch' });
    return;
  }
  streamBoxTail(boxId, req, res);
}));

/**
 * Real-transport task run: invoke the resolved runtime (or, under
 * MOCK_AGENTCORE, whatever `dataClient()` swaps in — `mockDevboxClient()` for
 * this router) and forward its SSE body verbatim, re-framed one JSON object
 * per line.
 *
 * Exported so `routes/internal-devbox.ts` runs a REAL (non-mock) task through
 * the exact same invoke-and-forward code as the browser route — the only
 * difference between principals is who was allowed to reach this far, not
 * what happens once they have. Its own mock path bypasses this entirely (see
 * `mock/devbox-agent-loop.ts`), since the platform-api loop's mock needs a
 * different frame shape (resume-aware growing context, DONE-on-completion)
 * than `mockDevboxClient()` produces, and this function must keep producing
 * exactly what it always has for the public route's own mock tests.
 */
export async function runTaskAndForward(opts: {
  sessionId: string;
  prompt: string;
  resume: boolean;
  model?: string;
  timeout?: number;
  res: Response;
  arn: string;
  /** Who this ad-hoc task spends for (DE-30). Only the two routes no bot run
   *  or job owns call this function, so every call writes its own entry. */
  spend: { source: 'box_task' | 'agent_loop'; actorId: string | null };
  /** The caller's confirm flags for the held allocation/envelope brakes (DE-34). */
  confirmed?: { allocation?: boolean; envelope?: boolean; userBudget?: boolean };
}): Promise<void> {
  const { sessionId, prompt, resume, model, timeout, res, arn } = opts;

  // Fleet tee: auto-register unknown sessions (curl/notebook starts, and an
  // internal-router session that predates this call, show up in the herd
  // too), flip status to running, and mirror every event into the box's
  // server-side log so other clients can tail this run.
  const fleetBox = getBoxBySession(sessionId) ?? registerBox({ sessionId });

  // The spend hold (DE-34), before InvokeRuntime — the box task's one side
  // effect that spends. The box's initiative is charged (none → unattributed,
  // no hold, as the ledger books it); the sender is the actor (DE-31). The
  // ledger key is minted first so the entry written in `finally` settles it.
  const taskId = randomUUID();
  const sourceId = `${fleetBox.id}:${taskId}`;
  const judged = !isReserved(fleetBox.id);
  const holdTtlMs = (timeout ? clampTaskTimeout(timeout) : lifetimePolicy().taskMaxS) * 1000 + HOLD_GRACE_MS;
  const held = await reserveSpend({
    initiativeId: fleetBox.projectId ?? null,
    actorId: opts.spend.actorId,
    source: opts.spend.source,
    sourceId,
    forecast: await forecastP75ForModel(model ?? null),
    ...(opts.confirmed ? { confirmed: opts.confirmed } : {}),
    // A task sent into a box a governed run holds (reserveBox) is a reply
    // inside that run — a person answering its question — whose money the
    // run's own hold already covers. It is held for visibility, never
    // refused: refusing it would strand a run that is already spending.
    judge: judged,
    expiresInMs: holdTtlMs,
  });
  if (held.kind !== 'held') {
    sendSpendRefusal(res, held);
    return;
  }

  // The hold is this task's ceiling (DE-35): metered as frames arrive, topped
  // up near it, cut at it. A reply inside a governed run (judge: false) is
  // the run's money and is not metered on its own.
  const meter: RunMeter | null = judged ? await meterForHold({
    holdId: held.holdId, amountUsd: held.amountUsd,
    initiativeId: fleetBox.projectId ?? null, actorId: opts.spend.actorId,
    source: opts.spend.source, sourceId, model: model ?? null, expiresInMs: holdTtlMs,
  }) : null;
  const budget = meter?.boxBudget(sourceId) ?? null;
  const payload = JSON.stringify({
    prompt,
    resume,
    ...(model ? { model } : {}),
    // The one cap (lib/devbox-lifetime.ts): the callers already clamped to the
    // box's profile; this keeps the deploy-wide ceiling for any that did not.
    ...(timeout ? { timeout: clampTaskTimeout(timeout) } : {}),
    ...(budget ? { budget } : {}),
  });

  appendEvent(fleetBox.id, { type: 'task_started', prompt, ts: new Date().toISOString() });

  let resp: InvokeAgentRuntimeCommandOutput;
  try {
    resp = await dataClient().send(new InvokeRuntime({
      agentRuntimeArn: arn,
      qualifier: 'DEFAULT',
      runtimeSessionId: sessionId,
      accept: 'text/event-stream',
      payload: new TextEncoder().encode(payload),
    }), ...(meter ? [{ abortSignal: meter.signal }] : []));
  } catch (err) {
    // The runtime never accepted the task, so nothing was spent.
    await releaseHold(held.holdId);
    throw err;
  }

  initSSE(res);
  // The task's own ledger figures, read off the frames as they pass.
  let reportedUsd: number | null = null;
  let resultSeen = false;
  let usedModel: string | null = model ?? null;
  let usage: TokenUsage | null = null;
  let endSeen = false;
  const observe = (ev: Record<string, unknown>): void => {
    meter?.observe(ev);
    if (ev['type'] === 'devbox_end') endSeen = true;
    if (ev['type'] === 'devbox_start' && typeof ev['model'] === 'string' && ev['model']) usedModel = ev['model'];
    if (ev['type'] === 'result') {
      resultSeen = true;
      reportedUsd = parseReportedCost(ev);
      usage = parseResultUsage(ev);
    }
  };
  try {
    const stream = resp.response as AsyncIterable<Uint8Array> | undefined;
    if (!stream) { writeSSE(res, { type: 'devbox_error', error: 'empty response stream' }); return; }

    // Forward the wrapper's SSE lines: re-frame each JSON event line as our
    // own data frame so consumers see one clean SSE stream regardless of how
    // the upstream body was chunked.
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of stream) {
      if (meter?.cutoff) break;
      buffer += decoder.decode(chunk, { stream: true });
      let idx: number;
      while (!meter?.cutoff && (idx = buffer.indexOf('\n')) >= 0) {
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
        try {
          const ev = JSON.parse(line) as Record<string, unknown>;
          appendEvent(fleetBox.id, ev);
          observe(ev);
        } catch { /* malformed frame — forwarded raw above, skip tee */ }
      }
    }
  } catch (err) {
    // The meter's own abort is a cut, not a failure of the transport.
    if (!meter?.cutoff) {
      writeSSE(res, { type: 'devbox_error', error: (err as Error).message });
      appendEvent(fleetBox.id, { type: 'devbox_error', error: (err as Error).message });
    }
  } finally {
    if (meter) await meter.settled();
    // The task is over: its concurrency slot frees now (DE-37).
    if (held.holdId) await import('../providers/run-limits.js').then((m) => m.releaseRunSlots(held.holdId)).catch(() => undefined);
    const cutoff = meter?.cutoff ?? null;
    if (cutoff) {
      // The recorded reason (DE-35): on the stream, in the box's log, and —
      // with the metered figure — in the ledger entry below.
      const ev = { type: 'run_cutoff', ...cutoff, error: cutoffMessage(cutoff), ts: new Date().toISOString() };
      writeSSE(res, ev);
      appendEvent(fleetBox.id, ev);
      // The browser's existing error line; not teed, because the box is not
      // broken — it stays `running` until the session stop below lands.
      writeSSE(res, { type: 'devbox_error', error: cutoffMessage(cutoff), reason: 'budget' });
      if (!endSeen) {
        scheduleCutoffBackstop({
          stop: async () => {
            await dataClient().send(new StopRuntimeSessionCommand({ agentRuntimeArn: arn, runtimeSessionId: sessionId }));
          },
          onStopped: () => markStopped(fleetBox.id),
        }, () => endSeen, (e) => appendEvent(fleetBox.id, e));
      }
    }
    endSSE(res);
    // The runtime accepted the task, so it may have spent: a run that never
    // reported a result is unknown cost, not zero. When it reported tokens but
    // no figure, the table prices them (DE-32) and the basis says so. A cut
    // run with no result books the metered figure as an estimate (DE-35).
    const u = usage as TokenUsage | null;
    const estimated = resultSeen && u && usedModel ? estimateUsageCost(usedModel, u) : null;
    const settled = !resultSeen && cutoff && cutoff.meteredUsd > 0
      ? { costUsd: cutoff.meteredUsd, costBasis: 'estimated' as const, estimatedCostUsd: cutoff.meteredUsd }
      : settleRunCost(resultSeen ? reportedUsd : null, estimated);
    await recordSpend({
      source: opts.spend.source,
      sourceId,
      initiativeId: fleetBox.projectId ?? null,
      boxId: fleetBox.id,
      actorId: opts.spend.actorId,
      model: usedModel,
      costUsd: settled.costUsd,
      costBasis: settled.costBasis,
      estimatedCostUsd: settled.estimatedCostUsd,
      inputTokens: u?.inputTokens ?? null,
      outputTokens: u?.outputTokens ?? null,
      // An InvokeRuntime task is AgentCore Runtime by construction (DE-33).
      provider: 'bedrock',
    });
  }
}

/**
 * The answer to a money refusal from reserveSpend, in the dispatch route's
 * shapes: 409 with the gate, its confirm flag and the figures; 403 for spend
 * refused outright; 503 when holds cannot be recorded and the deployment
 * fails closed. Sent before any SSE frame, so the caller sees plain JSON.
 */
export function sendSpendRefusal(res: Response, r: Exclude<ReserveSpendResult, { kind: 'held' }>): void {
  const out = spendRefusalResponse(r);
  if (out.headers) res.set(out.headers);
  res.status(out.status).json(out.body);
}

// Task mode: Claude Code headless run in /mnt/workspace, stream-json events
// forwarded as SSE. The devbox wrapper emits devbox_start/devbox_end envelope
// events around Claude Code's own stream.
devboxRouter.post('/:sessionId/task', requireBoxAction('RunDevboxTask'), asyncHandler(async (req, res) => {
  const sessionId = requireSessionId(String(req.params['sessionId'] ?? ''), res);
  if (!sessionId) return;
  if (!await requireBoxAccess(req, res, sessionId)) return;
  const arn = await requireArn(res);
  if (!arn) return;

  const body = (req.body ?? {}) as {
    prompt?: string; resume?: boolean; timeout?: number; model?: string;
    confirmOverAllocation?: unknown; confirmOverEnvelope?: unknown; confirmOverUserBudget?: unknown;
  };
  const prompt = (body.prompt ?? '').trim();
  if (!prompt) { res.status(400).json({ error: 'prompt is required' }); return; }

  // The box's profile decides the model and the timeout ceiling (DE-40); the
  // BFF always sends the model explicitly, so the container never falls back.
  const governed = await applyTaskProfile(getBoxBySession(sessionId), body, res);
  if (!governed) return;

  // A box is reused across people. `resume` continues the Claude Code
  // conversation in the box, so only the person who left it may resume it;
  // and a box the fleet made for itself (nobody's, on no initiative) is wiped
  // before it serves someone new. A personal or initiative box keeps its
  // workspace: whoever reaches it already passed requireBoxAccess, which is
  // the rule that shares it. A box a governed run holds (isReserved) is left
  // alone: a task sent there is a person answering that run's question, inside
  // the run (runTaskAndForward below), and resuming it is the point.
  const occupant = req.session?.sub ?? 'anonymous';
  const box = getBoxBySession(sessionId);
  if (box && !isReserved(box.id) && changesHands(box, occupant) && body.resume) {
    res.status(409).json({
      error: 'resume_refused',
      message: 'This computer last ran someone else\'s task; start a new conversation instead of resuming theirs.',
    });
    return;
  }
  if (!await takeOccupancy(sessionId, occupant, res)) return;

  await runTaskAndForward({
    sessionId, prompt, resume: Boolean(body.resume), res, arn,
    spend: { source: 'box_task', actorId: req.session?.sub ?? null },
    confirmed: {
      allocation: body.confirmOverAllocation === true, envelope: body.confirmOverEnvelope === true,
      userBudget: body.confirmOverUserBudget === true,
    },
    model: governed.model,
    timeout: governed.timeout,
  });
}));

/**
 * Hand the box to `occupant` before a task, a command or a shell reaches it.
 * A box the fleet made for itself (nobody's, on no initiative) that last held
 * someone else's work, or whose last occupant is unknown, is wiped first; a
 * personal or initiative box keeps its workspace (whoever reaches it already
 * passed requireBoxAccess, the rule that shares it). A box a governed run
 * holds (isReserved) is left alone. Records the occupant. Answers 502 and
 * returns false when the wipe fails: nobody works on another person's files.
 */
async function takeOccupancy(sessionId: string, occupant: string, res: Response): Promise<boolean> {
  const box = getBoxBySession(sessionId);
  if (!box || isReserved(box.id)) return true;
  if (changesHands(box, occupant) && isFleetOwnedBox(box)) {
    const wiped = await wipeDevboxWorkspace(sessionId);
    if (!wiped.ok) {
      res.status(502).json({ error: 'wipe_failed', message: `The computer could not be cleared for a new occupant: ${wiped.error ?? 'unknown'}` });
      return false;
    }
    appendEvent(box.id, { type: 'workspace_wiped', removed: wiped.removed ?? 0, ts: new Date().toISOString() });
  }
  setOccupant(box.id, occupant);
  return true;
}

// Command mode: deterministic shell via the InvokeAgentRuntimeCommand
// operation — no LLM in the loop. Allowlisted + metacharacter-banned; the cwd
// prefix below is composed server-side AFTER validation.
devboxRouter.post('/:sessionId/command', requireBoxAction('OpenDevboxShell'), asyncHandler(async (req, res) => {
  const sessionId = requireSessionId(String(req.params['sessionId'] ?? ''), res);
  if (!sessionId) return;
  if (!await requireBoxAccess(req, res, sessionId)) return;

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
  // A command reads and writes the workspace like a task does.
  if (!await takeOccupancy(sessionId, req.session?.sub ?? 'anonymous', res)) return;

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
 * Run a single command in the workspace via the same exec transport as
 * `/command` above, and return its captured stdout as one string (the
 * trailing `__ORGIQ_CWD__:` marker line stripped) — no SSE, one blob back.
 *
 * Exported for `lib/devbox-files.ts`, which backs
 * `routes/internal-devbox.ts`'s `GET /:sessionId/files[/:fileId]`
 * (LOOP-BRIEF.md §7). The deployed devbox runtime has no dedicated
 * file-listing or file-read API — `agents/devbox/main.py` exposes only the
 * headless `/task` entrypoint — so those endpoints fall back to `ls -la` /
 * `cat` through this same transport rather than inventing a new one.
 * Deliberately skips `validateCommand`'s safe/full allowlist: the caller is
 * platform-api behind the internal HMAC envelope, not a browser session, so
 * the allowlist's "protect an operator poking at someone else's box"
 * rationale does not apply here.
 */
export async function execWorkspaceCommand(
  sessionId: string,
  arn: string,
  command: string,
  cwd = '/mnt/workspace',
): Promise<string> {
  const resp = await dataClient().send(new RunRuntimeCommand({
    agentRuntimeArn: arn,
    runtimeSessionId: sessionId,
    body: {
      command: buildContainerCommand(command, cwd),
      timeout: Number(process.env['DEVBOX_COMMAND_TIMEOUT_S'] ?? 30),
    },
  }));
  let out = '';
  for await (const event of resp.stream ?? []) {
    const chunk = (event as { chunk?: Record<string, unknown> }).chunk;
    const delta = chunk?.['contentDelta'] as { stdout?: string } | undefined;
    if (delta?.stdout) out += delta.stdout;
  }
  const markerAt = out.indexOf(`\n${CWD_MARKER}`);
  return markerAt >= 0 ? out.slice(0, markerAt) : out;
}

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
/**
 * Shared shell-url minting — public route and `routes/internal-devbox.ts`
 * both call this after their own principal-specific access check. Handles
 * both the MOCK_AGENTCORE and real-runtime paths itself, unchanged from the
 * original inline handler.
 */
export async function mintShellUrl(
  sessionId: string,
  body: { shellId?: string; expiresIn?: number },
  res: Response,
): Promise<void> {
  // A stable default per session means a plain reload reattaches instead of
  // stranding the old shell against the 10-per-runtime limit.
  const shellId = (body.shellId ?? `portal-${sessionId.slice(-12)}`).trim();
  if (!isValidShellId(shellId)) {
    res.status(400).json({ error: `invalid shellId '${shellId}' — 1-128 chars of [A-Za-z0-9_-]` });
    return;
  }

  // MOCK_AGENTCORE: hand back a mock-shell: URL instead of a presigned one.
  //
  // Without this the terminal is the one thing in the whole surface that can
  // never render offline — every other panel has a mock provider, and the lab
  // is 80% terminal. It made the Computers page undevelopable without a
  // deployed runtime: you got a 503, an error line, and 600px of black where
  // the thing you were working on should have been.
  //
  // The scheme is the client's contract (ui-components/compute
  // `MOCK_SHELL_SCHEME`), and the portal only routes it to a simulated socket
  // in dev. A real deployment never emits this because MOCK_AGENTCORE is off,
  // and a browser asked to open `mock-shell://…` with no simulator installed
  // fails immediately rather than reaching anything.
  if (mockAgentCore()) {
    res.json({
      url: `mock-shell://${sessionId}?shell=${encodeURIComponent(shellId)}`,
      shellId,
      expiresIn: 900,
      maxFrameBytes: MAX_FRAME_BYTES,
      mock: true,
    });
    return;
  }

  const arn = await requireArn(res);
  if (!arn) return;

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
}

devboxRouter.post('/:sessionId/shell-url', requireBoxAction('OpenDevboxShell'), asyncHandler(async (req, res) => {
  const sessionId = requireSessionId(String(req.params['sessionId'] ?? ''), res);
  if (!sessionId) return;
  if (!await requireBoxAccess(req, res, sessionId)) return;
  // A shell reads and writes the workspace like a task does.
  if (!await takeOccupancy(sessionId, req.session?.sub ?? 'anonymous', res)) return;
  await mintShellUrl(sessionId, (req.body ?? {}) as { shellId?: string; expiresIn?: number }, res);
}));

/**
 * Stop a runtime session.
 *
 * Two failure shapes get handled here rather than escaping as a bare 500,
 * because both were observed against the deployed runtime on 2026-09-09 and
 * both told the operator "Internal server error" about a session that had in
 * fact stopped:
 *
 *   ResourceNotFoundException — "not found or has been terminated". Asking a
 *     stopped session to stop is not a failure, it is the goal already met.
 *     Same stance the teardown scripts take on an already-deleting cluster.
 *
 *   A response the SDK cannot parse — the service answered with an HTML error
 *     page, so the client threw `SyntaxError: Unexpected token '<'` while
 *     deserializing. The stop itself had gone through; only the reply was
 *     unreadable. We genuinely do not know the outcome in this case, so it is
 *     reported as unconfirmed rather than claimed as success — and because a
 *     retry then lands on ResourceNotFoundException, saying so leaves the
 *     operator with a next step that resolves it.
 */
export async function stopDevboxSessionForSourceControl(sessionId: string): Promise<'stopped' | 'already-stopped'> {
  // Source-owned control must follow the same offline boundary as every other
  // devbox operation. The caller settles the durable fleet row after this
  // returns; there is no runtime service to contact in mock mode.
  if (mockAgentCore()) return 'stopped';
  const arn = await resolveDevboxArn();
  if (!arn) throw new Error('devbox runtime is not configured');
  try {
    await dataClient().send(new StopRuntimeSessionCommand({
      agentRuntimeArn: arn,
      runtimeSessionId: sessionId,
    }));
  } catch (err) {
    if ((err as { name?: string }).name === 'ResourceNotFoundException') return 'already-stopped';
    throw err;
  }
  return 'stopped';
}

/**
 * Shared stop-and-settle — public DELETE and `routes/internal-devbox.ts`
 * both call this after their own principal-specific access check.
 */
export async function respondStopSession(sessionId: string, res: Response): Promise<void> {
  const settle = (): void => {
    const box = getBoxBySession(sessionId);
    if (box) markStopped(box.id);
  };

  try {
    const outcome = await stopDevboxSessionForSourceControl(sessionId);
    settle();
    res.json({ stopped: true, sessionId, ...(outcome === 'already-stopped' ? { alreadyStopped: true } : {}) });
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    console.warn(`[devbox] stop session ${sessionId} failed:`, message);
    res.status(502).json({
      error: 'the runtime did not confirm the stop — retry to check whether it took',
      sessionId,
      detail: message,
    });
  }
}

devboxRouter.delete('/:sessionId', asyncHandler(async (req, res) => {
  const sessionId = requireSessionId(String(req.params['sessionId'] ?? ''), res);
  if (!sessionId) return;
  if (!await requireBoxAccess(req, res, sessionId)) return;
  await respondStopSession(sessionId, res);
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
  signal?: AbortSignal;
  sessionId: string;
  prompt: string;
  resume?: boolean;
  model?: string;
  /**
   * Seconds this task may run (DE-48). The dispatcher passes the policy's
   * `taskDefaultS` explicitly rather than leaving the container to pick;
   * absent, the runner sends none and the image's own default applies.
   * Clamped through the one cap either way.
   */
  timeoutSeconds?: number;
  onEvent?: (event: Record<string, unknown>) => void;
  /** The run's LAB_* context (lib/run-brief.ts); see DevboxRunOptions.lab. */
  lab?: DevboxLabContext;
  /** DE-35: the hold's meter, and the box a cut run's session stop marks stopped. */
  meter?: RunMeter | null;
  boxId?: string;
}): Promise<DevboxRunOutcome> {
  opts.signal?.throwIfAborted();
  const meter = opts.meter ?? null;
  // Offline, a dispatched job plays a scripted run instead of dead-ending.
  // Without this the one journey the Work page exists for — pick a suggested
  // card, queue it, watch it run — ended in a red "job failed" on every
  // machine without a deployed runtime, which is every machine anyone
  // develops on. One fake-run dialect: the same helpers the cron simulation
  // uses, so a tail cannot tell scheduled and dispatched work apart.
  if (mockAgentCore()) {
    const { playDispatchedRun } = await import('../lib/mock-bot-runner.js');
    const firstLine = opts.prompt.split('\n')[0] ?? '';
    const signal = anySignal([opts.signal, meter?.signal]);
    const onEvent = (ev: Record<string, unknown>): void => { opts.onEvent?.(ev); meter?.observe(ev); };
    let played: Awaited<ReturnType<typeof playDispatchedRun>>;
    try {
      played = await playDispatchedRun({
        title: firstLine.slice(0, 120) || 'queued job',
        ...(signal ? { signal } : {}),
        prompt: opts.prompt,
        onEvent,
      });
    } catch (err) {
      if (!meter?.cutoff) throw err;
      // The same cut the real path records (DE-35), offline.
      await meter.settled();
      const cutoff = meter.cutoff;
      opts.onEvent?.({ type: 'run_cutoff', ...cutoff, ts: new Date().toISOString() });
      return {
        ok: false, summary: '', turns: 0, durationMs: 0,
        costUsd: cutoff.meteredUsd > 0 ? cutoff.meteredUsd : null,
        costBasis: cutoff.meteredUsd > 0 ? 'estimated' : 'unknown',
        estimatedCostUsd: cutoff.meteredUsd > 0 ? cutoff.meteredUsd : null,
        model: opts.model ?? null, usage: null, toolCalls: 0, exitCode: null,
        error: cutoffMessage(cutoff), transcript: [], cutoff,
      };
    }
    if (meter) await meter.settled();
    return {
      ok: true, summary: played.summary, turns: played.turns,
      durationMs: played.durationMs, costUsd: played.costUsd, costBasis: 'reported', estimatedCostUsd: null,
      model: opts.model ?? null, usage: null,
      toolCalls: played.toolCalls, exitCode: 0, transcript: [],
    };
  }

  const arn = await resolveDevboxArn();
  if (!arn) {
    return {
      // A legitimate zero rather than a null: this run provably never reached a
      // model, so $0 is a fact, not an absence. `costUsd` is `number | null`
      // precisely so the two can be told apart — "no figure was reported" is
      // null (see lib/run-cost.ts), "nothing was spent because nothing ran" is
      // 0, and there are no token counts beside it to make it read as free.
      ok: false, summary: '', turns: 0, durationMs: 0, costUsd: 0, costBasis: 'reported', estimatedCostUsd: null,
      model: opts.model ?? null, usage: null, toolCalls: 0,
      exitCode: null, error: 'devbox runtime not deployed', transcript: [],
    };
  }
  return executeDevboxTask({
    ...(opts.signal ? { signal: opts.signal } : {}),
    sessionId: opts.sessionId,
    prompt: opts.prompt,
    ...(opts.resume !== undefined ? { resume: opts.resume } : {}),
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.timeoutSeconds ? { timeoutSeconds: opts.timeoutSeconds } : {}),
    ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
    ...(opts.lab ? { lab: opts.lab } : {}),
    ...(meter ? {
      meter,
      cutoffBackstop: {
        stop: async () => {
          await dataClient().send(new StopRuntimeSessionCommand({ agentRuntimeArn: arn, runtimeSessionId: opts.sessionId }));
        },
        ...(opts.boxId ? { onStopped: () => markStopped(opts.boxId!) } : {}),
      },
    } : {}),
    runtimeArn: arn,
    client: dataClient(),
  });
}

/**
 * Empty a box's workspace before it serves a different person (the devbox
 * image's `{"op": "wipe"}`, agents/devbox/main.py): files, repos and the
 * Claude Code session history the last occupant left behind. Offline there is
 * no workspace to empty, so it answers as an empty one would. Never throws:
 * the caller decides what a failed wipe means, and every caller refuses to
 * hand the box over on one.
 */
export async function wipeDevboxWorkspace(sessionId: string): Promise<{ ok: boolean; removed?: number; error?: string }> {
  if (mockAgentCore()) return { ok: true, removed: 0 };
  const arn = await resolveDevboxArn();
  if (!arn) return { ok: false, error: 'devbox runtime not deployed' };
  try {
    const resp = await dataClient().send(new InvokeRuntime({
      agentRuntimeArn: arn,
      qualifier: 'DEFAULT',
      runtimeSessionId: sessionId,
      payload: new TextEncoder().encode(JSON.stringify({ op: 'wipe' })),
    }));
    const body = resp.response as unknown as { transformToString?: () => Promise<string> } | undefined;
    const text = body?.transformToString ? await body.transformToString() : '';
    let parsed: { ok?: unknown; removed?: unknown; error?: unknown } = {};
    try { parsed = JSON.parse(text.trim().split('\n').pop() || '{}') as typeof parsed; } catch { /* not JSON */ }
    if (parsed.ok === true) return { ok: true, removed: typeof parsed.removed === 'number' ? parsed.removed : 0 };
    return { ok: false, error: typeof parsed.error === 'string' ? parsed.error : 'wipe not confirmed' };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
