#!/usr/bin/env node
// Build the portal and publish it to OrgIQ-Portal (S3 + CloudFront) — the
// no-domain HTTPS path.
//
//   node scripts/portal-publish.mjs --dry-run              # print the plan; no AWS, no build
//   node scripts/portal-publish.mjs                        # build, sync, invalidate, check
//   node scripts/portal-publish.mjs --skip-build           # publish the existing portal/dist
//   node scripts/portal-publish.mjs --repair-bucket-policy # re-apply a stripped OAC statement
//
// Names come from the stack's outputs (PortalBucketName, PortalDistributionId,
// PortalDistributionArn, PortalUrl), never typed. Options: --stack <name>
// (OrgIQ-Portal), --region <r> (AWS_DEFAULT_REGION or us-east-1),
// --no-invalidate.
//
// ONE BUNDLE FOR EVERY ENVIRONMENT. The deployed portal learns its realtime
// endpoints at run time from GET /api/session/realtime-token. The build-time
// VITE_GATEWAY_URL / VITE_PLATFORM_API_URL / VITE_VIDEO_ENDPOINT are local
// overrides only — and Vite reads portal/.env.local in a production build too,
// so a developer's `VITE_GATEWAY_URL=http://localhost:…` would be baked into
// the deployed bundle and win over the server's answer. The build here blanks
// all three (process env beats .env files), then scans the output for any
// localhost endpoint and refuses to publish one.
//
// THE BUCKET POLICY. CloudFront reads the private bucket through Origin Access
// Control, which exists only as a bucket RESOURCE policy statement — and this
// account's custodian has stripped bucket policies before (lib/portal-stack.ts).
// Every publish checks the statement is still there; `--repair-bucket-policy`
// puts it back. A missing statement looks like this from a browser: 403
// AccessDenied on every page, every stack healthy.
//
// Caching: hashed files under assets/ are immutable for a year (old tabs keep
// working across a publish; stale ones are left in place), everything else is
// `no-cache`, and the invalidation is `/*`.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const portalDir = resolve(root, 'portal');
const distDir = resolve(portalDir, 'dist');

/** Build-time overrides that must never reach a deployed bundle. */
export const LOCAL_OVERRIDES = ['VITE_GATEWAY_URL', 'VITE_PLATFORM_API_URL', 'VITE_VIDEO_ENDPOINT'];
/**
 * A whole string literal that is an endpoint on this machine — the shape a
 * baked `VITE_*` value takes (`"http://localhost:3001"`). A URL inside longer
 * text (the approval queue's paste-me snippet, `…post("http://localhost:3001/api/…`)
 * is not one.
 */
const LOCAL_ENDPOINT = /["'`]((?:wss?|https?):\/\/(?:localhost|127\.0\.0\.1|\[::1\]):\d+\/?)["'`]/g;

export function parseArgs(argv) {
  const opts = {
    dryRun: false, skipBuild: false, repairPolicy: false, invalidate: true,
    stack: 'OrgIQ-Portal', region: process.env.AWS_DEFAULT_REGION || 'us-east-1',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => { const v = argv[++i]; if (!v) throw new Error(`${arg} needs a value`); return v; };
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--skip-build') opts.skipBuild = true;
    else if (arg === '--repair-bucket-policy') opts.repairPolicy = true;
    else if (arg === '--no-invalidate') opts.invalidate = false;
    else if (arg === '--stack') opts.stack = value();
    else if (arg === '--region') opts.region = value();
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`Unknown argument ${arg}`);
  }
  return opts;
}

/** The env the portal build runs with: the local overrides blanked. */
export function buildEnv(base = process.env) {
  return { ...base, NODE_ENV: 'production', ...Object.fromEntries(LOCAL_OVERRIDES.map((k) => [k, ''])) };
}

/** Stack outputs → what the publish needs; throws naming whatever is missing. */
export function publishTargets(outputs) {
  const get = (k) => outputs.find((o) => o.OutputKey === k)?.OutputValue;
  const t = {
    bucket: get('PortalBucketName'), distributionId: get('PortalDistributionId'),
    distributionArn: get('PortalDistributionArn'), url: get('PortalUrl'),
  };
  const missing = Object.entries(t).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw new Error(`OrgIQ-Portal outputs missing: ${missing.join(', ')} — is the stack deployed (--context deployPortal=true)?`);
  return t;
}

/** The aws CLI calls, in order. Pure. */
export function planPublish({ bucket, distributionId, region, invalidate = true }) {
  const steps = [
    ['s3', 'sync', join(distDir, 'assets'), `s3://${bucket}/assets`, '--region', region,
      '--cache-control', 'public,max-age=31536000,immutable'],
    ['s3', 'sync', distDir, `s3://${bucket}`, '--region', region, '--exclude', 'assets/*', '--delete',
      '--cache-control', 'no-cache'],
  ];
  if (invalidate) steps.push(['cloudfront', 'create-invalidation', '--distribution-id', distributionId, '--paths', '/*']);
  return steps;
}

/** The statement S3BucketOrigin.withOriginAccessControl writes. */
export function oacStatement(bucket, distributionArn) {
  return {
    Effect: 'Allow',
    Principal: { Service: 'cloudfront.amazonaws.com' },
    Action: 's3:GetObject',
    Resource: `arn:aws:s3:::${bucket}/*`,
    Condition: { StringEquals: { 'AWS:SourceArn': distributionArn } },
  };
}

