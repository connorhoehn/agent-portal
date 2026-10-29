/**
 * DE-4 prompt pointers: bootstrap, status, candidate, promote, rollback.
 *
 *   node --require ts-node/register scripts/prompt-pointers.ts status      [--env lab] [--agent search]
 *   node --require ts-node/register scripts/prompt-pointers.ts bootstrap   [--env lab] [--agent a] [--yes]
 *   node --require ts-node/register scripts/prompt-pointers.ts candidate   --agent search --version 8 [--weight 10] [--yes]
 *   node --require ts-node/register scripts/prompt-pointers.ts promote     --agent search [--yes]
 *   node --require ts-node/register scripts/prompt-pointers.ts rollback    --agent search [--yes]
 *
 * Every command reads the live pointers first (`aws ssm get-parameters`, a
 * read). Without `--yes` the plan is printed and NOTHING is written — that is
 * the dry run, and it is the default. `candidate` runs the offline gate
 * (`agents/tests/golden_runner.py <agent>`, structural mode) and refuses the
 * version when it fails; `--gate-command` replaces that command, `--skip-gate`
 * does not exist on purpose. `--aurora-cluster-arn` + `--aurora-secret-arn`
 * also record the lifecycle transition in `observability.prompt_version_meta`;
 * without them the SQL is printed for the operator.
 *
 * `bootstrap` is the day-one step: each agent whose pointer is absent gets its
 * DRAFT published (`aws bedrock-agent create-prompt-version`) and that version
 * written as live, so the fleet says exactly what it said on DRAFT.
 *
 * The account comes from the environment file (DE-17), never the shell.
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { loadEnvironment } from '../lib/environment';
import {
  awsArgvFor, lifecycleSql, planBootstrap, planCandidate, planPromote, planRollback,
  pointerNames, pointersFromParameters, POINTER_AGENTS, type CurrentPointers, type PointerPlan,
} from '../lib/prompt-pointers';

interface Opts {
  command: string; env: string; agent?: string; version?: string; weight?: number; yes: boolean;
  gateCommand?: string; auroraClusterArn?: string; auroraSecretArn?: string; help: boolean;
}

export function parseArgs(argv: string[]): Opts {
  const opts: Opts = { command: argv[0] ?? '', env: process.env.ENV || 'lab', yes: false, help: false };
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = (): string => { const v = argv[++i]; if (v === undefined) throw new Error(`${arg} needs a value`); return v; };
    if (arg === '--env') opts.env = value();
    else if (arg === '--agent') opts.agent = value();
    else if (arg === '--version') opts.version = value();
    else if (arg === '--weight') opts.weight = Number(value());
    else if (arg === '--yes') opts.yes = true;
    else if (arg === '--dry-run') opts.yes = false;
    else if (arg === '--gate-command') opts.gateCommand = value();
    else if (arg === '--aurora-cluster-arn') opts.auroraClusterArn = value();
    else if (arg === '--aurora-secret-arn') opts.auroraSecretArn = value();
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`Unknown argument ${arg}`);
  }
  if (!['status', 'bootstrap', 'candidate', 'promote', 'rollback'].includes(opts.command)) {
    throw new Error(`usage: prompt-pointers.ts <status|bootstrap|candidate|promote|rollback> [options] (got "${opts.command}")`);
  }
  return opts;
}

function aws(args: string[]): string {
  return execFileSync('aws', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function readPointers(prefix: string, region: string, agent: string): CurrentPointers {
  const names = pointerNames(prefix, agent);
  const out = aws(['ssm', 'get-parameters', '--region', region, '--names', names.live, names.candidate, '--output', 'json']);
  const parsed = JSON.parse(out || '{}') as { Parameters?: Array<{ Name?: string; Value?: string }> };
  return pointersFromParameters(prefix, agent, parsed.Parameters ?? []);
}

function findPromptId(prefix: string, region: string, agent: string): string | null {
  const name = `${prefix}-${agent}-system-prompt`;
  const out = aws(['bedrock-agent', 'list-prompts', '--region', region, '--query', `promptSummaries[?name=='${name}'].id | [0]`, '--output', 'text']);
  return out && out !== 'None' ? out : null;
}

function printPlan(plan: PointerPlan): void {
  console.log(`\n${plan.agent}: ${plan.action}${plan.refused ? ' — REFUSED' : ''}`);
  if (plan.refused) { console.log(`  ✗ ${plan.refused}`); return; }
  for (const n of plan.notes) console.log(`  ${n}`);
  for (const w of plan.writes) console.log(`  put ${w.name} = ${w.value}`);
  for (const d of plan.deletes) console.log(`  delete ${d}`);
  for (const t of plan.transitions) console.log(`  prompt_version_meta ${t.promptId}@${t.version} → ${t.lifecycleStatus}`);
}

function apply(plan: PointerPlan, opts: Opts, region: string): void {
  for (const argv of awsArgvFor(plan, region)) aws(argv);
  for (const t of plan.transitions) {
    const { sql, parameters } = lifecycleSql(t);
    if (opts.auroraClusterArn && opts.auroraSecretArn) {
      aws(['rds-data', 'execute-statement', '--region', region, '--resource-arn', opts.auroraClusterArn, '--secret-arn', opts.auroraSecretArn,
        '--database', 'orgiq', '--sql', sql, '--parameters', JSON.stringify(parameters)]);
    } else {
      console.log(`  (lifecycle not recorded: pass --aurora-cluster-arn/--aurora-secret-arn)  ${sql}`);
    }
  }
}

function runGate(opts: Opts, agent: string): boolean {
  const root = resolve(__dirname, '..', '..');
  const command = opts.gateCommand
    ?? `cd ${root}/agents/tests && ${root}/.venv-synth/bin/python golden_runner.py ${agent}`;
  console.log(`  gate: ${command}`);
  try {
    execFileSync('sh', ['-c', command], { stdio: 'inherit' });
    return true;
  } catch {
    return false;
  }
}

function main(): number {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log('see the header of scripts/prompt-pointers.ts'); return 0; }
  const env = loadEnvironment(opts.env);
  const { prefix, region } = env;
  const caller = aws(['sts', 'get-caller-identity', '--query', 'Account', '--output', 'text']);
  if (caller !== env.account) throw new Error(`credentials are for ${caller}; environment '${env.name}' is ${env.account}. Nothing was changed.`);
  const agents = opts.agent ? [opts.agent] : [...POINTER_AGENTS];
  if (['candidate', 'promote', 'rollback'].includes(opts.command) && !opts.agent) throw new Error(`${opts.command} needs --agent`);

  const plans: PointerPlan[] = [];
  for (const agent of agents) {
    const current = readPointers(prefix, region, agent);
    if (opts.command === 'status') {
      console.log(`${agent}: live=${current.live ? `${current.live.promptId}@${current.live.version}` : '(absent → baked)'}`
        + ` candidate=${current.candidate ? `${current.candidate.promptId}@${current.candidate.version} ${current.candidate.weight}%` : '-'}`);
      continue;
    }
    if (opts.command === 'bootstrap') {
      const promptId = current.live?.promptId ?? findPromptId(prefix, region, agent);
      const plan = planBootstrap({ prefix, agent, current, promptId });
      if (plan.createVersion && opts.yes && promptId) {
        const version = aws(['bedrock-agent', 'create-prompt-version', '--region', region, '--prompt-identifier', promptId,
          '--description', 'DE-4 bootstrap: the DRAFT text promoted as live', '--query', 'version', '--output', 'text']);
        plans.push(planBootstrap({ prefix, agent, current, promptId, publishedVersion: version }));
      } else {
        plans.push(plan);
      }
    } else if (opts.command === 'candidate') {
      if (!opts.version) throw new Error('candidate needs --version <n>');
      const promptId = current.live?.promptId ?? findPromptId(prefix, region, agent);
      if (!promptId) throw new Error(`no prompt for ${agent}`);
      const gatePassed = opts.yes ? runGate(opts, agent) : true;
      const plan = planCandidate({ prefix, agent, current, promptId, version: opts.version, weight: opts.weight, gatePassed });
      if (!opts.yes && !plan.refused) plan.notes.concat();
      plans.push(opts.yes ? plan : { ...plan, notes: [...plan.notes, 'the offline gate runs on --yes; a failing gate refuses the write'] });
    } else if (opts.command === 'promote') {
      plans.push(planPromote({ prefix, agent, current }));
    } else if (opts.command === 'rollback') {
      plans.push(planRollback({ prefix, agent, current }));
    }
  }

  let rc = 0;
  for (const plan of plans) {
    printPlan(plan);
    if (plan.refused) { rc = 1; continue; }
    if (opts.yes) apply(plan, opts, region);
  }
  if (plans.length && !opts.yes) console.log('\n(dry run: nothing written; add --yes to apply)');
  return rc;
}

if (require.main === module) {
  try { process.exit(main()); } catch (err) { console.error(`✗ ${(err as Error).message}`); process.exit(2); }
}
