#!/usr/bin/env node
// DE-14: one resumable deploy command.
//
//   node scripts/deploy/orchestrate.mjs plan   [--env lab] [--only a,b] [--from <phase>] [--dry-run]
//   node scripts/deploy/orchestrate.mjs apply  [--env lab] [--only a,b] [--from <phase>] [--working-tree] [--alb-allow-cidr <cidr>] [--break-lock]
//   node scripts/deploy/orchestrate.mjs resume [--env lab]        # = apply; the live account decides what is left
//   node scripts/deploy/orchestrate.mjs status [--env lab]
//
// A pure `planDeploy(env, probes, previous, options)` decides each phase from
// the LIVE account (read-only `aws` calls, `collectProbes`) and the recorded
// input key (git tree hash of the paths a phase builds + the context it
// passes); the state file `.scratch/deploy/<env>/state.json` is a record, and
// a resume on another machine, or after the file is lost, re-derives the same
// plan. `plan` and `--dry-run` make no write call. `apply` takes the SSM lock
// `/<prefix>/deploy/lock` (an atomic create), writes every phase before it
// starts and after it ends, and puts the record to `/<prefix>/deploy/last-run`
// so CI and a second machine see the same run. `deploy.sh` stays the only way
// CloudFormation is touched; its exit code is the phase result.
import { spawnSync, execFileSync } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PHASES, PHASE_IDS, REPO_ROOT, FLEET_STACKS, AGENTS, commandLine, fsExists } from './phases.mjs';
import {
  stateFile, readState, validateState, writeState, newState, inputKey, gitHead, dirtyPaths, runId as makeRunId, lockParameter, lastRunParameter,
} from './state.mjs';

export const FORBIDDEN_ACCOUNTS_FILE = resolve(REPO_ROOT, 'infra/environments/forbidden-accounts.json');

// ── environment (DE-17) ──────────────────────────────────────────────────────
export function loadEnvironment(name = 'lab', dir = resolve(REPO_ROOT, 'infra/environments')) {
  if (!/^[a-z][a-z0-9-]{0,19}$/.test(name)) throw new Error(`"${name}" is not an environment name`);
  const file = resolve(dir, `${name}.json`);
  if (!existsSync(file)) throw new Error(`${file} does not exist`);
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const forbidden = JSON.parse(readFileSync(FORBIDDEN_ACCOUNTS_FILE, 'utf8')).accounts ?? [];
  if (raw.name !== name) throw new Error(`environment "${name}": "name" is "${raw.name}"`);
  if (!/^\d{12}$/.test(String(raw.account))) throw new Error(`environment "${name}": account must be a 12-digit string`);
  if (forbidden.includes(raw.account)) throw new Error(`environment "${name}": account ${raw.account} is forbidden`);
  const f = raw.features ?? {};
  return {
    name, account: raw.account, region: raw.region, prefix: raw.prefix, stackPrefix: raw.stackPrefix,
    features: { social: f.social === true, documents: f.documents === true, devbox: f.devbox === true },
  };
}

