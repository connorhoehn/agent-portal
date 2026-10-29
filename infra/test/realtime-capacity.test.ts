/**
 * 100 simultaneous calls (docs/realtime-capacity-100-calls-2026-10-01.md,
 * "Ranked changes"; docs/social-calls-deploy-plan.md §11).
 *
 * Each block pins one ranked change: the SFU's Redis (one lobby, one session),
 * the one-task gateway (rings that reach the callee), the SFU's size and the
 * LVS caps that would refuse the 51st publisher, the TURN relay, ElastiCache
 * failover, the load alarms, and the 100-call profile as one synth.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { sfuPorts } from '../lib/social-media-stack';
import { middlewareServiceStack } from './helpers/stacks';
import { importedExportNames, synthApp } from './helpers/app-assembly';

const SOCIAL = { deploySocial: 'true', deploySocialMedia: 'true', sfuAllowCidr: '203.0.113.4/32' };
/** The documented 100-call profile, case (b) — deploy plan §11. */
const PROFILE_B = {
  ...SOCIAL, realtimeGateway: 'true', deployMiddlewareService: 'true', albAllowCidr: '203.0.113.4/32',
  sfuInstanceType: 'c7g.4xlarge', sfuWorkers: '16', sfuMaxStreams: '1000', sfuMaxTransports: '4000',
  sfuAdmissionCapacity: '400', alarmSfuNetworkOutMbps: '1000',
  socialRedisNodeType: 'cache.t4g.small', socialRedisReplicas: '1',
  platformApiCpu: '1024', platformApiMemoryMiB: '2048', realtimeAlarms: 'true',
};

const container = (t: Template, name: string) => {
  const td = Object.values<any>(t.findResources('AWS::ECS::TaskDefinition'))
    .find((d) => d.Properties.ContainerDefinitions.some((c: any) => c.Name === name));
  return { td, c: td.Properties.ContainerDefinitions.find((c: any) => c.Name === name) };
};
const env = (c: any, k: string) => (c.Environment as any[]).find((e) => e.Name === k)?.Value;
const userData = (t: Template, logicalPrefix = 'SfuInstance') => JSON.stringify(Object.entries<any>(t.findResources('AWS::EC2::Instance'))
  .find(([id]) => id.startsWith(logicalPrefix))![1].Properties.UserData);
const policyStatements = (t: Template) => Object.values<any>(t.findResources('AWS::IAM::Policy'))
  .flatMap((p) => p.Properties.PolicyDocument.Statement as any[]);

// ── #2: the gateway is one task ─────────────────────────────────────────────

