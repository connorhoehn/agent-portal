/**
 * The microVM runner's infrastructure (docs/microvm-runner-design.md §2, §5,
 * §7, §12): OrgIQ-MicrovmNetwork, OrgIQ-MicrovmRuntime and the middleware's
 * three additions, all behind `-c microvm=true`.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Template } from 'aws-cdk-lib/assertions';
import { synthApp } from './helpers/app-assembly';
import { middlewareServiceStack, newApp, withoutEcrLookup, PREFIX } from './helpers/stacks';
import { actionsOf, statementsForRole, type Statement } from './helpers/cfn';
import { MicrovmNetworkStack, MICROVM_EGRESS_DOMAINS } from '../lib/microvm-network-stack';
import {
  MicrovmRuntimeStack, MICROVM_ROLE_SIDS, microvmMaxLifetime, type MicrovmRuntimeStackProps,
} from '../lib/microvm-runtime-stack';

const ROLE = 'orgiq-microvm-execution-role';
const SUBNETS = ['subnet-aaaa1111', 'subnet-bbbb2222'];
const RUNTIME_SG = 'sg-0runtime000000001';

const runtimeStack = (context: Record<string, unknown> = {}, props: Partial<MicrovmRuntimeStackProps> = {}) =>
  withoutEcrLookup(() => new MicrovmRuntimeStack(newApp(context), 'OrgIQ-MicrovmRuntime', {
    prefix: PREFIX, subnetIds: SUBNETS, securityGroupIds: [RUNTIME_SG], ...props,
  }));

const runtime = Template.fromStack(runtimeStack());
const network = Template.fromStack(new MicrovmNetworkStack(newApp(), 'OrgIQ-MicrovmNetwork', { prefix: PREFIX }));
const roleStatements = statementsForRole(runtime, ROLE);
const microvmRuntime = (t: Template) =>
  Object.values<any>(t.findResources('AWS::BedrockAgentCore::Runtime'))
    .filter((r) => r.Properties.AgentRuntimeName === 'orgiq_microvm');

describe('the context flag', () => {
  test('the default app has no orgiq_microvm resources at all', () => {
    const app = synthApp();
    assert.ok(!app.has('OrgIQ-MicrovmNetwork') && !app.has('OrgIQ-MicrovmRuntime'));
    const all = JSON.stringify(app.templates);
    assert.ok(!all.includes('orgiq_microvm'), 'orgiq_microvm leaked into the default synth');
    assert.ok(!all.includes('MICROVM_'), 'MICROVM_* env leaked into the default synth');
    assert.ok(!all.includes('-microvm-'), 'a microvm export or name leaked into the default synth');
  });

  test('-c microvm=true adds both stacks, the runtime and the middleware wiring', () => {
    const app = synthApp({ microvm: 'true' });
    assert.ok(app.has('OrgIQ-MicrovmNetwork') && app.has('OrgIQ-MicrovmRuntime'));
    assert.equal(microvmRuntime(app.template('OrgIQ-MicrovmRuntime')).length, 1);
    const mw = JSON.stringify(app.templates['OrgIQ-MiddlewareService']);
    for (const v of ['MICROVM_RUNTIME_ARN', 'MICROVM_RUNS_BUCKET', 'MICROVM_COMPUTE_USD_PER_SECOND', 'MicrovmInvokeAndStop']) {
      assert.ok(mw.includes(v), `middleware is missing ${v}`);
    }
  });

  test('every microvm import is satisfied by an export in the flagged app', () => {
    const app = synthApp({ microvm: 'true' });
    const exported = new Set(Object.values<any>(app.templates)
      .flatMap((t) => Object.values<any>(t.Outputs ?? {}).map((o) => o.Export?.Name).filter(Boolean)));
    const imports = [...JSON.stringify(app.templates).matchAll(/"Fn::ImportValue":"([^"]+)"/g)]
      .map((m) => m[1]!).filter((n) => n.includes('microvm'));
    assert.ok(imports.length >= 5, `expected the runtime and middleware imports, got ${imports.join(', ')}`);
    for (const name of imports) assert.ok(exported.has(name), `nothing exports ${name}`);
  });
});

describe('execution role (design §12)', () => {
  test('has exactly the Sids in §12 and no others', () => {
    assert.deepEqual(roleStatements.map((s) => s.Sid).sort(), [...MICROVM_ROLE_SIDS].sort());
  });

  test('only EcrAuth, Traces and Metrics name Resource "*", and Metrics is namespace-conditioned', () => {
    const star = (s: Statement) => [].concat(s.Resource).some((r) => r === '*');
    assert.deepEqual(roleStatements.filter(star).map((s) => s.Sid).sort(), ['EcrAuth', 'Metrics', 'Traces']);
    const metrics = roleStatements.find((s) => s.Sid === 'Metrics')!;
    assert.deepEqual(metrics.Condition, { StringEquals: { 'cloudwatch:namespace': 'bedrock-agentcore' } });
  });

  test('deliberately absent: secrets, rds-data, Retrieve, s3, InvokeAgentRuntime', () => {
    const actions = roleStatements.flatMap(actionsOf);
    for (const a of actions) {
      assert.ok(!/^(secretsmanager|rds-data|s3):/.test(a), `role must not hold ${a}`);
      assert.ok(a !== 'bedrock:Retrieve' && !a.startsWith('bedrock-agentcore:InvokeAgentRuntime'), `role must not hold ${a}`);
    }
  });

  test('Logs are on the orgiq_microvm runtime log groups and Workload on its own identity', () => {
    const logs = JSON.stringify(roleStatements.find((s) => s.Sid === 'Logs')!.Resource);
    assert.match(logs, /log-group:\/aws\/bedrock-agentcore\/runtimes\/orgiq_microvm\*/);
    const workload = roleStatements.find((s) => s.Sid === 'Workload')!;
    assert.deepEqual(actionsOf(workload), ['bedrock-agentcore:GetWorkloadAccessToken']);
    assert.deepEqual(workload.Resource, { 'Fn::GetAtt': ['MicrovmRuntime', 'WorkloadIdentityDetails.WorkloadIdentityArn'] });
  });

  test('the trust policy carries aws:SourceAccount and aws:SourceArn', () => {
    const role = Object.values<any>(runtime.findResources('AWS::IAM::Role'))
      .find((r) => r.Properties.RoleName === ROLE);
    const [trust] = role.Properties.AssumeRolePolicyDocument.Statement;
    assert.deepEqual(trust.Principal, { Service: 'bedrock-agentcore.amazonaws.com' });
    assert.deepEqual(trust.Condition.StringEquals, { 'aws:SourceAccount': { Ref: 'AWS::AccountId' } });
    assert.match(JSON.stringify(trust.Condition.ArnLike['aws:SourceArn']), /:runtime\/\*"/);
  });
});

