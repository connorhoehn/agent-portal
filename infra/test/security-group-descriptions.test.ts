/**
 * EC2 refuses a security group (or rule) description outside a narrow
 * character set, and it only says so at CREATE time: OrgIQ-MiddlewareService
 * failed its first `deployPortal=true` deploy on "CloudFront origin-facing
 * prefix list -> middleware ALB" because of the `>`. Nothing offline caught
 * it, so check every literal description in every stack of the full app.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { synthApp } from './helpers/app-assembly';

// https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_CreateSecurityGroup.html
const ALLOWED = /^[a-zA-Z0-9. _\-:/()#,@[\]+=&;{}!$*]*$/;

const SCENARIOS: Record<string, Record<string, string>> = {
  default: {},
  full: {
    deployPortal: 'true', deploySocial: 'true', deploySocialMedia: 'true', realtimeGateway: 'true',
    deployMiddlewareService: 'true', deploySocialService: 'true',
    platformApiImageDigest: `sha256:${'0'.repeat(64)}`, sfuImageDigest: `sha256:${'0'.repeat(64)}`,
    albAllowCidr: '203.0.113.4/32', sfuAllowCidr: '203.0.113.4/32',
  },
};

function descriptions(templates: Record<string, any>): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [stack, template] of Object.entries(templates)) {
    for (const [id, resource] of Object.entries<any>(template.Resources ?? {})) {
      const p = resource.Properties ?? {};
      const at = `${stack}/${id}`;
      if (resource.Type === 'AWS::EC2::SecurityGroup') {
        out.push([at, p.GroupDescription]);
        for (const rule of [...(p.SecurityGroupIngress ?? []), ...(p.SecurityGroupEgress ?? [])]) {
          out.push([`${at} rule`, rule.Description]);
        }
      }
      if (resource.Type === 'AWS::EC2::SecurityGroupIngress' || resource.Type === 'AWS::EC2::SecurityGroupEgress') {
        out.push([at, p.Description]);
      }
    }
  }
  return out.filter(([, d]) => typeof d === 'string');
}

for (const [name, context] of Object.entries(SCENARIOS)) {
  test(`every security group description is one EC2 accepts (${name} app)`, () => {
    const found = descriptions(synthApp(context).templates);
    assert.ok(found.length > 0, 'no security group descriptions found — the scan is not looking');
    const bad = found.filter(([, d]) => d.length >= 256 || !ALLOWED.test(d));
    assert.deepEqual(bad, [], `EC2 would reject: ${bad.map(([at, d]) => `${at}: "${d}"`).join('; ')}`);
  });
}