describe('#2 the realtime gateway runs as exactly one task', () => {
  const on = Template.fromStack(middlewareServiceStack({ realtimeGateway: 'true' }));
  const off = Template.fromStack(middlewareServiceStack());

  test('no autoscaling, stop-before-start, a whole core and 2 GB, a short drain', () => {
    on.resourceCountIs('AWS::ApplicationAutoScaling::ScalableTarget', 0);
    on.hasResourceProperties('AWS::ECS::Service', {
      DeploymentConfiguration: Match.objectLike({ MinimumHealthyPercent: 0, MaximumPercent: 100 }),
      // ECS refuses MaximumPercent 100 while AZ rebalancing is on.
      AvailabilityZoneRebalancing: 'DISABLED',
    });
    const { td } = container(on, 'middleware');
    assert.equal(td.Properties.Cpu, '1024');
    assert.equal(td.Properties.Memory, '2048');
    on.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
      TargetGroupAttributes: Match.arrayWith([{ Key: 'deregistration_delay.timeout_seconds', Value: '15' }]),
    });
  });

  test('without the gateway or a Redis: one task (DE-47), 100/200, 0.5 vCPU, no REDIS_URL', () => {
    off.resourceCountIs('AWS::ApplicationAutoScaling::ScalableTarget', 0);
    off.hasResourceProperties('AWS::ECS::Service', {
      DeploymentConfiguration: Match.objectLike({ MinimumHealthyPercent: 100, MaximumPercent: 200 }),
    });
    const { td, c } = container(off, 'middleware');
    assert.equal(td.Properties.Cpu, '512');
    assert.equal(env(c, 'REDIS_URL'), undefined);
  });

  test('without the gateway, a Redis source brings back 1→4 autoscaling and hands the task REDIS_URL (DE-47)', () => {
    const viaUrl = Template.fromStack(middlewareServiceStack({ realtimeRedisUrl: 'redis://10.0.0.9:6379' }));
    viaUrl.resourceCountIs('AWS::ApplicationAutoScaling::ScalableTarget', 1);
    viaUrl.hasResourceProperties('AWS::ApplicationAutoScaling::ScalableTarget', { MinCapacity: 1, MaxCapacity: 4 });
    assert.equal(env(container(viaUrl, 'middleware').c, 'REDIS_URL'), 'redis://10.0.0.9:6379');

    const viaSocial = Template.fromStack(middlewareServiceStack({ deploySocial: 'true' }));
    viaSocial.resourceCountIs('AWS::ApplicationAutoScaling::ScalableTarget', 1);
    const secrets = (container(viaSocial, 'middleware').c.Secrets ?? []) as Array<{ Name: string }>;
    assert.ok(secrets.some((x) => x.Name === 'REDIS_URL'), 'REDIS_URL from the Social SSM parameter');

    // Opting out stays possible with a Redis present.
    Template.fromStack(middlewareServiceStack({ deploySocial: 'true', middlewareAutoscale: 'false' }))
      .resourceCountIs('AWS::ApplicationAutoScaling::ScalableTarget', 0);
  });

  test('autoscale without a Redis source fails synth; the gateway still forces one task (DE-47)', () => {
    assert.throws(() => middlewareServiceStack({ middlewareAutoscale: 'true' }), /needs a Redis for shared fleet state/);
    assert.throws(() => middlewareServiceStack({ realtimeGateway: 'true', deploySocial: 'true', middlewareAutoscale: 'true' }),
      /one-task realtime gateway safeguard/);
    Template.fromStack(middlewareServiceStack({ realtimeGateway: 'true', deploySocial: 'true' }))
      .resourceCountIs('AWS::ApplicationAutoScaling::ScalableTarget', 0);
  });

  test('middlewareCpu / middlewareMemoryMiB size it; asking to autoscale the gateway is refused', () => {
    const big = Template.fromStack(middlewareServiceStack({ realtimeGateway: 'true', middlewareCpu: '2048', middlewareMemoryMiB: '4096' }));
    assert.equal(container(big, 'middleware').td.Properties.Cpu, '2048');
    assert.throws(() => middlewareServiceStack({ realtimeGateway: 'true', middlewareAutoscale: 'true' }), /one-task realtime gateway safeguard/);
    assert.throws(() => middlewareServiceStack({ middlewareCpu: 'lots' }), /middlewareCpu/);
  });
});

// ── Grants and env the portal's features need ─────────────────────────────

describe('the middleware task can use what the portal ships', () => {
  const mw = synthApp().template('OrgIQ-MiddlewareService');
  const statements = policyStatements(mw);
  const sid = (s: string) => statements.find((x) => x.Sid === s);

  test('Code Interpreter sessions on the one code interpreter, by name — not an imported ARN', () => {
    const ci = sid('CodeInterpreterSessions');
    assert.ok(ci);
    assert.match(JSON.stringify(ci.Resource), /code-interpreter-custom\/orgiq_code_interpreter-\*/);
    assert.ok(ci.Action.includes('bedrock-agentcore:StartCodeInterpreterSession'));
  });

  test('canary + judge parameters: read/write on /orgiq/canary/* and nothing wider', () => {
    const p = sid('CanaryParameters');
    assert.deepEqual(p.Action, ['ssm:GetParameter', 'ssm:PutParameter']);
    assert.match(JSON.stringify(p.Resource), /parameter\/orgiq\/canary\/\*/);
    assert.match(JSON.stringify(sid('CanaryScoreLog').Resource), /log-group:\/orgiq\/canary\/scores:\*/);
  });

  test('observability reads, and no prompt or guardrail writes', () => {
    assert.deepEqual(sid('ObservabilityReads').Action, ['cloudwatch:GetMetricData', 'xray:GetTraceSummaries', 'xray:BatchGetTraces']);
    const all = JSON.stringify(statements);
    for (const a of ['bedrock:UpdatePrompt', 'bedrock:CreatePrompt', 'bedrock:UpdateGuardrail', 'CreateApiKeyCredentialProvider']) {
      assert.ok(!all.includes(a), `${a} granted`);
    }
  });

  test('CODE_INTERPRETER_ID and BROWSER_PROFILE_ID arrive from the capabilities stack\'s SSM parameters, not exports', () => {
    const { c } = container(mw, 'middleware');
    const secret = (k: string) => (c.Secrets as any[]).find((x) => x.Name === k);
    assert.match(JSON.stringify(secret('CODE_INTERPRETER_ID').ValueFrom), /capabilities\/code-interpreter-id/);
    assert.match(JSON.stringify(secret('BROWSER_PROFILE_ID').ValueFrom), /capabilities\/browser-profile-id/);
    const caps = synthApp().template('OrgIQ-AgentCoreCapabilities');
    caps.hasResourceProperties('AWS::SSM::Parameter', { Name: '/orgiq/capabilities/code-interpreter-id' });
    caps.hasResourceProperties('AWS::SSM::Parameter', { Name: '/orgiq/capabilities/browser-profile-id' });
    const mwImports = [...importedExportNames(synthApp().templates['OrgIQ-MiddlewareService'])];
    assert.ok(!mwImports.some((n) => /code-interpreter|browser-profile/.test(n)), 'the middleware imports a capability export');
  });
});

