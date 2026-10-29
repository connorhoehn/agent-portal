// DE-14: the deploy as data. Each phase names what it needs, when the
// environment enables it, which paths feed its input key, how the live account
// shows it is done (`live`), and the exact commands that carry it out — every
// one an existing script (`infra/scripts/deploy.sh` is the only thing that
// touches CloudFormation). Nothing here calls AWS: `probes` is a plain object
// `collectProbes` (orchestrate.mjs) fills with read-only calls, and the
// tests hand in fixtures.
//
// Order is Runbook A (docs/social-calls-deploy-plan.md): fleet → agent images
// + runtimes → middleware image → middleware + portal stacks → portal publish →
// auth URLs → the runtimes again for the callback guards → the opt-in Social,
// documents and devbox phases → verify.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export const REPO_ROOT = resolve(new URL('../..', import.meta.url).pathname);

/** The agents whose images `agents/build-all.sh` builds (not the devbox). */
export const AGENTS = ['supervisor', 'search', 'scoring', 'advisor', 'ingestion', 'graph-builder', 'assessment-scorer', 'assessment-drafter'];

/** Stacks `deploy.sh` with no names produces on a default (`cdk ls`) run. */
export const FLEET_STACKS = [
  'Foundation', 'Aurora', 'KnowledgeBase', 'Guardrails', 'Authorization', 'Authentication', 'Agents', 'Observability',
  'AgentCoreRuntime', 'AgentCoreGateway', 'AgentCoreMemory', 'AgentCorePolicy', 'AgentCoreCapabilities', 'AgentCoreTelemetry',
  'SpanProjector', 'MiddlewareService',
];

