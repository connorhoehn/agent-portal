#!/usr/bin/env node
// Build and push the middleware image to OrgIQ-MiddlewareService's ECR repo —
// ARM64, local `docker buildx`, never CodeBuild — the one command the deploy
// runbook's "build + push the middleware image" step means
// (docs/social-calls-deploy-plan.md §9 step 2, §10).
//
//   node scripts/docker/middleware-image-build.mjs --dry-run     # print, no git/Docker/AWS
//   node scripts/docker/middleware-image-build.mjs               # HEAD's middleware/, pushed
//   node scripts/docker/middleware-image-build.mjs --working-tree
//
// What it pins, and how:
//   - the middleware source: `git archive HEAD middleware/` into
//     .scratch/middleware-image/context — the committed tree, not whatever is
//     on disk (`--working-tree` builds the checkout as it is, and says so);
//   - the github: libraries (realtime-modules, ui-components' siblings…):
//     scripts/docker/prepare-libraries.mjs exports each EXACT locked commit
//     into .docker-libraries/, which the Dockerfile's deps stage installs from
//     (`--build-context locked_libraries=…`) — the same path compose and
//     scripts/build.sh take, so no build reaches GitHub for a moving ref.
//
// Tags `:<HEAD commit12>` and `:latest` (the stack pulls `:latest`), prints the
// pushed digest and the next commands (the ECS rollout). Options: --account
// <id> (default: `aws sts get-caller-identity`; dry run: 647757222309),
// --region <r> (AWS_DEFAULT_REGION or us-east-1), --prefix <p> (orgiq),
// --working-tree. Refuses the personal account CLAUDE.md forbids.
//
// `--provenance=false --sbom=false` keeps the push a single linux/arm64
// manifest — the middleware task is ARM64 (CLAUDE.md, "exec format error").
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FORBIDDEN_ACCOUNTS, LAB_ACCOUNT, commandLine, digestFromMetadata } from './social-images-build.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export function parseArgs(argv) {
  const opts = {
    dryRun: false, workingTree: false, account: process.env.AWS_ACCOUNT_ID || null,
    region: process.env.AWS_DEFAULT_REGION || 'us-east-1', prefix: 'orgiq',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => { const v = argv[++i]; if (!v) throw new Error(`${arg} needs a value`); return v; };
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--working-tree') opts.workingTree = true;
    else if (arg === '--account') opts.account = value();
    else if (arg === '--region') opts.region = value();
    else if (arg === '--prefix') opts.prefix = value();
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`Unknown argument ${arg}`);
  }
  return opts;
}

/** The exact commands. Pure: no git, Docker or AWS. */
export function planMiddlewareImage({ account, region, prefix = 'orgiq', commit, context, librariesDir, metadataFile }) {
  if (FORBIDDEN_ACCOUNTS.includes(account)) throw new Error(`Account ${account} must never be used for this project (CLAUDE.md)`);
  if (!/^\d{12}$/.test(account)) throw new Error(`Not an AWS account id: ${account}`);
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error(`Not a full commit: ${commit}`);
  const registry = `${account}.dkr.ecr.${region}.amazonaws.com`;
  const repository = `${prefix}-middleware`;
  const args = [
    'buildx', 'build', '--platform', 'linux/arm64', '--provenance=false', '--sbom=false', '--progress=plain',
    '--target', 'production',
    '--build-context', `locked_libraries=${librariesDir}`,
    '--label', `org.opencontainers.image.revision=${commit}`,
    '-f', resolve(context, 'Dockerfile'),
    '-t', `${registry}/${repository}:${commit.slice(0, 12)}`, '-t', `${registry}/${repository}:latest`,
    '--metadata-file', metadataFile, '--push', context,
  ];
  return {
    registry,
    repository,
    login: `aws ecr get-login-password --region ${region} | docker login --username AWS --password-stdin ${registry}`,
    args,
    // The service pulls `:latest`, so a push alone changes nothing that runs.
    rollout: `aws ecs update-service --region ${region} --cluster ${prefix}-middleware --service ${prefix}-middleware --force-new-deployment`,
    verify: `aws ecs describe-services --region ${region} --cluster ${prefix}-middleware --services ${prefix}-middleware --query 'services[0].[desiredCount,runningCount]'`,
  };
}