// ── options ─────────────────────────────────────────────────────────────────
export function parseArgs(argv) {
  const opts = { command: argv[0] ?? 'plan', env: process.env.ENV || 'lab', only: null, from: null, dryRun: false, workingTree: false,
    albAllowCidr: null, breakLock: false, help: false };
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${arg} needs a value`); return v; };
    if (arg === '--env') opts.env = value();
    else if (arg === '--only') opts.only = value().split(',').map((s) => s.trim()).filter(Boolean);
    else if (arg === '--from') opts.from = value();
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--working-tree') opts.workingTree = true;
    else if (arg === '--alb-allow-cidr') opts.albAllowCidr = value();
    else if (arg === '--break-lock') opts.breakLock = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`Unknown argument ${arg}`);
  }
  if (!['plan', 'apply', 'resume', 'status'].includes(opts.command)) throw new Error(`usage: orchestrate.mjs <plan|apply|resume|status> (got "${opts.command}")`);
  for (const id of [...(opts.only ?? []), ...(opts.from ? [opts.from] : [])]) {
    if (!PHASE_IDS.includes(id)) throw new Error(`unknown phase "${id}"; phases: ${PHASE_IDS.join(', ')}`);
  }
  if (opts.workingTree && !opts.only) throw new Error('--working-tree is allowed only with --only (a full apply builds HEAD)');
  return opts;
}

// ── the pure planner ────────────────────────────────────────────────────────
/**
 * @param env        the environment (loadEnvironment)
 * @param probes     what the live account says (collectProbes, or a fixture)
 * @param previous   the last recorded state, or null
 * @param options    { only, from, commit, inputKeyFor(phase), exists(path), albAllowCidr, dirty(paths) }
 * @returns { phases: [{ id, action, reason, inputKey, commands }] } in Runbook A order
 */
export function planDeploy(env, probes, previous, options = {}) {
  const commit = options.commit ?? '0'.repeat(40);
  const keyFor = options.inputKeyFor ?? ((phase, context) => inputKey(phase.inputPaths, context));
  const exists = options.exists ?? fsExists;
  const previousPhases = previous?.phases ?? {};
  const previousOutputs = Object.fromEntries(Object.entries(previousPhases).map(([id, p]) => [id, p.outputs ?? {}]));
  const outputs = { ...previousOutputs };
  const planned = [];
  const willRun = new Set();
  let fromReached = !options.from;

  for (const phase of PHASES) {
    if (phase.id === options.from) fromReached = true;
    const enabled = phase.enabled ? phase.enabled(env) : true;
    if (!enabled) { planned.push({ id: phase.id, action: 'disabled', reason: `features.${featureOf(phase.id)} is off in ${env.name}.json`, commands: [] }); continue; }
    if (options.only && !options.only.includes(phase.id) && !phase.always) {
      planned.push({ id: phase.id, action: 'skip', reason: 'not in --only', commands: [] }); continue;
    }
    const ctx = { commit, outputs, previousOutputs, options, exists };
    const commands = phase.commands(env, ctx);
    const context = contextOf(commands);
    const key = keyFor(phase, context);
    const prev = previousPhases[phase.id];
    const live = phase.live ? phase.live(probes, env, ctx) : false;
    const upstreamRuns = phase.needs.some((n) => willRun.has(n));

    let action = 'run';
    let reason;
    if (phase.always) { action = 'run'; reason = 'always runs'; }
    else if (!fromReached) { action = 'skip'; reason = `before --from ${options.from}`; }
    else if (live && prev?.status === 'done' && prev.inputKey === key && !upstreamRuns) {
      action = 'skip'; reason = `live and unchanged (input ${key}, recorded ${prev.finishedAt ?? 'earlier'})`;
    } else if (live && prev?.status === 'done' && upstreamRuns) {
      action = 'run'; reason = `live, but ${phase.needs.filter((n) => willRun.has(n)).join('+')} runs before it`;
    } else if (live && !prev) {
      action = 'run'; reason = 'live, but no record of its inputs (no state file): rebuilt once to record them';
    } else if (live) {
      action = 'run'; reason = prev?.status === 'done' ? `inputs changed (${prev.inputKey} → ${key})` : `last run ${prev?.status}`;
    } else {
      action = 'run'; reason = prev ? `not live (last ${prev.status})` : 'not live';
    }
    // Always-phases (preflight, verify) are checks, not changes: they never force downstream rebuilds.
    if (action === 'run' && !phase.always) willRun.add(phase.id);
    planned.push({ id: phase.id, action, reason, inputKey: key, commands: action === 'run' ? commands : [], describe: phase.describe });
  }
  return { env: env.name, account: probes.account ?? null, commit, phases: planned };
}

function featureOf(id) {
  if (id.startsWith('social')) return 'social';
  if (id.startsWith('documents')) return 'documents';
  return id;
}

/** The `--context k=v` pairs a phase's commands pass (part of its input key). */
export function contextOf(commands) {
  const ctx = {};
  for (const c of commands) {
    for (let i = 0; i < c.args.length; i += 1) {
      if (c.args[i] === '--context' && c.args[i + 1]) { const [k, ...v] = c.args[i + 1].split('='); ctx[k] = v.join('='); }
    }
  }
  return ctx;
}

// ── read-only probes ────────────────────────────────────────────────────────
const READ_ONLY = /^(sts get-caller-identity|cloudformation describe-stacks|ecr describe-images|ecs describe-services|ssm get-parameter|secretsmanager describe-secret|s3api head-object|bedrock-agentcore-control list-agent-runtimes|configure export-credentials)\b/;

export function makeAws(log = () => {}) {
  return (args, { readOnly = true, allowFail = true } = {}) => {
    const line = args.join(' ');
    if (readOnly && !READ_ONLY.test(line)) throw new Error(`probe is not read-only: aws ${line}`);
    log(`aws ${line}`);
    const r = spawnSync('aws', args, { encoding: 'utf8' });
    if (r.error) throw new Error(`aws not runnable: ${r.error.message}`);
    if (r.status !== 0) {
      const err = (r.stderr || '').slice(0, 400);
      if (/ExpiredToken|InvalidClientTokenId|Throttling|Could not connect|Unable to locate credentials/.test(err)) {
        throw new Error(`live read failed (aws ${args[0]} ${args[1]}): ${err.trim()} — re-login and rerun; nothing was changed`);
      }
      if (allowFail) return null;
      throw new Error(err || `aws ${line} failed`);
    }
    const out = r.stdout.trim();
    return out === 'None' ? null : out;
  };
}

export function collectProbes(env, aws) {
  const q = (args) => aws(args);
  const probes = { account: q(['sts', 'get-caller-identity', '--query', 'Account', '--output', 'text']), stacks: {}, ecr: {}, ssm: {}, secrets: {}, runtimes: [] };
  const stackNames = [...FLEET_STACKS, 'Portal', 'SocialImages', 'SocialMedia', 'Social', 'Devbox'].map((s) => `${env.stackPrefix}-${s}`);
  for (const name of stackNames) {
    const st = q(['cloudformation', 'describe-stacks', '--stack-name', name, '--region', env.region, '--query', 'Stacks[0].StackStatus', '--output', 'text']);
    if (st) probes.stacks[name] = st;
  }
  const repos = [`${env.prefix}-agent-base`, ...AGENTS.map((a) => `${env.prefix}-${a}`), `${env.prefix}-middleware`,
    `${env.prefix}-lvs-sfu`, `${env.prefix}-platform-api`, `${env.prefix}-social-gateway`];
  for (const repo of repos) {
    const tags = q(['ecr', 'describe-images', '--repository-name', repo, '--region', env.region, '--query', 'imageDetails[].imageTags[]', '--output', 'text']);
    probes.ecr[repo] = tags ? tags.split(/\s+/).filter(Boolean) : [];
  }
  const ecs = q(['ecs', 'describe-services', '--cluster', `${env.prefix}-middleware`, '--services', `${env.prefix}-middleware`, '--region', env.region,
    '--query', 'services[0].[desiredCount,runningCount]', '--output', 'text']);
  if (ecs) { const [d, r] = ecs.split(/\s+/); probes.ecs = { desired: Number(d), running: Number(r) }; }
  for (const name of [`/${env.prefix}/portal/url`, `/${env.prefix}/documents/workspace-config`, lastRunParameter(env.prefix), lockParameter(env.prefix)]) {
    probes.ssm[name] = q(['ssm', 'get-parameter', '--name', name, '--region', env.region, '--query', 'Parameter.Value', '--output', 'text']);
  }
  for (const s of ['approvals-request', 'harness-trace', 'assessment-run-complete']) {
    probes.secrets[`${env.prefix}-${s}-secret`] = q(['secretsmanager', 'describe-secret', '--secret-id', `${env.prefix}-${s}-secret`, '--region', env.region, '--query', 'Name', '--output', 'text']) !== null;
  }
  probes.portalUrl = probes.ssm[`/${env.prefix}/portal/url`] ?? q(['cloudformation', 'describe-stacks', '--stack-name', `${env.stackPrefix}-Portal`, '--region', env.region,
    '--query', "Stacks[0].Outputs[?OutputKey=='PortalUrl'].OutputValue", '--output', 'text']);
  const bucket = q(['cloudformation', 'describe-stacks', '--stack-name', `${env.stackPrefix}-Portal`, '--region', env.region,
    '--query', "Stacks[0].Outputs[?OutputKey=='PortalBucketName'].OutputValue", '--output', 'text']);
  probes.portalIndexPresent = bucket ? q(['s3api', 'head-object', '--bucket', bucket, '--key', 'index.html', '--query', 'ETag', '--output', 'text']) !== null : false;
  probes.documentGatewayUrl = q(['cloudformation', 'describe-stacks', '--stack-name', `${env.stackPrefix}-MiddlewareService`, '--region', env.region,
    '--query', "Stacks[0].Outputs[?OutputKey=='DocumentGatewayPublicUrl'].OutputValue", '--output', 'text']);
  const runtimes = q(['bedrock-agentcore-control', 'list-agent-runtimes', '--region', env.region, '--query', 'agentRuntimes[].[agentRuntimeName,status]', '--output', 'text']);
  probes.runtimes = runtimes ? runtimes.split('\n').map((l) => l.trim().split(/\s+/)).filter((p) => p.length === 2).map(([name, status]) => ({ name, status })) : [];
  const creds = q(['configure', 'export-credentials', '--format', 'process']);
  try { probes.credentialExpiration = creds ? JSON.parse(creds).Expiration ?? null : null; } catch { probes.credentialExpiration = null; }
  return probes;
}

// ── preflight and verify (the two phases without a script) ──────────────────
export function preflightChecks(env, probes, plan, options = {}) {
  const problems = [];
  if (probes.account !== env.account) problems.push(`credentials are for ${probes.account ?? 'nobody'}, environment '${env.name}' is ${env.account}`);
  if (probes.credentialExpiration) {
    const left = (new Date(probes.credentialExpiration).getTime() - (options.now ?? Date.now())) / 60000;
    if (left < 20) problems.push(`credentials expire in ${Math.max(0, Math.round(left))} min; a deploy needs more (re-login first)`);
  }
  const running = plan.phases.filter((p) => p.action === 'run');
  const imagePhase = running.some((p) => ['runtimes', 'middleware-image', 'social-images', 'documents-build', 'devbox'].includes(p.id));
  const tools = options.toolVersion ?? ((program, args) => { try { return execFileSync(program, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } });
  if (running.some((p) => p.commands.some((c) => c.args[0]?.endsWith('deploy.sh'))) && !tools(resolve(REPO_ROOT, 'infra/node_modules/.bin/cdk'), ['--version'])) {
    problems.push('cdk is not installed in infra/ (npm ci there first)');
  }
  if (imagePhase && !tools('docker', ['buildx', 'version'])) problems.push('docker buildx is not available and an image phase would run');
  // ORCHESTRATE_ASSUME_CLEAN=1 is a test hook (the CLI tests run against a developer tree that is often dirty); never set it for a real apply.
  const dirty = options.dirty ?? (process.env.ORCHESTRATE_ASSUME_CLEAN === '1' ? () => [] : dirtyPaths);
  const builtPaths = running.flatMap((p) => PHASES.find((x) => x.id === p.id)?.inputPaths ?? []);
  const dirtyList = builtPaths.length ? dirty(builtPaths) : [];
  if (dirtyList.length && !options.workingTree) problems.push(`uncommitted changes in paths this run builds: ${dirtyList.slice(0, 8).join(', ')} (commit them, or --working-tree with --only)`);
  return problems;
}

export function verifyChecks(env, probes, { health = null } = {}) {
  const problems = [];
  if (!(Number(probes.ecs?.desired) >= 1) || probes.ecs?.running !== probes.ecs?.desired) problems.push(`middleware ECS desired=${probes.ecs?.desired ?? '-'} running=${probes.ecs?.running ?? '-'}`);
  for (const a of AGENTS) {
    const rt = (probes.runtimes ?? []).find((r) => r.name === `orgiq_${a.replace(/-/g, '_')}`);
    if (!rt) problems.push(`runtime orgiq_${a.replace(/-/g, '_')} missing`);
    else if (rt.status !== 'READY') problems.push(`runtime ${rt.name} is ${rt.status}`);
  }
  if (health !== null && health !== 200) problems.push(`GET ${probes.portalUrl ?? '<portal>'}/health answered ${health}`);
  return problems;
}

/**
 * The last recorded run: the local file when it is usable, else the copy the
 * last `apply` put to SSM `/<prefix>/deploy/last-run` (so a second machine, or
 * this one after the file is lost, derives the same plan), else nothing.
 */
export function previousState(file, env, probes) {
  const local = readState(file, env.name);
  if (local.state) return local;
  const remote = probes.ssm?.[lastRunParameter(env.prefix)];
  if (remote) {
    try {
      const v = validateState(JSON.parse(remote), env.name);
      if (v.ok) return { state: v.state, reason: `${local.reason}; using the SSM last-run record (${v.state.runId})` };
      return { state: null, reason: `${local.reason}; SSM last-run rejected: ${v.reason}; the probes decide` };
    } catch {
      return { state: null, reason: `${local.reason}; SSM last-run unreadable; the probes decide` };
    }
  }
  return local;
}

// ── the runner ──────────────────────────────────────────────────────────────
export function createRunner({ env, aws, exec = defaultExec, now = () => new Date(), host = hostname(), root = REPO_ROOT, out = console.log, readJson = defaultReadJson, exists = fsExists, fetchHealth = defaultHealth }) {
  const file = stateFile(env.name, root);
  const put = (name, value, overwrite) => aws(['ssm', 'put-parameter', '--name', name, '--region', env.region, '--type', 'String', '--value', value,
    ...(overwrite ? ['--overwrite'] : [])], { readOnly: false, allowFail: false });

  function takeLock(runId, breakLock) {
    const name = lockParameter(env.prefix);
    const value = JSON.stringify({ runId, host, startedAt: now().toISOString() });
    try {
      put(name, value, false);
      return;
    } catch (err) {
      if (!/ParameterAlreadyExists/.test(err.message)) throw err;
    }
    const holder = aws(['ssm', 'get-parameter', '--name', name, '--region', env.region, '--query', 'Parameter.Value', '--output', 'text']) ?? '{}';
    if (!breakLock) {
      const h = (() => { try { return JSON.parse(holder); } catch { return { raw: holder }; } })();
      throw Object.assign(new Error(`another deploy holds ${name}: run ${h.runId ?? '?'} on ${h.host ?? '?'} since ${h.startedAt ?? '?'}. Wait, or --break-lock after confirming it is dead.`), { code: 3 });
    }
    out(`breaking the lock held by ${holder}`);
    put(name, value, true);
  }
  function releaseLock() {
    try { aws(['ssm', 'delete-parameter', '--name', lockParameter(env.prefix), '--region', env.region], { readOnly: false }); } catch { /* best effort */ }
  }

  function record(state) {
    writeState(file, state);
    try { put(lastRunParameter(env.prefix), JSON.stringify(state), true); } catch (err) { out(`  (last-run not published: ${err.message.split('\n')[0]})`); }
  }

  function apply(options) {
    const probes = collectProbes(env, aws);
    const { state: previous, reason } = previousState(file, env, probes);
    if (reason) out(`state: ${reason}`);
    const commit = options.commit ?? gitHead(root);
    const plan = planDeploy(env, probes, previous, { ...options, commit, exists });
    const problems = preflightChecks(env, probes, plan, options);
    if (problems.length) { for (const p of problems) out(`✗ preflight: ${p}`); return 2; }
    const id = makeRunId(now(), commit);
    takeLock(id, options.breakLock);
    const state = previous ? { ...previous, runId: id, commit, account: probes.account } : newState({ env, account: probes.account, commit, runId: id });
    let rc = 0;
    // Outputs as they stand NOW: a digest an image phase produced in this run
    // reaches every later deploy.sh as explicit --context (never the stale one).
    const liveOutputs = Object.fromEntries(Object.entries(state.phases).map(([pid, p]) => [pid, p.outputs ?? {}]));
    const previousOutputs = { ...liveOutputs };
    try {
      for (const phase of plan.phases) {
        if (phase.action !== 'run') { out(`· ${phase.id}: ${phase.action} — ${phase.reason}`); continue; }
        out(`▶ ${phase.id}: ${phase.reason}`);
        if (phase.id === 'preflight') { state.phases.preflight = { status: 'done', inputKey: phase.inputKey, startedAt: now().toISOString(), finishedAt: now().toISOString() }; record(state); continue; }
        if (phase.id === 'verify') {
          const after = collectProbes(env, aws);
          const health = fetchHealth(after.portalUrl);
          const bad = verifyChecks(env, after, { health });
          state.phases.verify = { status: bad.length ? 'failed' : 'done', inputKey: phase.inputKey, startedAt: now().toISOString(), finishedAt: now().toISOString(), problems: bad };
          record(state);
          for (const b of bad) out(`  ✗ ${b}`);
          if (bad.length) rc = 1;
          continue;
        }
        state.phases[phase.id] = { status: 'running', inputKey: phase.inputKey, startedAt: now().toISOString(), runId: id };
        record(state);
        const def = PHASES.find((p) => p.id === phase.id);
        const commands = def.commands(env, { commit, outputs: liveOutputs, previousOutputs, options, exists });
        let failed = null;
        for (const cmd of commands) {
          out(`  $ ${commandLine(cmd)}`);
          const result = exec(cmd, { logFile: resolve(dirname(file), `${phase.id}.log`) });
          if (result.status !== 0) { failed = result; break; }
        }
        const outputs = failed ? {} : (def.outputs?.({ readJson: (p) => readJson(resolve(root, p)) }) ?? {});
        if (!failed) liveOutputs[phase.id] = outputs;
        state.phases[phase.id] = {
          ...state.phases[phase.id], status: failed ? 'failed' : 'done', finishedAt: now().toISOString(), outputs,
          ...(failed && { exitCode: failed.status, tail: failed.tail }),
        };
        record(state);
        if (failed) { out(`✗ ${phase.id} failed (exit ${failed.status}); fix it and run \`orchestrate.mjs resume --env ${env.name}\``); rc = 1; break; }
      }
    } finally {
      releaseLock();
    }
    return rc;
  }

  return { apply, takeLock, releaseLock, file };
}

