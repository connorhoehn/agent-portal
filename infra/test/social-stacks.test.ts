/**
 * The social-calls stacks (docs/social-calls-deploy-plan.md) and the
 * OrgIQ-MiddlewareService amendments they lean on.
 *
 * Every assertion here is a failure mode the plan names: an image repo that a
 * failed-stack delete takes with it, a secret copied by hand, a socket cut at
 * the ALB's 60 s default, a table platform-api cannot create for itself, and
 * a media port opened to 0.0.0.0/0 in an account whose custodian revokes it.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { MiddlewareServiceStack } from '../lib/middleware-service-stack';
import { SOCIAL_IMAGE_REPOS, SocialImagesStack, type SocialImageKey } from '../lib/social-images-stack';
import { SocialMediaStack } from '../lib/social-media-stack';
import {
  MIDDLEWARE_CHAT_TABLES, SOCIAL_TABLES, SocialStack, socialPlatformInternalUrl, socialRedisUrlParameterName, socialTablePrefix,
} from '../lib/social-stack';
import { ARNS, PREFIX, middlewareServiceStack, newApp } from './helpers/stacks';
import { exportedNames, importedExportNames, synthApp } from './helpers/app-assembly';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const POOL = 'us-east-1_TESTPOOL';

function middlewareIn(app: ReturnType<typeof newApp>): MiddlewareServiceStack {
  return new MiddlewareServiceStack(app, 'OrgIQ-MiddlewareService', {
    prefix: PREFIX,
    scoresTableName: `${PREFIX}-scores`,
    sessionsTableName: `${PREFIX}-sessions`,
    scoresTableArn: ARNS.SCORES_TABLE_ARN,
    sessionsTableArn: ARNS.SESSIONS_TABLE_ARN,
    documentsBucketArn: ARNS.DOCS_BUCKET_ARN,
    artifactsBucketArn: ARNS.ARTIFACTS_BUCKET_ARN,
    documentsBucketName: 'docs',
    artifactsBucketName: 'artifacts',
    sessionSigningSecretArn: ARNS.SIGNING_SECRET_ARN,
    policyStoreId: 'PSTORE123456',
  });
}

/** Middleware + SFU + Social in one app, the way bin/app.ts wires them. */
function socialApp(context: Record<string, unknown> = {}, withSfu = true) {
  const app = newApp(context);
  const mw = middlewareIn(app);
  const media = withSfu
    ? new SocialMediaStack(app, 'OrgIQ-SocialMedia', { prefix: PREFIX, vpc: mw.vpc, cognitoUserPoolId: POOL })
    : undefined;
  const social = new SocialStack(app, 'OrgIQ-Social', {
    prefix: PREFIX,
    vpc: mw.vpc,
    cluster: mw.cluster,
    listener: mw.listener,
    loadBalancerSecurityGroupId: mw.loadBalancerSecurityGroupId,
    middlewareSecurityGroupId: mw.serviceSecurityGroupId,
    middlewareTaskRoleName: mw.taskRoleName,
    cognitoUserPoolId: POOL,
    ...(media && {
      sfu: {
        privateIp: media.privateIp,
        instanceId: media.instance.instanceId,
        securityGroupId: media.securityGroup.securityGroupId,
      },
    }),
  });
  return { app, mw, media, social };
}

function openRules(template: Template): string[] {
  const open: string[] = [];
  const isOpen = (r: any) => r?.CidrIp === '0.0.0.0/0' || r?.CidrIpv6 === '::/0';
  for (const [id, sg] of Object.entries(template.findResources('AWS::EC2::SecurityGroup'))) {
    for (const rule of (sg.Properties?.SecurityGroupIngress ?? []) as any[]) if (isOpen(rule)) open.push(id);
  }
  for (const [id, rule] of Object.entries(template.findResources('AWS::EC2::SecurityGroupIngress'))) {
    if (isOpen(rule.Properties)) open.push(id);
  }
  return open;
}

// ── OrgIQ-MiddlewareService amendments ─────────────────────────────────────

