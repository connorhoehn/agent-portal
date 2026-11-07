/**
 * OrgIQ-Portal (lib/portal-stack.ts) and the ALB side of the CloudFront path
 * on OrgIQ-MiddlewareService and OrgIQ-Social (docs/social-calls-deploy-plan.md §10).
 *
 * Each assertion is a way the no-domain HTTPS path fails while every stack
 * reads healthy: a CloudFront error page swallowing an API 404, a prefix list
 * that lets anyone's distribution past `albAllowCidr`, a bucket emptier the
 * custodian can disarm, a platform-api rule that loses to the middleware's
 * catch-all, and a default synth that quietly changed.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Match, Template } from 'aws-cdk-lib/assertions';
import {
  CLOUDFRONT_RULE_PRIORITY, DOCUMENT_PATHS, MIDDLEWARE_PATHS, ORIGIN_ROUTE_HEADER, ORIGIN_VERIFY_HEADER, portalParameterNames,
} from '../lib/portal-stack';
import { middlewareServiceStack } from './helpers/stacks';
import { exportedNames, importedExportNames, synthApp } from './helpers/app-assembly';

const CACHING_DISABLED = '4135ea2d-6df8-44a3-9df3-4b5a84be39ad';
const ALL_VIEWER_AND_CLOUDFRONT = '33f36d7e-f396-46d9-90e0-52428a34d9dc';
const PORTAL_URL = 'https://d111abcdef8.cloudfront.net';

const FULL = {
  deployPortal: 'true', allowHttpOrigin: 'true', deploySocial: 'true', deploySocialMedia: 'true', realtimeGateway: 'true',
  deployMiddlewareService: 'true', sfuAllowCidr: '203.0.113.4/32',
  albAllowCidr: '203.0.113.4/32,198.51.100.1/32,198.51.100.2/32,198.51.100.3/32,198.51.100.4/32,198.51.100.5/32',
};

const container = (t: Template) => {
  const td = Object.values<any>(t.findResources('AWS::ECS::TaskDefinition'))
    .find((d) => d.Properties.ContainerDefinitions.some((c: any) => c.Name === 'middleware'));
  return td.Properties.ContainerDefinitions.find((c: any) => c.Name === 'middleware');
};
const envOf = (c: any, name: string) => (c.Environment as any[]).find((e) => e.Name === name)?.Value;
const secretOf = (c: any, name: string) => (c.Secrets as any[] | undefined)?.find((s) => s.Name === name);
/** Prefix-list ingress, inline or as its own resource (a token id renders separately). */
const prefixListIngress = (t: Template): any[] => {
  const out: any[] = [];
  for (const sg of Object.values<any>(t.findResources('AWS::EC2::SecurityGroup'))) {
    for (const r of sg.Properties.SecurityGroupIngress ?? []) if (r.SourcePrefixListId) out.push(r);
  }
  for (const r of Object.values<any>(t.findResources('AWS::EC2::SecurityGroupIngress'))) {
    if (r.Properties.SourcePrefixListId) out.push(r.Properties);
  }
  return out;
};
const rules = (t: Template) => Object.values<any>(t.findResources('AWS::ElasticLoadBalancingV2::ListenerRule'))
  .map((r) => r.Properties);

// ── Nothing changes unless asked ────────────────────────────────────────────

describe('the CloudFront path is opt-in', () => {
  const app = synthApp();

  test('the default app has no OrgIQ-Portal, no CloudFront, no origin secret, no MIDDLEWARE_URL', () => {
    assert.ok(!app.has('OrgIQ-Portal'));
    for (const [name, tpl] of Object.entries<any>(app.templates)) {
      const json = JSON.stringify(tpl);
      assert.ok(!json.includes('AWS::CloudFront::'), `${name} has CloudFront by default`);
      assert.ok(!json.includes('cloudfront-origin-secret'), `${name} names the origin secret by default`);
      assert.ok(!json.includes('"MIDDLEWARE_URL"'), `${name} sets MIDDLEWARE_URL by default`);
      assert.ok(!json.includes('/portal/'), `${name} reads a portal parameter by default`);
    }
  });

  test('the default middleware keeps one trusted hop, a forwarding listener and no listener rules', () => {
    const mw = app.template('OrgIQ-MiddlewareService');
    assert.equal(envOf(container(mw), 'TRUST_PROXY_HOPS'), '1');
    assert.deepEqual(rules(mw), []);
    const listener = Object.values<any>(mw.findResources('AWS::ElasticLoadBalancingV2::Listener'))[0];
    assert.equal(listener.Properties.DefaultActions[0].Type, 'forward');
  });

  test('every template is identical with the new flags stated off', () => {
    const off = synthApp({ deployPortal: 'false', portalPublicUrls: 'false' });
    assert.deepEqual(off.stackNames, app.stackNames);
    for (const name of app.stackNames) {
      assert.deepEqual(off.templates[name], app.templates[name], `${name} changed with the portal flags off`);
    }
  });

  test('the social stacks are identical with and without the portal code when deployPortal is off', () => {
    // Host rules keep their logical ids and priorities; no header rule appears.
    const social = synthApp({
      deploySocial: 'true', deploySocialMedia: 'true', sfuAllowCidr: '203.0.113.4/32',
      socialPlatformHost: 'platform.example.com', socialSfuHost: 'sfu.example.com',
    }).template('OrgIQ-Social');
    const priorities = rules(social).map((r) => r.Priority).sort();
    assert.deepEqual(priorities, [30, 40]);
    assert.ok(!JSON.stringify(social.toJSON()).includes(ORIGIN_VERIFY_HEADER));
  });
});

