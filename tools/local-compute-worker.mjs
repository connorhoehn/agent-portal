#!/usr/bin/env node
// local-compute-worker — claim work from the OrgIQ queue and run it locally.
//
// The laptop half of the governed work loop: a paired machine registers its
// capabilities (models, kinds, concurrency), claims jobs from the queue, clones
// or updates the target repo, runs `claude -p` against it, and posts a fenced
// completion with token counts and the run report (local-compute-report.mjs: the final
// message's lab-report block, the skills the session loaded, the checkout's kept folders).
//
// Two inference modes, chosen by whether ANTHROPIC_BASE_URL is set:
//
//   anthropic (default) — `claude -p` exactly as the operator would run it at
//     the terminal: the machine's own Claude Code login, no env override
//     injected. The run is billed to whoever is signed in on this machine.
//     This is the mode for a laptop whose local model turned out too weak to
//     be worth the watts. The model is ALWAYS pinned, to Sonnet by default:
//     the account's interactive default may be a frontier model, and a fleet
//     of feature tickets is not what that is for. ANTHROPIC_MODEL may name a
//     Sonnet or Haiku id; anything else refuses to start.
//
//   PERMISSIONS. A run gets an explicit tool allowlist (ALLOWED_TOOLS below:
//     read, search, edit, git status/diff/log/show/add/commit, and the repo's
//     test commands: `npm test`, `npm run test:*`, `npx jest`, `npx vitest`,
//     `pytest`), a deny list for anything under .git/, and --permission-mode
//     dontAsk, so whatever is not allowed is refused, never prompted for. It is
//     never started with --dangerously-skip-permissions. The test commands are
//     kept only for a run whose working directory is the repo this worker
//     cloned for it; a job that names no repo runs without them, so `npm test`
//     is refused there (an edit to package.json plus `npm test` is a shell,
//     and outside the clone it would be a shell in whatever directory the
//     worker was started from). No general shell either way.
//
//   loopback — a local inference server (llama-server, Ollama, vLLM, anything
//     speaking the Anthropic Messages API) at ANTHROPIC_BASE_URL. Claude Code
//     is pointed at it through --settings with a placeholder key, and told a
//     real Anthropic model id the server then ignores. Marginal cost $0.
//
// Setup:
//   1. Pair the machine first (orgiq-presence.mjs or the portal header menu):
//        node orgiq-presence.mjs pair <CODE> [--base http://localhost:3001]
//   2. Switch on "Accepting work" for the machine in the portal under Local compute.
//   3. (loopback only) start the inference server and export ANTHROPIC_BASE_URL.
//   4. Run this worker:
//        node local-compute-worker.mjs
//
// The worker reads ~/.claude-mem/orgiq-presence.json for the node token (written
// by the pairing step) and announces its capabilities on every boot, so a
// restart picks up changes to the env vars below without requiring re-pairing.
// Every announce also carries a `metrics` snapshot (load average, CPU count,
// free/total memory, uptime, this file's version, how many jobs are held) so
// the fleet view can show live machine health, not only connected/stale/
// offline — see gatherMetrics() below.
//
// Environment (all optional, with sane defaults):
//   LOCAL_MODELS           comma-separated model list the machine advertises
//                          (default: ANTHROPIC_MODEL, else "claude-code" in
//                          anthropic mode; "qwen3.6-35b" in loopback mode)
//   JOB_KINDS              comma-separated, e.g. "local:task"
//   MAX_CONCURRENCY        how many jobs to hold at once (default: 2, the reference
//                          workstation's real slot count)
//   ANTHROPIC_BASE_URL     set it to run in loopback mode (e.g. http://127.0.0.1:8080)
//   ANTHROPIC_API_KEY      loopback only: any non-empty string (default: "local")
//   ANTHROPIC_MODEL        the model id passed as --model. Anthropic mode:
//                          default claude-sonnet-5, must match /sonnet|haiku/.
//                          Loopback mode needs one Claude Code recognizes even
//                          though the server ignores it (default there:
//                          claude-sonnet-4-5-20250929).
//   POLL_INTERVAL_S        how often to poll /claim when idle (default: 10)
//   REPOS_DIR              where to clone/update repos (default: ~/repos-worker)
//   LOCAL_ALLOWED_REPO_HOSTS
//                          comma-separated extra git hosts a job's repo may live on
//                          (GitHub Enterprise, GitLab), e.g. `github.example.com,gitlab.com`.
//                          github.com is always allowed. Set the same value on the
//                          middleware, which refuses to enqueue any other host.
//   LOCAL_ALLOWED_TOOLS    comma-separated Claude Code tool rules a run may use, replacing
//                          the default allowlist below (ALLOWED_TOOLS). Anything not
//                          listed is denied: the run is started with --permission-mode
//                          dontAsk, never --dangerously-skip-permissions.
//   LOCAL_SKILLS           "off" to stop installing the org's skill library (R8) into each
//                          run's checkout as project skills (default: on; see
//                          local-compute-skills.mjs — never touches ~/.claude/skills)
//   ORGIQ_PRESENCE_CONFIG  path of the pairing file to read instead of the
//                          default — for running a second worker (or a mock-mode
//                          audit with MOCK_NODE_TOKEN) without touching the real one
//
// THE DEBRIEF (lane C, docs/learning-loop-design.md Stage 2). The work turn runs with a
// --session-id the worker chose (the stream's own session_id wins if it differs). When the
// completion answer carries a debrief request, the worker keeps the checkout (no other job may
// reset it) and resumes that session once more: `claude -p <prompt> --resume <id> --fork-session
// --json-schema <schema>` with read-only tools plus writes under .lab/keep/, no shell or web
// tools, --permission-mode dontAsk, a dollar ceiling, the smaller model (LOCAL_DEBRIEF_MODEL,
// default Haiku) and a wall-clock timeout. It posts the answer and the one folder it names to
// POST /api/local-compute/jobs/:id/debrief, or says the session could not be resumed.
//
// The worker does NOT daemonize. Run it under systemd, launchd, tmux, or a plain
// shell — a failed claim, a dead network, or a revoked token all exit non-zero,
// and the operator decides whether to restart it.