// ── #1 / #3: the SFU ────────────────────────────────────────────────────────

describe('#1 the SFU has a Redis by default (one lobby, one session)', () => {
  const media = synthApp(SOCIAL).template('OrgIQ-SocialMedia');
  const ud = userData(media);

  test('a loopback Redis unit, ordered before the SFU, and REDIS_URL pointing at it', () => {
    assert.match(ud, /REDIS_URL=redis:\/\/127\.0\.0\.1:6379/);
    assert.match(ud, /lvs-redis\.service/);
    assert.match(ud, /--bind 127\.0\.0\.1 --port 6379/);
    assert.match(ud, /Requires=docker\.service lvs-redis\.service/);
    assert.match(ud, /systemctl enable --now lvs-redis\.service/);
  });

  test('the quota Redis arms is lifted from 50 publishers to 1000 (0 is NOT unlimited in LVS)', () => {
    assert.match(ud, /MAX_CONCURRENT_STREAMS=1000/);
    assert.doesNotMatch(ud, /MAX_TRANSPORTS_PER_POD|ADMISSION_GATE_CAPACITY/);
  });

  test('sfuRedisUrl overrides it and drops the local unit', () => {
    const o = userData(synthApp({ ...SOCIAL, sfuRedisUrl: 'redis://10.0.0.5:6379' }).template('OrgIQ-SocialMedia'));
    assert.match(o, /REDIS_URL=redis:\/\/10\.0\.0\.5:6379/);
    assert.doesNotMatch(o, /lvs-redis/);
  });

  test('OrgIQ-Social reads the SFU host by NAME, so an image roll (a new instance) cannot wedge on an export', () => {
    media.hasResourceProperties('AWS::SSM::Parameter', { Name: '/orgiq/social/sfu-private-ip' });
    media.hasResourceProperties('AWS::SSM::Parameter', { Name: '/orgiq/social/sfu-instance-id' });
    const social = synthApp(SOCIAL).templates['OrgIQ-Social'];
    assert.ok(![...importedExportNames(social)].some((n) => /SfuInstance/.test(n)), 'Social still imports the instance');
  });
});

