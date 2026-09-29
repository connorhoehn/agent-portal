import * as cdk from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import type { Construct } from 'constructs';

export interface SocialImagesStackProps extends cdk.StackProps {
  readonly prefix?: string;
}

/** Logical key → repository name suffix. Names are `${prefix}-${suffix}`. */
export const SOCIAL_IMAGE_REPOS = {
  /** realtime-examples `server-runtime` (the standalone websocket-gateway). */
  gateway: 'social-gateway',
  /** platform-api (sessions, rooms, call log, the LVS webhook). */
  platformApi: 'platform-api',
  /** live-video-streaming — the mediasoup SFU. */
  sfu: 'lvs-sfu',
} as const;

export type SocialImageKey = keyof typeof SOCIAL_IMAGE_REPOS;

export function socialRepoName(prefix: string, key: SocialImageKey): string {
  return `${prefix}-${SOCIAL_IMAGE_REPOS[key]}`;
}

/**
 * OrgIQ-SocialImages: the three ECR repositories the social-calls stack pulls
 * from, and nothing else.
 *
 * Why a stack of its own. A stack that owns a repository AND pulls from it has
 * a chicken-and-egg on every fresh deploy (see the OrgIQ-MiddlewareService and
 * OrgIQ-AgentCoreRuntime gotchas in CLAUDE.md): the service cannot pull from
 * the empty repository it just created, the deploy fails, and the failed-stack
 * cleanup takes the repository with it. Here the service stacks never own a
 * repository — they import these by NAME (`fromRepositoryName`), so no export
 * freezes and the order is simply: this stack, build + push, then the rest.
 *
 * RETAIN, like `orgiq-middleware`: a teardown leaves the repositories (and the
 * images) behind, so the NAMES survive too — a redeploy after teardown fails
 * with "already exists" unless `infra/scripts/deploy.sh`'s ECR orphan sweep
 * knows these three names (docs/social-calls-deploy-plan.md backlog).
 */
export class SocialImagesStack extends cdk.Stack {
  public readonly repositories: Record<SocialImageKey, ecr.Repository>;

  constructor(scope: Construct, id: string, props: SocialImagesStackProps = {}) {
    super(scope, id, props);
    const prefix = props.prefix ?? 'orgiq';

    const make = (key: SocialImageKey, logicalId: string, description: string): ecr.Repository => {
      const repositoryName = socialRepoName(prefix, key);
      const repo = new ecr.Repository(this, logicalId, {
        repositoryName,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
        emptyOnDelete: false,
        // The platform-api and SFU images are large (claude-code + g++ in one,
        // ffmpeg + mediasoup in the other); five is plenty to roll back to.
        lifecycleRules: [{ maxImageCount: 5 }],
      });
      new cdk.CfnOutput(this, `${logicalId}Uri`, {
        value: repo.repositoryUri,
        description,
        exportName: `${repositoryName}-ecr-uri`,
      });
      return repo;
    };

    this.repositories = {
      gateway: make('gateway', 'SocialGatewayRepo',
        'realtime-examples server-runtime image (docker buildx --platform linux/arm64 --target server-runtime)'),
      platformApi: make('platformApi', 'PlatformApiRepo',
        'platform-api image (build context: the parent of the platform-api checkout)'),
      sfu: make('sfu', 'LvsSfuRepo',
        'live-video-streaming (mediasoup SFU) image, run on the OrgIQ-SocialMedia instance'),
    };
  }
}