export function defaultExec(cmd, { logFile } = {}) {
  if (logFile) mkdirSync(dirname(logFile), { recursive: true, mode: 0o700 });
  const r = spawnSync(cmd.program, cmd.args, { cwd: cmd.cwd ?? REPO_ROOT, env: { ...process.env, ...(cmd.env ?? {}) }, encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  const text = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  process.stdout.write(text);
  if (logFile) appendFileSync(logFile, `\n$ ${commandLine(cmd)}\n${text}`);
  return { status: r.error ? 127 : r.status, tail: text.split('\n').slice(-40).join('\n') };
}
function defaultReadJson(p) { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } }
function defaultHealth(portalUrl) {
  if (!portalUrl) return null;
  const r = spawnSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', `${portalUrl.replace(/\/$/, '')}/health`], { encoding: 'utf8' });
  return r.status === 0 ? Number(r.stdout.trim()) : 0;
}

// ── CLI ─────────────────────────────────────────────────────────────────────
export function printPlan(plan, { out = console.log } = {}) {
  out(`# deploy plan: env=${plan.env} account=${plan.account ?? '?'} commit=${plan.commit.slice(0, 12)}`);
  for (const p of plan.phases) {
    const mark = p.action === 'run' ? '▶' : p.action === 'disabled' ? '○' : '·';
    out(`${mark} ${p.id}: ${p.action} — ${p.reason}`);
    for (const c of p.commands) out(`    ${commandLine(c)}`);
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 22).map((l) => l.replace(/^\/\/ ?/, '')).join('\n')); return 0; }
  const env = loadEnvironment(opts.env);
  const calls = [];
  const aws = makeAws((l) => calls.push(l));
  if (opts.command === 'status') {
    const { state, reason } = readState(stateFile(env.name), env.name);
    if (!state) { console.log(`no usable state for ${env.name}: ${reason}`); return 0; }
    console.log(`run ${state.runId} commit ${state.commit.slice(0, 12)} account ${state.account}`);
    for (const [id, p] of Object.entries(state.phases)) console.log(`  ${id}: ${p.status} (${p.finishedAt ?? p.startedAt})${p.outputs && Object.keys(p.outputs).length ? ' ' + JSON.stringify(p.outputs) : ''}`);
    return 0;
  }
  if (opts.command === 'plan' || opts.dryRun) {
    const probes = collectProbes(env, aws);
    const { state, reason } = previousState(stateFile(env.name), env, probes);
    if (reason) console.log(`# state: ${reason}`);
    const plan = planDeploy(env, probes, state, { ...opts, commit: gitHead() });
    printPlan(plan);
    const problems = preflightChecks(env, probes, plan, opts);
    for (const p of problems) console.log(`# preflight would refuse: ${p}`);
    console.log(`# ${calls.length} read-only aws calls, no write call`);
    return problems.length ? 2 : 0;
  }
  const runner = createRunner({ env, aws });
  return runner.apply(opts);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exit(main()); } catch (err) { console.error(`orchestrate: ${err.message}`); process.exit(err.code ?? 1); }
}