import { readFileSync, writeFileSync, appendFileSync, statSync, mkdirSync, existsSync, createWriteStream, rmSync, lstatSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { syncProjectSkills, describeSync, skillsNote, BODY_MAX } from './local-compute-skills.mjs';
import { buildReport, sessionIdFromStream, debriefArgs, readDebriefFolder, debriefAnswerOf, SESSION_UUID } from './local-compute-report.mjs';
import { allowedToolsFrom, toolsForRun, allowedRepoHosts, normaliseRepoUrl, TEST_TOOLS } from './local-compute-policy.mjs';
import { join, basename, dirname } from 'node:path';
import { homedir, hostname, platform, arch, loadavg, cpus, totalmem, freemem, uptime } from 'node:os';

const CONFIG_PATH = process.env.ORGIQ_PRESENCE_CONFIG ?? join(homedir(), '.claude-mem', 'orgiq-presence.json');
const REPOS_DIR = process.env.REPOS_DIR ?? join(homedir(), 'repos-worker');
// Per-job run logs, tail-able while a job runs (`tail -f`), and the source the
// worker ships to the middleware for the browser log view. Also holds
// `worker.log`, the durable mirror of this process's OWN scrollback (see
// "Operational log" below) — kept out of the repo checkout so `git clean -fd`
// in ensureRepo never deletes a live log.
const LOG_DIR = process.env.WORKER_LOG_DIR ?? join(homedir(), '.claude-mem', 'orgiq-worker-logs');
const POLL_INTERVAL_S = parseInt(process.env.POLL_INTERVAL_S ?? '10', 10) || 10;
// See the header: loopback iff a base URL is given. Nothing is defaulted to
// 127.0.0.1 any more — a worker that silently pointed `claude` at a server
// nobody started failed every job with a connection refusal.
const ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL || null;
const INFERENCE = ANTHROPIC_BASE_URL ? 'loopback' : 'anthropic';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? 'local';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL
  ?? (INFERENCE === 'loopback' ? 'claude-sonnet-4-5-20250929' : 'claude-sonnet-5');
// The cost ceiling for work handed to a laptop. Simple tickets on a frontier
// model (Opus, Fable) burn an order of magnitude more per run for no better
// outcome, and because this mode bills the operator's own account the number
// never shows up in the org's allocation where a brake would catch it. The
// check is on the id string rather than a fixed list so a new Sonnet/Haiku
// release works without editing this file.
if (INFERENCE === 'anthropic' && !/sonnet|haiku/i.test(ANTHROPIC_MODEL)) {
  console.error(`ANTHROPIC_MODEL=${ANTHROPIC_MODEL} is not a Sonnet or Haiku id — local compute runs only those (set ANTHROPIC_MODEL=claude-sonnet-5 or claude-haiku-4-5-20251001)`);
  process.exit(1);
}

// The worker self-reports these on every boot. Each can only NARROW what it is
// offered, never widen: kinds are intersected with the server's allowlist,
// concurrency is capped by the server's ceiling, and `accept_jobs` is the
// owner's switch — so a bearer token on somebody's laptop is acceptable.
const LOCAL_MODELS = (process.env.LOCAL_MODELS
  ?? (INFERENCE === 'loopback' ? 'qwen3.6-35b' : (ANTHROPIC_MODEL ?? 'claude-code')))
  .split(',').map((s) => s.trim()).filter(Boolean);
const JOB_KINDS = (process.env.JOB_KINDS ?? 'local:task')
  .split(',').map((s) => s.trim()).filter(Boolean);
const MAX_CONCURRENCY = Math.max(1, parseInt(process.env.MAX_CONCURRENCY ?? '2', 10) || 2);
// R8: install the org's skill library into each run's checkout as project skills.
const LOCAL_SKILLS = (process.env.LOCAL_SKILLS ?? 'on').toLowerCase() !== 'off';

// What a run may do, as Claude Code permission rules. It used to run with
// --dangerously-skip-permissions, so a prompt (a work item's text, which other
// people write) could do anything this machine's account can. The default
// (DEFAULT_ALLOWED_TOOLS in local-compute-policy.mjs) is a code change in the
// checkout: read and search it, edit it, follow the org's skills, look at or
// commit its git state, and run its tests. The test commands are dropped for
// any run that is not inside the repo this worker cloned for it (toolsForRun,
// applied in runTask), whatever list they came from. LOCAL_ALLOWED_TOOLS
// replaces the default list on this machine.
const ALLOWED_TOOLS = allowedToolsFrom(process.env.LOCAL_ALLOWED_TOOLS);
// Hosts a job's repo may be cloned from: github.com plus LOCAL_ALLOWED_REPO_HOSTS.
const REPO_HOSTS = allowedRepoHosts(process.env.LOCAL_ALLOWED_REPO_HOSTS);
// Never widened by LOCAL_ALLOWED_TOOLS, and deny wins over allow. A run that
// could write .git/ could plant .git/hooks/pre-commit (or point core.hooksPath
// somewhere) and then `git commit`, which runs the hook: a shell by another
// name. Both the checkout's own .git and any nested one are covered. Only
// Edit(path) rules are matched by Claude Code's file checks, and they cover
// every file-editing tool (Write and NotebookEdit included); the CLI warns
// about and ignores Write(path) / NotebookEdit(path) deny rules.
const DISALLOWED_TOOLS = ['Edit(./.git/**)', 'Edit(**/.git/**)'];

// Bumped by hand when this file's behaviour changes in a way worth seeing on
// the fleet view (a job kind added, a claim-loop fix). Reported in
// `metrics.workerVersion` — informational only, nothing server-side gates on
// it today.
const WORKER_VERSION = '1.3.0';

// ─── Logging ─────────────────────────────────────────────────────────────────
//
// One line, one fact, stamped. The worker runs unattended in a terminal that
// someone scrolls back through hours later, usually to answer "what was it
// doing when the portal said X" — and the old output had no clock in it at
// all, so a run could not be lined up against anything. Levels are a single
// glyph rather than a word: they scan in a narrow terminal and they do not
// pretend to be a structured log this thing does not ship.
const LEVEL_GLYPH = { info: '·', ok: '✓', warn: '!', err: '✗', step: '→' };

function stamp() {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

// ─── Operational log: shipped to the middleware, mirrored to disk ───────────
//
// Every emit() line below — registered, paired, presence acknowledged, a
// claim refused, a heartbeat rejected — used to live ONLY in whatever
// terminal started this process. That is the exact gap the "I paired this
// machine before I left and now I can't see what it's been doing" report
// named: presence says CONNECTED, but nothing between jobs was ever visible
// away from the machine itself. This ring, and the two things that drain it,
// close that without changing what emit() looks like to call.
//
// Bounded on every axis a long-lived worker can grow one:
//   * NODE_LOG_MAX_PENDING / NODE_LOG_RING_MAX_BYTES — the in-memory ring
//     (count AND bytes, so a handful of long lines can't outrun the count
//     cap before the byte cap catches them). Oldest lines drop first: a
//     machine unreachable for hours costs scrollback, never unbounded memory.
//   * NODE_LOG_BATCH_MAX — lines per flush POST, matching the server's own
//     MAX_NODE_LOG_BATCH so a full ring drains in exactly one flush.
//   * NODE_LOG_FLUSH_MS — how often the ring is drained. Well below the
//     10s claim-poll interval, so a line is visible in the browser before
//     the next thing this worker does.
//   * WORKER_LOG_FILE_MAX_BYTES — the local mirror under LOG_DIR, trimmed to
//     its tail when it grows past the cap (see trimWorkerLogFileIfNeeded).
//
// Both drains are best-effort: a failed ship leaves the ring alone for the
// next tick (the server dedupes by seq, so a line sent twice after a
// timed-out-but-actually-delivered POST is a safe no-op), and a failed file
// write is swallowed — the terminal is still the thing nobody has ever lost.
const NODE_LOG_MAX_PENDING = 200;
const NODE_LOG_RING_MAX_BYTES = 64 * 1024;
const NODE_LOG_MAX_LINE = 2_000;
const NODE_LOG_BATCH_MAX = 50;
const NODE_LOG_FLUSH_MS = 5_000;
const WORKER_LOG_FILE_MAX_BYTES = 2 * 1024 * 1024;

let nodeLogSeq = 0;
/**
 * This process's boot id, sent with every shipped batch.
 *
 * `nodeLogSeq` above restarts at 0 on every worker start, and the middleware
 * used to dedupe on that number alone — so a restarted worker's whole startup
 * log was silently discarded as "already seen" and the Computer Lab kept
 * rendering the previous, dead run. The server now orders the ring itself and
 * treats (run, seq) as the dedupe identity, which needs exactly one new fact
 * from here: something that differs between two runs of this worker.
 */
const NODE_LOG_RUN_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const nodeLogRing = []; // [{ seq, text }], FIFO — oldest first
let nodeLogRingBytes = 0;

/** Queue one rendered line for the next flush. Called from emit() itself, not
 *  from call sites — so every log level ships, not just what a caller
 *  remembers to forward (the job-log path, by contrast, ships the child's raw
 *  stdout, which is a different stream entirely). */
/**
 * Lines that stay LOCAL — written to the terminal and the on-disk mirror, but
 * never shipped to the server for the Computer Lab pane to render.
 *
 * The pane is "what is this machine doing", and it was showing the worker's
 * startup paperwork instead: where the token file lives, and one
 * `still waiting for "Accepting work"` tick per minute for as long as the
 * machine sat paused — nine of them in a ten-minute window, crowding out
 * everything that matters.
 *
 * The token path is the sharper of the two. It is deliberately printed on the
 * operator's own terminal ("it is shown nowhere else"), and shipping it put an
 * absolute path to a 0600 credential file into a log that every viewer of the
 * fleet can read. Local-only is where it belonged all along.
 *
 * Heartbeats are dropped rather than rate-limited: the machine's presence
 * already says it is alive, so a log line repeating it adds nothing the row
 * does not show. The transitions around them — paused, switched on, claiming —
 * all still ship.
 */
const LOCAL_ONLY_LOG = [
  /token written to /,
  // Same category as the token path, and it was still shipping: this reports
  // what happened to a FILE on the operator's own disk, which is nothing the
  // fleet can act on and slightly alarming to a reader who owns a different
  // machine ("replaced ... on this machine" reads like someone took theirs).
  /this replaced the previous token on this machine/,
  /still waiting for "Accepting work"/,
];

function queueNodeLogLine(line) {
  if (LOCAL_ONLY_LOG.some((re) => re.test(line))) return;
  const text = line.length > NODE_LOG_MAX_LINE ? line.slice(0, NODE_LOG_MAX_LINE) : line;
  nodeLogRing.push({ seq: nodeLogSeq++, text });
  nodeLogRingBytes += text.length;
  while ((nodeLogRing.length > NODE_LOG_MAX_PENDING || nodeLogRingBytes > NODE_LOG_RING_MAX_BYTES) && nodeLogRing.length > 1) {
    const dropped = nodeLogRing.shift();
    nodeLogRingBytes -= dropped.text.length;
  }
}

let workerLogLinesSinceCheck = 0;

/** Append one line to the durable local mirror, WORKER_LOG_DIR/worker.log.
 *  Fire-and-forget, same posture as everything else here: a disk error must
 *  never interrupt the run loop. Size-checked every ~200 lines rather than on
 *  every write — a stat() per line would make this feature busier than the
 *  process it logs. */
function appendWorkerLogFile(line) {
  try {
    if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
    const path = join(LOG_DIR, 'worker.log');
    appendFileSync(path, `${line}\n`);
    workerLogLinesSinceCheck += 1;
    if (workerLogLinesSinceCheck >= 200) {
      workerLogLinesSinceCheck = 0;
      trimWorkerLogFileIfNeeded(path);
    }
  } catch { /* the terminal and the ring are still authoritative */ }
}

/** Keep worker.log from growing without bound over a worker's lifetime
 *  (weeks, per this file's header). Trims to the TAIL at a newline boundary
 *  — the most recent history is what "what has this machine been doing"
 *  needs, and a rewrite that started mid-line would corrupt the first
 *  surviving line. */
function trimWorkerLogFileIfNeeded(path) {
  try {
    if (statSync(path).size <= WORKER_LOG_FILE_MAX_BYTES) return;
    const text = readFileSync(path, 'utf8');
    const keepFrom = Math.floor(text.length / 2);
    const nl = text.indexOf('\n', keepFrom);
    writeFileSync(path, nl >= 0 ? text.slice(nl + 1) : text.slice(keepFrom));
  } catch { /* best-effort trim — a failure here just means the file grows a bit more */ }
}

/** Drain up to NODE_LOG_BATCH_MAX queued lines to the middleware. Lines are
 *  removed from the ring only once the POST succeeds — a failed flush is
 *  retried whole on the next tick rather than losing the batch, and the
 *  ring's own cap (not this function giving up) is what bounds an
 *  unreachable middleware. */
async function shipNodeLog(config) {
  if (nodeLogRing.length === 0) return;
  const batch = nodeLogRing.slice(0, NODE_LOG_BATCH_MAX);
  try {
    const res = await post(config, '/api/local-compute/log', { lines: batch, run: NODE_LOG_RUN_ID }, authHeaders(config));
    if (res.ok) {
      nodeLogRing.splice(0, batch.length);
      nodeLogRingBytes -= batch.reduce((n, e) => n + e.text.length, 0);
    }
    // Anything else (a 404 against an older middleware with no route yet, a
    // 401 against a rotated token) is left for the next tick — same
    // best-effort posture as shipLog() for per-job output.
  } catch {
    /* unreachable — the ring and worker.log are still the record */
  }
}

/** Starts the periodic flush. Called once config is available (pairing and
 *  early startup lines still queue; they ship on the first tick). */
function startNodeLogShipping(config) {
  setInterval(() => { void shipNodeLog(config); }, NODE_LOG_FLUSH_MS).unref();
}

/** `indent` is for lines that belong to the job above them. */
function emit(level, msg, indent = 0) {
  const line = `${stamp()} ${LEVEL_GLYPH[level] ?? '·'} ${'  '.repeat(indent)}${msg}`;
  if (level === 'err' || level === 'warn') console.error(line); else console.log(line);
  appendWorkerLogFile(line);
  queueNodeLogLine(line);
}

const log = {
  info: (m, i) => emit('info', m, i),
  ok: (m, i) => emit('ok', m, i),
  warn: (m, i) => emit('warn', m, i),
  err: (m, i) => emit('err', m, i),
  step: (m, i) => emit('step', m, i),
  /** A blank separator that still carries the stamp column's width. */
  gap: () => console.log(''),
};

/** Short form of a job id for line prefixes — the uuid tail is enough. */
function shortId(id) {
  return typeof id === 'string' && id.length > 12 ? `${id.slice(0, 8)}…` : String(id ?? '?');
}

/**
 * A failed response, said usefully.
 *
 * The old text was `claim failed: 500 ` — status, then an empty body, then
 * nothing about what to do. An empty body on a dev middleware almost always
 * means it restarted mid-request (its pairings live in memory), so that is
 * worth naming rather than leaving someone to guess.
 */
async function describeFailure(res) {
  let body = '';
  try { body = (await res.text()).trim(); } catch { body = ''; }
  let detail = body;
  try { const j = JSON.parse(body); detail = j.error ?? body; } catch { /* not json */ }
  if (!detail) {
    detail = res.status >= 500
      ? '<empty body> — the server may have restarted mid-request'
      : '<empty body>';
  }
  return `${res.status} ${detail}`;
}

// ─── Pairing, so first run is one command ────────────────────────────────────
//
// It used to take two: claim the code with the presence plugin, then start
// this worker. Two commands to paste, and the gap between them is where a
// first run goes wrong — the portal shows the machine paired but offline, and
// nothing on screen says the second command is the missing half. `--pair
// <code>` folds the claim in: same endpoint and same token file the plugin
// writes, so the two paths cannot drift, and running it with a code already
// on disk re-keys the machine exactly as a re-pair does.
function parseArgs(argv) {
  const out = { pairCode: null, baseUrl: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--pair') { out.pairCode = argv[i + 1] ?? null; i += 1; }
    else if (argv[i] === '--base') { out.baseUrl = (argv[i + 1] ?? '').replace(/\/$/, '') || null; i += 1; }
  }
  return out;
}

async function pairWithCode(code, baseUrl) {
  const label = hostname().replace(/\.local$/, '');
  let existing = {};
  try { existing = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); } catch { /* first pairing */ }
  const base = baseUrl ?? existing.baseUrl ?? 'http://localhost:3001';
  const res = await fetch(`${base}/api/local-compute/pair/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      code,
      node: { ...(existing.nodeId ? { nodeId: existing.nodeId } : {}), label, platform: `${platform()}/${arch()}` },
    }),
  });
  if (!res.ok) {
    log.err(`pairing failed: ${await describeFailure(res)}`);
    // The server answers the same way for spent, expired and unknown codes on
    // purpose — a claim probe must learn nothing. This side knows more.
    if (existing.nodeToken && existing.baseUrl === base) {
      log.info(`this machine is already paired as ${existing.label ?? label} (${existing.nodeId}) against ${base}; a code is single-use, so a second run is expected to fail.`, 1);
      log.info('drop --pair and just run this worker.', 1);
    } else {
      log.info('mint a fresh code from Local compute › Pair a machine — codes expire and are single-use.', 1);
    }
    process.exit(1);
  }
  const { nodeId, nodeToken } = await res.json();
  const rePaired = Boolean(existing.nodeToken);
  // The claim has already succeeded here and a pairing code is SINGLE-USE, so
  // anything that throws between this line and a written token burns the code
  // with nothing to show for it. On a machine that has never run the presence
  // plugin, ~/.claude-mem does not exist and writeFileSync fails with ENOENT —
  // which is exactly the fresh-machine case this flag exists to serve. Create
  // the directory first (the plugin has always done this) and, if the write
  // still fails, say plainly that the code is spent rather than exiting on a
  // stack trace.
  try {
    mkdirSync(dirname(CONFIG_PATH), { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify({ baseUrl: base, nodeId, nodeToken, label }, null, 2), { mode: 0o600 });
  } catch (err) {
    log.err(`paired, but the token could not be written to ${CONFIG_PATH}: ${err.message}`);
    log.info('That code is now spent — mint a fresh one from Local compute › Pair a machine once the path is writable.', 1);
    process.exit(1);
  }
  log.ok(`paired as ${label} (${nodeId}) against ${base}`);
  if (rePaired) log.info('this replaced the previous token on this machine', 1);
  log.info(`token written to ${CONFIG_PATH} (0600) — it is shown nowhere else`, 1);
}

function readConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    log.err(`config not found at ${CONFIG_PATH} — pair this machine first from Local compute › Pair a machine`);
    process.exit(1);
  }
}

async function post(config, path, body, headers = {}) {
  const res = await fetch(`${config.baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return res;
}

function authHeaders(config) {
  return { authorization: `Bearer ${config.nodeToken}` };
}

// ─── Registration ────────────────────────────────────────────────────────────

async function register(config, { quiet = false } = {}) {
  const res = await post(config, '/api/local-compute/register', {
    localModels: LOCAL_MODELS,
    jobKinds: JOB_KINDS,
    maxConcurrency: MAX_CONCURRENCY,
  }, authHeaders(config));

  if (!res.ok) {
    const text = await res.text();
    log.err(`registration failed: ${res.status} ${text.trim() || '<empty body>'}`);
    process.exit(1);
  }

  const body = await res.json();
  if (typeof body.heartbeatIntervalS === 'number' && body.heartbeatIntervalS > 0) {
    heartbeatIntervalS = body.heartbeatIntervalS;
  }
  if (!quiet) {
    log.ok(`registered as ${config.label ?? 'this machine'} against ${config.baseUrl}`);
    log.info(`kinds: ${body.jobKinds.join(', ') || 'none'} · models: ${body.localModels.join(', ') || 'none'} · slots: ${body.maxConcurrency}`, 1);
  }
  if (!quiet && body.rejectedKinds?.length) {
    log.warn(`rejected kinds: ${body.rejectedKinds.join(', ')} — the fleet does not run these here`, 1);
    log.info(`runnable kinds: ${body.runnableKinds.join(', ')}`, 1);
  }
  return body;
}

/**
 * Park until the portal switches this machine on.
 *
 * The first version of this printed a sentence and exited, which meant the
 * documented first run — pair, start the worker, then flip "Accepting work" —
 * always ended with the worker dead and a second `node tools/…` to type. It
 * now re-registers on the poll interval and starts the moment the switch
 * flips, saying so once rather than every tick.
 */
async function waitForAcceptJobs(config, why) {
  log.warn(`paused: ${why}.`);
  log.info('Switch on "Accepting work" for this machine under Local compute — this worker picks it up on its own, no restart needed.', 1);
  let ticks = 0;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_S * 1000));
    ticks += 1;
    let reg;
    try {
      // Quiet: this re-registers on every poll tick, and repeating the
      // whole registration block ten times a minute buries the one line that
      // matters when the switch finally flips.
      reg = await register(config, { quiet: true });
    } catch (err) {
      log.warn(`still paused — cannot reach ${config.baseUrl} (${err.message})`, 1);
      continue;
    }
    if (reg.acceptJobs) {
      log.ok('switched on in the portal — claiming again');
      return reg;
    }
    // Once a minute, not every ten seconds: a reminder that repeats faster
    // than you can act on it is just noise in the scrollback.
    if (ticks % Math.max(1, Math.round(60 / POLL_INTERVAL_S)) === 0) {
      log.info(`still waiting for "Accepting work" (${ticks * POLL_INTERVAL_S}s)`, 1);
    }
  }
}

