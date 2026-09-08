/**
 * The smaller stacks — guardrails, capabilities, span projector, observability,
 * authorization, authentication. Nothing exotic here; just the handful of
 * properties whose regression would be invisible in the console.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Match, Template } from 'aws-cdk-lib/assertions';
import {
  capabilitiesStack,
  guardrailsStack,
  observabilityStack,
  spanProjectorStack,
} from './helpers/stacks';
import { actionsOf } from './helpers/cfn';

describe('OrgIQ-Guardrails: one guardrail per role, exported under a stable name', () => {
  const template = Template.fromStack(guardrailsStack());
  const roles = ['member', 'org-leader', 'hr-admin'];

  test('all three role guardrails exist', () => {
    const names = Object.values<any>(template.findResources('AWS::Bedrock::Guardrail'))
      .map((g) => g.Properties?.Name)
      .sort();
    assert.deepEqual(names, roles.map((r) => `orgiq-guardrail-${r}`).sort());
  });

  test('each ID is exported as orgiq-guardrail-id-<role>', () => {
    // The supervisor selects one of these per request based on the caller's
    // role; both AgentCoreRuntime and MiddlewareService import them by name.
    for (const role of roles) {
      template.hasOutput('*', { Export: { Name: `orgiq-guardrail-id-${role}` } });
    }
  });

  test('credentials and SSNs are BLOCKed, not anonymised', () => {
    for (const guardrail of Object.values<any>(
      template.findResources('AWS::Bedrock::Guardrail'),
    )) {
      const pii = guardrail.Properties.SensitiveInformationPolicyConfig.PiiEntitiesConfig as any[];
      const byType = new Map(pii.map((p) => [p.Type, p.Action]));
      assert.equal(byType.get('AWS_ACCESS_KEY'), 'BLOCK');
      assert.equal(byType.get('AWS_SECRET_KEY'), 'BLOCK');
      assert.equal(byType.get('US_SOCIAL_SECURITY_NUMBER'), 'BLOCK');
      // EMAIL and PHONE are deliberately absent: directory queries legitimately
      // return colleague contact details, and anonymising them breaks search.
      assert.ok(!byType.has('EMAIL'), 'blocking EMAIL breaks the core search use case');
    }
  });
});

describe('OrgIQ-AgentCoreCapabilities', () => {
  const template = Template.fromStack(capabilitiesStack());

  test('the code interpreter has NO outbound network', () => {
    // It runs model-authored Python. SANDBOX is the difference between a
    // sandbox and an egress path.
    template.hasResourceProperties('AWS::BedrockAgentCore::CodeInterpreterCustom', {
      NetworkConfiguration: { NetworkMode: 'SANDBOX' },
    });
  });

  test('the browser is PUBLIC, because web research needs the internet', () => {
    template.hasResourceProperties('AWS::BedrockAgentCore::BrowserCustom', {
      NetworkConfiguration: { NetworkMode: 'PUBLIC' },
    });
  });

  test('the capability ids are exported — middleware/.env.aws is regenerated from these', () => {
    // These ids are minted fresh on every rebuild of this stack. A stale
    // BROWSER_ID fails *soft*: site-survey's browser fallback becomes
    // indistinguishable from "this site has no JavaScript-only pages".
    for (const name of [
      'orgiq-code-interpreter-id',
      'orgiq-code-interpreter-arn',
      'orgiq-browser-id',
      'orgiq-browser-arn',
      'orgiq-browser-profile-id',
    ]) {
      template.hasOutput('*', { Export: { Name: name } });
    }
  });

  test('the workload identity does not accept an arbitrary OAuth2 return URL', () => {
    const identity = Object.values<any>(
      template.findResources('AWS::BedrockAgentCore::WorkloadIdentity'),
    )[0];
    const urls: string[] = identity.Properties.AllowedResourceOauth2ReturnUrls;
    assert.ok(urls.length > 0);
    for (const url of urls) {
      assert.ok(!url.includes('*'), 'a wildcard return URL is an open redirect for token exchange');
    }
  });
});

describe('OrgIQ-SpanProjector', () => {
  const template = Template.fromStack(spanProjectorStack());

  test('polls every minute — EventBridge cannot go finer', () => {
    template.hasResourceProperties('AWS::Events::Rule', {
      ScheduleExpression: 'rate(1 minute)',
    });
  });

  test('Aurora access is scoped to the one cluster, not *', () => {
    const statements = Object.values<any>(template.findResources('AWS::IAM::Policy')).flatMap(
      (p) => (p.Properties?.PolicyDocument?.Statement ?? []) as any[],
    );
    const rdsData = statements.filter((s) => actionsOf(s).includes('rds-data:ExecuteStatement'));
    assert.ok(rdsData.length > 0);
    for (const s of rdsData) {
      assert.ok(!JSON.stringify(s.Resource).includes('"*"'), 'rds-data must be cluster-scoped');
    }
  });

  test('the poll cursor is a durable SSM parameter, not in-memory state', () => {
    // Span projection is idempotent but not free — losing the high-water mark
    // means re-querying the whole window on every cold start.
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/orgiq/span-projector/cursor',
    });
  });
});

describe('OrgIQ-Observability', () => {
  const template = Template.fromStack(observabilityStack());

  test('there is a monthly budget with a notification — OpenSearch/Aurora bill while idle', () => {
    template.hasResourceProperties('AWS::Budgets::Budget', {
      Budget: Match.objectLike({ BudgetType: 'COST', TimeUnit: 'MONTHLY' }),
      NotificationsWithSubscribers: Match.anyValue(),
    });
  });

  test('the Aurora ACU alarm is wired to the alert topic', () => {
    const alarms = Object.values<any>(template.findResources('AWS::CloudWatch::Alarm'));
    assert.ok(alarms.length >= 2, 'expected the ACU and Bedrock throttle alarms');
    for (const alarm of alarms) {
      assert.ok(
        (alarm.Properties.AlarmActions ?? []).length > 0,
        'an alarm with no action is a dashboard decoration',
      );
    }
  });
});