describe('the runtime (design §2, §7)', () => {
  const [rt] = microvmRuntime(runtime);

  test('is VPC mode in the two runtime subnets with the runtime security group', () => {
    assert.deepEqual(rt.Properties.NetworkConfiguration, {
      NetworkMode: 'VPC',
      NetworkModeConfig: { Subnets: SUBNETS, SecurityGroups: [RUNTIME_SG] },
    });
  });

  test('comes from the orgiq-devbox image and has no session storage', () => {
    assert.match(JSON.stringify(rt.Properties.AgentRuntimeArtifact), /\/orgiq-devbox[:@]/);
    assert.equal(rt.Properties.FilesystemConfigurations, undefined);
  });

  test('idles out after 300 s and lives task timeout + 15 min, rounded up to the hour, capped at 8 h', () => {
    assert.deepEqual(rt.Properties.LifecycleConfiguration, { IdleRuntimeSessionTimeout: 300, MaxLifetime: 3600 });
    assert.equal(microvmMaxLifetime(840), 3600);
    assert.equal(microvmMaxLifetime(2700), 3600);
    assert.equal(microvmMaxLifetime(2701), 7200);
    assert.equal(microvmMaxLifetime(8 * 3600), 8 * 3600);
    assert.throws(() => microvmMaxLifetime(0));
    const long = Template.fromStack(runtimeStack({}, { taskTimeoutSeconds: 3 * 3600 }));
    assert.equal(microvmRuntime(long)[0].Properties.LifecycleConfiguration.MaxLifetime, 4 * 3600);
  });

  test('environment: the private lab origin, the runner marker, no callback secret of any form', () => {
    const env = rt.Properties.EnvironmentVariables;
    assert.equal(env.LAB_API_BASE, 'https://lab.orgiq.internal');
    assert.equal(env.ORGIQ_RUNNER, 'microvm');
    assert.ok(!Object.keys(env).some((k) => k.startsWith('LAB_CALLBACK_SECRET')));
  });

  test('a plaintext lab callback secret is refused', () => {
    assert.throws(() => runtimeStack({}, { labCallbackSecret: 'value' }), /plaintextCallbackSecrets/);
  });

  test('runtime and endpoint ARNs are outputs and SSM parameters', () => {
    const params = Object.values<any>(runtime.findResources('AWS::SSM::Parameter')).map((p) => p.Properties.Name).sort();
    assert.deepEqual(params, ['/orgiq/microvm/endpoint-arn', '/orgiq/microvm/runs-bucket', '/orgiq/microvm/runtime-arn']);
    const outputs = runtime.toJSON().Outputs;
    assert.equal(outputs.MicrovmRuntimeArn.Export.Name, 'orgiq-microvm-runtime-arn');
    assert.equal(outputs.MicrovmEndpointArn.Export.Name, 'orgiq-microvm-endpoint-arn');
  });
});