describe('#3 SFU size, workers and caps', () => {
  test('defaults stay t4g.small with two workers: UDP 40000-40001, TCP 40010-40011', () => {
    const p = sfuPorts();
    assert.deepEqual([p.rtcUdp, p.rtcTcp, p.workers], [{ from: 40000, to: 40001 }, { from: 40010, to: 40011 }, 2]);
    synthApp(SOCIAL).template('OrgIQ-SocialMedia').hasResourceProperties('AWS::EC2::Instance', { InstanceType: 't4g.small' });
  });

  test('sfuWorkers drives MEDIASOUP_WORKERS and the security group from one number', () => {
    const t = synthApp({ ...SOCIAL, sfuWorkers: '8', sfuInstanceType: 'c7g.2xlarge' }).template('OrgIQ-SocialMedia');
    t.hasResourceProperties('AWS::EC2::Instance', { InstanceType: 'c7g.2xlarge' });
    assert.match(userData(t), /MEDIASOUP_WORKERS=8/);
    const sg = Object.values<any>(t.findResources('AWS::EC2::SecurityGroup')).find((s) => s.Properties.GroupName === 'orgiq-social-sfu');
    const rules = (sg.Properties.SecurityGroupIngress as any[]).map((r) => `${r.IpProtocol} ${r.FromPort}-${r.ToPort}`).sort();
    assert.deepEqual(rules, ['tcp 40010-40017', 'udp 40000-40007']);
  });

  test('the LVS caps reach the env when given, and nonsense is refused', () => {
    const ud = userData(synthApp({ ...SOCIAL, sfuMaxTransports: '4000', sfuAdmissionCapacity: '400' }).template('OrgIQ-SocialMedia'));
    assert.match(ud, /MAX_TRANSPORTS_PER_POD=4000/);
    assert.match(ud, /ADMISSION_GATE_CAPACITY=400/);
    assert.throws(() => synthApp({ ...SOCIAL, sfuInstanceType: 'c7i.2xlarge' }), /Graviton/);
    assert.throws(() => synthApp({ ...SOCIAL, sfuWorkers: '0' }), /sfuWorkers/);
  });

  test('the host recovers itself on a failed system status check (same id, IP and EIP)', () => {
    const alarm = Object.values<any>(synthApp(SOCIAL).template('OrgIQ-SocialMedia').findResources('AWS::CloudWatch::Alarm'))
      .find((a) => a.Properties.MetricName === 'StatusCheckFailed_System');
    assert.ok(alarm);
    assert.match(JSON.stringify(alarm.Properties.AlarmActions), /:automate:.*:ec2:recover/);
  });
});

// ── #6: TURN ────────────────────────────────────────────────────────────────