// ─── Claim loop ──────────────────────────────────────────────────────────────

// jobId → { claimToken, sessionId, title, repo, startedAt (ms), child, logSeq }
// startedAt is a wall-clock ms stamp for the presence card; child is the live
// `claude` process so the heartbeat loop can kill a run whose claim was lost.
const held = new Map();

async function claim(config) {
  // `projectSkills`: this worker installs the org's skill library into the run's checkout, so the
  // frozen brief may say so (only for a job with a repo; see local-compute-skills.mjs).
  const res = await post(config, '/api/local-compute/claim', LOCAL_SKILLS ? { projectSkills: true } : {}, authHeaders(config));

  if (res.status === 204) return null; // empty queue
  if (res.status === 429) {
    const body = await res.json();
    if (body.gate === 'concurrency') {
      // At the slot limit — this is expected, not an error. Sleep and retry.
      return null;
    }
  }
  if (res.status === 409) {
    const body = await res.json();
    if (body.gate === 'accept_jobs') {
      // Was `process.exit(1)`. Switching the machine off in the portal is a
      // normal, reversible thing to do — it should pause this worker, not
      // kill it and make someone come back to the terminal to restart it.
      await waitForAcceptJobs(config, 'the portal switched this machine off');
      return null;
    }
    if (body.gate === 'kinds') {
      log.err('no runnable job kinds registered — set JOB_KINDS to a kind the fleet dispatches and restart');
      process.exit(1);
    }
  }
  if (res.status === 503) {
    const body = await res.json();
    if (body.gate === 'migration') {
      log.err('cluster has not applied schema/local_compute_worker_schema.sql — cannot fence claims');
      process.exit(1);
    }
  }
  if (!res.ok) {
    log.warn(`claim failed: ${await describeFailure(res)} — retrying in ${POLL_INTERVAL_S}s`);
    return null;
  }

  const body = await res.json();
  held.set(body.job.id, {
    claimToken: body.claimToken,
    sessionId: body.sessionId,
    title: body.job.title ?? body.job.id,
    repo: body.job.payload?.repo ?? null,
    // What the frozen brief told the run about the org's skills (dir null: "not on this machine").
    skillLibrary: body.skillLibrary ?? null,
    startedAt: Date.now(),
    child: null,
    logSeq: 0,
  });
  log.gap();
  log.ok(`claimed ${shortId(body.job.id)} — ${body.job.title}`);
  log.info(`slots ${body.slots.held}/${body.slots.limit} · heartbeat ${body.heartbeatIntervalS}s · stale after ${body.staleMinutes}m`, 1);
  return body;
}

