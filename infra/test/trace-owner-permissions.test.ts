/**
 * Scoped X-Ray reads need the agents' owner annotations, and both ends hold
 * the permissions that path uses (leftovers 2, 10 November).
 *
 * The agents tag every span with the verified caller's `user_id` / `tenant`
 * (agents/_shared/trace_owner.py), listed in `aws.xray.annotations` so X-Ray
 * indexes them. Annotations ride inside the segment document, so writing them
 * needs nothing beyond `xray:PutTraceSegments` (and the telemetry put) on each
 * runtime's execution role; there is no separate annotation or indexing
 * action. The middleware reads them back with a filter expression on
 * GetTraceSummaries, then BatchGetTraces.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Template } from 'aws-cdk-lib/assertions';
import { middlewareServiceStack, runtimeStack } from './helpers/stacks';
import { actionsOf, statementsForRole } from './helpers/cfn';

const AGENTS = ['supervisor', 'search', 'scoring', 'advisor', 'ingestion', 'graph-builder', 'assessment-scorer', 'assessment-drafter'];
const runtime = Template.fromStack(runtimeStack({ deployRuntimes: 'true' }).runtime);

describe('the agents can write annotated segments', () => {
  for (const agent of AGENTS) {
    test(`orgiq-${agent}-execution-role puts trace segments`, () => {
      const granted = new Set(statementsForRole(runtime, `orgiq-${agent}-execution-role`).flatMap(actionsOf));
      assert.ok(granted.has('xray:PutTraceSegments'), 'missing xray:PutTraceSegments: annotated spans never reach X-Ray');
      assert.ok(granted.has('xray:PutTelemetryRecords'), 'missing xray:PutTelemetryRecords');
    });
  }
});

describe('the middleware can read them back with a filter', () => {
  test('its task role may GetTraceSummaries and BatchGetTraces', () => {
    const t = Template.fromStack(middlewareServiceStack({ deployMiddlewareService: 'true' }));
    const statements = Object.values<any>(t.findResources('AWS::IAM::Policy'))
      .flatMap((p) => (p.Properties?.PolicyDocument?.Statement ?? []) as any[]);
    const granted = new Set(statements.flatMap((s) => actionsOf(s)));
    assert.ok(granted.has('xray:GetTraceSummaries'), 'missing xray:GetTraceSummaries');
    assert.ok(granted.has('xray:BatchGetTraces'), 'missing xray:BatchGetTraces');
  });
});
