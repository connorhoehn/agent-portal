#!/usr/bin/env node
// Publish the locally built document service images to ECR by digest and
// provision what `deployDocumentWorkspace=true` needs that CDK never creates:
// the Ed25519 grant key pair (lib/document-workspace.ts reads both secrets by
// ARN and never generates or reads key bytes) and the `documentWorkspace`
// context, which is also written to SSM so deploy.sh can keep it on later
// deploys (§ "Sticky context").
//
//   node scripts/document-workspace.mjs build                  # first: the images
//   node scripts/docker/document-workspace-push.mjs --dry-run  # print, no Docker, no AWS
//   node scripts/docker/document-workspace-push.mjs            # push, keys, context
//
// Options: --region <r> (AWS_DEFAULT_REGION or us-east-1), --prefix <p>
// (orgiq), --public-base-url <https origin> (default: SSM /<prefix>/portal/url,
// the portal's CloudFront origin, which fronts /document-realtime).
//
// Idempotent: repositories and key secrets are created only when absent; an
// existing key pair is reused, never rotated. Key bytes never reach stdout.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultImages } from './document-workspace-build.mjs';
import { FORBIDDEN_ACCOUNTS, LAB_ACCOUNT } from './social-images-build.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** lib/document-workspace.ts `images` keys → the build's image variables. */
export const DOCUMENT_IMAGE_KEYS = { gateway: 'GATEWAY_IMAGE', platform: 'PLATFORM_API_IMAGE', catalog: 'CATALOG_IMAGE', mq: 'MQ_IMAGE', redis: 'REDIS_IMAGE' };

export function documentRepository(prefix, key) { return `${prefix}-documents-${key}`; }
export function documentKeySecretNames(prefix) {
  return { privateKey: `${prefix}-document-grant-private-key`, publicKey: `${prefix}-document-grant-public-key` };
}
export function documentConfigParameterName(prefix) { return `/${prefix}/documents/workspace-config`; }

export function parseArgs(argv) {
  const opts = { dryRun: false, region: process.env.AWS_DEFAULT_REGION || 'us-east-1', prefix: 'orgiq', publicBaseUrl: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--region') opts.region = argv[++i];
    else if (arg === '--prefix') opts.prefix = argv[++i];
    else if (arg === '--public-base-url') opts.publicBaseUrl = argv[++i];
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`Unknown option ${arg}`);
  }
  return opts;
}

export function planDocumentPush({ account, region, prefix, images = defaultImages() }) {
  const registry = `${account}.dkr.ecr.${region}.amazonaws.com`;
  return {
    registry,
    login: `aws ecr get-login-password --region ${region} | docker login --username AWS --password-stdin ${registry}`,
    images: Object.entries(DOCUMENT_IMAGE_KEYS).map(([key, variable]) => {
      const local = images[variable];
      const repository = documentRepository(prefix, key);
      // The source tag (`:document-<sha>`), or `pinned` for redis@sha256:….
      const tag = local.includes('@') ? 'pinned' : local.slice(local.lastIndexOf(':') + 1);
      return { key, local, repository, remote: `${registry}/${repository}:${tag}`, tag };
    }),
  };
}

export function workspaceConfig({ publicBaseUrl, digests, prefix, keyArns }) {
  return {
    tenantId: 'assessment', publicBaseUrl, grantIssuer: 'assessment-bff', grantKeyId: 'v1',
    grantPrivateKeySecretArn: keyArns.privateKey, grantPublicKeySecretArn: keyArns.publicKey, architecture: 'ARM64',
    images: Object.fromEntries(Object.keys(DOCUMENT_IMAGE_KEYS).map(key => [key, { repositoryName: documentRepository(prefix, key), digest: digests[key] }])),
  };
}