// ─── Presence + live logs ─────────────────────────────────────────────────────
//
// A pull-side worker is a fleet participant, not a black box: while it holds
// jobs it announces them as presence sessions (so the browser shows the machine
// CONNECTED with a card per running job, exactly like an interactive Claude Code
// session), and it ships each run's output to the middleware so the same view
// can tail the log. An idle-but-running worker still announces (an empty session
// set) so it reads 'connected' rather than dropping to 'offline' between jobs.

// Filled from the register response; announce well inside the connected horizon.
let heartbeatIntervalS = 20;

function presenceSessions() {
  const sessions = [];
  for (const [jobId, h] of held.entries()) {
    sessions.push({
      sessionId: jobId,
      harness: 'claude-code',
      intent: h.title,
      model: h.model ?? ANTHROPIC_MODEL ?? LOCAL_MODELS[0],
      modelProvider: INFERENCE === 'loopback' ? 'local' : 'anthropic',
      startedAt: h.startedAt,
      ...(h.repo ? { repo: h.repo } : {}),
    });
  }
  return sessions;
}

/**
 * Machine health for the announce tick — cheap, synchronous, `node:os` only.
 * Each reading is wrapped individually: a single throwing call (a sandboxed
 * environment, a container missing `/proc`) drops that one field rather than
 * the whole announce, matching the contract's "all fields optional" and the
 * instruction to degrade silently. Never any I/O, so it can never make the
 * announce tick slower than the network call it rides on.
 */
