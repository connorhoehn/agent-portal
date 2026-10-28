/**
 * DE-28 check 1 (docs/deployment-enhancements/DE-28-bug-class-lint.md): no
 * partial secret ARN reaches a task definition or an IAM policy, and no source
 * looks a secret up by a name that ends in six characters after a hyphen.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Template } from 'aws-cdk-lib/assertions';
import { synthApp } from './helpers/app-assembly';
import { libSources, nameLookupFindings, partialSecretArns } from './helpers/secret-arns';

/**
 * scenario → [finding pattern, why]. A debt, not a pass: the test also fails when
 * the finding is gone, so the entry is dropped with the fix. OrgIQ-Social without
 * OrgIQ-SocialMedia falls back to fromSecretNameV2 for the SFU secrets
 * (lib/social-stack.ts); `orgiq-social-sfu-webhook-secret` is the exact failing
 * shape. DE-28 decision owed: remove the fallback.
 */
const EXEMPT_TEMPLATE: Record<string, [RegExp, string][]> = {
  social: [[/^OrgIQ-Social .*:secret:orgiq-social-sfu-(admin-token|webhook-secret|service-token)$/, 'SFU secret name fallback when OrgIQ-SocialMedia is absent']],
};
/** `lib file:call site` → why a dynamic name is acceptable. */
const EXEMPT_SOURCE: Record<string, string> = {
  'lib/social-media-stack.ts': 'TURN TLS certificate: the name is an operator-supplied context value (turnTlsCertSecretName); safe only if it does not end in -xxxxxx',
  'lib/social-stack.ts': 'SFU secret fallback when OrgIQ-SocialMedia is not in the app; the webhook secret name ends -secret (latent). DE-28 decision owed: remove the fallback',
};

const SCENARIOS: Record<string, Record<string, string>> = {
  default: {},
  social: { deploySocial: 'true', sfuAllowCidr: '203.0.113.4/32' },
  'social + media': {
    deploySocial: 'true', deploySocialMedia: 'true', sfuAllowCidr: '203.0.113.4/32',
    socialPlatformHost: 'platform.example.com', socialSfuHost: 'sfu.example.com',
  },
};

describe('no stack renders a partial secret ARN', () => {
  for (const [label, context] of Object.entries(SCENARIOS)) {
    test(label, () => {
      const app = synthApp(context);
      const bad: string[] = [];
      const exempt = EXEMPT_TEMPLATE[label] ?? [];
      const hit = new Set<RegExp>();
      for (const [stack, template] of Object.entries<any>(app.templates)) {
        for (const f of partialSecretArns(template)) {
          const line = `${stack} ${f}`;
          const e = exempt.find(([re]) => re.test(line));
          if (e) hit.add(e[0]); else bad.push(line);
        }
      }
      for (const [re] of exempt) assert.ok(hit.has(re), `exemption ${re} matches nothing any more; drop it`);
      assert.deepEqual(bad, [], `partial secret ARNs (use fromSecretCompleteArn):\n${bad.join('\n')}`);
    });
  }
});

describe('fromSecretNameV2 call sites', () => {
  test('no literal name ends in a six-character hyphen segment; dynamic names are exempted with a reason', () => {
    const root = path.join(__dirname, '..');
    const findings = libSources(root).flatMap((s) => nameLookupFindings(s.source, s.file));
    const bad = findings.filter((f) => f.name !== null || !EXEMPT_SOURCE[f.file]);
    assert.deepEqual(bad, []);
    const live = new Set(findings.map((f) => f.file));
    for (const file of Object.keys(EXEMPT_SOURCE)) assert.ok(live.has(file), `${file} is exempt but has no dynamic fromSecretNameV2 call any more; drop the exemption`);
  });

  test('the source rule finds the original bug and passes a safe name', () => {
    const bug = nameLookupFindings(`secretsmanager.Secret.fromSecretNameV2(this, 'X', 'orgiq-realtime-jwt-secret')`, 'fixture.ts');
    assert.equal(bug.length, 1);
    assert.equal(bug[0]!.name, 'orgiq-realtime-jwt-secret');
    const tpl = nameLookupFindings('Secret.fromSecretNameV2(this, "X", `${prefix}-turn-secret`)', 'fixture.ts');
    assert.equal(tpl.length, 1);
    assert.deepEqual(nameLookupFindings(`Secret.fromSecretNameV2(this, 'X', 'orgiq-realtime-jwt-token')`, 'fixture.ts'), []);
  });
});

describe('the template rule fails the original bug', () => {
  function fixture(complete: boolean): any {
    const stack = new cdk.Stack(new cdk.App(), 'Fixture');
    const secret = complete
      ? secretsmanager.Secret.fromSecretCompleteArn(stack, 'X', 'arn:aws:secretsmanager:us-east-1:111111111111:secret:orgiq-realtime-jwt-secret-AbCdEf')
      : secretsmanager.Secret.fromSecretNameV2(stack, 'X', 'orgiq-realtime-jwt-secret');
    const td = new ecs.FargateTaskDefinition(stack, 'TD');
    td.addContainer('c', {
      image: ecs.ContainerImage.fromRegistry('x'),
      secrets: { JWT: ecs.Secret.fromSecretsManager(secret) },
    });
    void ec2;
    return Template.fromStack(stack).toJSON();
  }
  test('fromSecretNameV2 of orgiq-realtime-jwt-secret in a task definition is flagged', () => {
    const found = partialSecretArns(fixture(false));
    assert.ok(found.some((f) => f.includes('orgiq-realtime-jwt-secret')), JSON.stringify(found));
  });
  test('the complete ARN is not', () => {
    assert.deepEqual(partialSecretArns(fixture(true)), []);
  });
});
