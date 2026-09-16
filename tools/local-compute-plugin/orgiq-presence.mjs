#!/usr/bin/env node
// orgiq-presence — reference local-compute presence client.
//
// The machine half of docs/local-compute-presence.md: announces this
// machine's live Claude Code sessions to the OrgIQ middleware so they show
// in the portal's top-nav machine menu and (later) the Computer Lab.
//
// No daemon — the worker syncs on write, the design rule stolen from
// claude-mem's sync layer. Claude Code hooks invoke this script on session
// events; each invocation updates a local state file and pushes one announce.
// A failed push is dropped silently (presence is advisory; it must never
// slow a session down) and the next hook event re-announces the full
// snapshot, so there is nothing to retry.
//
// Setup:
//   1. In the portal header menu (or POST /api/local-compute/pair/start),
//      mint a pairing code, then:
//        node orgiq-presence.mjs pair <CODE> [--base http://localhost:3001]
//   2. Wire hooks in ~/.claude/settings.json:
//        "hooks": {
//          "SessionStart":      [{ "hooks": [{ "type": "command", "command": "node <here>/orgiq-presence.mjs hook" }] }],
//          "UserPromptSubmit":  [{ "hooks": [{ "type": "command", "command": "node <here>/orgiq-presence.mjs hook" }] }],
//          "Stop":              [{ "hooks": [{ "type": "command", "command": "node <here>/orgiq-presence.mjs hook" }] }],
//          "SessionEnd":        [{ "hooks": [{ "type": "command", "command": "node <here>/orgiq-presence.mjs hook" }] }]
//        }
//   3. Optional: `node orgiq-presence.mjs heartbeat` from cron/launchd every
//      minute keeps the node "connected" through long quiet stretches.
//
// Config lives at ~/.claude-mem/orgiq-presence.json (mode 0600):
//   { "baseUrl": "...", "nodeToken": "lcn_...", "nodeId": "...", "label": "..." }

import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { hostname, homedir, platform, arch } from 'node:os';
import { execSync } from 'node:child_process';
import { join, basename } from 'node:path';

const CONFIG_DIR = join(homedir(), '.claude-mem');
const CONFIG_PATH = join(CONFIG_DIR, 'orgiq-presence.json');
const STATE_PATH = join(CONFIG_DIR, 'orgiq-presence-state.json');
const SESSION_TTL_MS = 6 * 60 * 60_000; // a session silent this long is gone
const PUSH_TIMEOUT_MS = 3_000; // a dead network must never stall a hook

function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

function writeJson(path, value) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
  chmodSync(path, 0o600);
}

function git(args, cwd) {
  try {
    return execSync(`git ${args}`, { cwd, stdio: ['ignore', 'pipe', 'ignore'], timeout: 1500 })
      .toString().trim();
  } catch { return ''; }
}