// ── OrgIQ-Portal ────────────────────────────────────────────────────────────

describe('OrgIQ-Portal', () => {
  const app = synthApp(FULL);
  const t = app.template('OrgIQ-Portal');
  const dists = () => Object.values<any>(t.findResources('AWS::CloudFront::Distribution'))
    .map((d) => d.Properties.DistributionConfig);
  const portal = () => dists().find((d) => d.DefaultRootObject === 'index.html');

  test('is in the app with deployPortal=true, after the middleware', () => {
    assert.ok(app.has('OrgIQ-Portal'));
  });

  test('the bucket is private and empties itself on destroy WITHOUT autoDeleteObjects', () => {
    t.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true,
      },
    });
    t.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Delete' });
    // The stock provider's grant lives in a bucket policy the custodian strips.
    assert.deepEqual(Object.keys(t.findResources('Custom::S3AutoDeleteObjects')), []);
    t.resourceCountIs('Custom::EmptyBucketOnDestroy', 1);
  });

  test('CloudFront reads the bucket through OAC, conditioned on this distribution', () => {
    t.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
    t.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([Match.objectLike({
          Principal: { Service: 'cloudfront.amazonaws.com' },
          Condition: { StringEquals: { 'AWS:SourceArn': Match.anyValue() } },
        })]),
      },
    });
  });

  test('the middleware and document-socket paths go to the ALB, uncached, every method, every viewer header', () => {
    const d = portal();
    const paths = d.CacheBehaviors.map((b: any) => b.PathPattern);
    assert.deepEqual(paths, [...MIDDLEWARE_PATHS, ...DOCUMENT_PATHS]);
    for (const b of d.CacheBehaviors) {
      assert.equal(b.CachePolicyId, CACHING_DISABLED, `${b.PathPattern} is cached`);
      assert.equal(b.OriginRequestPolicyId, ALL_VIEWER_AND_CLOUDFRONT, `${b.PathPattern} drops viewer headers`);
      assert.ok(b.AllowedMethods.includes('POST') && b.AllowedMethods.includes('DELETE'));
      assert.equal(b.ViewerProtocolPolicy, 'https-only');
    }
  });

  test('SPA fallback is a viewer-request function on the S3 behaviour, never distribution-wide error pages', () => {
    // A CustomErrorResponses entry would turn the middleware's own 403/404
    // into index.html with a 200 — the portal would parse HTML as JSON.
    const d = portal();
    assert.equal(d.CustomErrorResponses, undefined);
    assert.equal(d.DefaultCacheBehavior.FunctionAssociations[0].EventType, 'viewer-request');
    for (const b of d.CacheBehaviors) assert.equal(b.FunctionAssociations, undefined);
    const fn = Object.values<any>(t.findResources('AWS::CloudFront::Function'))[0];
    assert.match(fn.Properties.FunctionCode, /index\.html/);
  });

  test('every ALB origin sends the origin-verify secret, by name, as a dynamic reference', () => {
    for (const d of dists()) {
      for (const o of d.Origins.filter((x: any) => x.CustomOriginConfig)) {
        const h = o.OriginCustomHeaders.find((x: any) => x.HeaderName === ORIGIN_VERIFY_HEADER);
        assert.ok(h, 'origin without the verify header');
        assert.match(JSON.stringify(h.HeaderValue), /\{\{resolve:secretsmanager:orgiq-cloudfront-origin-secret:SecretString:::\}\}/);
        // No certificate: the ALB listens on HTTP only.
        assert.equal(o.CustomOriginConfig.OriginProtocolPolicy, 'http-only');
        assert.deepEqual(o.DomainName, { 'Fn::ImportValue': 'orgiq-middleware-alb-dns' });
      }
    }
  });

  test('platform-api and the SFU get their own distributions, each naming its route', () => {
    const routes = dists().filter((d) => !d.DefaultRootObject)
      .map((d) => d.Origins[0].OriginCustomHeaders.find((h: any) => h.HeaderName === ORIGIN_ROUTE_HEADER).HeaderValue)
      .sort();
    assert.deepEqual(routes, ['platform-api', 'sfu']);
  });

  test('writes the middleware\'s public URLs to SSM by name', () => {
    const names = portalParameterNames('orgiq');
    for (const n of Object.values(names)) t.hasResourceProperties('AWS::SSM::Parameter', { Name: n });
    t.hasResourceProperties('AWS::SSM::Parameter', {
      Name: names.gatewayUrl,
      Value: { 'Fn::Join': ['', ['wss://', Match.anyValue()]] },
    });
  });

  test('without the social flags it builds only the portal distribution', () => {
    const solo = synthApp({ deployPortal: 'true', allowHttpOrigin: 'true' }).template('OrgIQ-Portal');
    solo.resourceCountIs('AWS::CloudFront::Distribution', 1);
    solo.resourceCountIs('AWS::SSM::Parameter', 4);
  });

  test('imports only the ALB DNS export the middleware has always had', () => {
    assert.deepEqual([...importedExportNames(app.templates['OrgIQ-Portal'])], ['orgiq-middleware-alb-dns']);
    assert.deepEqual([...exportedNames(app.templates['OrgIQ-Portal'])], []);
  });

  test('without a certificate deployPortal is refused (plain HTTP to the ALB); allowHttpOrigin=true is the throwaway escape', () => {
    assert.throws(() => synthApp({ deployPortal: 'true' }), /deployPortal requires --context certificateArn/);
    assert.throws(() => synthApp({ deployPortal: 'true', allowHttpOrigin: 'yes' }), /allowHttpOrigin must be true or false/);
    const origin = Object.values<any>(app.template('OrgIQ-Portal').findResources('AWS::CloudFront::Distribution'))[0]
      .Properties.DistributionConfig.Origins.find((o: any) => o.CustomOriginConfig);
    assert.equal(origin.CustomOriginConfig.OriginProtocolPolicy, 'http-only', 'only because the test opted in');
  });

  test('with a certificate it needs portalAlbOriginHost, and then speaks TLS to that host', () => {
    assert.throws(() => synthApp({ deployPortal: 'true', certificateArn: 'arn:aws:acm:us-east-1:111111111111:certificate/abc' }),
      /portalAlbOriginHost/);
    const tls = synthApp({
      deployPortal: 'true', certificateArn: 'arn:aws:acm:us-east-1:111111111111:certificate/abc',
      portalAlbOriginHost: 'mw.example.com',
    });
    const origin = Object.values<any>(tls.template('OrgIQ-Portal').findResources('AWS::CloudFront::Distribution'))[0]
      .Properties.DistributionConfig.Origins.find((o: any) => o.CustomOriginConfig);
    assert.equal(origin.DomainName, 'mw.example.com');
    assert.equal(origin.CustomOriginConfig.OriginProtocolPolicy, 'https-only');
    // …and the ALB admits CloudFront on 443, where the HTTPS listener is.
    const ingress = prefixListIngress(tls.template('OrgIQ-MiddlewareService'));
    assert.deepEqual(ingress.map((r) => [r.FromPort, r.ToPort]), [[443, 443]]);
  });
});

