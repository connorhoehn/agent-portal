#!/usr/bin/env node
// local-compute-worker — claim work from the OrgIQ queue and run it locally.
//
// The laptop half of the governed work loop: a paired machine registers its
// capabilities (models, kinds, concurrency), claims jobs from the queue, clones
// or updates the target repo, runs Claude Code against a local inference server
// (llama-server, Ollama, vLLM, anything speaking the Anthropic Messages API),
// and posts a fenced completion with token counts.
//
// Setup:
//   1. Pair the machine first (orgiq-presence.mjs or the portal header menu):
//        node orgiq-presence.mjs pair <CODE> [--base http://localhost:3001]
//   2. Switch on "accept jobs" for the machine in the portal under Local compute.
//   3. Start the local inference server (e.g. `cclocal up` for llama-server).
//   4. Run this worker:
//        node local-compute-worker.mjs [--base http://localhost:3001] [--poll 10]
//
// The worker reads ~/.claude-mem/orgiq-presence.json for the node token (written
// by the pairing step) and announces its capabilities on every boot, so a
// restart picks up changes to the env vars below without requiring re-pairing.
//
// Environment (all optional, with sane defaults):
//   LOCAL_MODELS           comma-separated model list, e.g. "qwen3.6-35b,llama3.3:70b"
//   JOB_KINDS              comma-separated, e.g. "local:task,local:distill"
//   MAX_CONCURRENCY        how many jobs to hold at once (default: 2, the reference
//                          workstation's real slot count)
//   ANTHROPIC_BASE_URL     loopback inference endpoint (default: http://127.0.0.1:8080)
//   ANTHROPIC_API_KEY      any non-empty string for local servers (default: "local")
//   ANTHROPIC_MODEL        the model id Claude Code will be told to use; must be
//                          recognized by Claude Code even though llama.cpp ignores it
//                          (default: claude-sonnet-4-5-20250929)
//   POLL_INTERVAL_S        how often to poll /claim when idle (default: 10)
//   REPOS_DIR              where to clone/update repos (default: ~/repos-worker)
//
// The worker does NOT daemonize. Run it under systemd, launchd, tmux, or a plain
// shell — a failed claim, a dead network, or a revoked token all exit non-zero,
// and the operator decides whether to restart it.

import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';

const CONFIG_PATH = join(homedir(), '.claude-mem', 'orgiq-presence.json');
const REPOS_DIR = process.env.REPOS_DIR ?? join(homedir(), 'repos-worker');
const POLL_INTERVAL_S = parseInt(process.env.POLL_INTERVAL_S ?? '10', 10) || 10;
const ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL ?? 'http://127.0.0.1:8080';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? 'local';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-5-20250929';

// The worker self-reports these on every boot. Each can only NARROW what it is
// offered, never widen: kinds are intersected with the server's allowlist,
// concurrency is capped by the server's ceiling, and `accept_jobs` is the
// owner's switch — so a bearer token on somebody's laptop is acceptable.
const LOCAL_MODELS = (process.env.LOCAL_MODELS ?? 'qwen3.6-35b')
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

const held = new Map(); // jobId → { claimToken, sessionId }

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
  held.set(body.job.id, { claimToken: body.claimToken, sessionId: body.sessionId });
  console.log(`claimed: ${body.job.title} (${body.job.id})`);
  console.log(`  heartbeat every ${body.heartbeatIntervalS}s, stale after ${body.staleMinutes}m`);
  console.log(`  slots: ${body.slots.held}/${body.slots.limit}`);
  return body;
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

function runTask(cwd, prompt) {
  const started = Date.now();
  const settingsOverride = JSON.stringify({
    env: {
      CLAUDE_CODE_USE_BEDROCK: '0',
      ANTHROPIC_BASE_URL,
      ANTHROPIC_API_KEY,
    },
  });

  // The command built here is what the devbox agent does, minus the microVM
  // glue: `claude -p` with --output-format json (collected, not streamed),
  // --model (must be recognized by Claude Code even though llama.cpp ignores it),
  // --dangerously-skip-permissions (the machine IS the sandbox), and --settings
  // (env block outranks process.env, so this is the only way to reliably point
  // at loopback). The prompt is passed as a single string argument, not via stdin.
  const cmd = [
    'claude', '-p', prompt,
    '--output-format', 'json',
    '--model', ANTHROPIC_MODEL,
    '--dangerously-skip-permissions',
    '--settings', settingsOverride,
  ];

  console.log(`  running: claude -p "${prompt.slice(0, 60)}${prompt.length > 60 ? '...' : ''}"`);
  console.log(`  inference: ${ANTHROPIC_BASE_URL}, model: ${ANTHROPIC_MODEL}`);

  let stdout = '';
  let exitCode = null;
  try {
    stdout = execSync(cmd.join(' '), { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 10 * 1024 * 1024 });
    exitCode = 0;
  } catch (err) {
    exitCode = err.status ?? 1;
    stdout = err.stdout ?? '';
  }

  const durationMs = Date.now() - started;
  let result = {};
  try {
    result = stdout.trim() ? JSON.parse(stdout) : {};
  } catch {
    result = { error: 'could not parse Claude Code output' };
  }

  return {
    ok: exitCode === 0 && result.subtype === 'success' && result.is_error !== true,
    result,
    exitCode,
    durationMs,
  };
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
      held.delete(jobId);
      return false;
    }
  }
  return res.ok;
}

async function complete(config, jobId, status, outcome) {
  const claim = held.get(jobId);
  if (!claim) return false;

  const body = {
    claimToken: claim.claimToken,
    status,
    ...(outcome.result.result ? { result: { summary: outcome.result.result } } : {}),
    ...(outcome.result.total_cost_usd !== undefined ? { costUsd: outcome.result.total_cost_usd } : {}),
    ...(ANTHROPIC_MODEL ? { model: ANTHROPIC_MODEL } : {}),
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
    const outcome = runTask(cwd, prompt);

    console.log(`  finished in ${(outcome.durationMs / 1000).toFixed(1)}s, exit ${outcome.exitCode}`);
    await complete(config, job.id, outcome.ok ? 'done' : 'failed', outcome);
  } catch (err) {
    console.error(`  run failed: ${err.message}`);
    await complete(config, job.id, 'failed', { ok: false, result: { error: err.message } }).catch(() => {});
  }
}

async function loop(config) {
  while (true) {
    try {
      const claim = await claim(config);
      if (claim) {
        // Fire and forget — the worker is allowed MAX_CONCURRENCY live claims, so
        // we keep polling while held.size < limit rather than blocking on each run.
        void runJob(config, claim);
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

console.log(`polling every ${POLL_INTERVAL_S}s...`);
await loop(config);