function run(program, args, options = {}) {
  const result = spawnSync(program, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${program} ${args.slice(0, 2).join(' ')} failed with status ${result.status}`);
}

function git(args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

function callerAccount() {
  try {
    return execFileSync('aws', ['sts', 'get-caller-identity', '--query', 'Account', '--output', 'text'], { encoding: 'utf8' }).trim();
  } catch {
    throw new Error('aws sts get-caller-identity failed: sign in first (aws-azure-login --mode gui)');
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    const lines = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1);
    console.log(lines.slice(0, lines.findIndex(l => !l.startsWith('//'))).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
    return;
  }
  const stateDir = resolve(root, '.scratch/middleware-image');
  const archived = resolve(stateDir, 'context');
  const context = opts.workingTree ? resolve(root, 'middleware') : resolve(archived, 'middleware');
  const librariesDir = resolve(root, '.docker-libraries');
  const metadataFile = resolve(stateDir, 'metadata.json');
  const commit = git(['rev-parse', 'HEAD']);
  const dirty = git(['status', '--porcelain', '--', 'middleware']).length > 0;

  if (opts.dryRun) {
    const plan = planMiddlewareImage({ ...opts, account: opts.account ?? LAB_ACCOUNT, commit, context, librariesDir, metadataFile });
    console.log('# dry run: nothing is archived, built or pushed');
    console.log(`# source: ${opts.workingTree ? 'the middleware/ working tree' : `git archive ${commit} middleware/ -> ${archived}`}`);
    if (dirty && !opts.workingTree) console.log('# note: middleware/ has uncommitted changes; they are NOT in this build (use --working-tree to include them)');
    console.log(`node ${resolve(root, 'scripts/docker/prepare-libraries.mjs')}   # exact locked library commits -> ${librariesDir}`);
    console.log(plan.login);
    console.log(commandLine(plan.args));
    console.log(`# then: jq -r '."containerimage.digest"' ${metadataFile}`);
    console.log(`# phase 2 (service at desiredCount 0 until --context deployMiddlewareService=true), or if already running:`);
    console.log(plan.rollout);
    console.log(plan.verify + '   # CREATE_COMPLETE proves nothing');
    return;
  }

  const account = callerAccount();
  if (opts.account && opts.account !== account) throw new Error(`--account ${opts.account} but the credentials are for ${account}`);
  if (account !== LAB_ACCOUNT) console.warn(`⚠️  Credentials are for ${account}, not the innovation-lab account ${LAB_ACCOUNT}.`);
  const plan = planMiddlewareImage({ ...opts, account, commit, context, librariesDir, metadataFile });

  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  if (opts.workingTree) {
    if (dirty) console.warn('⚠️  Building the middleware/ WORKING TREE, uncommitted changes included; the tag still names HEAD.');
  } else {
    if (dirty) console.warn(`⚠️  middleware/ has uncommitted changes — NOT in this build (HEAD ${commit.slice(0, 12)} is).`);
    rmSync(archived, { recursive: true, force: true });
    mkdirSync(archived, { recursive: true });
    const tar = execFileSync('git', ['-C', root, 'archive', '--format=tar', commit, 'middleware'], { maxBuffer: 512 * 1024 * 1024 });
    execFileSync('tar', ['-xf', '-', '-C', archived], { input: tar });
  }
  if (!existsSync(resolve(context, 'Dockerfile'))) throw new Error(`No Dockerfile in ${context}`);

  run('node', [resolve(root, 'scripts/docker/prepare-libraries.mjs')]);
  run('sh', ['-c', plan.login]);
  rmSync(metadataFile, { force: true });
  run('docker', plan.args, { env: process.env });
  const digest = digestFromMetadata(JSON.parse(readFileSync(metadataFile, 'utf8')));
  writeFileSync(resolve(stateDir, 'report.json'), JSON.stringify({
    schemaVersion: 1, builtAt: new Date().toISOString(), account, region: opts.region,
    repository: plan.repository, sourceCommit: commit, workingTree: opts.workingTree, dirty, digest,
  }, null, 2) + '\n');
  console.log(`\nPushed ${plan.registry}/${plan.repository}@${digest} (:latest, :${commit.slice(0, 12)}).`);
  console.log('First time: deploy OrgIQ-MiddlewareService with --context deployMiddlewareService=true.');
  console.log(`Already running: ${plan.rollout}`);
  console.log(`Then: ${plan.verify}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { main(); } catch (err) { console.error(`middleware-image-build: ${err.message}`); process.exit(1); }
}
