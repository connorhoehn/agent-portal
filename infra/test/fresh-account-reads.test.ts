/**
 * A fresh account (nothing live) deploys with no hand-ordered step.
 *
 * The 2026-11 rebuild of 647757222309 after aws-nuke hit a cycle: the Social
 * stacks import exports OrgIQ-MiddlewareService has only when it is
 * synthesized with the social flags, but with those flags the middleware (and
 * OrgIQ-Social) resolved SSM parameters by name that only OrgIQ-Social /
 * OrgIQ-Portal write, and CloudFormation failed "Unable to fetch parameters
 * [/orgiq/portal/platform-api-url,/orgiq/portal/video-url,/orgiq/social/redis-url]
 * from parameter store". Each read is now gated on a producer-live flag that
 * deploy.sh infers from the account (socialLive, portalPlatformApiUrlLive,
 * portalVideoUrlLive), so the social flags can be carried from the first
 * middleware deploy and the live account's inferred flags give its template.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { middlewareServiceStack } from './helpers/stacks';
import { exportedNames, importedExportNames, synthApp } from './helpers/app-assembly';

const REDIS = '/orgiq/social/redis-url';
const PLATFORM = '/orgiq/portal/platform-api-url';
const VIDEO = '/orgiq/portal/video-url';

// What deploy.sh passes and infers between "the middleware + portal exist" and
// "OrgIQ-Social exists": the orchestrator's social flags, the portal inferred.
const FRESH = {
  deploySocial: 'true', deploySocialMedia: 'true', deployPortal: 'true', allowHttpOrigin: 'true', portalPublicUrls: 'true',
  deployMiddlewareService: 'true', sfuAllowCidr: '203.0.113.4/32',
};
// What deploy.sh infers once each producer has written its parameter.
const LIVE = { socialLive: 'true', portalPlatformApiUrlLive: 'true', portalVideoUrlLive: 'true' };

const reads = (tpl: unknown) => [REDIS, PLATFORM, VIDEO].filter((name) => JSON.stringify(tpl).includes(name));
const middlewareSecrets = (t: Template) => {
  const td = Object.values<any>(t.findResources('AWS::ECS::TaskDefinition'))[0];
  const c = td.Properties.ContainerDefinitions.find((x: any) => x.Name === 'middleware');
  return Object.fromEntries(((c.Secrets ?? []) as any[]).map((s) => [s.Name, s.ValueFrom]));
};

describe('fresh account: no stack reads a parameter before its producer is live', () => {
  test('(a) the middleware with the social context but no live flags reads none of the three parameters', () => {
    for (const extra of [{}, { realtimeGateway: 'true' }] as Array<Record<string, string>>) {
      const app = synthApp({ ...FRESH, ...extra });
      assert.deepEqual(reads(app.templates['OrgIQ-MiddlewareService']), [], JSON.stringify(extra));
      const secrets = middlewareSecrets(app.template('OrgIQ-MiddlewareService'));
      for (const k of ['REDIS_URL', 'REALTIME_PLATFORM_PUBLIC_URL', 'REALTIME_VIDEO_PUBLIC_URL']) assert.equal(secrets[k], undefined, k);
      // The portal URL it does read exists: OrgIQ-Portal wrote it (portalPublicUrls is inferred from it).
      assert.ok(secrets.PUBLIC_BASE_URL);
    }
  });

  test('(a) …and still carries every export OrgIQ-SocialMedia / OrgIQ-Social import (cycle A)', () => {
    const app = synthApp(FRESH);
    const mwExports = exportedNames(app.templates['OrgIQ-MiddlewareService']);
    for (const consumer of ['OrgIQ-SocialMedia', 'OrgIQ-Social']) {
      const imports = [...importedExportNames(app.templates[consumer])];
      assert.ok(imports.some((n) => n.startsWith('OrgIQ-MiddlewareService:ExportsOutput')), `${consumer} imports the middleware's VPC/listener`);
      for (const imp of imports.filter((n) => n.startsWith('OrgIQ-MiddlewareService:'))) {
        assert.ok(mwExports.has(imp), `${consumer} imports ${imp}, which the fresh middleware does not export`);
      }
    }
  });

  test('(a) OrgIQ-Social does not read /portal/video-url until OrgIQ-Portal has written it', () => {
    const app = synthApp(FRESH);
    assert.ok(!JSON.stringify(app.templates['OrgIQ-Social']).includes(VIDEO), 'Social reads the video URL before the portal wrote it');
    // The portal URL (lobby authority) is still read: portalPublicUrls means it exists.
    assert.ok(JSON.stringify(app.templates['OrgIQ-Social']).includes('/orgiq/portal/url'));
    const live = synthApp({ ...FRESH, portalVideoUrlLive: 'true' });
    assert.ok(JSON.stringify(live.templates['OrgIQ-Social']).includes(VIDEO), 'with the producer live it reads it as before');
  });

  test('(b) with the live flags the middleware reads all three as container secrets, as before', () => {
    const app = synthApp({ ...FRESH, ...LIVE, realtimeGateway: 'true' });
    assert.deepEqual(reads(app.templates['OrgIQ-MiddlewareService']), [REDIS, PLATFORM, VIDEO]);
    const secrets = middlewareSecrets(app.template('OrgIQ-MiddlewareService'));
    assert.match(JSON.stringify(secrets.REDIS_URL), /parameter\/orgiq\/social\/redis-url/);
    assert.ok(secrets.REALTIME_PLATFORM_PUBLIC_URL);
    assert.ok(secrets.REALTIME_VIDEO_PUBLIC_URL);
    // Each flag gates only its own parameter.
    assert.deepEqual(reads(synthApp({ ...FRESH, socialLive: 'true', realtimeGateway: 'true' }).templates['OrgIQ-MiddlewareService']), [REDIS]);
    assert.deepEqual(reads(synthApp({ ...FRESH, portalPlatformApiUrlLive: 'true' }).templates['OrgIQ-MiddlewareService']), [PLATFORM]);
    assert.deepEqual(reads(synthApp({ ...FRESH, portalVideoUrlLive: 'true' }).templates['OrgIQ-MiddlewareService']), [VIDEO]);
  });

  test('a live flag without its social flag reads nothing (the flag says the producer exists, not that this app uses it)', () => {
    assert.deepEqual(reads(Template.fromStack(middlewareServiceStack({ ...LIVE, portalPublicUrls: 'true', realtimeGateway: 'true' })).toJSON()), []);
  });
});

describe('(c) autoscaling does not default on before OrgIQ-Social is live', () => {
  test('deploySocial alone: one task, no REDIS_URL; with socialLive: 1→4 on the Social Redis', () => {
    const before = Template.fromStack(middlewareServiceStack({ deploySocial: 'true' }));
    before.resourceCountIs('AWS::ApplicationAutoScaling::ScalableTarget', 0);
    assert.equal(middlewareSecrets(before).REDIS_URL, undefined);
    assert.ok(!JSON.stringify(before.toJSON()).includes(REDIS));

    const after = Template.fromStack(middlewareServiceStack({ deploySocial: 'true', socialLive: 'true' }));
    after.resourceCountIs('AWS::ApplicationAutoScaling::ScalableTarget', 1);
    assert.match(JSON.stringify(middlewareSecrets(after).REDIS_URL), /social\/redis-url/);
  });

  test('asking for autoscale before Social is live is refused (no Redis yet), naming socialLive', () => {
    assert.throws(() => middlewareServiceStack({ deploySocial: 'true', middlewareAutoscale: 'true' }), /socialLive/);
  });

  test('the gateway before Social is live warns that REDIS_URL waits for socialLive', () => {
    const stack = middlewareServiceStack({ deploySocial: 'true', realtimeGateway: 'true' });
    Annotations.fromStack(stack).hasWarning('*', Match.stringLikeRegexp('without socialLive=true'));
    Annotations.fromStack(middlewareServiceStack({ deploySocial: 'true', socialLive: 'true', realtimeGateway: 'true' }))
      .hasNoWarning('*', Match.stringLikeRegexp('without socialLive=true'));
  });
});
