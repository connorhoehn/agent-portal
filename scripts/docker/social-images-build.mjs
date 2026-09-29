#!/usr/bin/env node
// Build and push the three OrgIQ-SocialImages images by digest — ARM64, local
// `docker buildx`, never CodeBuild — from the pinned commits in
// document-workspace-sources.json `socialSources` (git archive of a committed
// object, the way document-workspace-build.mjs does it: no sibling working
// tree, dirty file or untracked secret reaches a build context).
//
//   node scripts/docker/social-images-build.mjs --dry-run          # print, no Docker, no AWS
//   node scripts/docker/social-images-build.mjs                    # all three
//   node scripts/docker/social-images-build.mjs --only sfu,platformApi
//
// Options: --account <id> (default: `aws sts get-caller-identity`; dry run:
// 647757222309), --region <r> (AWS_DEFAULT_REGION or us-east-1), --prefix
// <p> (orgiq), --only <keys>. Real runs need SSH_AUTH_SOCK (the gateway and
// platform-api builds clone private github: pins with --ssh default) and
// GH_TOKEN (the SFU's Dockerfile reads it as the `gh-token` BuildKit secret).
//
// Each push prints its digest as the CDK context the stacks read:
//   --context sfuImageDigest=sha256:…          (OrgIQ-SocialMedia)
//   --context platformApiImageDigest=sha256:…  (OrgIQ-Social)
//   --context gatewayImageDigest=sha256:…      (no consumer today: the middleware is its own gateway)
// and writes them to .scratch/social-images/report.json.
//
// `--provenance=false --sbom=false` keeps each push a single linux/arm64
// manifest, so the digest is the image itself (not an attestation index) and
// `aws ecr describe-images` reports its architecture.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { archiveCommittedSource, resolveCommittedRepository, sourceManifest } from './document-workspace-build.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const LAB_ACCOUNT = '647757222309';
/** CLAUDE.md: a personal account that must never receive this project. */
export const FORBIDDEN_ACCOUNTS = ['264161986065'];

/** Keys and repo suffixes match SOCIAL_IMAGE_REPOS in infra/lib/social-images-stack.ts.
 * `context` and `dockerfile` are relative to that image's own build root,
 * `<contextRoot>/<key>/`, which holds only its source archived as
 * `<key>/<source>/` — so platform-api's parent-directory context never ships
 * the other two checkouts to the builder. */
export const socialImageDefinitions = [
  {
    key: 'gateway', repo: 'social-gateway', source: 'realtime-examples', context: '{source}',
    dockerfile: 'realtime-examples/Dockerfile', target: 'server-runtime', ssh: true, digestContext: 'gatewayImageDigest',
  },
  {
    // Its Dockerfile COPYs `platform-api/…`, so the context is the directory
    // HOLDING the checkout — as compose, the Tiltfile and the document build do.
    key: 'platformApi', repo: 'platform-api', source: 'platform-api', context: '.',
    dockerfile: 'platform-api/Dockerfile', ssh: true, digestContext: 'platformApiImageDigest',
  },
  {
    key: 'sfu', repo: 'lvs-sfu', source: 'live-video-streaming', context: '{source}',
    dockerfile: 'live-video-streaming/Dockerfile', ghToken: true, digestContext: 'sfuImageDigest',
  },
];

export function socialSources(manifest = sourceManifest) {
  const sources = Object.fromEntries(Object.entries(manifest.socialSources ?? {}).filter(([name]) => !name.startsWith('_')));
  for (const definition of socialImageDefinitions) {
    const source = sources[definition.source];
    if (!source || !/^[a-f0-9]{40}$/.test(source.commit)) throw new Error(`socialSources.${definition.source} needs a full 40-char commit`);
  }
  return sources;
}

export function parseArgs(argv) {
  const opts = { dryRun: false, only: null, account: process.env.AWS_ACCOUNT_ID || null, region: process.env.AWS_DEFAULT_REGION || 'us-east-1', prefix: 'orgiq' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => { const v = argv[++i]; if (!v) throw new Error(`${arg} needs a value`); return v; };
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--only') opts.only = value().split(',').map(s => s.trim()).filter(Boolean);
    else if (arg === '--account') opts.account = value();
    else if (arg === '--region') opts.region = value();
    else if (arg === '--prefix') opts.prefix = value();
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`Unknown argument ${arg}`);
  }
  const keys = socialImageDefinitions.map(d => d.key);
  for (const key of opts.only ?? []) if (!keys.includes(key)) throw new Error(`--only takes ${keys.join(', ')}; got ${key}`);
  return opts;
}