// ── The ALB side ────────────────────────────────────────────────────────────

describe('OrgIQ-MiddlewareService with deployPortal=true', () => {
  const app = synthApp(FULL);
  const mw = app.template('OrgIQ-MiddlewareService');

  test('trusts two hops (CloudFront, then the ALB)', () => {
    assert.equal(envOf(container(mw), 'TRUST_PROXY_HOPS'), '2');
  });

  test('admits CloudFront by the managed prefix list on its own security group — never 0.0.0.0/0', () => {
    const ingress = prefixListIngress(mw);
    assert.deepEqual(ingress.map((r) => [r.FromPort, r.ToPort]), [[80, 80]]);
    const lb = Object.values<any>(mw.findResources('AWS::ElasticLoadBalancingV2::LoadBalancer'))[0];
    assert.equal(lb.Properties.SecurityGroups.length, 2);
    // The CloudFront group carries the prefix list and nothing else: a
    // prefix-list rule weighs ~55 against a 60-rule quota, so the albAllowCidr
    // rules must not be replayed onto it.
    const cfGroup = Object.entries<any>(mw.findResources('AWS::EC2::SecurityGroup'))
      .find(([, sg]) => /CloudFront origin-facing/.test(sg.Properties.GroupDescription))!;
    assert.equal((cfGroup[1].Properties.SecurityGroupIngress ?? []).length, 0);
    const otherRulesOnIt = Object.values<any>(mw.findResources('AWS::EC2::SecurityGroupIngress'))
      .filter((r) => JSON.stringify(r.Properties.GroupId).includes(cfGroup[0]) && !r.Properties.SourcePrefixListId);
    assert.deepEqual(otherRulesOnIt, []);
    const openIngress = [
      ...Object.values<any>(mw.findResources('AWS::EC2::SecurityGroup')).flatMap((sg) => sg.Properties.SecurityGroupIngress ?? []),
      ...Object.values<any>(mw.findResources('AWS::EC2::SecurityGroupIngress')).map((r) => r.Properties),
    ].filter((r) => r.CidrIp === '0.0.0.0/0' || r.CidrIpv6 === '::/0');
    assert.deepEqual(openIngress, []);
    // The id is looked up at deploy time (it differs per region)…
    mw.resourceCountIs('Custom::AWS', 1);
    // …unless named.
    const named = middlewareServiceStack({ deployPortal: 'true', allowHttpOrigin: 'true', cloudFrontPrefixListId: 'pl-3b927c52' });
    const nt = Template.fromStack(named);
    nt.resourceCountIs('Custom::AWS', 0);
    assert.deepEqual(prefixListIngress(nt).map((r) => r.SourcePrefixListId), ['pl-3b927c52']);
  });

  test('locks the listener: default 403, forward only with the secret header or from albAllowCidr', () => {
    const listener = Object.values<any>(mw.findResources('AWS::ElasticLoadBalancingV2::Listener'))
      .find((l) => l.Properties.Port === 80);
    assert.equal(listener.Properties.DefaultActions[0].Type, 'fixed-response');
    assert.equal(listener.Properties.DefaultActions[0].FixedResponseConfig.StatusCode, '403');

    const byPriority = new Map(rules(mw).map((r) => [r.Priority, r]));
    const cf = byPriority.get(CLOUDFRONT_RULE_PRIORITY.middleware)!;
    assert.equal(cf.Conditions[0].HttpHeaderConfig.HttpHeaderName, ORIGIN_VERIFY_HEADER);
    // Six CIDRs → two rules (an ALB rule takes at most five condition values).
    assert.equal(byPriority.get(91)!.Conditions[0].SourceIpConfig.Values.length, 5);
    assert.deepEqual(byPriority.get(92)!.Conditions[0].SourceIpConfig.Values, ['198.51.100.5/32']);
    mw.hasResourceProperties('AWS::SecretsManager::Secret', { Name: 'orgiq-cloudfront-origin-secret' });
  });

  test('imports nothing from OrgIQ-Portal', () => {
    const mwImports = [...importedExportNames(app.templates['OrgIQ-MiddlewareService'])];
    assert.deepEqual(mwImports.filter((n) => /OrgIQ-Portal/.test(n)), []);
    assert.ok(!/"OrgIQ-Portal:/.test(JSON.stringify(app.templates['OrgIQ-MiddlewareService'])));
  });

  test('every Fn::ImportValue in the full CloudFront app resolves to an export', () => {
    const exported = new Set<string>();
    for (const tpl of Object.values(app.templates)) for (const n of exportedNames(tpl)) exported.add(n);
    for (const [name, tpl] of Object.entries(app.templates)) {
      for (const imp of importedExportNames(tpl)) assert.ok(exported.has(imp), `${name} imports ${imp}, which no stack exports`);
    }
  });
});

describe('OrgIQ-Social with deployPortal=true', () => {
  const social = synthApp(FULL).template('OrgIQ-Social');

  test('platform-api and the SFU are reachable by header rules without any host', () => {
    const byPriority = new Map(rules(social).map((r) => [r.Priority, r]));
    for (const [priority, route] of [[CLOUDFRONT_RULE_PRIORITY.platformApi, 'platform-api'], [CLOUDFRONT_RULE_PRIORITY.sfu, 'sfu']] as const) {
      const r = byPriority.get(priority);
      assert.ok(r, `no rule at ${priority}`);
      const headers = Object.fromEntries(r.Conditions.map((c: any) => [c.HttpHeaderConfig.HttpHeaderName, c.HttpHeaderConfig.Values[0]]));
      assert.equal(headers[ORIGIN_ROUTE_HEADER], route);
      assert.match(JSON.stringify(headers[ORIGIN_VERIFY_HEADER]), /resolve:secretsmanager:orgiq-cloudfront-origin-secret:/);
    }
  });

  test('every routed rule outranks the middleware catch-all on the shared listener', () => {
    assert.ok(CLOUDFRONT_RULE_PRIORITY.platformApi < CLOUDFRONT_RULE_PRIORITY.middleware);
    assert.ok(CLOUDFRONT_RULE_PRIORITY.sfu < CLOUDFRONT_RULE_PRIORITY.middleware);
    const app = synthApp({ ...FULL, socialPlatformHost: 'platform.example.com', socialSfuHost: 'sfu.example.com' });
    const all = [...rules(app.template('OrgIQ-MiddlewareService')), ...rules(app.template('OrgIQ-Social'))]
      .map((r) => r.Priority);
    assert.equal(new Set(all).size, all.length, `duplicate listener priorities: ${all.join(',')}`);
  });
});

// ── portalPublicUrls / portalPublicUrl ──────────────────────────────────────

describe('the public URLs flow back without a hand-copied CloudFront domain', () => {
  test('portalPublicUrls=true: the middleware reads them from SSM as container secrets, never also as env', () => {
    // The flags deploy.sh infers once OrgIQ-Portal has written the social URLs.
    const mw = synthApp({ ...FULL, portalPublicUrls: 'true', portalPlatformApiUrlLive: 'true', portalVideoUrlLive: 'true' })
      .template('OrgIQ-MiddlewareService');
    const c = container(mw);
    const names = portalParameterNames('orgiq');
    for (const k of ['PUBLIC_BASE_URL', 'PORTAL_ORIGIN', 'COGNITO_CALLBACK_URL', 'COGNITO_LOGOUT_URL',
      'REALTIME_GATEWAY_URL', 'REALTIME_PLATFORM_PUBLIC_URL', 'REALTIME_VIDEO_PUBLIC_URL']) {
      assert.ok(secretOf(c, k), `${k} missing from container secrets`);
      assert.equal(envOf(c, k), undefined, `${k} is both env and secret`);
    }
    assert.match(JSON.stringify(secretOf(c, 'COGNITO_CALLBACK_URL').ValueFrom), new RegExp(names.cognitoCallbackUrl.slice(1)));
  });

  test('explicit context still wins over the parameter', () => {
    const c = container(synthApp({
      ...FULL, portalPublicUrls: 'true', portalPlatformApiUrlLive: 'true', realtimePlatformPublicUrl: 'https://platform.example.com',
    }).template('OrgIQ-MiddlewareService'));
    assert.equal(envOf(c, 'REALTIME_PLATFORM_PUBLIC_URL'), 'https://platform.example.com');
    assert.equal(secretOf(c, 'REALTIME_PLATFORM_PUBLIC_URL'), undefined);
  });

  test('portalPublicUrl registers the Cognito callback + sign-out and points the runtimes at the middleware', () => {
    const app = synthApp({ portalPublicUrl: PORTAL_URL, deployRuntimes: 'true' });
    app.template('OrgIQ-Authentication').hasResourceProperties('AWS::Cognito::UserPoolClient', {
      CallbackURLs: [`${PORTAL_URL}/api/auth/callback`],
      LogoutURLs: Match.arrayWith([`${PORTAL_URL}/`]),
    });
    const runtimes = Object.values<any>(app.template('OrgIQ-AgentCoreRuntime').findResources('AWS::BedrockAgentCore::Runtime'));
    assert.ok(runtimes.length > 0);
    for (const r of runtimes) assert.equal(r.Properties.EnvironmentVariables.MIDDLEWARE_URL, PORTAL_URL);
  });

  test('middlewareCallbackUrl overrides it, and an http:// portal URL is refused (Cognito would refuse it too)', () => {
    const app = synthApp({ portalPublicUrl: PORTAL_URL, middlewareCallbackUrl: 'https://mw.example.com', deployRuntimes: 'true' });
    const r = Object.values<any>(app.template('OrgIQ-AgentCoreRuntime').findResources('AWS::BedrockAgentCore::Runtime'))[0];
    assert.equal(r.Properties.EnvironmentVariables.MIDDLEWARE_URL, 'https://mw.example.com');
    assert.throws(() => synthApp({ portalPublicUrl: 'http://d111.cloudfront.net' }), /https:\/\/ origin/);
  });
});
