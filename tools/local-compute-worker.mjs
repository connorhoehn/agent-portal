#!/usr/bin/env node
// local-compute-worker — claim work from the OrgIQ queue and run it locally.
//
// The laptop half of the governed work loop: a paired machine registers its
// capabilities (models, kinds, concurrency), claims jobs from the queue, clones
// or updates the target repo, runs `claude -p` against it, and posts a fenced
// completion with token counts.
//
// Two inference modes, chosen by whether ANTHROPIC_BASE_URL is set:
//
//   anthropic (default) — `claude -p` exactly as the operator would run it at
//     the terminal: the machine's own Claude Code login, whatever model that
//     account defaults to (or ANTHROPIC_MODEL), no env override injected. The
//     run is billed to whoever is signed in on this machine. This is the mode
//     for a laptop whose local model turned out too weak to be worth the watts.
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
//
// Environment (all optional, with sane defaults):
//   LOCAL_MODELS           comma-separated model list the machine advertises
//                          (default: ANTHROPIC_MODEL, else "claude-code" in
//                          anthropic mode; "qwen3.6-35b" in loopback mode)
//   JOB_KINDS              comma-separated, e.g. "local:task,local:distill"
//   MAX_CONCURRENCY        how many jobs to hold at once (default: 2, the reference
//                          workstation's real slot count)
//   ANTHROPIC_BASE_URL     set it to run in loopback mode (e.g. http://127.0.0.1:8080)
//   ANTHROPIC_API_KEY      loopback only: any non-empty string (default: "local")
//   ANTHROPIC_MODEL        the model id passed as --model. Loopback mode needs one
//                          Claude Code recognizes even though the server ignores it
//                          (default there: claude-sonnet-4-5-20250929); anthropic
//                          mode passes none and lets the account's default apply.
//   POLL_INTERVAL_S        how often to poll /claim when idle (default: 10)
//   REPOS_DIR              where to clone/update repos (default: ~/repos-worker)
//   ORGIQ_PRESENCE_CONFIG  path of the pairing file to read instead of the
//                          default — for running a second worker (or a mock-mode
//                          audit with MOCK_NODE_TOKEN) without touching the real one
//
// The worker does NOT daemonize. Run it under systemd, launchd, tmux, or a plain
// shell — a failed claim, a dead network, or a revoked token all exit non-zero,
// and the operator decides whether to restart it.

import { readFileSync, mkdirSync, existsSync, createWriteStream } from 'node:fs';
import { execSync, spawn } from 'node:child_process';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';

const CONFIG_PATH = process.env.ORGIQ_PRESENCE_CONFIG ?? join(homedir(), '.claude-mem', 'orgiq-presence.json');
const REPOS_DIR = process.env.REPOS_DIR ?? join(homedir(), 'repos-worker');
// Per-job run logs, tail-able while a job runs (`tail -f`), and the source the
// worker ships to the middleware for the browser log view. Kept out of the repo
// checkout so `git clean -fd` in ensureRepo never deletes a live log.
const LOG_DIR = process.env.WORKER_LOG_DIR ?? join(homedir(), '.claude-mem', 'orgiq-worker-logs');
const POLL_INTERVAL_S = parseInt(process.env.POLL_INTERVAL_S ?? '10', 10) || 10;
// See the header: loopback iff a base URL is given. Nothing is defaulted to
// 127.0.0.1 any more — a worker that silently pointed `claude` at a server
// nobody started failed every job with a connection refusal.
const ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL || null;
const INFERENCE = ANTHROPIC_BASE_URL ? 'loopback' : 'anthropic';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? 'local';
// `null` means "pass no --model": in anthropic mode the signed-in account's
// default is the right answer and a hard-coded id would pin every machine to
// whatever this file said the day it was written.
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL
  ?? (INFERENCE === 'loopback' ? 'claude-sonnet-4-5-20250929' : null);

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

function readConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    console.error(`config not found at ${CONFIG_PATH} — pair the machine first`);
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