export const HEALTHY = new Set(['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'IMPORT_COMPLETE']);

const stackId = (env, short) => `${env.stackPrefix}-${short}`;
const stackHealthy = (probes, env, short) => HEALTHY.has(probes.stacks?.[stackId(env, short)]);
const ssmPresent = (probes, name) => probes.ssm?.[name] !== undefined && probes.ssm?.[name] !== null;

/** `deploy.sh` for `stacks` with explicit context; `ENV` carries the environment file. */
export function deploySh(env, stacks = [], context = {}) {
  const args = [...stacks];
  for (const [k, v] of Object.entries(context)) if (v !== undefined && v !== null && v !== '') args.push('--context', `${k}=${v}`);
  return { program: 'bash', args: [resolve(REPO_ROOT, 'infra/scripts/deploy.sh'), ...args], cwd: REPO_ROOT, env: { ENV: env.name } };
}
const node = (script, args = []) => ({ program: 'node', args: [resolve(REPO_ROOT, script), ...args], cwd: REPO_ROOT, env: {} });
const sh = (script, args = [], env = {}) => ({ program: 'bash', args: [resolve(REPO_ROOT, script), ...args], cwd: REPO_ROOT, env });

/** A command line for printing (quoted the way a shell wants it). */
export function commandLine(cmd) {
  const q = (s) => (/^[A-Za-z0-9_./:=@,-]+$/.test(s) ? s : `'${String(s).replace(/'/g, "'\\''")}'`);
  const envPrefix = Object.entries(cmd.env ?? {}).map(([k, v]) => `${k}=${q(v)} `).join('');
  return `${envPrefix}${[cmd.program, ...cmd.args].map(q).join(' ')}`;
}

const ecrHasTag = (probes, repo, tag) => (probes.ecr?.[repo] ?? []).includes(tag);
const allRuntimesReady = (probes) => AGENTS.every((a) => (probes.runtimes ?? []).some((r) => r.name === `orgiq_${a.replace(/-/g, '_')}` && r.status === 'READY'));

export const PHASES = [
  {
    id: 'preflight', always: true, needs: [], inputPaths: [],
    describe: 'account matches the environment file, credentials not expiring, cdk present, buildx when images build, clean tree for built paths',
    commands: () => [],
  },
  {
    id: 'fleet', needs: ['preflight'], inputPaths: ['infra', 'schema'],
    describe: 'infra/scripts/deploy.sh (every default stack; it infers the second-phase context and runs the DE-20 migrations)',
    live: (probes, env) => FLEET_STACKS.every((s) => stackHealthy(probes, env, s)),
    commands: (env) => [deploySh(env)],
  },
  {
    id: 'runtimes', needs: ['fleet'],
    inputPaths: ['agents/_shared', 'agents/base', 'agents/Dockerfile.agent', 'agents/build-all.sh', ...AGENTS.map((a) => `agents/${a}`)],
    describe: 'agent base + images (agents/rollout.sh when present, else base/build.sh + build-all.sh), then OrgIQ-AgentCoreRuntime with deployRuntimes=true',
    live: (probes, env) => ecrHasTag(probes, `${env.prefix}-agent-base`, 'latest')
      && AGENTS.every((a) => ecrHasTag(probes, `${env.prefix}-${a}`, 'latest')) && allRuntimesReady(probes),
    commands: (env, ctx) => {
      const rollout = resolve(REPO_ROOT, 'agents/rollout.sh');
      const build = ctx.exists(rollout) ? [sh('agents/rollout.sh', [], awsEnv(env))]
        : [sh('agents/base/build.sh', [], awsEnv(env)), sh('agents/build-all.sh', [], awsEnv(env))];
      return [...build, deploySh(env, [stackId(env, 'AgentCoreRuntime')], { deployRuntimes: 'true' })];
    },
  },
  {
    id: 'middleware-image', needs: ['fleet'],
    inputPaths: ['middleware', 'scripts/docker/middleware-image-build.mjs', 'scripts/docker/prepare-libraries.mjs', 'scripts/docker/install-locked.mjs'],
    describe: 'scripts/docker/middleware-image-build.mjs (ARM64, :<commit12> and :latest)',
    live: (probes, env, ctx) => ecrHasTag(probes, `${env.prefix}-middleware`, ctx.commit.slice(0, 12)),
    commands: (env) => [node('scripts/docker/middleware-image-build.mjs', ['--region', env.region, '--prefix', env.prefix])],
    outputs: (ctx) => {
      const report = ctx.readJson('.scratch/middleware-image/report.json');
      return report?.digest ? { digest: report.digest, sourceCommit: report.sourceCommit } : {};
    },
  },
  {
    id: 'middleware-portal', needs: ['middleware-image'], inputPaths: ['infra'],
    describe: 'OrgIQ-MiddlewareService + OrgIQ-Portal with deployMiddlewareService/deployPortal (albAllowCidr from --alb-allow-cidr), then a forced ECS rollout only when the image digest changed',
    live: (probes, env) => stackHealthy(probes, env, 'MiddlewareService') && stackHealthy(probes, env, 'Portal')
      && Number(probes.ecs?.desired) >= 1 && probes.ecs?.running === probes.ecs?.desired,
    commands: (env, ctx) => {
      const cmds = [deploySh(env, [stackId(env, 'MiddlewareService'), stackId(env, 'Portal')], {
        deployMiddlewareService: 'true', deployPortal: 'true', albAllowCidr: ctx.options.albAllowCidr,
      })];
      const digest = ctx.outputs['middleware-image']?.digest;
      const previousDigest = ctx.previousOutputs['middleware-image']?.digest;
      // DE-18 is not in yet: the service pulls :latest, so a new digest needs a forced rollout.
      if (digest && digest !== previousDigest) {
        cmds.push({ program: 'aws', cwd: REPO_ROOT, env: {}, args: ['ecs', 'update-service', '--region', env.region, '--cluster', `${env.prefix}-middleware`,
          '--service', `${env.prefix}-middleware`, '--force-new-deployment'] });
      }
      return cmds;
    },
  },
  {
    id: 'portal-publish', needs: ['middleware-portal'], inputPaths: ['portal'],
    describe: 'scripts/portal-publish.mjs (build, sync to the portal bucket, invalidate)',
    live: (probes) => probes.portalIndexPresent === true,
    commands: (env) => [node('scripts/portal-publish.mjs', ['--stack', stackId(env, 'Portal'), '--region', env.region])],
  },
  {
    id: 'auth-urls', needs: ['portal-publish'], inputPaths: ['infra'],
    describe: 'OrgIQ-Authentication + OrgIQ-MiddlewareService again: deploy.sh infers portalPublicUrl and portalPublicUrls once the portal is live',
    live: (probes, env) => ssmPresent(probes, `/${env.prefix}/portal/url`) && stackHealthy(probes, env, 'Authentication'),
    commands: (env) => [deploySh(env, [stackId(env, 'Authentication'), stackId(env, 'MiddlewareService')])],
  },
  {
    id: 'runtime-callbacks', needs: ['auth-urls', 'runtimes'], inputPaths: ['infra/lib/agentcore-runtime-stack.ts'],
    describe: 'OrgIQ-AgentCoreRuntime again: deploy.sh infers the three callback secrets and portalPublicUrl, closing the callback guards',
    live: (probes, env) => ['approvals-request', 'harness-trace', 'assessment-run-complete'].every((s) => probes.secrets?.[`${env.prefix}-${s}-secret`] === true)
      && allRuntimesReady(probes),
    commands: (env) => [deploySh(env, [stackId(env, 'AgentCoreRuntime')])],
  },
  {
    id: 'social-images', needs: ['fleet'], enabled: (env) => env.features.social,
    inputPaths: ['scripts/docker/document-workspace-sources.json', 'scripts/docker/social-images-build.mjs', 'scripts/docker/document-workspace-build.mjs'],
    describe: 'OrgIQ-SocialImages, then scripts/docker/social-images-build.mjs (sfu, platform-api, gateway by digest)',
    live: (probes, env) => stackHealthy(probes, env, 'SocialImages') && ['lvs-sfu', 'platform-api', 'social-gateway'].every((r) => (probes.ecr?.[`${env.prefix}-${r}`] ?? []).length > 0),
    commands: (env) => [
      deploySh(env, [stackId(env, 'SocialImages')], { deploySocialImages: 'true' }),
      node('scripts/docker/social-images-build.mjs', ['--region', env.region, '--prefix', env.prefix]),
    ],
    outputs: (ctx) => {
      const report = ctx.readJson('.scratch/social-images/report.json');
      const out = {};
      for (const image of report?.images ?? []) {
        const [key, value] = String(image.context ?? '').split('=');
        if (key && value) out[key] = value;
      }
      return out;
    },
  },
  {
    id: 'social-stacks', needs: ['social-images', 'middleware-portal'], enabled: (env) => env.features.social, inputPaths: ['infra'],
    describe: 'OrgIQ-SocialMedia + OrgIQ-Social with the image digests as explicit --context (an explicit value beats the inferred one)',
    live: (probes, env) => stackHealthy(probes, env, 'SocialMedia') && stackHealthy(probes, env, 'Social'),
    commands: (env, ctx) => {
      const digests = ctx.outputs['social-images'] ?? {};
      return [deploySh(env, [stackId(env, 'SocialMedia'), stackId(env, 'Social')], {
        deploySocialMedia: 'true', deploySocial: 'true',
        sfuImageDigest: digests.sfuImageDigest, platformApiImageDigest: digests.platformApiImageDigest,
        ...(digests.platformApiImageDigest && { deploySocialService: 'true' }),
      })];
    },
  },
  {
    id: 'documents-build', needs: ['fleet'], enabled: (env) => env.features.documents,
    inputPaths: ['scripts/docker/document-workspace-sources.json', 'scripts/docker/document-workspace-build.mjs', 'scripts/document-workspace.mjs'],
    describe: 'scripts/document-workspace.mjs build (local images from the pinned commits)',
    live: (probes, env) => ssmPresent(probes, `/${env.prefix}/documents/workspace-config`),
    commands: () => [node('scripts/document-workspace.mjs', ['build'])],
  },
  {
    id: 'documents-push', needs: ['documents-build'], enabled: (env) => env.features.documents, inputPaths: ['scripts/docker/document-workspace-push.mjs'],
    describe: 'scripts/docker/document-workspace-push.mjs (push by digest, key pair, SSM workspace-config)',
    live: (probes, env) => ssmPresent(probes, `/${env.prefix}/documents/workspace-config`),
    commands: (env) => [node('scripts/docker/document-workspace-push.mjs', ['--region', env.region, '--prefix', env.prefix])],
    outputs: (ctx) => {
      const report = ctx.readJson('.scratch/document-workspace/push-report.json');
      return report?.config ? { documentWorkspace: JSON.stringify(report.config) } : {};
    },
  },
  {
    id: 'documents-deploy', needs: ['documents-push', 'middleware-portal'], enabled: (env) => env.features.documents, inputPaths: ['infra'],
    describe: 'OrgIQ-MiddlewareService with deployDocumentWorkspace and the pushed workspace config as explicit --context',
    live: (probes, env) => Boolean(probes.documentGatewayUrl),
    commands: (env, ctx) => [deploySh(env, [stackId(env, 'MiddlewareService')], {
      deployDocumentWorkspace: 'true', documentWorkspace: ctx.outputs['documents-push']?.documentWorkspace,
    })],
  },
  {
    id: 'devbox', needs: ['fleet'], enabled: (env) => env.features.devbox, inputPaths: ['agents/devbox'],
    describe: 'agents/devbox/rollout.sh when present, else agents/devbox/build.sh then OrgIQ-Devbox with deployDevbox=true (rolls the runtime; workspaces are a cache)',
    live: (probes, env) => stackHealthy(probes, env, 'Devbox') && (probes.runtimes ?? []).some((r) => r.name === 'orgiq_devbox' && r.status === 'READY'),
    commands: (env, ctx) => {
      const rollout = resolve(REPO_ROOT, 'agents/devbox/rollout.sh');
      return ctx.exists(rollout) ? [sh('agents/devbox/rollout.sh', [], awsEnv(env))]
        : [sh('agents/devbox/build.sh', [], awsEnv(env)), deploySh(env, [stackId(env, 'Devbox')], { deployDevbox: 'true' })];
    },
  },
  {
    id: 'verify', always: true, needs: ['runtime-callbacks'], inputPaths: [],
    describe: '/health through the portal origin, ECS desired = running, every runtime READY (DE-21 adds the smoke specs)',
    commands: () => [],
  },
];

function awsEnv(env) { return { AWS_REGION: env.region, AWS_DEFAULT_REGION: env.region }; }

export const PHASE_IDS = PHASES.map((p) => p.id);
export const phaseById = (id) => PHASES.find((p) => p.id === id);

/** Default `exists` for phase commands; the tests inject their own. */
export const fsExists = (p) => existsSync(p);
