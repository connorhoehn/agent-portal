import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cr from 'aws-cdk-lib/custom-resources';
import type { Construct } from 'constructs';
import { contextFlag } from './context-flags';

// ── The contract between OrgIQ-Portal and the stacks behind it ──────────────
//
// CloudFront reaches the shared ALB (OrgIQ-MiddlewareService's) over the
// internet, admitted by the CloudFront origin-facing managed prefix list. That
// list is every CloudFront edge — ANY distribution, anyone's — so the prefix
// list alone would let a stranger's distribution reach the middleware past
// `albAllowCidr`. Every origin here therefore sends a secret header, and the
// ALB forwards to a target only when it carries it (listener rules in the
// middleware and social stacks; the default action becomes a 403).
//
// A second header names the TARGET, because the three distributions share one
// ALB and platform-api's paths collide with the middleware's (`/api` mounted
// wholesale), so host rules are not available without a domain and path rules
// cannot tell them apart.

/** The secret header CloudFront adds and the ALB rules require. */
export const ORIGIN_VERIFY_HEADER = 'x-orgiq-origin-verify';
/** Which service behind the ALB a distribution is for. */
export const ORIGIN_ROUTE_HEADER = 'x-orgiq-origin-route';
export const ORIGIN_ROUTES = { platformApi: 'platform-api', sfu: 'sfu' } as const;

/**
 * Listener-rule priorities. The document workspace holds 10/20 and the
 * social host rules 30/40; the CloudFront header rules for platform-api and
 * the SFU sit right after theirs, and the middleware's catch-alls (the
 * CloudFront rule, then the albAllowCidr rules) come last — a header rule
 * for platform-api must win over the middleware's verify-only rule.
 */
export const CLOUDFRONT_RULE_PRIORITY = { platformApi: 31, sfu: 41, middleware: 90, allowlistFirst: 91 } as const;

/** Minted by OrgIQ-MiddlewareService (it deploys first); imported here by NAME. */
export function cloudFrontOriginSecretName(prefix: string): string {
  return `${prefix}-cloudfront-origin-secret`;
}

/**
 * The secret's value as a dynamic reference BY NAME. Not
 * `Secret.fromSecretNameV2(...).secretValue`: that renders a partial ARN
 * (no random suffix) into the reference, which is not a form the secret's
 * own ARN ever takes.
 */
export function originVerifyValue(prefix: string): string {
  return cdk.SecretValue.secretsManager(cloudFrontOriginSecretName(prefix)).unsafeUnwrap();
}

/**
 * SSM parameters this stack writes, read BY NAME by OrgIQ-MiddlewareService
 * under `--context portalPublicUrls=true` — so the middleware imports nothing
 * from this stack and nobody copies a CloudFront domain by hand into it.
 */
export function portalParameterNames(prefix: string) {
  const base = `/${prefix}/portal`;
  return {
    url: `${base}/url`,
    gatewayUrl: `${base}/gateway-url`,
    cognitoCallbackUrl: `${base}/cognito-callback-url`,
    cognitoLogoutUrl: `${base}/cognito-logout-url`,
    platformApiUrl: `${base}/platform-api-url`,
    videoUrl: `${base}/video-url`,
  };
}

/** Paths the portal distribution sends to the middleware instead of S3. */
export const MIDDLEWARE_PATHS = ['/api/*', '/ws', '/ws/*', '/health'] as const;
/** The document workspace gateway's socket on the same ALB (deployDocumentWorkspace);
 * without it the ALB answers these paths with its default action. */
export const DOCUMENT_PATHS = ['/document-realtime', '/document-realtime/*'] as const;

export interface PortalStackProps extends cdk.StackProps {
  readonly prefix?: string;
  /** Stack-id prefix of the environment (DE-17); only used in the distribution comment destroy.sh matches on. */
  readonly stackPrefix?: string;
  /**
   * The ALB's DNS name — `Fn.importValue('<prefix>-middleware-alb-dns')`, an
   * export OrgIQ-MiddlewareService has always had, so this stack adds none.
   */
  readonly loadBalancerDnsName: string;
  /** Add the platform-api distribution (OrgIQ-Social is in the app). */
  readonly platformApi?: boolean;
  /** Add the SFU distribution (OrgIQ-SocialMedia is in the app). */
  readonly sfu?: boolean;
}