function gatherMetrics() {
  const metrics = { workerVersion: WORKER_VERSION, activeJobs: held.size };
  try { metrics.loadAvg1 = loadavg()[0]; } catch { /* not available on this platform */ }
  try { metrics.cpuCount = cpus().length; } catch { /* not available on this platform */ }
  try {
    metrics.memTotalMb = Math.round(totalmem() / (1024 * 1024));
    metrics.memFreeMb = Math.round(freemem() / (1024 * 1024));
  } catch { /* not available on this platform */ }
  try { metrics.uptimeS = Math.round(uptime()); } catch { /* not available on this platform */ }
  return metrics;
}

// Presence is best-effort in the sense that a missed announce must never take
// down the run loop — but it is not silent. The first version swallowed every
// response, so a worker whose token had been rotated (a second pairing of the
// same machine re-keys the row) kept printing its normal cadence while the
// server aged the machine to offline: the operator's terminal said connected
// and the portal said otherwise, with nothing to reconcile them.
let presenceState = 'unknown'; // 'ok' | 'failing' | 'unknown'
async function announce(config) {
  let res;
  try {
    res = await post(config, '/api/local-compute/announce',
      { sessions: presenceSessions(), metrics: gatherMetrics() }, authHeaders(config));
  } catch (err) {
    if (presenceState !== 'failing') log.warn(`presence: cannot reach ${config.baseUrl} (${err.message}) — the portal will show this machine stale, then offline, until it can`);
    presenceState = 'failing';
    return;
  }
  if (res.status === 401 || res.status === 403) {
    // The token on disk may be newer than the one in memory (re-paired while
    // running). Adopt it once; if the server still refuses, say so and stop —
    // an unauthenticated worker can neither claim nor report, so idling here
    // only looks like working.
    const fresh = reloadToken(config);
    if (fresh) { log.ok('presence: token was rotated on disk (re-paired) — adopted the new one without restarting'); presenceState = 'unknown'; return; }
    log.err(`presence: ${config.baseUrl} rejected this machine's token (${res.status}).`);
    log.info('Most often this is the dev middleware having restarted: it keeps pairings in memory, so every restart forgets this machine.', 1);
    log.info('Re-pair from Local compute › Pair a machine, then start this worker again.', 1);
    process.exit(2);
  }
  if (!res.ok) {
    if (presenceState !== 'failing') log.warn(`presence: announce failed (${res.status}) — retrying every tick`);
    presenceState = 'failing';
    return;
  }
  if (presenceState !== 'ok') log.ok('presence: acknowledged — the portal shows this machine connected');
  presenceState = 'ok';
}

/** Re-read the pairing file; true when it carries a different token. */
function reloadToken(config) {
  try {
    const next = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    if (next?.nodeToken && next.nodeToken !== config.nodeToken) { config.nodeToken = next.nodeToken; return true; }
  } catch { /* unreadable — nothing to adopt */ }
  return false;
}

// Ship a chunk of run output to the middleware's per-job log. Fenced by the
// claim token, like every other post-claim write. Degrades silently: a 404 (a
// middleware without the log route) or any error must not disturb the run — the
// authoritative copy is the local file under LOG_DIR, which is always written.
async function shipLog(config, jobId, chunk) {
  const h = held.get(jobId);
  if (!h) return;
  try {
    await post(config, `/api/local-compute/jobs/${jobId}/log`,
      { claimToken: h.claimToken, seq: h.logSeq++, chunk }, authHeaders(config));
  } catch {
    /* local file is the source of truth; shipping is best-effort */
  }
}

// ─── Repo sync ───────────────────────────────────────────────────────────────

// The shapes the middleware hands out (routes/local-compute.ts `normaliseRepo`):
// an https or ssh URL on github.com or a LOCAL_ALLOWED_REPO_HOSTS host whose
// owner/name is plain. Checked here as well, so a row written before that
// check (or by another enqueuer) never reaches git.
//
// Returns the run's working directory and the clone it is in. A job with no
// repo runs in the worker's own directory with clonePath null, which is what
// keeps the test commands off that run (toolsForRun).
function ensureRepo(rawRepo) {
  if (!rawRepo) return { cwd: process.cwd(), clonePath: null };
  const repoUrl = normaliseRepoUrl(rawRepo, REPO_HOSTS.hosts);
  if (!repoUrl) {
    throw new Error(`repo ${JSON.stringify(rawRepo)} is not a repository URL on an allowed host (${REPO_HOSTS.hosts.join(', ')}; LOCAL_ALLOWED_REPO_HOSTS adds more)`);
  }
  const name = basename(repoUrl, '.git');
  if (!name || /^\.+$/.test(name) || name.startsWith('-')) throw new Error(`repo name ${JSON.stringify(name)} is not usable`);
  const repoPath = join(REPOS_DIR, name);

  if (!existsSync(REPOS_DIR)) mkdirSync(REPOS_DIR, { recursive: true });

  // Every git call takes an argument array and no shell: the job's `repo`
  // once reached `execSync` as part of a command line.
  if (existsSync(repoPath)) {
    log.step(`updating ${name}`, 1);
    // Discard any local changes — the workspace is ephemeral and the worker is
    // the only writer, so anything uncommitted is leftover junk from a prior run.
    execFileSync('git', ['reset', '--hard', 'HEAD'], { cwd: repoPath, stdio: 'ignore' });
    execFileSync('git', ['clean', '-fd'], { cwd: repoPath, stdio: 'ignore' });
    execFileSync('git', ['pull', '--ff-only'], { cwd: repoPath, stdio: 'ignore' });
  } else {
    log.step(`cloning ${name}`, 1);
    // The machine uses its OWN git credentials, not a borrowed token. Shipping
    // the middleware's GitHub token to a laptop would make a stolen node token
    // a way to clone every private repo the service account can reach.
    execFileSync('git', ['clone', '--', repoUrl, name], { cwd: REPOS_DIR, stdio: 'ignore' });
  }
  return { cwd: repoPath, clonePath: repoPath };
}

// ─── Run ─────────────────────────────────────────────────────────────────────

// ─── Skills (R8) ─────────────────────────────────────────────────────────────

/** The org's skill library for this run, over the fenced work-loop door. */
async function fetchSkills(config, jobId, claimToken, have) {
  const res = await post(config, `/api/local-compute/jobs/${encodeURIComponent(jobId)}/skills`,
    { claimToken, ...(have ? { have } : {}) }, authHeaders(config));
  const len = Number(res.headers.get('content-length') ?? '0');
  if (res.status === 200 && len > BODY_MAX) return { status: 413, body: '', sha: '' };
  return {
    status: res.status,
    body: res.status === 200 ? await res.text() : '',
    sha: res.headers.get('x-skill-library-sha256') ?? '',
  };
}

/**
 * Install the library into the run's checkout (never ~/.claude/skills) and return the line the
 * run is told when that disagrees with its frozen brief, or null.
 */