describe('runs bucket', () => {
  const [bucket] = Object.values<any>(runtime.findResources('AWS::S3::Bucket'));

  test('blocks public access, SSE-S3, 30-day expiry on runs/', () => {
    assert.deepEqual(bucket.Properties.PublicAccessBlockConfiguration, {
      BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true,
    });
    assert.equal(bucket.Properties.BucketEncryption.ServerSideEncryptionConfiguration[0].ServerSideEncryptionByDefault.SSEAlgorithm, 'AES256');
    const [rule] = bucket.Properties.LifecycleConfiguration.Rules;
    assert.deepEqual({ prefix: rule.Prefix, days: rule.ExpirationInDays, status: rule.Status }, { prefix: 'runs/', days: 30, status: 'Enabled' });
  });

  test('refuses non-TLS requests', () => {
    const [policy] = Object.values<any>(runtime.findResources('AWS::S3::BucketPolicy'));
    const deny = policy.Properties.PolicyDocument.Statement.find((s: any) => s.Effect === 'Deny');
    assert.deepEqual(deny.Condition, { Bool: { 'aws:SecureTransport': 'false' } });
  });
});

describe('network (design §5)', () => {
  test('two runtime subnets, two firewall subnets, one NAT gateway', () => {
    const subnets = Object.values<any>(network.findResources('AWS::EC2::Subnet'));
    const named = (n: string) => subnets.filter((s) => s.Properties.Tags.some((t: any) => t.Key === 'aws-cdk:subnet-name' && t.Value === n));
    assert.equal(named('runtime').length, 2);
    assert.equal(named('firewall').length, 2);
    network.resourceCountIs('AWS::EC2::NatGateway', 1);
  });

  test('the runtime subnets default-route only to the firewall endpoint', () => {
    const viaFirewall = Object.entries<any>(network.findResources('AWS::EC2::Route'))
      .filter(([id]) => id.startsWith('RuntimeDefaultViaFirewall'));
    assert.equal(viaFirewall.length, 2);
    for (const [, r] of viaFirewall) {
      assert.equal(r.Properties.DestinationCidrBlock, '0.0.0.0/0');
      assert.ok(r.Properties.VpcEndpointId, 'route target must be the firewall endpoint');
      assert.equal(r.Properties.NatGatewayId ?? r.Properties.GatewayId, undefined);
    }
  });

  test('the Network Firewall SNI allowlist lists exactly the four GitHub names, strict order', () => {
    const groups = Object.values<any>(network.findResources('AWS::NetworkFirewall::RuleGroup'));
    const lists = groups.map((g) => g.Properties.RuleGroup.RulesSource.RulesSourceList).filter(Boolean);
    assert.equal(lists.length, 1);
    assert.deepEqual([...lists[0].Targets].sort(), [...MICROVM_EGRESS_DOMAINS].sort());
    assert.deepEqual(lists[0].Targets.sort(), ['api.github.com', 'codeload.github.com', 'github.com', 'objects.githubusercontent.com']);
    assert.deepEqual(lists[0].TargetTypes, ['TLS_SNI']);
    assert.equal(lists[0].GeneratedRulesType, 'ALLOWLIST');
    for (const g of groups) assert.equal(g.Properties.RuleGroup.StatefulRuleOptions.RuleOrder, 'STRICT_ORDER');
  });

  test('port 80 is dropped and everything unmatched is dropped by default', () => {
    const groups = Object.values<any>(network.findResources('AWS::NetworkFirewall::RuleGroup'));
    const rules = groups.map((g) => g.Properties.RuleGroup.RulesSource.RulesString).filter(Boolean).join('\n');
    assert.match(rules, /^drop tcp \$HOME_NET any -> \$EXTERNAL_NET 80 /m);
    const [policy] = Object.values<any>(network.findResources('AWS::NetworkFirewall::FirewallPolicy'));
    const fp = policy.Properties.FirewallPolicy;
    assert.equal(fp.StatefulEngineOptions.RuleOrder, 'STRICT_ORDER');
    assert.ok(fp.StatefulDefaultActions.includes('aws:drop_established'));
    assert.equal(fp.StatefulRuleGroupReferences.length, 2);
  });

  test('flow and alert logs go to /orgiq/microvm/egress, kept 30 days', () => {
    network.hasResourceProperties('AWS::Logs::LogGroup', { LogGroupName: '/orgiq/microvm/egress', RetentionInDays: 30 });
    const [cfg] = Object.values<any>(network.findResources('AWS::NetworkFirewall::LoggingConfiguration'));
    const types = cfg.Properties.LoggingConfiguration.LogDestinationConfigs.map((d: any) => d.LogType).sort();
    assert.deepEqual(types, ['ALERT', 'FLOW']);
  });

  test('DNS Firewall allows the GitHub names (and the two in-VPC names) and blocks everything else', () => {
    const lists = network.findResources('AWS::Route53Resolver::FirewallDomainList');
    const domainsOf = (id: string) => lists[id].Properties.Domains;
    assert.deepEqual([...domainsOf('DnsAllowGithub')].sort(), [...MICROVM_EGRESS_DOMAINS].sort());
    assert.equal(domainsOf('DnsAllowInVpc')[1], 'lab.orgiq.internal');
    assert.deepEqual(domainsOf('DnsEverything'), ['*']);
    const [group] = Object.values<any>(network.findResources('AWS::Route53Resolver::FirewallRuleGroup'));
    const rules = [...group.Properties.FirewallRules].sort((a: any, b: any) => a.Priority - b.Priority);
    const last = rules[rules.length - 1];
    assert.deepEqual([last.Action, last.BlockResponse, last.FirewallDomainListId], ['BLOCK', 'NXDOMAIN', { 'Fn::GetAtt': ['DnsEverything', 'Id'] }]);
    assert.ok(rules.slice(0, -1).every((r: any) => r.Action === 'ALLOW'));
    network.resourceCountIs('AWS::Route53Resolver::FirewallRuleGroupAssociation', 1);
  });

  test('the runtime security group has no ingress, and egress only 443 to the endpoint SG and 0.0.0.0/0', () => {
    const sgs = network.findResources('AWS::EC2::SecurityGroup');
    const [rtId, rtSg] = Object.entries<any>(sgs).find(([id]) => id.startsWith('RuntimeSecurityGroup'))!;
    assert.equal(rtSg.Properties.SecurityGroupIngress, undefined);
    const ingressToRuntime = Object.values<any>(network.findResources('AWS::EC2::SecurityGroupIngress'))
      .filter((r) => JSON.stringify(r.Properties.GroupId).includes(rtId));
    assert.deepEqual(ingressToRuntime, []);
    const inline = rtSg.Properties.SecurityGroupEgress;
    assert.deepEqual(inline.map((e: any) => [e.CidrIp, e.IpProtocol, e.FromPort, e.ToPort]), [['0.0.0.0/0', 'tcp', 443, 443]]);
    const egress = Object.values<any>(network.findResources('AWS::EC2::SecurityGroupEgress'))
      .filter((r) => JSON.stringify(r.Properties.GroupId).includes(rtId));
    assert.equal(egress.length, 1);
    assert.match(JSON.stringify(egress[0].Properties.DestinationSecurityGroupId), /EndpointSecurityGroup/);
    assert.deepEqual([egress[0].Properties.FromPort, egress[0].Properties.ToPort], [443, 443]);
  });

  test('the bedrock-runtime endpoint has private DNS and a policy naming exactly the role\'s model ARNs', () => {
    const [ep] = Object.values<any>(network.findResources('AWS::EC2::VPCEndpoint'));
    assert.equal(ep.Properties.PrivateDnsEnabled, true);
    assert.match(JSON.stringify(ep.Properties.ServiceName), /bedrock-runtime/);
    const [st] = ep.Properties.PolicyDocument.Statement;
    assert.deepEqual(st.Action, ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream', 'bedrock:CountTokens']);
    const roleInvoke = roleStatements.find((s) => s.Sid === 'BedrockInvokeClaude')!;
    assert.deepEqual(st.Resource, roleInvoke.Resource);
    assert.ok(!JSON.stringify(st.Resource).includes('"*"'));
  });

  test('lab.orgiq.internal is a private zone, with an alias and an SG pair only when the ALB is given', () => {
    network.hasResourceProperties('AWS::Route53::HostedZone', { Name: 'lab.orgiq.internal.' });
    network.resourceCountIs('AWS::Route53::RecordSet', 0);

    const app = newApp();
    const bff = new cdk.Stack(app, 'Bff');
    const vpc = new ec2.Vpc(bff, 'Vpc', { maxAzs: 2, natGateways: 0 });
    const albSg = new ec2.SecurityGroup(bff, 'AlbSg', { vpc, allowAllOutbound: false });
    const alb = new elbv2.ApplicationLoadBalancer(bff, 'Alb', { vpc, securityGroup: albSg });
    const t = Template.fromStack(new MicrovmNetworkStack(app, 'OrgIQ-MicrovmNetwork', { prefix: PREFIX, alb, albSecurityGroup: albSg }));
    t.resourceCountIs('AWS::Route53::RecordSet', 1);
    const toAlb = Object.values<any>(t.findResources('AWS::EC2::SecurityGroupEgress'))
      .filter((r) => JSON.stringify(r.Properties.DestinationSecurityGroupId).includes('ImportValue'));
    assert.equal(toAlb.length, 1);
    const fromRuntime = Object.values<any>(t.findResources('AWS::EC2::SecurityGroupIngress'))
      .filter((r) => JSON.stringify(r.Properties.GroupId).includes('ImportValue'));
    assert.deepEqual(fromRuntime.map((r) => [r.Properties.FromPort, r.Properties.ToPort]), [[443, 443]]);
    assert.throws(() => new MicrovmNetworkStack(newApp(), 'X', { alb }), /together/);
  });
});

describe('middleware task role additions (design §12)', () => {
  const MICROVM_SIDS = ['MicrovmGithubSecrets', 'MicrovmInvokeAndStop', 'MicrovmRunObjects'];
  const RT_ARN = 'arn:aws:bedrock-agentcore:us-east-1:111111111111:runtime/orgiq_microvm-AbCdEf1234';
  const EP_ARN = `${RT_ARN}/runtime-endpoint/orgiq_microvm_endpoint`;
  const sidsOf = (t: Template) => statementsForRole(t, 'orgiq-middleware-task-role').map((s) => s.Sid);

  test('none of the three statement groups, and no MICROVM_ env, without the prop', () => {
    const t = Template.fromStack(middlewareServiceStack());
    assert.deepEqual(sidsOf(t).filter((s) => s?.startsWith('Microvm')), []);
    assert.ok(!JSON.stringify(t.toJSON()).includes('MICROVM_'));
  });

  test('with microvmRuntimeArn: invoke/stop on the runtime and endpoint, the GitHub secrets, runs/ objects, and env', () => {
    const t = Template.fromStack(middlewareServiceStack({ microvmComputeUsdPerSecond: '0.0001' }, {
      microvmRuntimeArn: RT_ARN, microvmEndpointArn: EP_ARN, microvmRunsBucketName: 'orgiq-microvm-runs-x',
    }));
    const st = statementsForRole(t, 'orgiq-middleware-task-role');
    assert.deepEqual(sidsOf(t).filter((s) => s?.startsWith('Microvm')).sort(), MICROVM_SIDS);
    const bySid = (sid: string) => st.find((s) => s.Sid === sid)!;
    assert.deepEqual(actionsOf(bySid('MicrovmInvokeAndStop')), ['bedrock-agentcore:InvokeAgentRuntime', 'bedrock-agentcore:StopRuntimeSession']);
    assert.deepEqual(bySid('MicrovmInvokeAndStop').Resource, [RT_ARN, EP_ARN]);
    assert.deepEqual(actionsOf(bySid('MicrovmGithubSecrets')), ['secretsmanager:GetSecretValue']);
    assert.match(JSON.stringify(bySid('MicrovmGithubSecrets').Resource), /secret:orgiq\/github-app\*".*secret:orgiq\/github-user\/\*"/);
    assert.deepEqual(actionsOf(bySid('MicrovmRunObjects')), ['s3:PutObject', 's3:GetObject']);
    assert.equal(bySid('MicrovmRunObjects').Resource, 'arn:aws:s3:::orgiq-microvm-runs-x/runs/*');
    const env = JSON.stringify(t.toJSON());
    assert.ok(env.includes(`"Name":"MICROVM_RUNTIME_ARN","Value":"${RT_ARN}"`));
    assert.ok(env.includes('"Name":"MICROVM_RUNS_BUCKET","Value":"orgiq-microvm-runs-x"'));
    assert.ok(env.includes('"Name":"MICROVM_COMPUTE_USD_PER_SECOND","Value":"0.0001"'));
  });

  test('the compute rate defaults to 0 and must be a number', () => {
    const props = { microvmRuntimeArn: RT_ARN, microvmEndpointArn: EP_ARN, microvmRunsBucketName: 'b' };
    const t = Template.fromStack(middlewareServiceStack({}, props));
    assert.ok(JSON.stringify(t.toJSON()).includes('"Name":"MICROVM_COMPUTE_USD_PER_SECOND","Value":"0"'));
    assert.throws(() => middlewareServiceStack({ microvmComputeUsdPerSecond: 'cheap' }, props), /non-negative number/);
    assert.throws(() => middlewareServiceStack({}, { microvmRuntimeArn: RT_ARN }), /microvmEndpointArn/);
  });
});