describe('OrgIQ-MiddlewareService — realtime amendments', () => {
  const stack = middlewareServiceStack();
  const t = Template.fromStack(stack);
  const container = () => {
    const td = Object.values<any>(t.findResources('AWS::ECS::TaskDefinition'))[0];
    return td.Properties.ContainerDefinitions.find((c: any) => c.Name === 'middleware');
  };

  test('mints orgiq-realtime-jwt-secret with a generated value', () => {
    t.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'orgiq-realtime-jwt-secret',
      GenerateSecretString: Match.objectLike({ PasswordLength: 64 }),
    });
  });

  test('publishes its complete ARN to SSM by name (OrgIQ-Social cannot use a partial ARN)', () => {
    const [secretId] = Object.keys(t.findResources('AWS::SecretsManager::Secret', {
      Properties: { Name: 'orgiq-realtime-jwt-secret' },
    }));
    t.hasResourceProperties('AWS::SSM::Parameter', { Name: '/orgiq/realtime/jwt-secret-arn', Value: { Ref: secretId } });
  });

  test('wires it as the REALTIME_JWT_SECRET container secret (no plaintext env copy)', () => {
    const c = container();
    const secret = (c.Secrets as any[]).find((s) => s.Name === 'REALTIME_JWT_SECRET');
    assert.ok(secret, 'REALTIME_JWT_SECRET missing from container secrets');
    const [logicalId] = Object.keys(t.findResources('AWS::SecretsManager::Secret', {
      Properties: { Name: 'orgiq-realtime-jwt-secret' },
    }));
    assert.deepEqual(secret.ValueFrom, { Ref: logicalId });
    assert.ok(!(c.Environment as any[]).some((e) => e.Name === 'REALTIME_JWT_SECRET'));
  });

  test('ALB idle timeout is 300 s unconditionally (WebSocket/SSE), not only with the document workspace', () => {
    t.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
      LoadBalancerAttributes: Match.arrayWith([{ Key: 'idle_timeout.timeout_seconds', Value: '300' }]),
    });
  });

  test('target group speaks HTTP/1.1 (the upgrade mechanism) and is not sticky', () => {
    t.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
      ProtocolVersion: 'HTTP1',
      TargetGroupAttributes: Match.arrayWith([{ Key: 'stickiness.enabled', Value: 'false' }]),
    });
  });

  test('REALTIME_GATEWAY/REDIS_URL are absent by default — the Redis they name deploys later', () => {
    const names = (container().Environment as any[]).map((e) => e.Name);
    assert.ok(!names.includes('REALTIME_GATEWAY'));
    assert.ok(!names.includes('REDIS_URL'));
  });

  test('REALTIME_GATEWAY/REDIS_URL/SOCIAL_CHAT_* are absent by default — the state they name deploys later', () => {
    const c = container();
    const names = [...(c.Environment as any[]), ...(c.Secrets as any[])].map((e) => e.Name);
    for (const absent of ['REALTIME_GATEWAY', 'REDIS_URL', 'SOCIAL_CHAT_STORE', 'SOCIAL_CHAT_TABLE_PREFIX', 'REALTIME_GATEWAY_URL']) {
      assert.ok(!names.includes(absent), `${absent} must not be set without realtimeGateway=true`);
    }
    // Only the realtime JWT's ARN, which the secret itself always carries.
    const params = Object.values<any>(t.findResources('AWS::SSM::Parameter')).map((p) => p.Properties.Name);
    assert.deepEqual(params, ['/orgiq/realtime/jwt-secret-arn']);
  });

  const envOf = (stack: MiddlewareServiceStack) => {
    const td = Object.values<any>(Template.fromStack(stack).findResources('AWS::ECS::TaskDefinition'))[0];
    const c = td.Properties.ContainerDefinitions.find((x: any) => x.Name === 'middleware');
    return {
      env: Object.fromEntries((c.Environment as any[]).map((e) => [e.Name, e.Value])) as Record<string, any>,
      secrets: Object.fromEntries((c.Secrets as any[]).map((e) => [e.Name, e.ValueFrom])) as Record<string, any>,
    };
  };

  test('Social REST targets its private platform even without the gateway or a public host', () => {
    assert.equal(envOf(middlewareServiceStack()).env.SOCIAL_PLATFORM_INTERNAL_URL, undefined);
    const { env } = envOf(middlewareServiceStack({ deploySocial: 'true' }));
    assert.equal(env.SOCIAL_PLATFORM_INTERNAL_URL, 'http://social-platform.orgiq-social.local:3001');
    assert.equal(env.REALTIME_GATEWAY, undefined);
    assert.equal(env.REALTIME_PLATFORM_PUBLIC_URL, undefined);
    assert.equal(socialPlatformInternalUrl('other'), 'http://social-platform.other-social.local:3001');
  });

  test('realtimeGateway=true alone: gateway on, memory state (no REDIS_URL, no SOCIAL_CHAT_*), warned', () => {
    const stack = middlewareServiceStack({ realtimeGateway: 'true' });
    const { env, secrets } = envOf(stack);
    assert.equal(env.REALTIME_GATEWAY, 'on');
    assert.equal(env.REDIS_URL, undefined);
    assert.equal(secrets.REDIS_URL, undefined);
    assert.equal(env.SOCIAL_CHAT_STORE, undefined);
    const a = Annotations.fromStack(stack);
    a.hasWarning('*', Match.stringLikeRegexp('no REDIS_URL'));
    a.hasWarning('*', Match.stringLikeRegexp('in-memory store'));
  });

  test('without a certificate the socket URL is derived from the ALB (ws://<alb dns>; the portal appends /ws)', () => {
    const stack = middlewareServiceStack({ realtimeGateway: 'true' });
    const { env } = envOf(stack);
    const [albId] = Object.keys(Template.fromStack(stack).findResources('AWS::ElasticLoadBalancingV2::LoadBalancer'));
    assert.deepEqual(env.REALTIME_GATEWAY_URL, { 'Fn::Join': ['', ['ws://', { 'Fn::GetAtt': [albId, 'DNSName'] }]] });
  });

  test('with a certificate and no realtimeGatewayUrl, the socket URL stays unset and synth says why', () => {
    const stack = middlewareServiceStack({
      realtimeGateway: 'true',
      certificateArn: 'arn:aws:acm:us-east-1:111111111111:certificate/abc',
    });
    assert.equal(envOf(stack).env.REALTIME_GATEWAY_URL, undefined);
    Annotations.fromStack(stack).hasWarning('*', Match.stringLikeRegexp('No realtimeGatewayUrl'));
  });

  test('with deploySocial=true and OrgIQ-Social live: REDIS_URL is read from the SSM parameter it writes, chat goes to its tables', () => {
    const stack = middlewareServiceStack({ realtimeGateway: 'true', deploySocial: 'true', socialLive: 'true' });
    const { env, secrets } = envOf(stack);
    assert.equal(env.REDIS_URL, undefined, 'REDIS_URL must not be a plaintext env copy');
    assert.match(JSON.stringify(secrets.REDIS_URL), /parameter\/orgiq\/social\/redis-url/);
    assert.equal(socialRedisUrlParameterName('orgiq'), '/orgiq/social/redis-url');
    // Names middleware/src/lib/social-chat.ts reads.
    assert.equal(env.SOCIAL_CHAT_STORE, 'dynamo');
    assert.equal(env.SOCIAL_CHAT_TABLE_PREFIX, 'orgiq-social-');
    assert.equal(env.SOCIAL_PLATFORM_INTERNAL_URL, 'http://social-platform.orgiq-social.local:3001');
    // The execution role (which resolves container secrets) can read it.
    const policies = JSON.stringify(Template.fromStack(stack).findResources('AWS::IAM::Policy'));
    assert.match(policies, /ssm:GetParameters/);
    Annotations.fromStack(stack).hasNoWarning('*', Match.stringLikeRegexp('no REDIS_URL'));
  });

  test('tableSuffix moves SOCIAL_CHAT_TABLE_PREFIX with the tables', () => {
    const { env } = envOf(middlewareServiceStack({ realtimeGateway: 'true', deploySocial: 'true', tableSuffix: 'v2' }));
    assert.equal(env.SOCIAL_CHAT_TABLE_PREFIX, 'orgiq-social-v2-');
  });

  test('realtimeRedisUrl overrides as plain env, even with deploySocial', () => {
    const { env, secrets } = envOf(middlewareServiceStack({
      realtimeGateway: 'true', deploySocial: 'true', realtimeRedisUrl: 'redis://cache.example.internal:6379',
    }));
    assert.equal(env.REDIS_URL, 'redis://cache.example.internal:6379');
    assert.equal(secrets.REDIS_URL, undefined);
  });

  test('explicit browser URLs win; otherwise platform/video derive from the social host rules', () => {
    const explicit = envOf(middlewareServiceStack({
      realtimeGateway: 'true',
      realtimeGatewayUrl: 'wss://rt.example.com',
      realtimeVideoPublicUrl: 'https://sfu.example.com',
    })).env;
    assert.equal(explicit.REALTIME_GATEWAY_URL, 'wss://rt.example.com');
    assert.equal(explicit.REALTIME_VIDEO_PUBLIC_URL, 'https://sfu.example.com');

    const derived = envOf(middlewareServiceStack({
      realtimeGateway: 'true', socialPlatformHost: 'platform.example.com', socialSfuHost: 'sfu.example.com',
    })).env;
    assert.equal(derived.REALTIME_PLATFORM_PUBLIC_URL, 'https://platform.example.com');
    assert.equal(derived.REALTIME_VIDEO_PUBLIC_URL, 'https://sfu.example.com');
    // Never the server-side name (work-graph/producer.ts).
    assert.equal(derived.PLATFORM_API_URL, undefined);
  });

  test('with no host known, platform/video URLs stay unset and synth warns (no invented SFU or DNS)', () => {
    const stack = middlewareServiceStack({ realtimeGateway: 'true' });
    const { env } = envOf(stack);
    assert.equal(env.REALTIME_PLATFORM_PUBLIC_URL, undefined);
    assert.equal(env.REALTIME_VIDEO_PUBLIC_URL, undefined);
    const a = Annotations.fromStack(stack);
    a.hasWarning('*', Match.stringLikeRegexp('REALTIME_PLATFORM_PUBLIC_URL is unset'));
    a.hasWarning('*', Match.stringLikeRegexp('REALTIME_VIDEO_PUBLIC_URL is unset'));
  });
});