async function equipRun(config, jobId, cwd) {
  const h = held.get(jobId);
  const briefDir = h?.skillLibrary?.dir ?? null;
  if (!LOCAL_SKILLS) return skillsNote({ status: 'refused', why: 'LOCAL_SKILLS=off on this worker' }, briefDir);
  const r = await syncProjectSkills({ workdir: cwd, fetchLibrary: (have) => fetchSkills(config, jobId, h.claimToken, have) });
  log[r.status === 'installed' || r.status === 'unchanged' ? 'info' : 'warn'](describeSync(r), 1);
  return skillsNote(r, briefDir);
}

function runTask(config, jobId, cwd, prompt, systemNote = null, clonePath = null) {
  const started = Date.now();
  // The repo's test commands only inside the clone this worker made for the
  // run; anywhere else `npm test` and friends are refused like any other shell.
  const tools = toolsForRun(ALLOWED_TOOLS, { cwd, clonePath });
  if (tools.length < ALLOWED_TOOLS.length) log.info(`no cloned repo: test commands off for this run (${TEST_TOOLS.filter((t) => ALLOWED_TOOLS.includes(t)).length} removed)`, 1);
  // Loopback only. In anthropic mode NO settings block is passed: `claude -p`
  // resolves auth and model exactly as it would for the operator at a terminal,
  // and an injected placeholder key would override that login and 401.
  const settingsOverride = INFERENCE === 'loopback'
    ? JSON.stringify({
      env: {
        CLAUDE_CODE_USE_BEDROCK: '0',
        ANTHROPIC_BASE_URL,
        ANTHROPIC_API_KEY,
      },
    })
    : null;

  // The command built here is what the devbox agent does, minus the microVM
  // glue: `claude -p` with --model (must be recognized by Claude Code even
  // though llama.cpp ignores it), an explicit tool allowlist with
  // --permission-mode dontAsk (anything not on ALLOWED_TOOLS is denied rather
  // than prompted for; this machine is a person's laptop, not a sandbox), and
  // --settings (env block outranks process.env, so this is the only way to
  // reliably point at loopback). The prompt is passed as a single string
  // argument, not via stdin.
  //
  // `--output-format stream-json` rather than `json`, and it is what makes the
  // log worth having: `json` buffers the ENTIRE run and emits one object at
  // exit, so both the local file and the browser view sat at the header for
  // minutes and then filled in all at once — a progress view that only works
  // once there is no longer any progress to watch. stream-json emits one JSON
  // object per line as the run happens. It REQUIRES --verbose (claude refuses
  // the combination otherwise), and the final line is the same
  // `{type:'result',...}` object `json` would have returned on its own.
  //
  // spawn with an args array, NOT a joined string through a shell: the prompt has
  // spaces and the --settings value is JSON full of quotes. A shell would
  // word-split the prompt and strip the JSON's quotes (claude then rejects it as
  // invalid JSON). Each argument reaches claude verbatim, unquoted.
  //
  // ASYNC on purpose: a local model run takes minutes, and the old synchronous
  // execFileSync blocked the event loop for its whole duration — no heartbeats
  // fired, the pooled keep-alive socket to the middleware went stale, and the
  // very next request (the completion POST) died with `fetch failed`. Running it
  // as a child keeps the loop free to heartbeat, announce presence and ship logs.
  // Lane C: the session id is chosen here (`--session-id`, a documented flag) so the debrief can
  // resume exactly this session even if the stream is cut short; the stream's own `session_id`
  // (every stream-json event carries it) wins when it disagrees.
  const chosenSessionId = randomUUID();
  const args = [
    '-p', prompt,
    '--session-id', chosenSessionId,
    '--output-format', 'stream-json',
    '--verbose',
    ...(ANTHROPIC_MODEL ? ['--model', ANTHROPIC_MODEL] : []),
    '--allowedTools', tools.join(','),
    '--disallowedTools', DISALLOWED_TOOLS.join(','),
    '--permission-mode', 'dontAsk',
    ...(settingsOverride ? ['--settings', settingsOverride] : []),
    // R8: only when the skills install and the frozen brief disagree (the brief's bytes stay as frozen).
    ...(systemNote ? ['--append-system-prompt', systemNote] : []),
  ];
  const inferenceLabel = INFERENCE === 'loopback' ? ANTHROPIC_BASE_URL : 'anthropic (this machine\'s Claude Code login)';
  const modelLabel = ANTHROPIC_MODEL ?? 'account default';

  log.step(`claude -p "${prompt.slice(0, 60)}${prompt.length > 60 ? '…' : ''}"`, 1);
  log.info(`inference: ${inferenceLabel} · model: ${modelLabel}`, 1);

  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
  const logPath = join(LOG_DIR, `${jobId}.log`);
  const logFile = createWriteStream(logPath, { flags: 'w' });
  logFile.write(`[worker] job ${jobId}\n[worker] model ${modelLabel} via ${inferenceLabel}\n[worker] cwd ${cwd}\n[worker] started\n\n`);
  log.info(`transcript: ${logPath}`, 1);

  return new Promise((resolve) => {
    // Claude Code refuses to start inside another Claude Code session (it
    // reads CLAUDECODE / CLAUDE_CODE_ENTRYPOINT). A worker launched from a
    // Claude terminal would inherit those and fail every job, so the child
    // gets a copy of the environment with them removed.
    const { CLAUDECODE: _cc, CLAUDE_CODE_ENTRYPOINT: _ep, ...childEnv } = process.env;
    const child = spawn('claude', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv });
    const h = held.get(jobId);
    if (h) h.child = child;

    let stdout = '';
    const onChunk = (buf) => {
      const text = buf.toString();
      logFile.write(text);
      // Ship stdout to the browser log view; fire-and-forget so a slow POST
      // never backpressures the child's pipe.
      void shipLog(config, jobId, text);
    };
    child.stdout.on('data', (buf) => { stdout += buf.toString(); onChunk(buf); });
    child.stderr.on('data', onChunk);

    const finish = (exitCode) => {
      const durationMs = Date.now() - started;
      // stream-json is newline-delimited, so the run's outcome is the LAST line
      // with `type: 'result'` rather than the whole buffer. Scanned from the end
      // and tolerant of unparseable lines: a partial final line (the child was
      // killed mid-write) or an interleaved stderr warning must not turn a
      // finished run into "could not parse".
      let result = {};
      const lines = stdout.split('\n');
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = lines[i].trim();
        if (!line.startsWith('{')) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.type === 'result') { result = obj; break; }
        } catch { /* not a complete JSON line — keep scanning backwards */ }
      }
      if (!result.type && stdout.trim()) {
        result = { error: 'run produced no result line — see the log for what it did emit' };
      }
      // `json` returned token counts at the top level; stream-json nests them
      // under `usage`. Flattened here so `complete()` reads one shape and the
      // recorded tokensIn/tokensOut do not silently become undefined.
      const usage = result.usage ?? {};
      if (result.input_tokens === undefined && usage.input_tokens !== undefined) {
        result.input_tokens = usage.input_tokens;
      }
      if (result.output_tokens === undefined && usage.output_tokens !== undefined) {
        result.output_tokens = usage.output_tokens;
      }
      // Which model actually answered, from the result's `modelUsage` map (one
      // key per model the run touched). `--model` names a family alias like
      // `claude-sonnet-5`; the key here is the dated id that served it, and
      // that is the one worth recording against the run.
      if (result.modelUsage && typeof result.modelUsage === 'object') {
        const [served] = Object.keys(result.modelUsage);
        if (served) result.model = served;
      }
      logFile.write(`\n[worker] exit ${exitCode} after ${(durationMs / 1000).toFixed(1)}s\n`);
      logFile.end();
      // The run report's worker half (local-compute-report.mjs): the final message (its
      // lab-report block), the skills the stream showed it loading, and the checkout's kept folders.
      const claudeSessionId = sessionIdFromStream(stdout) ?? chosenSessionId;
      let report = null;
      try {
        report = buildReport({
          finalMessage: typeof result.result === 'string' ? result.result : '',
          stdout, workdir: clonePath, runRef: jobId, sessionId: held.get(jobId)?.sessionId ?? '', claudeSessionId,
        });
      } catch (err) {
        logFile.write?.(`[worker] could not read the run report: ${err.message}\n`);
      }
      resolve({
        ok: exitCode === 0 && result.subtype === 'success' && result.is_error !== true,
        result,
        exitCode,
        durationMs,
        report,
        claudeSessionId,
        settingsOverride,
      });
    };

    child.on('error', (err) => {
      logFile.write(`\n[worker] spawn error: ${err.message}\n`);
      stdout = stdout || JSON.stringify({ error: err.message });
      finish(1);
    });
    child.on('close', (code) => finish(code ?? 1));
  });
}