async function register(config) {
  const res = await post(config, '/api/local-compute/register', {
    localModels: LOCAL_MODELS,
    jobKinds: JOB_KINDS,
    maxConcurrency: MAX_CONCURRENCY,
  }, authHeaders(config));

  if (!res.ok) {
    const text = await res.text();
    console.error(`registration failed: ${res.status} ${text}`);
    process.exit(1);
  }

  const body = await res.json();
  if (typeof body.heartbeatIntervalS === 'number' && body.heartbeatIntervalS > 0) {
    heartbeatIntervalS = body.heartbeatIntervalS;
  }
  console.log(`registered: ${body.jobKinds.length} kind(s), ${body.maxConcurrency} slot(s), ${body.localModels.length} model(s)`);
  if (body.rejectedKinds?.length) {
    console.log(`  rejected kinds: ${body.rejectedKinds.join(', ')}`);
    console.log(`  runnable kinds: ${body.runnableKinds.join(', ')}`);
  }
  if (!body.acceptJobs) {
    console.log(`  machine is paired but NOT accepting jobs — turn on "accept jobs" in the portal`);
  }
  return body;
}

// ─── Claim loop ──────────────────────────────────────────────────────────────

// jobId → { claimToken, sessionId, title, repo, startedAt (ms), child, logSeq }
// startedAt is a wall-clock ms stamp for the presence card; child is the live
// `claude` process so the heartbeat loop can kill a run whose claim was lost.
const held = new Map();

async function claim(config) {
  const res = await post(config, '/api/local-compute/claim', {}, authHeaders(config));

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
      console.error('machine is not accepting jobs — turn on "accept jobs" in the portal, then restart');
      process.exit(1);
    }
    if (body.gate === 'kinds') {
      console.error('no runnable job kinds registered — check JOB_KINDS env var and restart');
      process.exit(1);
    }
  }
  if (res.status === 503) {
    const body = await res.json();
    if (body.gate === 'migration') {
      console.error('cluster has not applied schema/local_compute_worker_schema.sql — cannot fence claims');
      process.exit(1);
    }
  }
  if (!res.ok) {
    console.error(`claim failed: ${res.status} ${await res.text()}`);
    return null;
  }

  const body = await res.json();
  held.set(body.job.id, {
    claimToken: body.claimToken,
    sessionId: body.sessionId,
    title: body.job.title ?? body.job.id,
    repo: body.job.payload?.repo ?? null,
    startedAt: Date.now(),
    child: null,
    logSeq: 0,
  });
  console.log(`claimed: ${body.job.title} (${body.job.id})`);
  console.log(`  heartbeat every ${body.heartbeatIntervalS}s, stale after ${body.staleMinutes}m`);
  console.log(`  slots: ${body.slots.held}/${body.slots.limit}`);
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