/** The exact commands for each image. Pure: no git, Docker or AWS. */
export function planSocialImages({ account, region, prefix = 'orgiq', only = null, contextRoot, stateDir, sources = socialSources() }) {
  if (FORBIDDEN_ACCOUNTS.includes(account)) throw new Error(`Account ${account} must never be used for this project (CLAUDE.md)`);
  if (!/^\d{12}$/.test(account)) throw new Error(`Not an AWS account id: ${account}`);
  const registry = `${account}.dkr.ecr.${region}.amazonaws.com`;
  const images = socialImageDefinitions.filter(d => !only || only.includes(d.key)).map((definition) => {
    const source = sources[definition.source];
    const commit = source.commit;
    const repository = `${prefix}-${definition.repo}`;
    const buildRoot = resolve(contextRoot, definition.key);
    const context = resolve(buildRoot, definition.context.replace('{source}', definition.source));
    const metadataFile = resolve(stateDir, `${definition.key}.metadata.json`);
    const args = ['buildx', 'build', '--platform', 'linux/arm64', '--provenance=false', '--sbom=false', '--progress=plain'];
    if (definition.target) args.push('--target', definition.target);
    if (definition.ssh) args.push('--ssh', 'default');
    if (definition.ghToken) args.push('--secret', 'id=gh-token,env=GH_TOKEN');
    args.push('--label', `org.opencontainers.image.revision=${commit}`, '--label', `org.opencontainers.image.source=${source.url}`,
      '-f', resolve(buildRoot, definition.dockerfile),
      '-t', `${registry}/${repository}:${commit.slice(0, 12)}`, '-t', `${registry}/${repository}:latest`,
      '--metadata-file', metadataFile, '--push', context);
    return { ...definition, repository, commit, sourceUrl: source.url, buildRoot, context, metadataFile, args };
  });
  return {
    registry,
    login: `aws ecr get-login-password --region ${region} | docker login --username AWS --password-stdin ${registry}`,
    images,
  };
}

const shellQuote = (s) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
export const commandLine = (args) => ['docker', ...args].map(shellQuote).join(' ');

/** `containerimage.digest` from buildx's --metadata-file. */
export function digestFromMetadata(metadata) {
  const digest = metadata['containerimage.digest'];
  if (typeof digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error('buildx metadata has no containerimage.digest');
  return digest;
}

function run(program, args, options = {}) {
  const result = spawnSync(program, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${program} ${args.slice(0, 2).join(' ')} failed with status ${result.status}`);
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
  const stateDir = resolve(root, '.scratch/social-images');
  const contextRoot = resolve(stateDir, 'context');
  const sources = socialSources();

  if (opts.dryRun) {
    const plan = planSocialImages({ ...opts, account: opts.account ?? LAB_ACCOUNT, contextRoot, stateDir, sources });
    console.log('# dry run: nothing is archived, built or pushed');
    console.log('# sources (git archive <commit> of the sibling checkout, or a fetched bare cache):');
    for (const image of plan.images) console.log(`#   ${image.source}@${image.commit} (${image.sourceUrl}) -> ${image.buildRoot}/${image.source}`);
    console.log(plan.login);
    for (const image of plan.images) console.log(commandLine(image.args));
    console.log('# then, per image: jq -r \'."containerimage.digest"\' <metadata-file>  → the digest contexts:');
    for (const image of plan.images) console.log(`#   --context ${image.digestContext}=sha256:…   (${image.repository}, ${image.metadataFile})`);
    return;
  }

  const account = callerAccount();
  if (opts.account && opts.account !== account) throw new Error(`--account ${opts.account} but the credentials are for ${account}`);
  if (account !== LAB_ACCOUNT) console.warn(`⚠️  Credentials are for ${account}, not the innovation-lab account ${LAB_ACCOUNT}.`);
  const plan = planSocialImages({ ...opts, account, contextRoot, stateDir, sources });
  if (plan.images.some(i => i.ssh) && !process.env.SSH_AUTH_SOCK) throw new Error('SSH_AUTH_SOCK is unset: the builds clone private github: pins with --ssh default');
  if (plan.images.some(i => i.ghToken) && !process.env.GH_TOKEN) throw new Error('GH_TOKEN is unset: the SFU build reads it as the gh-token BuildKit secret');

  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  rmSync(contextRoot, { recursive: true, force: true });
  for (const image of plan.images) {
    const source = sources[image.source];
    const repository = resolveCommittedRepository(source, { sibling: resolve(root, '..', image.source), cache: resolve(stateDir, 'git-cache', `${image.source}.git`) });
    archiveCommittedSource(repository, source.commit, resolve(image.buildRoot, image.source));
  }
  for (const image of plan.images) {
    const dockerfile = image.args[image.args.indexOf('-f') + 1];
    if (!existsSync(dockerfile)) throw new Error(`Missing Dockerfile ${dockerfile} in ${image.source}@${image.commit}`);
  }

  run('sh', ['-c', plan.login]);
  const report = { schemaVersion: 1, builtAt: new Date().toISOString(), account, region: opts.region, registry: plan.registry, images: [] };
  for (const image of plan.images) {
    console.log(`\n── ${image.repository} from ${image.source}@${image.commit} ──`);
    rmSync(image.metadataFile, { force: true });
    run('docker', image.args, { env: process.env });
    const digest = digestFromMetadata(JSON.parse(readFileSync(image.metadataFile, 'utf8')));
    report.images.push({ key: image.key, repository: image.repository, sourceCommit: image.commit, digest, context: `${image.digestContext}=${digest}` });
    writeFileSync(resolve(stateDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  }
  rmSync(contextRoot, { recursive: true, force: true });
  console.log('\nPushed. Pass these to the social stacks:');
  for (const image of report.images) console.log(`  --context ${image.context}`);
  console.log(`Report: ${resolve(stateDir, 'report.json')}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { main(); } catch (err) { console.error(`social-images-build: ${err.message}`); process.exit(1); }
}