// ─── Fenced writes ───────────────────────────────────────────────────────────

async function markRunning(config, jobId) {
  const claim = held.get(jobId);
  if (!claim) return false;
  const res = await post(config, `/api/local-compute/jobs/${jobId}/start`, {
    claimToken: claim.claimToken,
  }, authHeaders(config));
  return res.ok;
}

async function heartbeat(config, jobId) {
  const claim = held.get(jobId);
  if (!claim) return false;
  const res = await post(config, `/api/local-compute/jobs/${jobId}/heartbeat`, {
    claimToken: claim.claimToken,
  }, authHeaders(config));
  if (res.status === 401 || res.status === 403) {
    log.err(`heartbeat for ${shortId(jobId)} rejected (${res.status}) — this machine's token no longer authenticates; re-pair and start this worker again`, 1);
    return false;
  }
  if (res.status === 409) {
    const body = await res.json();
    if (body.gate === 'claim_lost') {
      log.warn(`claim on ${shortId(jobId)} expired — another worker may take it; abandoning this run`, 1);
      // Kill the orphaned child: its result would be fenced out on completion
      // anyway, so letting it keep spending the local model's slots is pure waste.
      if (claim.child && !claim.child.killed) claim.child.kill('SIGTERM');
      held.delete(jobId);
      return false;
    }
  }
  return res.ok;
}

// One ticker for the whole worker: announce presence (so the fleet view shows
// this machine connected with a card per running job) and heartbeat every held
// job (fencing liveness). Runs even while idle — an empty announce keeps the
// badge 'connected' between jobs rather than letting it decay to 'offline'.
function startPresenceLoop(config) {
  const tick = async () => {
    await announce(config);
    for (const jobId of [...held.keys()]) {
      await heartbeat(config, jobId);
    }
  };
  void tick();
  const everyMs = Math.max(5, Math.min(heartbeatIntervalS, 25)) * 1000;
  setInterval(() => { void tick(); }, everyMs);
}

async function complete(config, jobId, status, outcome) {
  const claim = held.get(jobId);
  if (!claim) return false;

  const body = {
    claimToken: claim.claimToken,
    status,
    ...(outcome.result.result ? { result: { summary: outcome.result.result } } : {}),
    ...(outcome.result.total_cost_usd !== undefined ? { costUsd: outcome.result.total_cost_usd } : {}),
    ...((outcome.result.model ?? ANTHROPIC_MODEL) ? { model: outcome.result.model ?? ANTHROPIC_MODEL } : {}),
    ...(outcome.result.input_tokens ? { tokensIn: outcome.result.input_tokens } : {}),
    ...(outcome.result.output_tokens ? { tokensOut: outcome.result.output_tokens } : {}),
    ...(outcome.ok ? {} : { error: outcome.result.error ?? `exit code ${outcome.exitCode}` }),
    ...(outcome.report ? { report: outcome.report } : {}),
  };

  const res = await post(config, `/api/local-compute/jobs/${jobId}/complete`, body, authHeaders(config));
  held.delete(jobId);

  if (!res.ok) {
    log.err(`completion failed: ${await describeFailure(res)}`, 1);
    return false;
  }

  const reply = await res.json();
  log.ok(`recorded ${reply.status} · $${reply.costUsd} (${reply.provider})`, 1);
  if (reply.report) {
    log.info(`report: self-report ${reply.report.selfReport} · ${reply.report.runbooksUsed} runbook(s) used · ${reply.report.kept} kept`, 1);
    if (reply.report.debrief?.state === 'skipped') log.info(`no debrief: ${reply.report.debrief.reason}`, 1);
  }
  return reply;
}

// ─── The debrief (lane C) ────────────────────────────────────────────────────
//
// When the completion answers with a debrief request, the SAME session is resumed for one more
// headless turn (docs/learning-loop-design.md, Stage 2): it writes one runbook folder under
// .lab/keep/ in the checkout it worked in, or answers that nothing is worth keeping. The checkout
// is held (no other job may reset it) until the folder is posted or the server is told the
// session could not be resumed. The turn's bounds come from the request and are only narrowed
// here (local-compute-report.mjs debriefArgs). In anthropic mode it runs on the smaller model.
const DEBRIEF_MODEL = INFERENCE === 'loopback'
  ? ANTHROPIC_MODEL
  : (process.env.LOCAL_DEBRIEF_MODEL ?? 'claude-haiku-4-5-20251001');
if (INFERENCE === 'anthropic' && !/sonnet|haiku/i.test(DEBRIEF_MODEL)) {
  console.error(`LOCAL_DEBRIEF_MODEL=${DEBRIEF_MODEL} is not a Sonnet or Haiku id`);
  process.exit(1);
}

async function postDebrief(config, jobId, body) {
  try {
    const res = await post(config, `/api/local-compute/jobs/${encodeURIComponent(jobId)}/debrief`, body, authHeaders(config));
    if (!res.ok) { log.warn(`debrief not recorded: ${await describeFailure(res)}`, 1); return null; }
    const out = await res.json();
    const d = out.debrief ?? {};
    log.ok(`debrief ${d.state}${d.proposalId ? ` · proposal ${d.proposalId}` : ''}${d.lint?.length ? ` · lint ${d.lint.join(', ')}` : ''}${d.problems?.length ? ` · ${d.problems[0]}` : ''}`, 1);
    return out;
  } catch (err) {
    log.warn(`debrief not recorded: ${err.message}`, 1);
    return null;
  }
}