// ── OrgIQ-SocialImages ──────────────────────────────────────────────────────

describe('OrgIQ-SocialImages', () => {
  const stack = new SocialImagesStack(newApp(), 'OrgIQ-SocialImages', { prefix: PREFIX });
  const t = Template.fromStack(stack);

  test('three repos with the agreed names, all RETAIN, none emptied on delete', () => {
    const repos = t.findResources('AWS::ECR::Repository');
    const names = Object.values<any>(repos).map((r) => r.Properties.RepositoryName).sort();
    assert.deepEqual(names, ['orgiq-lvs-sfu', 'orgiq-platform-api', 'orgiq-social-gateway']);
    for (const [id, r] of Object.entries<any>(repos)) {
      assert.equal(r.DeletionPolicy, 'Retain', `${id} must survive a failed-stack delete`);
      assert.equal(r.UpdateReplacePolicy, 'Retain');
    }
    t.resourceCountIs('Custom::ECRAutoDeleteImages', 0);
  });

  test('outputs carry stable export names', () => {
    const exports = Object.values<any>(t.toJSON().Outputs).map((o) => o.Export?.Name).sort();
    assert.deepEqual(exports, [
      'orgiq-lvs-sfu-ecr-uri', 'orgiq-platform-api-ecr-uri', 'orgiq-social-gateway-ecr-uri',
    ]);
  });

  test("deploy.sh's ECR orphan sweep knows all three RETAINed names", () => {
    // A RETAINed name the sweep does not know blocks the next create with
    // "already exists" — how OrgIQ-MiddlewareService once wedged a rebuild.
    const deploySh = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'deploy.sh'), 'utf8');
    const list = /^ECR_REPOS=\(([\s\S]*?)^\)/m.exec(deploySh)?.[1] ?? '';
    const entries = list.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    for (const key of Object.keys(SOCIAL_IMAGE_REPOS) as SocialImageKey[]) {
      assert.ok(entries.includes(`"\${PREFIX}-${SOCIAL_IMAGE_REPOS[key]}"`), `ECR_REPOS lacks \${PREFIX}-${SOCIAL_IMAGE_REPOS[key]}`);
    }
  });

  test('the image build script pushes to exactly these repos (scripts/docker/social-images-build.mjs)', () => {
    const script = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'docker', 'social-images-build.mjs'), 'utf8');
    for (const [key, repo] of Object.entries(SOCIAL_IMAGE_REPOS)) {
      assert.match(script, new RegExp(`key: '${key}', repo: '${repo}'`), `build script disagrees on ${key}`);
    }
  });
});

// ── OrgIQ-SocialMedia ──────────────────────────────────────────────────────