/** Whether a bucket policy still lets this distribution read objects. */
export function policyAdmitsDistribution(policy, distributionArn) {
  const statements = policy?.Statement ?? [];
  return statements.some((s) => {
    const services = [].concat(s.Principal?.Service ?? []);
    const actions = [].concat(s.Action ?? []);
    const source = s.Condition?.StringEquals?.['AWS:SourceArn'];
    return s.Effect === 'Allow' && services.includes('cloudfront.amazonaws.com')
      && actions.some((a) => a === 's3:GetObject' || a === 's3:*') && source === distributionArn;
  });
}

/** The policy with the OAC statement added (or the policy unchanged if present). */
export function repairedPolicy(policy, bucket, distributionArn) {
  if (policyAdmitsDistribution(policy, distributionArn)) return policy;
  return { Version: '2012-10-17', ...(policy ?? {}), Statement: [...(policy?.Statement ?? []), oacStatement(bucket, distributionArn)] };
}

/** Localhost endpoints in a built file's text. */
export function leakedEndpoints(text) {
  return [...new Set([...text.matchAll(LOCAL_ENDPOINT)].map((m) => m[1]))];
}

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/** Every baked local endpoint in the bundle's JS, as `file: url`. */
export function scanBundle(files, read = (f) => readFileSync(f, 'utf8')) {
  const found = [];
  for (const f of files.filter((x) => x.endsWith('.js'))) {
    for (const url of leakedEndpoints(read(f))) found.push(`${f}: ${url}`);
  }
  return found;
}

function aws(args, opts = {}) {
  return execFileSync('aws', args, { encoding: 'utf8', ...opts });
}

function run(program, args, options = {}) {
  const result = spawnSync(program, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${program} ${args.slice(0, 2).join(' ')} failed with status ${result.status}`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    const lines = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1);
    console.log(lines.slice(0, lines.findIndex((l) => !l.startsWith('//'))).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    return;
  }

  if (opts.dryRun) {
    const placeholder = { bucket: '<PortalBucketName>', distributionId: '<PortalDistributionId>', region: opts.region, invalidate: opts.invalidate };
    console.log('# dry run: no AWS call, no build');
    console.log(`aws cloudformation describe-stacks --stack-name ${opts.stack} --region ${opts.region} --query 'Stacks[0].Outputs'`);
    if (!opts.skipBuild) {
      console.log(`(cd portal && ${LOCAL_OVERRIDES.map((k) => `${k}=`).join(' ')} NODE_ENV=production npm run build)`);
      console.log('# then: refuse to publish if any built .js names a localhost endpoint');
    }
    for (const step of planPublish(placeholder)) console.log(['aws', ...step].join(' '));
    console.log(`aws s3api get-bucket-policy --bucket <PortalBucketName>   # must still admit cloudfront.amazonaws.com for <PortalDistributionArn>${opts.repairPolicy ? ' (re-applied if not)' : ''}`);
    console.log('# then: GET <PortalUrl>/ and <PortalUrl>/health');
    const envLocal = resolve(portalDir, '.env.local');
    if (existsSync(envLocal)) {
      const set = LOCAL_OVERRIDES.filter((k) => new RegExp(`^${k}=.+`, 'm').test(readFileSync(envLocal, 'utf8')));
      if (set.length) console.log(`# note: portal/.env.local sets ${set.join(', ')} — blanked for this build`);
    }
    return;
  }

  const outputs = JSON.parse(aws(['cloudformation', 'describe-stacks', '--stack-name', opts.stack, '--region', opts.region,
    '--query', 'Stacks[0].Outputs', '--output', 'json']));
  const targets = publishTargets(outputs ?? []);
  console.log(`Publishing to s3://${targets.bucket} behind ${targets.url} (${targets.distributionId})`);

  if (!opts.skipBuild) run('npm', ['run', 'build'], { cwd: portalDir, env: buildEnv() });
  if (!existsSync(resolve(distDir, 'index.html'))) throw new Error('portal/dist/index.html is missing — build first');
  const leaks = scanBundle(walk(distDir));
  if (leaks.length) {
    throw new Error(`the bundle names local endpoints — a VITE_* override was baked in:\n  ${leaks.join('\n  ')}`);
  }

  for (const step of planPublish({ ...targets, region: opts.region, invalidate: opts.invalidate })) run('aws', step);

  // The OAC statement (see the header).
  let policy = null;
  try {
    policy = JSON.parse(JSON.parse(aws(['s3api', 'get-bucket-policy', '--bucket', targets.bucket, '--output', 'json'])).Policy);
  } catch { policy = null; }
  if (!policyAdmitsDistribution(policy, targets.distributionArn)) {
    if (!opts.repairPolicy) {
      throw new Error(`the bucket policy no longer admits ${targets.distributionArn} — CloudFront will answer 403 AccessDenied. `
        + 'Re-run with --repair-bucket-policy, and suspect the account custodian (lib/portal-stack.ts).');
    }
    const fixed = repairedPolicy(policy, targets.bucket, targets.distributionArn);
    run('aws', ['s3api', 'put-bucket-policy', '--bucket', targets.bucket, '--policy', JSON.stringify(fixed)]);
    console.warn('⚠️  The OAC bucket-policy statement was missing and has been re-applied. If it vanishes again, the custodian strips it.');
  } else {
    console.log('✓ bucket policy admits the distribution');
  }

  // Smoke: the page, and the middleware through the same origin. Edge caches
  // may still hold the previous index for a moment after the invalidation.
  for (const path of ['/', '/health']) {
    try {
      const res = await fetch(`${targets.url}${path}`, { redirect: 'manual' });
      console.log(`${res.ok ? '✓' : '✗'} GET ${targets.url}${path} → ${res.status}`);
    } catch (err) {
      console.log(`✗ GET ${targets.url}${path} failed: ${err.message}`);
    }
  }
  console.log(`\nPublished. Open ${targets.url}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(`portal-publish: ${err.message}`); process.exit(1); });
}