describe('#6 the TURN relay (deployTurn=true)', () => {
  test('off by default: no TURN host, no LVS_TURN_URL', () => {
    const t = synthApp(SOCIAL).template('OrgIQ-SocialMedia');
    assert.doesNotMatch(userData(t), /LVS_TURN_URL/);
    assert.equal(Object.keys(t.findResources('AWS::EC2::Instance')).length, 1);
  });

  const app = synthApp({ ...SOCIAL, deployTurn: 'true', turnAllowCidr: '198.51.100.7/32' });
  const t = app.template('OrgIQ-SocialMedia');

  test('a second host with its own EIP, secret and group; the SFU learns LVS_TURN_URL + the secret', () => {
    assert.equal(Object.keys(t.findResources('AWS::EC2::Instance')).length, 2);
    t.resourceCountIs('AWS::EC2::EIP', 2);
    t.hasResourceProperties('AWS::SecretsManager::Secret', { Name: 'orgiq-social-turn-secret' });
    const ud = userData(t);
    assert.match(ud, /LVS_TURN_URL=turn:/);
    assert.match(ud, /:3478,turn:/);
    assert.match(ud, /:443\?transport=tcp/);
    assert.match(ud, /LVS_TURN_STATIC_SECRET=\$\(aws secretsmanager get-secret-value/);
    const turnUd = userData(t, 'TurnInstance');
    assert.match(turnUd, /use-auth-secret/);
    assert.match(turnUd, /listening-port=443/);
    assert.match(turnUd, /denied-peer-ip=10\.0\.0\.0-10\.255\.255\.255/);
  });

  test('ingress: allowlisted clients on 3478/443, the SFU on the relay range, and the relay on the SFU media ports', () => {
    const turnSg = Object.values<any>(t.findResources('AWS::EC2::SecurityGroup')).find((s) => s.Properties.GroupName === 'orgiq-social-turn');
    const inline = (turnSg.Properties.SecurityGroupIngress ?? []) as any[];
    const separate = Object.values<any>(t.findResources('AWS::EC2::SecurityGroupIngress')).map((r) => r.Properties);
    const all = [...inline, ...separate];
    const clientRules = all.filter((r) => r.CidrIp === '198.51.100.7/32').map((r) => `${r.IpProtocol} ${r.FromPort}`).sort();
    assert.deepEqual(clientRules, ['tcp 3478', 'tcp 443', 'udp 3478']);
    assert.ok(all.some((r) => r.FromPort === 49152 && r.ToPort === 49651 && r.IpProtocol === 'udp'), 'relay range from the SFU');
    const sfuSg = Object.values<any>(t.findResources('AWS::EC2::SecurityGroup')).find((s) => s.Properties.GroupName === 'orgiq-social-sfu');
    const sfuRules = [...(sfuSg.Properties.SecurityGroupIngress ?? []), ...separate];
    assert.ok(sfuRules.some((r: any) => r.FromPort === 40000 && JSON.stringify(r.CidrIp ?? '').includes('TurnEip')), 'SFU admits the relay EIP');
    const open = all.filter((r) => r.CidrIp === '0.0.0.0/0');
    assert.deepEqual(open, []);
  });

  test('no turnAllowCidr warns; TLS takes a domain and a certificate secret together', () => {
    const bare = synthApp({ ...SOCIAL, deployTurn: 'true' });
    assert.ok(bare.has('OrgIQ-SocialMedia'));
    assert.throws(() => synthApp({ ...SOCIAL, deployTurn: 'true', turnTlsDomain: 'turn.example.com' }), /go together/);
    const tls = synthApp({ ...SOCIAL, deployTurn: 'true', turnTlsDomain: 'turn.example.com', turnTlsCertSecretName: 'orgiq-turn-tls' })
      .template('OrgIQ-SocialMedia');
    assert.match(userData(tls), /turns:turn\.example\.com:443\?transport=tcp/);
    assert.match(userData(tls, 'TurnInstance'), /tls-listening-port=443/);
  });
});

// ── #8 / #12: OrgIQ-Social ──────────────────────────────────────────────────

describe('#8 ElastiCache resilience and #12 platform-api', () => {
  test('default: one node, no failover; socialRedisReplicas=1: a replica, failover, Multi-AZ, a daily snapshot', () => {
    const one = synthApp(SOCIAL).template('OrgIQ-Social');
    one.hasResourceProperties('AWS::ElastiCache::ReplicationGroup', {
      NumCacheClusters: 1, AutomaticFailoverEnabled: false, CacheNodeType: 'cache.t4g.micro', SnapshotRetentionLimit: 0,
    });
    const two = synthApp({ ...SOCIAL, socialRedisReplicas: '1', socialRedisNodeType: 'cache.t4g.small' }).template('OrgIQ-Social');
    two.hasResourceProperties('AWS::ElastiCache::ReplicationGroup', {
      NumCacheClusters: 2, AutomaticFailoverEnabled: true, MultiAZEnabled: true, CacheNodeType: 'cache.t4g.small', SnapshotRetentionLimit: 1,
    });
  });

  test('the TTLs platform-api cannot enable itself are CDK\'s', () => {
    const t = synthApp(SOCIAL).template('OrgIQ-Social');
    for (const name of ['document-video-sessions', 'pipeline-runs', 'social-outbox']) {
      t.hasResourceProperties('AWS::DynamoDB::Table', {
        TableName: `orgiq-social-${name}`, TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
      });
    }
  });

  test('platformApiCpu / platformApiMemoryMiB size the task (default 512 / 1024)', () => {
    assert.equal(container(synthApp(SOCIAL).template('OrgIQ-Social'), 'platform-api').td.Properties.Cpu, '512');
    const big = container(synthApp({ ...SOCIAL, platformApiCpu: '1024', platformApiMemoryMiB: '2048' }).template('OrgIQ-Social'), 'platform-api');
    assert.deepEqual([big.td.Properties.Cpu, big.td.Properties.Memory], ['1024', '2048']);
  });
});

// ── #9: alarms ──────────────────────────────────────────────────────────────

describe('#9 load alarms (realtimeAlarms=true)', () => {
  test('off by default: no realtime topic, no metric filters, only the auto-recover alarm', () => {
    const app = synthApp({ ...SOCIAL, realtimeGateway: 'true' });
    for (const [name, tpl] of Object.entries<any>(app.templates)) {
      assert.ok(!JSON.stringify(tpl).includes('realtime-alarms'), `${name} names the topic by default`);
      const types = Object.values<any>(tpl.Resources ?? {}).map((r) => r.Type);
      assert.ok(!types.includes('AWS::Logs::MetricFilter'), `${name} has metric filters by default`);
    }
    const alarms = Object.values<any>(app.template('OrgIQ-SocialMedia').findResources('AWS::CloudWatch::Alarm'));
    assert.deepEqual(alarms.map((a) => a.Properties.AlarmName), ['orgiq-social-sfu-auto-recover']);
  });

  const app = synthApp(PROFILE_B);
  const names = (stack: string) => Object.values<any>(app.template(stack).findResources('AWS::CloudWatch::Alarm'))
    .map((a) => a.Properties.AlarmName).sort();

  test('each stack alarms on what it owns', () => {
    assert.deepEqual(names('OrgIQ-MiddlewareService'), [
      'orgiq-gateway-event-loop', 'orgiq-gateway-silent', 'orgiq-middleware-alb-5xx', 'orgiq-middleware-alb-connections',
      'orgiq-middleware-alb-rejected', 'orgiq-middleware-alb-response-time', 'orgiq-middleware-cpu', 'orgiq-middleware-memory',
    ]);
    assert.deepEqual(names('OrgIQ-Social'), [
      'orgiq-social-dynamodb-throttles', 'orgiq-social-platform-api-cpu', 'orgiq-social-platform-api-memory',
      'orgiq-social-redis-cpu', 'orgiq-social-redis-evictions', 'orgiq-social-redis-memory',
    ]);
    // c7g is not burstable: no credit alarm.
    assert.deepEqual(names('OrgIQ-SocialMedia'), [
      'orgiq-sfu-cpu', 'orgiq-sfu-network-out', 'orgiq-sfu-status-check', 'orgiq-social-sfu-auto-recover',
    ]);
    const burst = Object.values<any>(synthApp({ ...SOCIAL, realtimeAlarms: 'true' }).template('OrgIQ-SocialMedia')
      .findResources('AWS::CloudWatch::Alarm')).map((a) => a.Properties.AlarmName);
    assert.ok(burst.includes('orgiq-sfu-cpu-credits'));
  });

  test('one topic, minted by the middleware; the social stacks address it by ARN, not an import', () => {
    app.template('OrgIQ-MiddlewareService').hasResourceProperties('AWS::SNS::Topic', { TopicName: 'orgiq-realtime-alarms' });
    for (const stack of ['OrgIQ-Social', 'OrgIQ-SocialMedia']) {
      const tpl = app.templates[stack];
      assert.ok(JSON.stringify(tpl).includes(':orgiq-realtime-alarms'), `${stack} does not notify the topic`);
      assert.ok(![...importedExportNames(tpl)].some((n) => /Alarm|Topic/.test(n)), `${stack} imports the topic`);
    }
  });

  test('the gateway load line becomes metrics through filters on its exact type and field names', () => {
    const filters = Object.values<any>(app.template('OrgIQ-MiddlewareService').findResources('AWS::Logs::MetricFilter'));
    assert.deepEqual(filters.map((f) => f.Properties.MetricTransformations[0].MetricValue).sort(),
      ['$.activeCalls', '$.eventLoopDelayP99Ms', '$.sockets']);
    for (const f of filters) assert.match(f.Properties.FilterPattern, /\$\.type = "realtime-gateway-stats"/);
  });

  test('alertEmail subscribes an address', () => {
    synthApp({ ...PROFILE_B, alertEmail: 'ops@example.com' }).template('OrgIQ-MiddlewareService')
      .hasResourceProperties('AWS::SNS::Subscription', { Protocol: 'email', Endpoint: 'ops@example.com' });
  });
});

// ── The profile as a whole ──────────────────────────────────────────────────

describe('the 100-call profile synthesizes as documented', () => {
  const app = synthApp(PROFILE_B);
  test('case (b): c7g.4xlarge, 16 workers, raised caps, Redis replica, 1-vCPU platform-api, pinned gateway', () => {
    const media = app.template('OrgIQ-SocialMedia');
    media.hasResourceProperties('AWS::EC2::Instance', { InstanceType: 'c7g.4xlarge', Monitoring: true });
    const ud = userData(media);
    for (const kv of ['MEDIASOUP_WORKERS=16', 'MAX_CONCURRENT_STREAMS=1000', 'MAX_TRANSPORTS_PER_POD=4000', 'ADMISSION_GATE_CAPACITY=400']) {
      assert.ok(ud.includes(kv), kv);
    }
    app.template('OrgIQ-MiddlewareService').resourceCountIs('AWS::ApplicationAutoScaling::ScalableTarget', 0);
    app.template('OrgIQ-Social').hasResourceProperties('AWS::ElastiCache::ReplicationGroup', { NumCacheClusters: 2 });
  });
});