async function runDebrief(config, jobId, { request, claudeSessionId, workdir, settingsOverride }) {
  log.step(`debrief: resuming session ${claudeSessionId ? claudeSessionId.slice(0, 8) : '?'}…`, 1);
  // The folder the work turn kept was already sent with the completion; start the debrief clean
  // so the folder it names is the one it wrote. rmSync removes a link, never what it points at.
  try {
    const keep = join(workdir, '.lab', 'keep');
    if (existsSync(keep) || (() => { try { lstatSync(keep); return true; } catch { return false; } })()) rmSync(keep, { recursive: true, force: true });
  } catch (err) { log.warn(`debrief: could not clear .lab/keep (${err.message})`, 1); }
  const args = debriefArgs(request, { sessionId: claudeSessionId, model: DEBRIEF_MODEL, settingsOverride });
  if (!args) {
    await postDebrief(config, jobId, { token: request?.token, sessionUnavailable: true });
    return;
  }
  const timeoutS = Math.min(Math.max(Number(request.timeoutS) || 300, 30), 1800);
  const { CLAUDECODE: _cc, CLAUDE_CODE_ENTRYPOINT: _ep, ...childEnv } = process.env;
  const outcome = await new Promise((resolveRun) => {
    let stdout = '';
    const child = spawn('claude', args, { cwd: workdir, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv });
    const timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* gone */ } }, timeoutS * 1000);
    child.stdout.on('data', (b) => { if (stdout.length < 1_000_000) stdout += b.toString(); });
    child.stderr.on('data', () => { /* the CLI's own warnings; the result object is what counts */ });
    const done = (code) => { clearTimeout(timer); resolveRun({ code, stdout }); };
    child.on('error', () => done(127));
    child.on('close', (code) => done(code ?? 1));
  });
  let result = null;
  for (const line of outcome.stdout.trim().split('\n').reverse()) {
    try { const o = JSON.parse(line); if (o && o.type === 'result') { result = o; break; } } catch { /* keep looking */ }
  }
  const answer = debriefAnswerOf(result);
  if (!answer && (outcome.code !== 0 || !result)) {
    log.warn(`debrief: the session could not be resumed (exit ${outcome.code})`, 1);
    await postDebrief(config, jobId, { token: request.token, sessionUnavailable: true });
    return;
  }
  const costUsd = typeof result?.total_cost_usd === 'number' ? result.total_cost_usd : null;
  const body = { token: request.token, answer, ...(costUsd !== null ? { costUsd } : {}) };
  if (answer && (answer.kind === 'new' || answer.kind === 'revise')) {
    const read = readDebriefFolder(workdir, answer.folder);
    if (read.folder) body.folder = read.folder;
    else if (read.problems) body.problems = read.problems;
  }
  await postDebrief(config, jobId, body);
}

/** One holder of a checkout at a time: a debrief keeps it until its folder is posted. */
const checkoutLocks = new Map();
async function holdCheckout(key, fn) {
  if (!key) return fn();
  const prev = checkoutLocks.get(key) ?? Promise.resolve();
  let release;
  const mine = new Promise((r) => { release = r; });
  const chain = prev.then(() => mine);
  checkoutLocks.set(key, chain);
  await prev;
  try { return await fn(); } finally {
    release();
    if (checkoutLocks.get(key) === chain) checkoutLocks.delete(key);
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function runJob(config, claim) {
  const { job } = claim;
  const { claimToken, sessionId } = held.get(job.id);

  try {
    await markRunning(config, job.id);
    log.step('running', 1);

    const repoUrl = job.payload.repo;
    const prompt = job.payload.prompt;
    if (!prompt) {
      await complete(config, job.id, 'failed', { ok: false, result: { error: 'payload.prompt is required' } });
      return;
    }

    // The checkout is this run's from the reset in ensureRepo until its debrief (if any) is posted.
    const lockKey = repoUrl ? `repo:${basename(String(repoUrl), '.git')}` : null;
    await holdCheckout(lockKey, async () => {
    const { cwd, clonePath } = ensureRepo(repoUrl);
    // Skills go only into a checkout this worker owns (REPOS_DIR/<repo>), never the directory it
    // was started from, which may be the operator's home.
    const note = repoUrl
      ? await equipRun(config, job.id, cwd)
      : skillsNote(null, held.get(job.id)?.skillLibrary?.dir ?? null);
    const outcome = await runTask(config, job.id, cwd, prompt, note, clonePath);

    log[outcome.exitCode === 0 ? 'ok' : 'warn'](`finished in ${(outcome.durationMs / 1000).toFixed(1)}s · exit ${outcome.exitCode}`, 1);
    // `payload.requiresReview` is the same field the push-side dispatcher honours
    // (middleware lib/job-dispatcher.ts), and this is where the pull side keeps
    // its half of that contract: a run that needs a human look lands in
    // `awaiting_review`, not `done`. Review is for a run that produced a change
    // someone can accept or reject — one with a repo. A job that names no repo
    // and says nothing about review has nothing to review, so it lands in
    // `done`; "what is 10+10" parked in a review lane was the bug. A failure is
    // never "awaiting review": there is no output to look at.
    const needsReview = typeof job.payload?.requiresReview === 'boolean'
      ? job.payload.requiresReview
      : Boolean(repoUrl);
    const status = outcome.ok ? (needsReview ? 'awaiting_review' : 'done') : 'failed';
    const reply = await complete(config, job.id, status, outcome);
    // Lane C: a debrief runs only in a checkout this worker cloned; never in its own directory.
    if (reply && reply.debrief) {
      if (clonePath) {
        await runDebrief(config, job.id, { request: reply.debrief, claudeSessionId: outcome.claudeSessionId, workdir: clonePath, settingsOverride: outcome.settingsOverride });
      } else {
        await postDebrief(config, job.id, { token: reply.debrief.token, sessionUnavailable: true });
      }
    }
    });
  } catch (err) {
    log.err(`run failed: ${err.message}`, 1);
    await complete(config, job.id, 'failed', { ok: false, result: { error: err.message } }).catch(() => {});
  }
}

async function loop(config) {
  while (true) {
    try {
      const claimed = await claim(config);
      if (claimed) {
        // Fire and forget — the worker is allowed MAX_CONCURRENCY live claims, so
        // we keep polling while held.size < limit rather than blocking on each run.
        void runJob(config, claimed);
      } else {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_S * 1000));
      }
    } catch (err) {
      log.err(`loop error: ${err.message} — retrying in ${POLL_INTERVAL_S}s`);
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_S * 1000));
    }
  }
}

// ─── Entry ───────────────────────────────────────────────────────────────────

const args = parseArgs(process.argv.slice(2));
if (args.pairCode) {
  await pairWithCode(args.pairCode, args.baseUrl);
}

const config = readConfig();
// Start shipping this worker's operational log as early as config exists —
// pairing and early registration lines above are already queued in the ring
// and go out on the first tick, so nothing before this line is lost to it.
startNodeLogShipping(config);
const reg = await register(config);

// PRESENCE STARTS BEFORE THE PAUSE WAIT, and the order is the whole fix.
//
// `/register` records capabilities; only `/announce` moves `lastSeenAt`, which
// is the sole input to `statusOfNode`. Starting the presence loop after
// `waitForAcceptJobs` therefore meant a paired-but-not-switched-on worker
// announced NOTHING: it sat re-registering on a poll tick while the portal
// read it as `offline`, because from the server's side nothing had ever
// arrived. That deadlocked the documented first run. The pairing dialog waits
// for `presence.status === 'connected'` before closing, and it is a MODAL —
// so it covered the row holding the "Accepting work" switch while telling the
// user it would close once the machine reported in, and the worker told the
// user it would pick the switch up on its own. Both sides were waiting for the
// other, and the one control that could break the tie was underneath the
// dialog.
//
// Being present and accepting work are two different facts — the same split
// this codebase makes everywhere else between "can we reach it" and "what does
// it say". A paired, running, reachable machine IS connected; it just is not
// taking jobs. Announcing while paused is also what the idle case already
// does (see startPresenceLoop: an idle-but-running worker announces an empty
// session list), so this makes the paused case consistent rather than special.
startPresenceLoop(config);

if (!reg.acceptJobs) {
  await waitForAcceptJobs(config, 'this machine is paired but not switched on');
}

if (reg.jobKinds.length === 0) {
  log.err('no runnable job kinds — set JOB_KINDS to a kind the fleet dispatches, then start this worker again');
  process.exit(1);
}

if (REPO_HOSTS.ignored.length) log.warn(`LOCAL_ALLOWED_REPO_HOSTS: ignored ${REPO_HOSTS.ignored.map((h) => JSON.stringify(h)).join(', ')} (bare host names only)`);
log.info(`repo hosts: ${REPO_HOSTS.hosts.join(', ')}`);
log.info(`polling for work every ${POLL_INTERVAL_S}s · announcing presence every ${Math.max(5, Math.min(heartbeatIntervalS, 25))}s`);
log.info('Ctrl-C to stop. Anything claimed is handed back to the fleet if this worker dies mid-run.');
// (presence is already running — started above, before the pause wait)
await loop(config);