async function announce(config) {
  try {
    await post(config, '/api/local-compute/announce',
      { sessions: presenceSessions() }, authHeaders(config));
  } catch {
    // Presence is best-effort — a missed announce just lets the badge age. Never
    // let it take down the run loop.
  }
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

function ensureRepo(repoUrl) {
  if (!repoUrl) return process.cwd();
  const name = basename(repoUrl, '.git');
  const repoPath = join(REPOS_DIR, name);

  if (!existsSync(REPOS_DIR)) mkdirSync(REPOS_DIR, { recursive: true });

  if (existsSync(repoPath)) {
    console.log(`  updating ${name}...`);
    // Discard any local changes — the workspace is ephemeral and the worker is
    // the only writer, so anything uncommitted is leftover junk from a prior run.
    execSync('git reset --hard HEAD && git clean -fd', { cwd: repoPath, stdio: 'ignore' });
    execSync('git pull --ff-only', { cwd: repoPath, stdio: 'ignore' });
  } else {
    console.log(`  cloning ${name}...`);
    // The machine uses its OWN git credentials, not a borrowed token. Shipping
    // the middleware's GitHub token to a laptop would make a stolen node token
    // a way to clone every private repo the service account can reach.
    execSync(`git clone ${repoUrl} ${name}`, { cwd: REPOS_DIR, stdio: 'ignore' });
  }
  return repoPath;
}

// ─── Run ─────────────────────────────────────────────────────────────────────

function runTask(config, jobId, cwd, prompt) {
  const started = Date.now();
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
  // though llama.cpp ignores it), --dangerously-skip-permissions (the machine IS
  // the sandbox), and --settings (env block outranks process.env, so this is the
  // only way to reliably point at loopback). The prompt is passed as a single
  // string argument, not via stdin.
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
  const args = [
    '-p', prompt,
    '--output-format', 'stream-json',
    '--verbose',
    ...(ANTHROPIC_MODEL ? ['--model', ANTHROPIC_MODEL] : []),
    '--dangerously-skip-permissions',
    ...(settingsOverride ? ['--settings', settingsOverride] : []),
  ];
  const inferenceLabel = INFERENCE === 'loopback' ? ANTHROPIC_BASE_URL : 'anthropic (this machine\'s Claude Code login)';
  const modelLabel = ANTHROPIC_MODEL ?? 'account default';

  console.log(`  running: claude -p "${prompt.slice(0, 60)}${prompt.length > 60 ? '...' : ''}"`);
  console.log(`  inference: ${inferenceLabel}, model: ${modelLabel}`);

  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
  const logPath = join(LOG_DIR, `${jobId}.log`);
  const logFile = createWriteStream(logPath, { flags: 'w' });
  logFile.write(`[worker] job ${jobId}\n[worker] model ${modelLabel} via ${inferenceLabel}\n[worker] cwd ${cwd}\n[worker] started\n\n`);
  console.log(`  log: ${logPath}`);

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
      // Which model actually answered. In anthropic mode nothing was passed as
      // --model, so the only place the id exists is the result's `modelUsage`
      // map (one key per model the run touched); the first key is recorded and
      // shown on the machine's presence card while the run is live.
      if (!ANTHROPIC_MODEL && result.modelUsage && typeof result.modelUsage === 'object') {
        const [served] = Object.keys(result.modelUsage);
        if (served) result.model = served;
      }
      logFile.write(`\n[worker] exit ${exitCode} after ${(durationMs / 1000).toFixed(1)}s\n`);
      logFile.end();
      resolve({
        ok: exitCode === 0 && result.subtype === 'success' && result.is_error !== true,
        result,
        exitCode,
        durationMs,
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
  if (res.status === 409) {
    const body = await res.json();
    if (body.gate === 'claim_lost') {
      console.log(`  claim expired for ${jobId} — abandoning run`);
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
  };

  const res = await post(config, `/api/local-compute/jobs/${jobId}/complete`, body, authHeaders(config));
  held.delete(jobId);

  if (!res.ok) {
    console.error(`  completion failed: ${res.status} ${await res.text()}`);
    return false;
  }

  const reply = await res.json();
  console.log(`  recorded: ${reply.status}, $${reply.costUsd} (${reply.provider})`);
  return true;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function runJob(config, claim) {
  const { job } = claim;
  const { claimToken, sessionId } = held.get(job.id);

  try {
    await markRunning(config, job.id);
    console.log(`  → running`);

    const repoUrl = job.payload.repo;
    const prompt = job.payload.prompt;
    if (!prompt) {
      await complete(config, job.id, 'failed', { ok: false, result: { error: 'payload.prompt is required' } });
      return;
    }

    const cwd = ensureRepo(repoUrl);
    const outcome = await runTask(config, job.id, cwd, prompt);

    console.log(`  finished in ${(outcome.durationMs / 1000).toFixed(1)}s, exit ${outcome.exitCode}`);
    // `payload.requiresReview` is the same field the push-side dispatcher honours
    // (middleware lib/job-dispatcher.ts), and this is where the pull side keeps
    // its half of that contract: a run that needs a human look lands in
    // `awaiting_review`, not `done`. Defaults to true — the same default the
    // composer sends — so a job that omits it is reviewed rather than silently
    // accepted. A failure is never "awaiting review": there is no output to look at.
    const needsReview = job.payload?.requiresReview !== false;
    const status = outcome.ok ? (needsReview ? 'awaiting_review' : 'done') : 'failed';
    await complete(config, job.id, status, outcome);
  } catch (err) {
    console.error(`  run failed: ${err.message}`);
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
      console.error(`loop error: ${err.message}`);
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_S * 1000));
    }
  }
}

// ─── Entry ───────────────────────────────────────────────────────────────────

const config = readConfig();
const reg = await register(config);

if (!reg.acceptJobs) {
  console.log('machine is paired but not switched on — exiting');
  console.log('turn on "accept jobs" in the portal under Local compute, then restart this worker');
  process.exit(0);
}

if (reg.jobKinds.length === 0) {
  console.log('no runnable job kinds — check JOB_KINDS env var and restart');
  process.exit(1);
}

console.log(`polling every ${POLL_INTERVAL_S}s, announcing presence every ${Math.max(5, Math.min(heartbeatIntervalS, 25))}s...`);
startPresenceLoop(config);
await loop(config);