describe('OrgIQ-SocialMedia — the SFU', () => {
  const { media } = socialApp();
  const t = Template.fromStack(media!);

  test('publishes the complete ARN of each secret it mints to SSM by name', () => {
    for (const [secret, param] of [
      ['orgiq-social-sfu-admin-token', '/orgiq/social/sfu-admin-token-arn'],
      ['orgiq-social-sfu-webhook-secret', '/orgiq/social/sfu-webhook-secret-arn'],
      ['orgiq-social-sfu-service-token', '/orgiq/social/sfu-service-token-arn'],
    ]) {
      const [secretId] = Object.keys(t.findResources('AWS::SecretsManager::Secret', { Properties: { Name: secret } }));
      t.hasResourceProperties('AWS::SSM::Parameter', { Name: param, Value: { Ref: secretId } });
    }
  });

  test('a t4g.small (ARM64) instance with an Elastic IP associated', () => {
    t.hasResourceProperties('AWS::EC2::Instance', { InstanceType: 't4g.small' });
    t.resourceCountIs('AWS::EC2::EIP', 1);
    const [eipId] = Object.keys(t.findResources('AWS::EC2::EIP'));
    const [instanceId] = Object.keys(t.findResources('AWS::EC2::Instance'));
    t.hasResourceProperties('AWS::EC2::EIPAssociation', {
      AllocationId: { 'Fn::GetAtt': [eipId, 'AllocationId'] },
      InstanceId: { Ref: instanceId },
    });
  });

  test('user data announces the EIP, pins the four RTC ports and reads ADMIN_TOKEN from Secrets Manager', () => {
    const json = JSON.stringify(Object.values<any>(t.findResources('AWS::EC2::Instance'))[0].Properties.UserData);
    const [eipId] = Object.keys(t.findResources('AWS::EC2::EIP'));
    assert.match(json, /MEDIASOUP_ANNOUNCED_IP=/);
    assert.ok(json.includes(`"Fn::GetAtt":["${eipId}","PublicIp"]`), 'announced IP must be the EIP');
    assert.match(json, /MEDIASOUP_RTC_PORT=40000/);
    assert.match(json, /MEDIASOUP_RTC_TCP_PORT=40010/);
    assert.match(json, /MEDIASOUP_RTC_TCP_PORT_PER_POD=false/);
    assert.match(json, /RECORDING_ENABLED=false/);
    assert.match(json, /secretsmanager get-secret-value/);
    assert.match(json, /--network host/);
    t.hasResourceProperties('AWS::SecretsManager::Secret', { Name: 'orgiq-social-sfu-admin-token' });
    t.hasResourceProperties('AWS::SecretsManager::Secret', { Name: 'orgiq-social-sfu-webhook-secret' });
  });

  test('mints the service token platform-api calls the SFU with, and the unit reads it into LVS_SERVICE_TOKEN', () => {
    // LVS cognito-auth.js accepts `Bearer <LVS_SERVICE_TOKEN>` on /api/sessions,
    // so platform-api never forwards a user bearer (deploy plan §8 Verifiers).
    const [secretId] = Object.keys(t.findResources('AWS::SecretsManager::Secret', {
      Properties: { Name: 'orgiq-social-sfu-service-token' },
    }));
    assert.ok(secretId, 'orgiq-social-sfu-service-token not minted');
    const json = JSON.stringify(Object.values<any>(t.findResources('AWS::EC2::Instance'))[0].Properties.UserData);
    assert.match(json, /LVS_SERVICE_TOKEN=\$\(aws secretsmanager get-secret-value/);
    assert.ok(json.includes(`{"Ref":"${secretId}"}`), 'the unit must read the minted service-token secret');
    assert.match(json, /echo \\"LVS_SERVICE_TOKEN=\$LVS_SERVICE_TOKEN\\"/);
    const grants = JSON.stringify(t.findResources('AWS::IAM::Policy'));
    assert.ok(grants.includes(`{"Ref":"${secretId}"}`), 'the instance role must be able to read it');
  });

  test('with no sfuAllowCidr: no 0.0.0.0/0 anywhere, no media ingress at all, and a synth warning', () => {
    assert.deepEqual(openRules(t), []);
    const sg = Object.values<any>(t.findResources('AWS::EC2::SecurityGroup'))
      .find((s) => s.Properties.GroupName === 'orgiq-social-sfu');
    assert.ok(sg);
    assert.equal((sg.Properties.SecurityGroupIngress ?? []).length, 0);
    Annotations.fromStack(media!).hasWarning('*', Match.stringLikeRegexp('sfuAllowCidr'));
  });

  test('sfuAllowCidr opens exactly UDP 40000-40001 and TCP 40010-40011 for each CIDR, nothing else', () => {
    const { media: m } = socialApp({ sfuAllowCidr: '203.0.113.4/32,198.51.100.7/32', sfuImageDigest: DIGEST });
    const mt = Template.fromStack(m!);
    const sg = Object.values<any>(mt.findResources('AWS::EC2::SecurityGroup'))
      .find((s) => s.Properties.GroupName === 'orgiq-social-sfu');
    const rules = (sg.Properties.SecurityGroupIngress as any[])
      .map((r) => `${r.CidrIp} ${r.IpProtocol} ${r.FromPort}-${r.ToPort}`).sort();
    assert.deepEqual(rules, [
      '198.51.100.7/32 tcp 40010-40011', '198.51.100.7/32 udp 40000-40001',
      '203.0.113.4/32 tcp 40010-40011', '203.0.113.4/32 udp 40000-40001',
    ]);
    assert.deepEqual(openRules(mt), []);
    Annotations.fromStack(m!).hasNoWarning('*', Match.stringLikeRegexp('sfuAllowCidr'));
    const ud = JSON.stringify(Object.values<any>(mt.findResources('AWS::EC2::Instance'))[0].Properties.UserData);
    assert.ok(ud.includes(`@${DIGEST}`), 'image must be pinned by digest');
  });

  test('an explicit 0.0.0.0/0 is honoured (the context said so) but warned about', () => {
    const { media: m } = socialApp({ sfuAllowCidr: '0.0.0.0/0' });
    // One rule per protocol (UDP media + TCP fallback), both on the SFU group.
    assert.equal(openRules(Template.fromStack(m!)).length, 2);
    Annotations.fromStack(m!).hasWarning('*', Match.stringLikeRegexp('custodian'));
  });

  test('a malformed sfuImageDigest fails synth', () => {
    assert.throws(() => socialApp({ sfuImageDigest: 'latest' }), /sfuImageDigest/);
  });

  // An unpinned image is AWS's newest at every deploy, and a new image replaces
  // the host: each Amazon Linux release dropped every live call on the next
  // unrelated deploy. deploy.sh carries the live image forward (SfuAmiId).
  test('sfuAmiId pins the SFU host image and is published for the next deploy', () => {
    const { media: m } = socialApp({ sfuAmiId: 'ami-0123456789abcdef0', sfuImageDigest: DIGEST });
    const mt = Template.fromStack(m!);
    const instance = Object.values<any>(mt.findResources('AWS::EC2::Instance'))[0];
    assert.equal(JSON.stringify(instance.Properties.ImageId).includes('ami-0123456789abcdef0'), true);
    assert.ok(mt.findOutputs('SfuAmiId').SfuAmiId, 'SfuAmiId is the value deploy.sh reads back');
  });

  test('an unpinned (or latest) SFU image still resolves the newest Amazon Linux 2023', () => {
    for (const ctx of [{}, { sfuAmiId: 'latest' }]) {
      const { media: m } = socialApp({ ...ctx, sfuImageDigest: DIGEST });
      const instance = Object.values<any>(Template.fromStack(m!).findResources('AWS::EC2::Instance'))[0];
      assert.match(JSON.stringify(instance.Properties.ImageId), /Ref/);
    }
  });

  test('a malformed sfuAmiId fails synth', () => {
    assert.throws(() => socialApp({ sfuAmiId: 'al2023' }), /sfuAmiId/);
  });
});

// ── OrgIQ-Social ────────────────────────────────────────────────────────────

describe('OrgIQ-Social — platform-api, Redis, tables', () => {
  const { social } = socialApp({ socialPlatformHost: 'platform.example.com', socialSfuHost: 'sfu.example.com' });
  const t = Template.fromStack(social);
  const platformTd = () => Object.values<any>(t.findResources('AWS::ECS::TaskDefinition'))
    .find((td) => td.Properties.ContainerDefinitions.some((c: any) => c.Name === 'platform-api'));

  test('platform-api is ARM64, 0.5 vCPU / 1 GB, runs node dist/index.js', () => {
    const td = platformTd();
    assert.deepEqual(td.Properties.RuntimePlatform, { CpuArchitecture: 'ARM64', OperatingSystemFamily: 'LINUX' });
    assert.equal(td.Properties.Cpu, '512');
    assert.equal(td.Properties.Memory, '1024');
    const c = td.Properties.ContainerDefinitions[0];
    assert.deepEqual(c.Command, ['node', 'dist/index.js']);
  });

  test('env per the plan: VIDEO_API_URL (SFU private IP), VIDEO_PUBLIC_URL, LVS_WEBHOOK_BOOTSTRAP_URL, COGNITO_*, table prefix', () => {
    const c = platformTd().Properties.ContainerDefinitions[0];
    const env = Object.fromEntries((c.Environment as any[]).map((e) => [e.Name, e.Value]));
    assert.equal(env.NODE_ENV, 'production');
    assert.equal(env.SKIP_AUTH, undefined, 'SKIP_AUTH must never be set in AWS');
    assert.equal(env.DDB_TABLE_PREFIX, 'orgiq-social-');
    assert.equal(env.VIDEO_PUBLIC_URL, 'https://sfu.example.com');
    assert.equal(env.LVS_WEBHOOK_BOOTSTRAP_URL, 'http://social-platform.orgiq-social.local:3001/hooks/lvs/recording');
    assert.equal(env.COGNITO_USER_POOL_ID, POOL);
    assert.equal(env.VIDEO_SECRETS_REQUIRED, 'true');
    assert.match(JSON.stringify(env.REDIS_URL), /PrimaryEndPoint\.Address/, 'REDIS_URL must be the ElastiCache endpoint');
    assert.match(JSON.stringify(env.REDIS_ENDPOINT), /PrimaryEndPoint\.Address/);
    // The SFU private IP, read by NAME from OrgIQ-SocialMedia's parameter (an
    // import would pin the replaced host's export on every image roll).
    assert.ok(JSON.stringify(env.VIDEO_API_URL).includes('Parameter'), 'VIDEO_API_URL must be the SFU private IP (SSM)');
    assert.ok(!JSON.stringify(env.VIDEO_API_URL).includes('Fn::ImportValue'), 'VIDEO_API_URL must not import the instance');
  });

  test('secrets: REALTIME_JWT_SECRET is read from the same named secret; video secrets are secrets, not env', () => {
    const c = platformTd().Properties.ContainerDefinitions[0];
    const secrets = Object.fromEntries((c.Secrets as any[]).map((s) => [s.Name, JSON.stringify(s.ValueFrom)]));
    for (const name of ['REALTIME_JWT_SECRET', 'VIDEO_ADMIN_TOKEN', 'VIDEO_SERVICE_TOKEN', 'LVS_WEBHOOK_SECRET', 'SERVICE_AUTH_SECRET']) {
      assert.ok(secrets[name], `${name} missing`);
    }
    // COMPLETE ARNs read from SSM by name, never a by-name import's partial
    // ARN: Secrets Manager reads the `-secret` of
    // `arn:…:secret:orgiq-realtime-jwt-secret` as the random suffix.
    const params = t.toJSON().Parameters ?? {};
    const ssmName = (env: string) => {
      const ref = JSON.parse(secrets[env]!).Ref;
      assert.ok(ref, `${env} must come from an SSM parameter, not ${secrets[env]}`);
      return params[ref].Default;
    };
    assert.equal(ssmName('REALTIME_JWT_SECRET'), '/orgiq/realtime/jwt-secret-arn');
    assert.equal(ssmName('VIDEO_ADMIN_TOKEN'), '/orgiq/social/sfu-admin-token-arn');
    assert.equal(ssmName('LVS_WEBHOOK_SECRET'), '/orgiq/social/sfu-webhook-secret-arn');
    // The SFU's LVS_SERVICE_TOKEN under platform-api's name for it.
    assert.equal(ssmName('VIDEO_SERVICE_TOKEN'), '/orgiq/social/sfu-service-token-arn');
    const envNames = (c.Environment as any[]).map((e) => e.Name);
    for (const leaked of ['VIDEO_ADMIN_TOKEN', 'VIDEO_SERVICE_TOKEN', 'LVS_WEBHOOK_SECRET', 'REALTIME_JWT_SECRET']) {
      assert.ok(!envNames.includes(leaked), `${leaked} must not be plaintext env`);
    }
  });

  test('with the portal live, the lobby (and call-seat) authority is the middleware through CloudFront', () => {
    const envOfSocial = (context: Record<string, unknown>) => {
      const st = Template.fromStack(socialApp(context).social);
      const td = Object.values<any>(st.findResources('AWS::ECS::TaskDefinition'))
        .find((d) => d.Properties.ContainerDefinitions.some((c: any) => c.Name === 'platform-api'));
      const env = Object.fromEntries(td.Properties.ContainerDefinitions[0].Environment.map((e: any) => [e.Name, e.Value]));
      return { env, params: st.toJSON().Parameters ?? {} };
    };
    const off = envOfSocial({}).env;
    assert.equal(off.LOBBY_AUTHORITY_URL, undefined, 'no portal, no authority: call lobbies would refuse');
    const { env, params } = envOfSocial({ deployPortal: 'true', allowHttpOrigin: 'true', portalPublicUrls: 'true', portalVideoUrlLive: 'true' });
    const lobby = JSON.stringify(env.LOBBY_AUTHORITY_URL);
    assert.match(lobby, /\/api\/realtime\/lobby-access/);
    const [ref] = [...lobby.matchAll(/"Ref":"([^"]+)"/g)].map((m) => m[1]);
    assert.equal(params[ref!].Default, '/orgiq/portal/url');
    assert.equal(env.LOBBY_AUTHORITY_REQUIRED, 'true');
    assert.equal(params[env.VIDEO_PUBLIC_URL.Ref].Default, '/orgiq/portal/video-url');
    // Explicit context still wins.
    assert.equal(envOfSocial({ deployPortal: 'true', allowHttpOrigin: 'true', portalPublicUrls: 'true', lobbyAuthorityUrl: 'https://x.example/api/realtime/lobby-access' })
      .env.LOBBY_AUTHORITY_URL, 'https://x.example/api/realtime/lobby-access');
  });

  test('phase 1: platform-api runs at DesiredCount 0, stop-before-start', () => {
    t.hasResourceProperties('AWS::ECS::Service', {
      ServiceName: 'orgiq-social-platform-api',
      DesiredCount: 0,
      DeploymentConfiguration: Match.objectLike({ MinimumHealthyPercent: 0, MaximumPercent: 100 }),
      AvailabilityZoneRebalancing: 'DISABLED',
    });
  });

  test('phase 2 needs the digest, then scales to 1 and pins the image by digest', () => {
    assert.throws(() => socialApp({ deploySocialService: 'true' }), /platformApiImageDigest/);
    const { social: s } = socialApp({ deploySocialService: 'true', platformApiImageDigest: DIGEST });
    const st = Template.fromStack(s);
    st.hasResourceProperties('AWS::ECS::Service', { ServiceName: 'orgiq-social-platform-api', DesiredCount: 1 });
    assert.ok(JSON.stringify(st.toJSON()).includes(`orgiq-platform-api@${DIGEST}`));
  });

  test('host rules on the shared listener at priorities 30 (platform) and 40 (SFU)', () => {
    t.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', {
      Priority: 30,
      Conditions: [{ Field: 'host-header', HostHeaderConfig: { Values: ['platform.example.com'] } }],
    });
    t.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', {
      Priority: 40,
      Conditions: [{ Field: 'host-header', HostHeaderConfig: { Values: ['sfu.example.com'] } }],
    });
    t.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
      Port: 3001, TargetType: 'ip', ProtocolVersion: 'HTTP1', HealthCheckPath: '/health',
    });
    t.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
      Port: 3901, TargetType: 'instance', HealthCheckPath: '/api/health',
    });
  });

  test('Redis is ElastiCache: one cache.t4g.micro node, plain redis:// (the clients speak no TLS), encrypted at rest, DESTROY', () => {
    t.resourceCountIs('AWS::ElastiCache::ReplicationGroup', 1);
    t.hasResourceProperties('AWS::ElastiCache::ReplicationGroup', {
      ReplicationGroupId: 'orgiq-social-redis',
      Engine: 'redis',
      CacheNodeType: 'cache.t4g.micro',
      NumCacheClusters: 1,
      AutomaticFailoverEnabled: false,
      TransitEncryptionEnabled: false,
      AtRestEncryptionEnabled: true,
      Port: 6379,
    });
    const rg = Object.values<any>(t.findResources('AWS::ElastiCache::ReplicationGroup'))[0];
    assert.equal(rg.DeletionPolicy, 'Delete', 'a cache must not outlive the stack and keep billing');
    t.hasResourceProperties('AWS::ElastiCache::SubnetGroup', { CacheSubnetGroupName: 'orgiq-social-redis' });
    // No Redis container any more — the old RedisService lost the notification inbox on every task replacement.
    t.resourcePropertiesCountIs('AWS::ServiceDiscovery::Service', { Name: 'redis' }, 0);
  });

  test('the Redis security group admits exactly the middleware and platform-api on 6379', () => {
    const [redisSgId] = Object.keys(t.findResources('AWS::EC2::SecurityGroup', {
      Properties: { GroupDescription: Match.stringLikeRegexp('social Redis') },
    }));
    assert.ok(redisSgId);
    const rg = Object.values<any>(t.findResources('AWS::ElastiCache::ReplicationGroup'))[0];
    assert.ok(JSON.stringify(rg.Properties.SecurityGroupIds).includes(redisSgId));
    const standalone = Object.values<any>(t.findResources('AWS::EC2::SecurityGroupIngress')).map((r) => r.Properties);
    const inline = (t.findResources('AWS::EC2::SecurityGroup')[redisSgId]!.Properties.SecurityGroupIngress ?? []) as any[];
    const toRedis = [...standalone.filter((r) => JSON.stringify(r.GroupId).includes(redisSgId)), ...inline];
    assert.equal(toRedis.length, 2, 'middleware + platform-api, nothing else');
    for (const r of toRedis) {
      assert.equal(r.FromPort, 6379);
      assert.equal(r.CidrIp, undefined, 'source must be a security group, never a CIDR');
    }
  });

  test('the Redis URL is published to SSM by name for the middleware (no export)', () => {
    t.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/orgiq/social/redis-url',
      Type: 'String',
      Value: Match.objectLike({ 'Fn::Join': Match.anyValue() }),
    });
    const value = JSON.stringify(Object.values<any>(t.findResources('AWS::SSM::Parameter'))[0].Properties.Value);
    assert.match(value, /redis:\/\//);
    assert.match(value, /PrimaryEndPoint\.Address/);
  });

  test('the middleware task role gets the chat and pin tables — attached by role name, six store calls, no Scan/CreateTable', () => {
    const policies = Object.values<any>(t.findResources('AWS::IAM::Policy', {
      Properties: { PolicyName: 'orgiq-middleware-social-chat' },
    }));
    assert.equal(policies.length, 1);
    const p = policies[0].Properties;
    assert.deepEqual(p.Roles, ['orgiq-middleware-task-role']);
    const [stmt] = p.PolicyDocument.Statement;
    assert.deepEqual([...stmt.Action].sort(), [
      'dynamodb:BatchGetItem', 'dynamodb:DeleteItem', 'dynamodb:GetItem',
      'dynamodb:PutItem', 'dynamodb:Query', 'dynamodb:UpdateItem',
    ]);
    const resources = JSON.stringify(stmt.Resource);
    assert.ok(resources.includes(':table/orgiq-social-chat-pins"'), 'pinning requires durable pin-table access');
    for (const table of MIDDLEWARE_CHAT_TABLES) {
      assert.ok(resources.includes(`:table/orgiq-social-${table}"`), `missing ${table}`);
      assert.ok(resources.includes(`:table/orgiq-social-${table}/index/*`), `missing ${table} indexes`);
      assert.ok(SOCIAL_TABLES.some((x) => x.name === table), `${table} is granted but OrgIQ-Social does not create it`);
    }
    assert.ok(!/table\/orgiq-social-\*/.test(resources), 'never the whole namespace');
    assert.equal(stmt.Resource.length, MIDDLEWARE_CHAT_TABLES.length * 2);
    // chat-conversations carries the GSI the store queries.
    assert.ok(SOCIAL_TABLES.find((x) => x.name === 'chat-conversations')!.gsi!.some((g) => g.name === 'channel-index'));
  });

  test('no open ingress anywhere in the stack', () => {
    assert.deepEqual(openRules(t), []);
  });

  test('every table: on-demand, RETAIN, fixed prefixed name, PITR — including call-log and voicemail', () => {
    const tables = t.findResources('AWS::DynamoDB::Table');
    assert.equal(Object.keys(tables).length, SOCIAL_TABLES.length);
    const names = new Set<string>();
    for (const [id, table] of Object.entries<any>(tables)) {
      assert.equal(table.Properties.BillingMode, 'PAY_PER_REQUEST', `${id} billing`);
      assert.equal(table.DeletionPolicy, 'Retain', `${id} must be RETAIN`);
      assert.equal(table.Properties.PointInTimeRecoverySpecification.PointInTimeRecoveryEnabled, true);
      names.add(table.Properties.TableName);
    }
    for (const required of ['call-log', 'voicemail', 'document-video-sessions', 'call-session-bindings', 'chat-messages']) {
      assert.ok(names.has(`orgiq-social-${required}`), `missing orgiq-social-${required}`);
    }
    t.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'orgiq-social-call-log',
      KeySchema: [{ AttributeName: 'userId', KeyType: 'HASH' }, { AttributeName: 'callId', KeyType: 'RANGE' }],
    });
    t.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'orgiq-social-voicemail',
      KeySchema: [{ AttributeName: 'userId', KeyType: 'HASH' }, { AttributeName: 'voicemailId', KeyType: 'RANGE' }],
    });
  });

  test('the S2 tables — teams, team-members, social-relationships, video-recording-share-links — with their indexes and TTL', () => {
    t.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'orgiq-social-teams',
      KeySchema: [{ AttributeName: 'orgId', KeyType: 'HASH' }, { AttributeName: 'teamId', KeyType: 'RANGE' }],
      GlobalSecondaryIndexes: Match.arrayWith([Match.objectLike({ IndexName: 'orgId-slug-index' })]),
    });
    t.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'orgiq-social-team-members',
      KeySchema: [{ AttributeName: 'teamId', KeyType: 'HASH' }, { AttributeName: 'userId', KeyType: 'RANGE' }],
      GlobalSecondaryIndexes: Match.arrayWith([Match.objectLike({ IndexName: 'userId-index' })]),
    });
    t.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'orgiq-social-social-relationships',
      KeySchema: [{ AttributeName: 'followerId', KeyType: 'HASH' }, { AttributeName: 'followeeId', KeyType: 'RANGE' }],
      GlobalSecondaryIndexes: Match.arrayWith([Match.objectLike({ IndexName: 'followeeId-followerId-index' })]),
    });
    t.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'orgiq-social-video-recording-share-links',
      KeySchema: [{ AttributeName: 'shareToken', KeyType: 'HASH' }],
      TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
    });
  });

  test('tableSuffix moves the whole namespace so a redeploy dodges the RETAINed tables', () => {
    assert.equal(socialTablePrefix('orgiq', 'v2'), 'orgiq-social-v2-');
    assert.throws(() => socialTablePrefix('orgiq', 'bad suffix'));
    const { social: s } = socialApp({ tableSuffix: 'v2' });
    const st = Template.fromStack(s);
    st.hasResourceProperties('AWS::DynamoDB::Table', { TableName: 'orgiq-social-v2-call-log' });
    const td = Object.values<any>(st.findResources('AWS::ECS::TaskDefinition'))
      .find((d) => d.Properties.ContainerDefinitions.some((c: any) => c.Name === 'platform-api'));
    const env = td.Properties.ContainerDefinitions[0].Environment as any[];
    assert.equal(env.find((e) => e.Name === 'DDB_TABLE_PREFIX').Value, 'orgiq-social-v2-');
  });

  test('the table keys agree with the pinned realtime-examples manifest where both list a table', () => {
    // Not an exported subpath of the package, so read it off disk.
    const manifest = JSON.parse(fs.readFileSync(
      path.join(__dirname, '..', 'node_modules', '@connorhoehn', 'realtime-examples-cdk', 'dist', 'dynamodb-schemas.json'), 'utf8',
    )) as { tables: any[] };
    const byName = new Map(manifest.tables.map((x) => [x.tableName, x]));
    for (const spec of SOCIAL_TABLES) {
      const m = byName.get(spec.name);
      if (!m) continue; // call-log / voicemail are in no manifest
      assert.equal(spec.hash.name, m.hashKey.name, `${spec.name} hash key`);
      assert.equal(spec.range?.name, m.rangeKey?.name, `${spec.name} range key`);
    }
  });

  test('without the SFU in the app, synth warns that VIDEO_API_URL is unset', () => {
    const { social: s } = socialApp({}, false);
    Annotations.fromStack(s).hasWarning('*', Match.stringLikeRegexp('VIDEO_API_URL'));
  });
});