async function post(config, path, body, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PUSH_TIMEOUT_MS);
  try {
    const res = await fetch(`${config.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

// ─── pair ────────────────────────────────────────────────────────────────────

async function pair(code, baseUrl) {
  const label = hostname().replace(/\.local$/, '');
  const config = readJson(CONFIG_PATH, {});
  const res = await post({ baseUrl }, '/api/local-compute/pair/claim', {
    code,
    node: {
      ...(config.nodeId ? { nodeId: config.nodeId } : {}),
      label,
      platform: `${platform()}/${arch()}`,
    },
  });
  if (!res.ok) {
    console.error(`pairing failed: ${res.status} ${await res.text()}`);
    // The server says the same thing for spent, expired and unknown codes on
    // purpose (a claim probe must learn nothing). This side knows more: if a
    // token for this base is already on disk, the code most likely did its job
    // the first time — a code is single-use — and what is missing is the
    // worker, not another pairing.
    if (config.nodeToken && config.baseUrl === baseUrl) {
      console.error(`this machine is already paired as ${config.label ?? label} (${config.nodeId}) against ${baseUrl};`);
      console.error('a pairing code is single-use, so a second run is expected to fail.');
      console.error(`next: ${NEXT_STEP}`);
    } else if (config.nodeToken) {
      console.error(`note: a token for ${config.baseUrl} is on disk; mint a new code in the portal to pair against ${baseUrl}.`);
    } else {
      console.error('mint a new code from Local compute › Pair a machine — codes expire and are single-use.');
    }
    process.exit(1);
  }
  const { nodeId, nodeToken } = await res.json();
  writeJson(CONFIG_PATH, { baseUrl, nodeId, nodeToken, label });
  console.log(`paired as ${label} (${nodeId}) against ${baseUrl}`);
  console.log(`token written to ${CONFIG_PATH} (0600) — it is shown nowhere else`);
  console.log('');
  console.log('Pairing only registers the machine — the portal shows it offline with no runnable');
  console.log('kinds until its worker is running. Next:');
  console.log(`  ${NEXT_STEP}`);
  console.log('then switch on "Accepting work" for it under Local compute.');
}

/** The one command every pairing message points at. The worker reads the token
 *  this step just wrote, announces the machine's models/kinds, and heartbeats. */
const NEXT_STEP = 'node tools/local-compute-worker.mjs   (from the aws-agentcore checkout; JOB_KINDS/LOCAL_MODELS env optional)';

// ─── hook: maintain the session snapshot, then announce it ───────────────────

function readHookEvent() {
  try {
    const raw = readFileSync(0, 'utf8');
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function sessionFromEvent(ev) {
  const cwd = ev.cwd ?? process.cwd();
  const branch = git('rev-parse --abbrev-ref HEAD', cwd);
  const remote = git('remote get-url origin', cwd);
  const repo = remote ? basename(remote, '.git') : basename(cwd);
  // The distilled intent line — the FIRST line of the prompt, truncated.
  // Deliberately never the full prompt: presence is glanceable metadata,
  // and prompt text stays on the machine.
  const promptLine = typeof ev.prompt === 'string'
    ? ev.prompt.split('\n')[0].slice(0, 160)
    : undefined;
  return {
    sessionId: ev.session_id ?? `unknown-${process.pid}`,
    harness: 'claude-code',
    repo,
    branch: branch || undefined,
    worktree: cwd,
    intent: promptLine,
    modelProvider: process.env.CLAUDE_CODE_USE_BEDROCK ? 'bedrock' : 'anthropic',
    model: ev.model ?? process.env.ANTHROPIC_MODEL ?? undefined,
    startedAt: Math.floor(Date.now() / 1000),
  };
}

function memoryState() {
  // If claude-mem's sync settings are present, report the sidecar's own
  // account of itself; otherwise sync is off. Deeper integration (real
  // outbox depth from the sidecar DB) replaces this whole function.
  const settings = readJson(join(CONFIG_DIR, 'settings.json'), {});
  const on = settings.CLAUDE_MEM_CLOUD_SYNC_TOKEN
    && settings.CLAUDE_MEM_CLOUD_SYNC_USER_ID
    && settings.CLAUDE_MEM_CLOUD_SYNC_HUB_URL;
  return on ? { mode: 'synced' } : { mode: 'disabled' };
}

async function handleHook() {
  const config = readJson(CONFIG_PATH, null);
  if (!config?.nodeToken) process.exit(0); // not paired — hooks stay silent

  const ev = readHookEvent();
  const state = readJson(STATE_PATH, { sessions: {} });
  const now = Date.now();

  if (ev.hook_event_name === 'SessionEnd' && ev.session_id) {
    delete state.sessions[ev.session_id];
  } else {
    const session = sessionFromEvent(ev);
    const prior = state.sessions[session.sessionId] ?? {};
    state.sessions[session.sessionId] = {
      ...prior,
      ...session,
      // A Stop event carries no prompt; keep the intent the session had.
      intent: session.intent ?? prior.intent,
      startedAt: prior.startedAt ?? session.startedAt,
      lastSeenAt: now,
    };
  }
  // Age out sessions that stopped announcing (crashed harness, no SessionEnd).
  for (const [id, s] of Object.entries(state.sessions)) {
    if (now - (s.lastSeenAt ?? 0) > SESSION_TTL_MS) delete state.sessions[id];
  }
  writeJson(STATE_PATH, state);
  await announce(config, state).catch(() => {}); // advisory — never fail the hook
}

async function announce(config, state) {
  const memory = memoryState();
  const sessions = Object.values(state.sessions).map((s) => ({ ...s, memory }));
  await post(config, '/api/local-compute/announce', { v: 1, sessions }, {
    authorization: `Bearer ${config.nodeToken}`,
  });
}

async function heartbeat() {
  const config = readJson(CONFIG_PATH, null);
  if (!config?.nodeToken) process.exit(0);
  const state = readJson(STATE_PATH, { sessions: {} });
  // A full re-announce, not a bare heartbeat: it is idempotent, it heals a
  // middleware restart, and it costs the same one request.
  await announce(config, state).catch(() => {});
}

// ─── main ────────────────────────────────────────────────────────────────────

const [cmd, ...args] = process.argv.slice(2);
switch (cmd) {
  case 'pair': {
    const code = args.find((a) => !a.startsWith('--'));
    const baseIdx = args.indexOf('--base');
    const baseUrl = baseIdx >= 0 ? args[baseIdx + 1] : 'http://localhost:3001';
    if (!code) { console.error('usage: orgiq-presence pair <CODE> [--base <url>]'); process.exit(1); }
    await pair(code, baseUrl.replace(/\/$/, ''));
    break;
  }
  case 'hook':
    await handleHook();
    break;
  case 'heartbeat':
    await heartbeat();
    break;
  default:
    console.error('usage: orgiq-presence <pair|hook|heartbeat>');
    process.exit(1);
}
