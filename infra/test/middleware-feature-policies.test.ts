/**
 * The middleware task role never spills into a CDK overflow policy.
 *
 * Its default inline policy sits near IAM's size limit. Past it, CDK moves
 * statements into `OverflowPolicy<n>` managed policies, which it creates in an
 * aspect after lib/nag.ts has applied the path-scoped suppressions, so every
 * wildcard in them fails the synth as an unsuppressed AwsSolutions-IAM5. That
 * is how `-c microvm=true` broke `cdk synth` against the real account. Each
 * opt-in feature's grants therefore live in a managed policy of their own
 * (`*TaskPolicy`, lib/middleware-service-stack.ts `featurePolicy`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { synthApp } from './helpers/app-assembly';

const EVERY_FEATURE = {
  deployRuntimes: 'true', deployDevbox: 'true', deployCanary: 'true', deployMiddlewareService: 'true',
  deploySocial: 'true', deploySocialMedia: 'true', sfuAllowCidr: '203.0.113.4/32', realtimeGateway: 'true',
  microvm: 'true', voice: 'true', interviews: 'true', meetingAssistant: 'true',
  deployPortal: 'true', certificateArn: 'arn:aws:acm:us-east-1:647757222309:certificate/nag',
  portalAlbOriginHost: 'mw.example.com',
};

const middlewareTemplate = () => {
  const app = synthApp(EVERY_FEATURE);
  const name = app.stackNames.find((n) => n.endsWith('-MiddlewareService'));
  assert.ok(name, 'the app produced no MiddlewareService stack');
  return app.templates[name];
};

test('with every feature on, the task role has no overflow policy', () => {
  const resources = Object.keys(middlewareTemplate().Resources);
  assert.deepEqual(resources.filter((id) => /OverflowPolicy/.test(id)), []);
});

test('each feature that grants the task role does so through its own managed policy', () => {
  const managed = Object.entries<any>(middlewareTemplate().Resources)
    .filter(([, r]) => r.Type === 'AWS::IAM::ManagedPolicy')
    .map(([id]) => id.replace(/[0-9A-F]{8}$/, ''));
  for (const feature of ['MicrovmTaskPolicy', 'InterviewsTaskPolicy', 'MeetingAssistantTaskPolicy']) {
    assert.ok(managed.includes(feature), `no ${feature} (found ${managed.join(', ')})`);
  }
});

test('the default inline policy keeps headroom under the 10,240-character role limit', () => {
  const t = middlewareTemplate();
  const inline = Object.entries<any>(t.Resources)
    .filter(([id, r]) => r.Type === 'AWS::IAM::Policy' && /MiddlewareTaskRoleDefaultPolicy/.test(id))
    .map(([, r]) => JSON.stringify(r.Properties.PolicyDocument).length);
  assert.equal(inline.length, 1);
  assert.ok(inline[0]! < 9500, `default policy is ${inline[0]} characters`);
});