function aws(args, options = {}) {
  return execFileSync('aws', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...options }).trim();
}
function tryAws(args) { try { return aws(args); } catch { return null; } }
function run(program, args) {
  const result = spawnSync(program, args, { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${program} ${args.slice(0, 2).join(' ')} failed with status ${result.status}`);
}

function ensureRepository(name, region) {
  if (tryAws(['ecr', 'describe-repositories', '--repository-names', name, '--region', region])) return;
  aws(['ecr', 'create-repository', '--repository-name', name, '--region', region, '--image-scanning-configuration', 'scanOnPush=true']);
  console.log(`created ECR repository ${name}`);
}

/** The existing pair's ARNs, or a fresh Ed25519 pair made in a private temp dir. */
function ensureKeyPair(prefix, region) {
  const names = documentKeySecretNames(prefix);
  const arnOf = (name) => tryAws(['secretsmanager', 'describe-secret', '--secret-id', name, '--region', region, '--query', 'ARN', '--output', 'text']);
  const existing = { privateKey: arnOf(names.privateKey), publicKey: arnOf(names.publicKey) };
  if (existing.privateKey && existing.publicKey) { console.log('document grant key pair: reusing the existing secrets'); return existing; }
  if (existing.privateKey || existing.publicKey) throw new Error(`Only one of ${names.privateKey} / ${names.publicKey} exists; restore or delete it before minting a new pair`);
  const dir = mkdtempSync(join(tmpdir(), 'document-keys-'));
  try {
    const priv = join(dir, 'private.pem'), pub = join(dir, 'public.pem');
    execFileSync('openssl', ['genpkey', '-algorithm', 'ed25519', '-out', priv], { stdio: 'ignore' });
    execFileSync('openssl', ['pkey', '-in', priv, '-pubout', '-out', pub], { stdio: 'ignore' });
    const create = (name, file, description) => aws(['secretsmanager', 'create-secret', '--name', name, '--region', region,
      '--description', description, '--secret-string', `file://${file}`, '--query', 'ARN', '--output', 'text']);
    const arns = {
      privateKey: create(names.privateKey, priv, 'Document grant Ed25519 private key (BFF only); document-workspace-push.mjs'),
      publicKey: create(names.publicKey, pub, 'Document grant Ed25519 public key (gateway, platform); document-workspace-push.mjs'),
    };
    console.log('document grant key pair: minted and stored');
    return arns;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    const lines = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1);
    console.log(lines.slice(0, lines.findIndex(l => !l.startsWith('//'))).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
    return;
  }
  if (opts.dryRun) {
    const plan = planDocumentPush({ ...opts, account: LAB_ACCOUNT });
    console.log('# dry run: nothing is created, tagged or pushed');
    console.log(plan.login);
    for (const image of plan.images) console.log(`docker tag ${image.local} ${image.remote} && docker push ${image.remote}   # ${image.key}`);
    console.log(`# then: the ${Object.values(documentKeySecretNames(opts.prefix)).join(' / ')} secrets, and SSM ${documentConfigParameterName(opts.prefix)}`);
    return;
  }
  const account = aws(['sts', 'get-caller-identity', '--query', 'Account', '--output', 'text']);
  if (FORBIDDEN_ACCOUNTS.includes(account)) throw new Error(`Refusing to publish to ${account}`);
  if (account !== LAB_ACCOUNT) console.warn(`⚠️  Credentials are for ${account}, not the innovation-lab account ${LAB_ACCOUNT}.`);
  const publicBaseUrl = opts.publicBaseUrl
    ?? tryAws(['ssm', 'get-parameter', '--name', `/${opts.prefix}/portal/url`, '--region', opts.region, '--query', 'Parameter.Value', '--output', 'text']);
  if (!publicBaseUrl?.startsWith('https://')) throw new Error('No HTTPS public base URL: deploy OrgIQ-Portal first, or pass --public-base-url');

  const plan = planDocumentPush({ ...opts, account });
  for (const image of plan.images) {
    if (spawnSync('docker', ['image', 'inspect', image.local], { stdio: 'ignore' }).status !== 0) {
      throw new Error(`${image.local} is not built: run node scripts/document-workspace.mjs build`);
    }
  }
  run('sh', ['-c', plan.login]);
  const digests = {};
  for (const image of plan.images) {
    ensureRepository(image.repository, opts.region);
    run('docker', ['tag', image.local, image.remote]);
    run('docker', ['push', image.remote]);
    digests[image.key] = aws(['ecr', 'describe-images', '--repository-name', image.repository, '--region', opts.region,
      '--image-ids', `imageTag=${image.tag}`, '--query', 'imageDetails[0].imageDigest', '--output', 'text']);
    if (!/^sha256:[a-f0-9]{64}$/.test(digests[image.key])) throw new Error(`No digest for ${image.remote}`);
  }
  const config = workspaceConfig({ publicBaseUrl, digests, prefix: opts.prefix, keyArns: ensureKeyPair(opts.prefix, opts.region) });
  aws(['ssm', 'put-parameter', '--name', documentConfigParameterName(opts.prefix), '--region', opts.region, '--type', 'String',
    '--overwrite', '--value', JSON.stringify(config)]);
  const stateDir = resolve(root, '.scratch/document-workspace');
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(resolve(stateDir, 'push-report.json'), JSON.stringify({ pushedAt: new Date().toISOString(), account, config }, null, 2) + '\n');
  console.log(`\nPublished. ${documentConfigParameterName(opts.prefix)} holds the context; deploy with:`);
  console.log(`  ./scripts/deploy.sh OrgIQ-MiddlewareService -e --context deployDocumentWorkspace=true --context documentWorkspace='${JSON.stringify(config)}'`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { main(); } catch (err) { console.error(`document-workspace-push: ${err.message}`); process.exit(1); }
}