// ── bin/app.ts gating ───────────────────────────────────────────────────────

describe('bin/app.ts — the social stacks are opt-in', () => {
  test('none of them is in the default app', () => {
    const app = synthApp();
    for (const name of ['OrgIQ-SocialImages', 'OrgIQ-SocialMedia', 'OrgIQ-Social']) {
      assert.ok(!app.has(name), `${name} must not deploy unless asked`);
    }
  });

  test('cdk.json states deploySocial off, and ctxFlag reads "false" as off', () => {
    const cdkJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cdk.json'), 'utf8'));
    assert.equal(cdkJson.context.deploySocial, 'false');
    assert.ok(!synthApp({ deploySocial: 'false' }).has('OrgIQ-Social'));
  });

  test('the default app carries no ElastiCache, no social SSM parameter and no realtime env on the middleware', () => {
    const app = synthApp();
    for (const [name, tpl] of Object.entries<any>(app.templates)) {
      const types = Object.values<any>(tpl.Resources ?? {}).map((r) => r.Type);
      assert.ok(!types.some((x) => x.startsWith('AWS::ElastiCache::')), `${name} has ElastiCache by default`);
      assert.ok(!JSON.stringify(tpl).includes('/social/redis-url'), `${name} references the social Redis parameter`);
    }
    const mw = JSON.stringify(app.templates['OrgIQ-MiddlewareService']);
    for (const name of ['"REALTIME_GATEWAY"', '"REDIS_URL"', '"SOCIAL_CHAT_STORE"', '"SOCIAL_CHAT_TABLE_PREFIX"']) {
      assert.ok(!mw.includes(name), `${name} in the default middleware template`);
    }
  });

  test('the full social app: every Fn::ImportValue resolves, and the middleware imports nothing social', () => {
    const app = synthApp({
      deploySocial: 'true', deploySocialMedia: 'true', realtimeGateway: 'true', sfuAllowCidr: '203.0.113.4/32', socialLive: 'true',
    });
    const exported = new Set<string>();
    for (const tpl of Object.values(app.templates)) for (const n of exportedNames(tpl)) exported.add(n);
    for (const [name, tpl] of Object.entries(app.templates)) {
      for (const imp of importedExportNames(tpl)) assert.ok(exported.has(imp), `${name} imports ${imp}, which no stack exports`);
    }
    const mw = app.template('OrgIQ-MiddlewareService');
    const mwImports = [...importedExportNames(app.templates['OrgIQ-MiddlewareService'])];
    assert.deepEqual(mwImports.filter((n) => /social/i.test(n)), [], 'middleware must not import from the social stacks');
    // …yet it is wired to Social's Redis and tables, by name.
    const td = Object.values<any>(mw.findResources('AWS::ECS::TaskDefinition'))[0];
    const c = td.Properties.ContainerDefinitions.find((x: any) => x.Name === 'middleware');
    assert.ok((c.Secrets as any[]).some((x) => x.Name === 'REDIS_URL'));
    assert.ok((c.Environment as any[]).some((x) => x.Name === 'SOCIAL_CHAT_STORE' && x.Value === 'dynamo'));
    app.template('OrgIQ-Social').hasResourceProperties('AWS::IAM::Policy', {
      PolicyName: 'orgiq-middleware-social-chat', Roles: ['orgiq-middleware-task-role'],
    });
  });

  test('deploySocial + deploySocialMedia bring in all three, wired without a dependency cycle', () => {
    const app = synthApp({ deploySocial: 'true', deploySocialMedia: 'true', sfuAllowCidr: '203.0.113.4/32' });
    for (const name of ['OrgIQ-SocialImages', 'OrgIQ-SocialMedia', 'OrgIQ-Social']) {
      assert.ok(app.has(name), `missing ${name}; got ${app.stackNames.join(', ')}`);
    }
    // OrgIQ-MiddlewareService must not import anything from the social stacks.
    const mw = JSON.stringify(app.templates['OrgIQ-MiddlewareService']);
    assert.ok(!/OrgIQ-Social/.test(mw), 'middleware stack must not reference the social stacks');
  });

  test('both stacks report the image digest they were deployed with (deploy.sh reads it back)', () => {
    const sfu = `sha256:${'1'.repeat(64)}`, platform = `sha256:${'2'.repeat(64)}`;
    const app = synthApp({
      deploySocial: 'true', deploySocialMedia: 'true', sfuAllowCidr: '203.0.113.4/32',
      sfuImageDigest: sfu, deploySocialService: 'true', platformApiImageDigest: platform,
    });
    assert.equal(app.templates['OrgIQ-SocialMedia'].Outputs.SfuImageDigest.Value, sfu);
    assert.equal(app.templates['OrgIQ-Social'].Outputs.PlatformApiImageDigest.Value, platform);
  });
});