/**
 * OrgIQ-Portal: the portal bundle on a private S3 bucket behind CloudFront,
 * and HTTPS for everything the browser talks to — with no domain and no ACM
 * certificate. CloudFront's own `*.cloudfront.net` name and certificate supply
 * the TLS that the deploy plan (§5) made a prerequisite: `wss://` from an
 * HTTPS page, the Cognito callback, and `getUserMedia` all need it.
 *
 *   portal distribution     /            → S3 (SPA: extensionless paths → /index.html)
 *                           /api/*, /ws, /ws/*, /health → the ALB (middleware)
 *   platform distribution   /*           → the ALB, routed to platform-api   (deploySocial)
 *   sfu distribution        /*           → the ALB, routed to the SFU :3901  (deploySocialMedia)
 *
 * The middleware's paths are on the SAME origin as the portal, so the session
 * cookie, the browser-origin allowlist and the socket need no cross-origin
 * story. platform-api and the SFU are separate distributions because their
 * paths overlap the middleware's and their responses carry absolute paths
 * (LVS answers WHIP/WHEP with `Location: /api/channels/…`), which a path
 * prefix on the portal distribution would break.
 *
 * Context:
 *   deployPortal=true        instantiate this stack (bin/app.ts) — and, on the
 *                            middleware/social stacks, the ALB side of it
 *   certificateArn +         with a certificate the ALB answers HTTPS only (port
 *   portalAlbOriginHost      80 redirects), so CloudFront must connect over TLS
 *                            to a name the certificate covers
 *
 * ⚠️ THE BUCKET POLICY. Origin Access Control has no identity-based form: S3
 * admits CloudFront only through a bucket RESOURCE policy (principal
 * cloudfront.amazonaws.com, conditioned on this distribution's ARN). This
 * account's custodian has stripped a bucket policy before — the stock
 * `autoDeleteObjects` grant was gone by teardown (OrgIQ-Foundation's comment).
 * Whether it strips a service-principal statement like this one is unknown.
 * If it does, the portal answers 403 AccessDenied while every stack reads
 * healthy. `scripts/portal-publish.mjs` checks the statement on every publish
 * and re-applies it with `--repair-bucket-policy`. The bucket stays private
 * either way; nothing here is public.
 */
