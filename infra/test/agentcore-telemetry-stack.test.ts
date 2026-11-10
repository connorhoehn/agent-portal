/**
 * OrgIQ-AgentCoreTelemetry — online evaluation needs BOTH gates, and the
 * config resource has hard service-side limits that CFN rejects at create.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Template } from 'aws-cdk-lib/assertions';
import { telemetryStack } from './helpers/stacks';

const ONLINE_EVAL = 'AWS::BedrockAgentCore::OnlineEvaluationConfig';

const off = Template.fromStack(telemetryStack());
const evalOnly = Template.fromStack(telemetryStack({ enableEval: 'true' }));
const full = Template.fromStack(
  telemetryStack({ enableEval: 'true', enableOnlineEvalConfig: 'true' }),
);

describe('online evaluation is behind two gates, not one', () => {
  test('nothing eval-shaped by default', () => {
    off.resourceCountIs(ONLINE_EVAL, 0);
  });

  test('enableEval alone creates the evaluators but NOT the online config', () => {
    // The config must not be created before agents are running: it reads
    // aws/spans, which X-Ray only creates once traffic exists, and its
    // execution role must be able to create the results log group.
    assert.ok(Object.keys(evalOnly.findResources('AWS::BedrockAgentCore::Evaluator')).length >= 2);
    evalOnly.resourceCountIs(ONLINE_EVAL, 0);
  });

  test('both gates together create exactly one online evaluation config', () => {
    full.resourceCountIs(ONLINE_EVAL, 1);
  });
});

describe('the online evaluation config respects the service limits', () => {
  const config = () => Object.values<any>(full.findResources(ONLINE_EVAL))[0].Properties;

  test('ExecutionStatus is ENABLED — otherwise the config is created and silently does nothing', () => {
    assert.equal(config().ExecutionStatus, 'ENABLED');
  });

  test('ServiceNames is present and holds at most one entry', () => {
    // Required since the 2026-08 resource schema; CFN early validation rejects
    // the resource without it. Limit is 1.
    const serviceNames = config().DataSourceConfig.CloudWatchLogs.ServiceNames;
    assert.ok(Array.isArray(serviceNames) && serviceNames.length === 1, 'ServiceNames limit is 1');
    assert.equal(serviceNames[0], 'orgiq-supervisor');
  });

  test('at most 5 log groups', () => {
    const groups = config().DataSourceConfig.CloudWatchLogs.LogGroupNames;
    assert.ok(groups.length <= 5, `LogGroupNames limit is 5, got ${groups.length}`);
  });

  test('the sampled service name matches the OTEL_SERVICE_NAME the supervisor emits', () => {
    // agentcore-runtime-stack sets OTEL_SERVICE_NAME=orgiq-<agent>. If these
    // diverge, the config samples a service that never appears in aws/spans
    // and evaluation produces nothing, with no error.
    assert.equal(config().DataSourceConfig.CloudWatchLogs.ServiceNames[0], 'orgiq-supervisor');
  });

  test('the log groups are created before the config references them', () => {
    const [, resource] = Object.entries(full.findResources(ONLINE_EVAL))[0]!;
    const deps = resource.DependsOn ?? [];
    assert.ok(
      (Array.isArray(deps) ? deps : [deps]).length > 0,
      'the config must depend on the LogRetention resources that pre-create its log groups',
    );
  });
});

describe('the evaluation execution role', () => {
  test('can create AND write its own results log group', () => {
    // CreateOnlineEvaluationConfig 400s without these — the eval control plane
    // creates /aws/bedrock-agentcore/evaluations/results/<config-id> as this role.
    const statements = Object.values<any>(full.findResources('AWS::IAM::Role'))
      .filter((r) => r.Properties?.RoleName === 'orgiq-eval-execution-role')
      .flatMap((r) => (r.Properties.Policies ?? []) as any[])
      .flatMap((p) => (p.PolicyDocument?.Statement ?? []) as any[]);
    const results = statements.find((s) => s.Sid === 'EvaluationResultsWrite');
    assert.ok(results, 'missing EvaluationResultsWrite');
    for (const action of ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents']) {
      assert.ok(
        (Array.isArray(results.Action) ? results.Action : [results.Action]).includes(action),
        `missing ${action}`,
      );
    }
  });
});

describe('X-Ray transaction search', () => {
  test('bedrock-agentcore may write trace segments, scoped to this account', () => {
    const policies = Object.values<any>(off.findResources('AWS::XRay::ResourcePolicy'));
    assert.equal(policies.length, 1);
    // The document interpolates the account id, so it synthesises as an
    // Fn::Join rather than a plain string — read it as flattened text.
    const doc = JSON.stringify(policies[0].Properties.PolicyDocument);
    assert.match(doc, /bedrock-agentcore\.amazonaws\.com/);
    assert.match(doc, /xray:PutTraceSegments/);
    assert.match(doc, /aws:SourceAccount/, 'the resource policy must be account-scoped');
  });
});

describe('X-Ray Transaction Search indexing (sweep 12, U3)', () => {
  const SEARCH = 'AWS::XRay::TransactionSearchConfig';

  test('unset, the stack leaves the account-wide setting alone', () => {
    off.resourceCountIs(SEARCH, 0);
  });

  test('xrayIndexingPercent sets the indexing share, after the log policy X-Ray writes spans under', () => {
    const t = Template.fromStack(telemetryStack({ xrayIndexingPercent: '100' }));
    t.resourceCountIs(SEARCH, 1);
    const search = Object.values<any>(t.findResources(SEARCH))[0];
    assert.equal(search.Properties.IndexingPercentage, 100);
    const policies = t.findResources('AWS::Logs::ResourcePolicy');
    const policyIds = Object.keys(policies).filter((k) => JSON.stringify(policies[k].Properties.PolicyDocument).includes('xray.amazonaws.com'));
    assert.equal(policyIds.length, 1);
    assert.ok((search.DependsOn ?? []).includes(policyIds[0]), 'Transaction Search is enabled only after X-Ray may write aws/spans');
    const doc = JSON.stringify(policies[policyIds[0]!].Properties.PolicyDocument);
    assert.match(doc, /aws\/spans/);
    assert.match(doc, /aws:SourceAccount/, 'the log policy must be account-scoped');
  });

  test('a value outside 1 to 100 fails the synth', () => {
    for (const bad of ['0', '101', 'all', '-5']) {
      assert.throws(() => telemetryStack({ xrayIndexingPercent: bad }), /xrayIndexingPercent/);
    }
  });
});
