/**
 * Every service trust policy names this account and a source ARN
 * (docs/next-steps.md §7: "Service trust policies lack aws:SourceAccount and
 * aws:SourceArn conditions").
 *
 * Without them any resource of that service, in any account, that is handed
 * the role's ARN can act as the role: the confused deputy. lib/service-trust.ts
 * builds the conditioned principal; this test holds the whole app to it.
 *
 * Exempt, because the service does not send the keys and the condition would
 * stop the workload: Lambda execution roles, EC2 instance roles and ECS task
 * EXECUTION roles (assumed by the ECS agent to pull images and read secrets;
 * the task roles the code runs as are covered). See SECURITY-NOTES.md.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { synthApp } from './helpers/app-assembly';
import { SERVICES_WITHOUT_SOURCE_CONDITIONS } from '../lib/service-trust';

const EVERYTHING = {
  deployRuntimes: 'true', deployDevbox: 'true', deployCanary: 'true', deployMiddlewareService: 'true',
  deploySocial: 'true', deploySocialMedia: 'true', sfuAllowCidr: '203.0.113.4/32',
};

const EXEMPT = new Set<string>(SERVICES_WITHOUT_SOURCE_CONDITIONS);
const isEcsExecutionRole = (id: string, role: any) =>
  /ExecutionRole/.test(id) && JSON.stringify(role.Properties?.ManagedPolicyArns ?? []).includes('AmazonECSTaskExecutionRolePolicy')
  || /TaskDefExecutionRole/.test(id);

describe('service trust policies carry aws:SourceAccount and aws:SourceArn', () => {
  const app = synthApp(EVERYTHING);

  test('every non-exempt service principal, in every stack', () => {
    const bad: string[] = [];
    let checked = 0;
    for (const [stack, t] of Object.entries(app.templates)) {
      for (const [id, role] of Object.entries<any>(t.Resources ?? {})) {
        if (role.Type !== 'AWS::IAM::Role') continue;
        for (const st of role.Properties.AssumeRolePolicyDocument.Statement as any[]) {
          const services = [].concat(st.Principal?.Service ?? []) as string[];
          for (const svc of services) {
            if (EXEMPT.has(svc)) continue;
            if (svc === 'ecs-tasks.amazonaws.com' && isEcsExecutionRole(id, role)) continue;
            checked += 1;
            const account = st.Condition?.StringEquals?.['aws:SourceAccount'];
            const arn = st.Condition?.ArnLike?.['aws:SourceArn'];
            if (!account || !arn) bad.push(`${stack}/${id} (${svc})`);
          }
        }
      }
    }
    assert.ok(checked >= 15, `expected to check the AgentCore, Bedrock, ECS, Step Functions and Scheduler roles, checked ${checked}`);
    assert.deepEqual(bad, []);
  });

  test('the knowledge base role only trusts this account\'s knowledge bases', () => {
    const kb = Object.values<any>(app.templates['OrgIQ-KnowledgeBase'].Resources)
      .find((r) => r.Properties?.RoleName === 'orgiq-kb-service-role');
    const st = kb.Properties.AssumeRolePolicyDocument.Statement[0];
    assert.match(JSON.stringify(st.Condition.ArnLike['aws:SourceArn']), /knowledge-base\/\*/);
  });
});