export class PortalStack extends cdk.Stack {
  public readonly bucket: s3.Bucket;
  public readonly distribution: cloudfront.Distribution;
  public readonly portalUrl: string;
  public readonly platformApiDistribution?: cloudfront.Distribution;
  public readonly sfuDistribution?: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: PortalStackProps) {
    super(scope, id, props);
    const prefix = props.prefix ?? 'orgiq';
    const ctx = (k: string) => this.node.tryGetContext(k) as string | undefined;

    // ── Bucket ─────────────────────────────────────────────────────────────
    // Private (BLOCK_ALL), and DESTROY with the identity-based emptier
    // OrgIQ-Foundation uses, not `autoDeleteObjects`: the stock provider's
    // permissions live in a bucket policy the custodian strips, which wedges
    // teardown in DELETE_FAILED. The bundle is rebuilt from source, so there
    // is nothing to keep.
    this.bucket = new s3.Bucket(this, 'PortalBucket', {
      bucketName: `${prefix}-portal-${this.account}-${this.region}`,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      versioned: false,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    this.emptyOnDestroy(this.bucket);

    // ── The ALB origin ─────────────────────────────────────────────────────
    // Without a certificate the ALB listens on HTTP :80 only, so CloudFront
    // connects over HTTP inside AWS's network and the viewer leg is HTTPS.
    // With one, :80 redirects to :443 and the certificate does not name the
    // ALB's own DNS name, so the origin must be a host the certificate covers.
    const certArn = ctx('certificateArn');
    const originHost = ctx('portalAlbOriginHost');
    // Without a certificate the CloudFront → ALB leg is plain HTTP across the
    // internet: session cookies, the OAuth callback (code and state) and the
    // origin-verify secret all cross it in clear (docs/next-steps.md §7).
    // Refused (work item 19). `-c allowHttpOrigin=true` is for throwaway
    // stacks only and is named so that nobody passes it by accident.
    if (!certArn && !contextFlag(this, 'allowHttpOrigin', false)) {
      throw new Error('deployPortal requires --context certificateArn=<ACM certificate on the ALB> and '
        + 'portalAlbOriginHost=<a host it covers>: without them CloudFront reaches the ALB over plain HTTP, '
        + 'carrying cookies, the OAuth callback and the origin-verify secret. For a throwaway stack only: '
        + '--context allowHttpOrigin=true (infra/SECURITY-NOTES.md).');
    }
    if (!certArn) {
      cdk.Annotations.of(this).addWarningV2('orgiq:portal-http-origin',
        'allowHttpOrigin=true: CloudFront reaches the ALB over plain HTTP. Throwaway stacks only.');
    }
    if (certArn && !originHost) {
      throw new Error('deployPortal with certificateArn requires --context portalAlbOriginHost=<a host the '
        + 'certificate covers, resolving to the ALB> — CloudFront cannot reach an HTTPS-only ALB by its DNS name');
    }
    // A CloudFormation dynamic reference by secret NAME (`{{resolve:
    // secretsmanager:<name>:SecretString:::}}`): resolved at deploy time, never
    // in the template, and no export. It does land in the distribution config
    // (that is how CloudFront sends it), readable with cloudfront:GetDistribution.
    const verifyValue = originVerifyValue(prefix);
    const albOrigin = (route?: string) => new origins.HttpOrigin(originHost ?? props.loadBalancerDnsName, {
      protocolPolicy: certArn ? cloudfront.OriginProtocolPolicy.HTTPS_ONLY : cloudfront.OriginProtocolPolicy.HTTP_ONLY,
      ...(certArn ? { originSslProtocols: [cloudfront.OriginSslPolicy.TLS_V1_2] } : {}),
      customHeaders: {
        [ORIGIN_VERIFY_HEADER]: verifyValue,
        ...(route ? { [ORIGIN_ROUTE_HEADER]: route } : {}),
      },
      // The quota ceilings without a support case. readTimeout is the gap
      // CloudFront tolerates between response PACKETS, so an SSE agent stream
      // that is silent for longer than this is cut (deploy plan §10).
      readTimeout: cdk.Duration.seconds(60),
      keepaliveTimeout: cdk.Duration.seconds(60),
    });

    // Never cached, every method, every viewer header/cookie/query string —
    // including Host and CloudFront-Forwarded-Proto, which the middleware reads
    // for the viewer's scheme (lib/trusted-proxy.ts) — and the socket upgrade,
    // which CloudFront passes through on any behaviour.
    const passThrough = (origin: cloudfront.IOrigin): cloudfront.BehaviorOptions => ({
      origin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_AND_CLOUDFRONT_2022,
      compress: false,
    });

    // ── SPA fallback ───────────────────────────────────────────────────────
    // A viewer-request function on the S3 behaviour only, NOT distribution-wide
    // errorResponses: those would also rewrite the middleware's own 403/404
    // into index.html with a 200, and the portal would parse HTML as JSON.
    const spaRewrite = new cloudfront.Function(this, 'SpaRewrite', {
      functionName: `${prefix}-portal-spa-rewrite`,
      comment: 'Extensionless portal routes serve /index.html',
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline([
        'function handler(event) {',
        '  var request = event.request;',
        "  var last = request.uri.split('/').pop();",
        "  if (last === '' || last.indexOf('.') === -1) request.uri = '/index.html';",
        '  return request;',
        '}',
      ].join('\n')),
    });

    const middleware = albOrigin();
    this.distribution = new cloudfront.Distribution(this, 'PortalDistribution', {
      comment: `${prefix} portal + middleware (${props.stackPrefix ?? 'OrgIQ'}-Portal)`,
      defaultRootObject: 'index.html',
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        functionAssociations: [{ function: spaRewrite, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }],
      },
      additionalBehaviors: Object.fromEntries([...MIDDLEWARE_PATHS, ...DOCUMENT_PATHS].map((p) => [p, passThrough(middleware)])),
    });
    this.portalUrl = `https://${this.distribution.distributionDomainName}`;

    // ── platform-api and the SFU, each on its own distribution ────────────
    const routed = (logicalId: string, route: string, comment: string) => new cloudfront.Distribution(this, logicalId, {
      comment: `${prefix} ${comment} (${props.stackPrefix ?? 'OrgIQ'}-Portal)`,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      defaultBehavior: passThrough(albOrigin(route)),
    });
    if (props.platformApi) {
      this.platformApiDistribution = routed('PlatformApiDistribution', ORIGIN_ROUTES.platformApi, 'platform-api');
    }
    if (props.sfu) {
      this.sfuDistribution = routed('SfuDistribution', ORIGIN_ROUTES.sfu, 'SFU signalling (media stays on the EIP)');
    }

    // ── What the middleware reads (by name) ────────────────────────────────
    const names = portalParameterNames(prefix);
    const param = (logicalId: string, parameterName: string, stringValue: string, description: string) =>
      new ssm.StringParameter(this, logicalId, { parameterName, stringValue, description });
    param('PortalUrlParameter', names.url, this.portalUrl,
      'PUBLIC_BASE_URL / PORTAL_ORIGIN for the middleware (portalPublicUrls=true)');
    param('GatewayUrlParameter', names.gatewayUrl, `wss://${this.distribution.distributionDomainName}`,
      'REALTIME_GATEWAY_URL — the middleware\'s own /ws through CloudFront');
    param('CognitoCallbackUrlParameter', names.cognitoCallbackUrl, `${this.portalUrl}/api/auth/callback`,
      'COGNITO_CALLBACK_URL — register it on the app client (authCallbackUrls / portalPublicUrl)');
    param('CognitoLogoutUrlParameter', names.cognitoLogoutUrl, `${this.portalUrl}/`,
      'COGNITO_LOGOUT_URL — register it on the app client (authLogoutUrls / portalPublicUrl)');
    if (this.platformApiDistribution) {
      param('PlatformApiUrlParameter', names.platformApiUrl,
        `https://${this.platformApiDistribution.distributionDomainName}`, 'REALTIME_PLATFORM_PUBLIC_URL');
    }
    if (this.sfuDistribution) {
      param('VideoUrlParameter', names.videoUrl,
        `https://${this.sfuDistribution.distributionDomainName}`, 'REALTIME_VIDEO_PUBLIC_URL (LVSProvider baseUrl)');
    }

    // ── Outputs (read by scripts/portal-publish.mjs and the runbook) ──────
    new cdk.CfnOutput(this, 'PortalUrl', {
      value: this.portalUrl,
      description: 'The portal (and the middleware under /api, /ws) — pass as --context portalPublicUrl=<this>',
    });
    new cdk.CfnOutput(this, 'PortalBucketName', { value: this.bucket.bucketName, description: 'aws s3 sync target' });
    new cdk.CfnOutput(this, 'PortalDistributionId', {
      value: this.distribution.distributionId, description: 'aws cloudfront create-invalidation --distribution-id <this>',
    });
    new cdk.CfnOutput(this, 'PortalDistributionArn', {
      value: this.distribution.distributionArn, description: 'The AWS:SourceArn the bucket policy is conditioned on',
    });
    if (this.platformApiDistribution) {
      new cdk.CfnOutput(this, 'PlatformApiPublicUrl', {
        value: `https://${this.platformApiDistribution.distributionDomainName}`, description: 'platform-api for browsers',
      });
    }
    if (this.sfuDistribution) {
      new cdk.CfnOutput(this, 'SfuPublicUrl', {
        value: `https://${this.sfuDistribution.distributionDomainName}`,
        description: 'SFU HTTP signalling for browsers (media goes to the Elastic IP)',
      });
    }
  }

  /** OrgIQ-Foundation's `emptyBucketOnDestroy`, for one unversioned bucket. */
  private emptyOnDestroy(bucket: s3.Bucket): void {
    const fn = new lambda.Function(this, 'PortalBucketEmptierFn', {
      description: 'Empties the OrgIQ-Portal bucket on stack destroy (identity-based S3 grants).',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      timeout: cdk.Duration.minutes(15),
      memorySize: 256,
      code: lambda.Code.fromInline([
        "const { S3Client, ListObjectVersionsCommand, DeleteObjectsCommand } = require('@aws-sdk/client-s3');",
        'const s3 = new S3Client({});',
        'exports.handler = async (event) => {',
        "  if (event.RequestType !== 'Delete') return {};",
        '  const Bucket = event.ResourceProperties.BucketName;',
        '  try {',
        '    let KeyMarker, VersionIdMarker;',
        '    do {',
        '      const page = await s3.send(new ListObjectVersionsCommand({ Bucket, KeyMarker, VersionIdMarker }));',
        '      const objects = [...(page.Versions || []), ...(page.DeleteMarkers || [])]',
        '        .map((o) => ({ Key: o.Key, VersionId: o.VersionId }));',
        '      if (objects.length > 0) {',
        '        await s3.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects: objects, Quiet: true } }));',
        '      }',
        '      KeyMarker = page.NextKeyMarker;',
        '      VersionIdMarker = page.NextVersionIdMarker;',
        '    } while (KeyMarker || VersionIdMarker);',
        '  } catch (err) {',
        "    if (err && err.name === 'NoSuchBucket') return {};",
        '    throw err;',
        '  }',
        '  return {};',
        '};',
      ].join('\n')),
    });
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:ListBucket', 's3:ListBucketVersions'],
      resources: [bucket.bucketArn],
    }));
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:DeleteObject', 's3:DeleteObjectVersion'],
      resources: [bucket.arnForObjects('*')],
    }));
    const provider = new cr.Provider(this, 'PortalBucketEmptierProvider', { onEventHandler: fn });
    const cleaner = new cdk.CustomResource(this, 'PortalBucketEmptier', {
      serviceToken: provider.serviceToken,
      resourceType: 'Custom::EmptyBucketOnDestroy',
      properties: { BucketName: bucket.bucketName },
    });
    cleaner.node.addDependency(bucket);
  }
}
