import { execFileSync } from 'child_process';
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as bedrockagentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import type { Construct } from 'constructs';

/**
 * Resolve `<repo>:latest` to a digest-pinned URI at synth time so CFN sees a
 * diff (and rolls the runtime) every time a new image is pushed. Falls back
 * to `:latest` if the image doesn't yet exist — keeps first-time deploys
 * working in the documented "Runtime PENDING until image is pushed" flow.
 */
export function resolveContainerUri(repoUri: string, repoName: string, region: string): string {
  try {
    const digest = execFileSync(
      'aws',
      [
        'ecr', 'describe-images',
        '--repository-name', repoName,
        '--image-ids', 'imageTag=latest',
        '--region', region,
        '--query', 'imageDetails[0].imageDigest',
        '--output', 'text',
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    if (digest.startsWith('sha256:')) {
      return `${repoUri}@${digest}`;
    }
  } catch {
    // No :latest tag yet — first deploy. Re-run ./scripts/deploy.sh after
    // ./agents/build-all.sh to pin the digest and force a runtime roll.
  }
  return `${repoUri}:latest`;
}

export interface AgentCoreRuntimeStackProps extends cdk.StackProps {
  readonly prefix?: string;
  readonly agentRoles: Record<string, iam.Role>;
  readonly memoryId: string;
  /** Per-role guardrail IDs — supervisor selects one based on caller's role. */
  readonly guardrailIdMember?: string;
  readonly guardrailIdOrgLeader?: string;
  readonly guardrailIdHrAdmin?: string;
  readonly auroraClusterArn: string;
  readonly auroraCredentialsSecretArn: string;
  readonly knowledgeBaseId: string;
  /** Newsroom KB ID — injected into news-researcher agent only. Provisioned via portal after Wave 3. */
  readonly newsroomKbId?: string;
  /** Documents S3 bucket name — injected into news-researcher so it can push articles to S3. */
  readonly documentsBucketName?: string;
  readonly modelId?: string;
  readonly codeInterpreterId?: string;
  readonly codeInterpreterArn?: string;
  readonly browserId?: string;
  readonly browserArn?: string;
  readonly browserProfileId?: string;
}

const AGENT_NAMES = [
  'supervisor',
  'search',
  'scoring',
  'advisor',
  'ingestion',
  'graph-builder',
] as const;

// News agents — ECR repos exist externally (created via `aws ecr create-repository`
// before the stack knew about these names). Imported rather than created here.
const EXTERNAL_AGENT_NAMES = [
  'news-researcher',
  'news-brief',
  'news-headline',
] as const;

const ALL_AGENT_NAMES = [...AGENT_NAMES, ...EXTERNAL_AGENT_NAMES] as const;

// Explicit session lifecycle per agent. The service defaults are 900s idle /
// 28800s max — set explicitly so the numbers live in source rather than being
// implicit, and tuned per agent:
//  - supervisor: 1800s idle — it fronts multi-turn AG-UI sessions, and a
//    warm microVM avoids the ~8s cold-start TTFT penalty between user turns.
//  - everything else: 600s idle — sub-agents and newsroom agents are invoked
//    per-request (A2A or direct); releasing the workload sooner is pure cost
//    hygiene with no UX cost (they cold-start per invocation anyway).
// None of these runtimes use session storage, so lifecycle changes carry no
// data-loss risk (the resulting version bump wipes nothing).
const DEFAULT_LIFECYCLE = { idleRuntimeSessionTimeout: 600, maxLifetime: 28800 } as const;
const AGENT_LIFECYCLE: Partial<Record<(typeof ALL_AGENT_NAMES)[number], { idleRuntimeSessionTimeout: number; maxLifetime: number }>> = {
  supervisor: { idleRuntimeSessionTimeout: 1800, maxLifetime: 28800 },
};

/**
 * OrgIQ-AgentCoreRuntime: ECR repos, execution roles, and CfnRuntime resources.
 *
 * After deploying this stack, push container images to the ECR repos:
 *   cd agents/<name>
 *   aws ecr get-login-password | docker login --username AWS --password-stdin <ecr-uri>
 *   docker buildx build --platform linux/arm64 -t <ecr-uri>:latest --push .
 *
 * Runtime resources will be PENDING until the image exists in ECR.
 */
export class AgentCoreRuntimeStack extends cdk.Stack {
  public readonly runtimeIds: Record<string, string> = {};
  public readonly ecrRepos: Record<string, ecr.IRepository> = {};

  constructor(scope: Construct, id: string, props: AgentCoreRuntimeStackProps) {
    super(scope, id, props);

    const prefix = props.prefix ?? 'orgiq';
    const modelId = props.modelId ?? 'amazon.nova-pro-v1:0';

    // Phase 1 (default): create ECR repos + execution roles
    // Phase 2 (after images pushed): add CfnRuntime + CfnRuntimeEndpoint
    //   cdk deploy OrgIQ-AgentCoreRuntime --context deployRuntimes=true
    //
    // Optionally restrict to a subset of agents whose images are actually in
    // ECR via --context onlyAgents=supervisor[,search,...]. When unset, all
    // six runtimes are created (which requires all six images to exist).
    const deployRuntimes = this.node.tryGetContext('deployRuntimes') === 'true';
    const onlyAgentsCtx = this.node.tryGetContext('onlyAgents') as string | undefined;
    const onlyAgents = onlyAgentsCtx
      ? new Set(onlyAgentsCtx.split(',').map(s => s.trim()).filter(Boolean))
      : null;

    // Shared base image for all 6 agents. Built once via agents/base/build.sh
    // and pre-loaded with strands-agents + bedrock-agentcore + ag-ui deps, so
    // per-agent rebuilds become a single COPY layer (<10s).
    const baseRepo = new ecr.Repository(this, 'AgentBaseRepo', {
      repositoryName: `${prefix}-agent-base`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      emptyOnDelete: true,
      lifecycleRules: [{ maxImageCount: 5 }],
    });

    new cdk.CfnOutput(this, 'AgentBaseEcrUri', {
      value: baseRepo.repositoryUri,
      description: 'ECR URI for shared agent base image — push once via agents/base/build.sh',
      exportName: `${prefix}-agent-base-ecr-uri`,
    });

    for (const agentName of ALL_AGENT_NAMES) {
      const agentRole = props.agentRoles[agentName];
      // External agents (news-*) are not registered in AgentsStack, so they won't
      // have an entry in props.agentRoles. Allow them through — the runtime stack
      // creates its own execution role for every agent regardless.
      const isExternal = (EXTERNAL_AGENT_NAMES as readonly string[]).includes(agentName);
      if (!agentRole && !isExternal) continue;

      const pascal = this.pascal(agentName);
      const runtimeName = `${prefix}-${agentName}`;
      // agentRuntimeName and endpoint name must match [a-zA-Z][a-zA-Z0-9_]{0,47} — no hyphens
      const safeRuntimeName = `${prefix}_${agentName.replace(/-/g, '_')}`;

      // ECR repo — created for internally-managed agents, imported for externally-managed.
      // News agent repos were created manually before the stack covered them; importing
      // avoids "repository already exists" errors while still wiring up the runtime.
      let repo: ecr.IRepository;
      if (isExternal) {
        repo = ecr.Repository.fromRepositoryName(this, `${pascal}Repo`, runtimeName);
      } else {
        repo = new ecr.Repository(this, `${pascal}Repo`, {
          repositoryName: runtimeName,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
          emptyOnDelete: true,
          lifecycleRules: [{ maxImageCount: 5 }],
        });
      }
      this.ecrRepos[agentName] = repo;

      // Runtime execution role — trusted by bedrock-agentcore service
      const executionRole = new iam.Role(this, `${pascal}ExecutionRole`, {
        roleName: `${runtimeName}-execution-role`,
        assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
        description: `Execution role for ${runtimeName} AgentCore Runtime`,
        inlinePolicies: {
          RuntimeAccess: new iam.PolicyDocument({
            statements: [
              new iam.PolicyStatement({
                sid: 'BedrockInvoke',
                // Converse/ConverseStream/ApplyGuardrail are needed when the
                // BedrockModel is configured with a guardrail (the SDK calls
                // bedrock:ApplyGuardrail implicitly inside ConverseStream).
                actions: [
                  'bedrock:InvokeModel',
                  'bedrock:InvokeModelWithResponseStream',
                  'bedrock:Converse',
                  'bedrock:ConverseStream',
                  'bedrock:ApplyGuardrail',
                ],
                resources: ['*'],
              }),
              new iam.PolicyStatement({
                sid: 'EcrAccess',
                // Agents pull layers from BOTH their per-agent repo and the
                // shared base image repo. Without baseRepo here, the runtime
                // fails on layer resolution at container start.
                actions: ['ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer'],
                resources: [repo.repositoryArn, baseRepo.repositoryArn],
              }),
              new iam.PolicyStatement({
                sid: 'EcrAuth',
                actions: ['ecr:GetAuthorizationToken'],
                resources: ['*'],
              }),
              new iam.PolicyStatement({
                sid: 'Logs',
                actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
                resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:/aws/bedrock-agentcore/*`],
              }),
              new iam.PolicyStatement({
                sid: 'Xray',
                actions: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords'],
                resources: ['*'],
              }),
              new iam.PolicyStatement({
                sid: 'Metrics',
                actions: ['cloudwatch:PutMetricData'],
                resources: ['*'],
                conditions: { StringEquals: { 'cloudwatch:namespace': 'bedrock-agentcore' } },
              }),
              new iam.PolicyStatement({
                sid: 'AgentCoreWorkload',
                actions: ['bedrock-agentcore:GetWorkloadAccessToken', 'bedrock-agentcore:GetWorkloadAccessTokenForJwt'],
                resources: ['*'],
              }),
            ],
          }),
        },
      });

      // Supervisor needs A2A: list runtimes for discovery + invoke sub-agents
      if (agentName === 'supervisor') {
        executionRole.addToPolicy(new iam.PolicyStatement({
          sid: 'A2ARuntimeDiscovery',
          actions: [
            'bedrock-agentcore:ListAgentRuntimes',
            'bedrock-agentcore:GetAgentRuntime',
          ],
          resources: ['*'],
        }));
        executionRole.addToPolicy(new iam.PolicyStatement({
          sid: 'A2AInvokeSubAgents',
          actions: ['bedrock-agentcore:InvokeAgentRuntime'],
          resources: [`arn:aws:bedrock-agentcore:${this.region}:${this.account}:runtime/${prefix}_*`],
        }));
      }

      // Data-plane permissions every agent's tools need. Granted to the
      // execution role (the one the runtime container actually assumes) — the
      // separate AgentsStack roles are for non-AgentCore-Runtime deployments
      // and aren't in the call path here.
      executionRole.addToPolicy(new iam.PolicyStatement({
        sid: 'AuroraRdsData',
        actions: [
          'rds-data:ExecuteStatement',
          'rds-data:BatchExecuteStatement',
          'rds-data:BeginTransaction',
          'rds-data:CommitTransaction',
          'rds-data:RollbackTransaction',
        ],
        resources: [props.auroraClusterArn],
      }));
      executionRole.addToPolicy(new iam.PolicyStatement({
        sid: 'AuroraSecret',
        actions: ['secretsmanager:GetSecretValue'],
        resources: [props.auroraCredentialsSecretArn],
      }));
      // Wildcard over all KBs in this account — covers the default orgiq KB and
      // any new KBs provisioned via the portal registry wizard (Wave 1+).
      // Scoped to account/region; no cross-account access is possible.
      executionRole.addToPolicy(new iam.PolicyStatement({
        sid: 'KnowledgeBaseRetrieve',
        actions: [
          'bedrock:Retrieve',
          'bedrock:RetrieveAndGenerate',
        ],
        resources: [`arn:aws:bedrock:${this.region}:${this.account}:knowledge-base/*`],
      }));
      executionRole.addToPolicy(new iam.PolicyStatement({
        sid: 'S3DocsRead',
        actions: ['s3:GetObject', 's3:ListBucket'],
        resources: [
          `arn:aws:s3:::${prefix}-documents-${this.account}-${this.region}`,
          `arn:aws:s3:::${prefix}-documents-${this.account}-${this.region}/*`,
        ],
      }));
      executionRole.addToPolicy(new iam.PolicyStatement({
        sid: 'ScoresTableReadWrite',
        actions: [
          'dynamodb:GetItem',
          'dynamodb:PutItem',
          'dynamodb:UpdateItem',
          'dynamodb:Query',
          'dynamodb:Scan',
          'dynamodb:BatchGetItem',
          'dynamodb:BatchWriteItem',
        ],
        resources: [`arn:aws:dynamodb:${this.region}:${this.account}:table/${prefix}-scores`],
      }));

      // Code interpreter — needed by graph-builder + scoring for their
      // run_in_sandbox tools. Granted to ALL execution roles since it's
      // cheap and other agents may want it later.
      if (props.codeInterpreterArn) {
        executionRole.addToPolicy(new iam.PolicyStatement({
          sid: 'CodeInterpreterInvoke',
          actions: [
            'bedrock-agentcore:InvokeCodeInterpreter',
            'bedrock-agentcore:StartCodeInterpreterSession',
            'bedrock-agentcore:StopCodeInterpreterSession',
            'bedrock-agentcore:GetCodeInterpreterSession',
            'bedrock-agentcore:ListCodeInterpreterSessions',
          ],
          resources: [props.codeInterpreterArn],
        }));
      }

      // Browser — needed by supervisor + search + advisor for web research.
      // Granted to ALL execution roles for similar future-proofing.
      if (props.browserArn) {
        executionRole.addToPolicy(new iam.PolicyStatement({
          sid: 'BrowserInvoke',
          // The automation stream WebSocket endpoint is gated by a separate
          // IAM action — grant `bedrock-agentcore:*` on the browser ARN so we
          // pick up whichever specific action AWS uses for stream access
          // (likely AccessBrowserSession / ConnectBrowserAutomationStream).
          actions: ['bedrock-agentcore:*'],
          resources: [props.browserArn, `${props.browserArn}/*`],
        }));
      }

      new cdk.CfnOutput(this, `${pascal}EcrUri`, {
        value: repo.repositoryUri,
        description: `ECR URI for ${agentName} — push ARM64 image then redeploy with --context deployRuntimes=true`,
      });

      if (!deployRuntimes) continue;
      if (onlyAgents && !onlyAgents.has(agentName)) continue;

      // AgentCore Runtime resource (requires image in ECR)
      const runtime = new bedrockagentcore.CfnRuntime(this, `${pascal}Runtime`, {
        agentRuntimeName: safeRuntimeName,
        description: `OrgIQ ${agentName} agent runtime`,
        roleArn: executionRole.roleArn,
        agentRuntimeArtifact: {
          containerConfiguration: {
            containerUri: resolveContainerUri(repo.repositoryUri, runtimeName, this.region),
          },
        },
        networkConfiguration: { networkMode: 'PUBLIC' },
        protocolConfiguration: 'HTTP',
        lifecycleConfiguration: AGENT_LIFECYCLE[agentName] ?? DEFAULT_LIFECYCLE,
        environmentVariables: {
          // 'otlp' ships spans through ADOT into CloudWatch GenAI observability
          // (aws/spans) — feeds the span projector, /recent-invocations, and
          // online evaluation. ('console' was a debugging setting that starved
          // the whole trace pipeline: aws/spans stayed empty.)
          OTEL_TRACES_EXPORTER: 'otlp',
          // ADOT switch: routes spans through the AgentCore-injected OTLP
          // endpoint into CloudWatch GenAI observability (requires the
          // aws-opentelemetry-distro package in the image).
          AGENT_OBSERVABILITY_ENABLED: 'true',
          OTEL_SERVICE_NAME: `orgiq-${agentName}`,
          OTEL_PYTHON_LOG_CORRELATION: 'true',
          OTEL_RESOURCE_ATTRIBUTES: `deployment.environment=dev,service.namespace=orgiq,agent.id=orgiq-${agentName}`,
          OTEL_PYTHON_DISABLED_INSTRUMENTATIONS: '',
          AGENT_NAME: agentName,
          MEMORY_ID: props.memoryId,
          // Sub-agents run without a guardrail — the supervisor enforces at the
          // edge based on the caller's role. Supervisor still gets per-role IDs
          // via GUARDRAIL_ID_MEMBER/ORG_LEADER/HR_ADMIN below.
          // DRAFT means agents always see the latest portal edits without rebuild.
          // Switch to a numbered version (e.g. "2") for audited rollouts.
          GUARDRAIL_VERSION: 'DRAFT',
          MODEL_ID: modelId,
          AURORA_CLUSTER_ARN: props.auroraClusterArn,
          AURORA_SECRET_ARN: props.auroraCredentialsSecretArn,
          KB_ID: props.knowledgeBaseId,
          // Newsroom KB — only injected for the news-researcher agent so it
          // resolves the correct vector space for newsroom article retrieval.
          ...(agentName === 'news-researcher' && props.newsroomKbId && { NEWSROOM_KB_ID: props.newsroomKbId }),
          ...(agentName === 'news-researcher' && props.documentsBucketName && { DOCUMENTS_BUCKET: props.documentsBucketName }),
          PROJECT_PREFIX: prefix,
          ...(props.codeInterpreterId && { CODE_INTERPRETER_ID: props.codeInterpreterId }),
          ...(props.browserId && { BROWSER_ID: props.browserId }),
          ...(props.browserProfileId && { BROWSER_PROFILE_ID: props.browserProfileId }),
          // Supervisor-only edge enforcement: it picks one of three guardrails
          // per request based on the caller's role. Sub-agents trust the
          // supervisor's enforcement and stay on the default guardrail.
          ...(agentName === 'supervisor' && props.guardrailIdMember && { GUARDRAIL_ID_MEMBER: props.guardrailIdMember }),
          ...(agentName === 'supervisor' && props.guardrailIdOrgLeader && { GUARDRAIL_ID_ORG_LEADER: props.guardrailIdOrgLeader }),
          ...(agentName === 'supervisor' && props.guardrailIdHrAdmin && { GUARDRAIL_ID_HR_ADMIN: props.guardrailIdHrAdmin }),
        },
      });

      this.runtimeIds[agentName] = runtime.attrAgentRuntimeId;

      const endpoint = new bedrockagentcore.CfnRuntimeEndpoint(this, `${pascal}Endpoint`, {
        name: `${safeRuntimeName}_endpoint`,
        agentRuntimeId: runtime.attrAgentRuntimeId,
        description: `Default endpoint for ${agentName} agent`,
      });
      endpoint.node.addDependency(runtime);

      new cdk.CfnOutput(this, `${pascal}RuntimeId`, {
        value: runtime.attrAgentRuntimeId,
        exportName: `${prefix}-${agentName}-runtime-id`,
      });
    }

    // Grant capability access to the appropriate agent roles now that both
    // AgentsStack (roles) and AgentCoreCapabilitiesStack (ARNs) are resolved.
    // These grants live here to avoid a cross-stack dependency cycle.
    if (props.codeInterpreterArn) {
      for (const agentName of ['graph-builder', 'scoring'] as const) {
        props.agentRoles[agentName]?.addToPolicy(new iam.PolicyStatement({
          sid: 'CodeInterpreterInvoke',
          actions: [
            'bedrock-agentcore:InvokeCodeInterpreter',
            'bedrock-agentcore:StartCodeInterpreterSession',
            'bedrock-agentcore:StopCodeInterpreterSession',
            'bedrock-agentcore:ExecuteCodeInterpreterCode',
            'bedrock-agentcore:ListCodeInterpreterSessions',
          ],
          resources: [props.codeInterpreterArn],
        }));
      }
    }

    if (props.browserArn) {
      for (const agentName of ['supervisor', 'search', 'advisor'] as const) {
        props.agentRoles[agentName]?.addToPolicy(new iam.PolicyStatement({
          sid: 'BrowserInvoke',
          actions: [
            'bedrock-agentcore:InvokeBrowser',
            'bedrock-agentcore:StartBrowserSession',
            'bedrock-agentcore:StopBrowserSession',
            'bedrock-agentcore:TakeBrowserScreenshot',
            'bedrock-agentcore:ClickBrowserElement',
            'bedrock-agentcore:SendKeystrokesToBrowser',
            'bedrock-agentcore:ScrollBrowserElement',
            'bedrock-agentcore:NavigateBrowserToPage',
            'bedrock-agentcore:GetBrowserPageSource',
          ],
          resources: [props.browserArn],
        }));
      }
    }

    new cdk.CfnOutput(this, 'ModelId', {
      value: modelId,
      exportName: `${prefix}-runtime-model-id`,
    });
  }

  private pascal(name: string): string {
    return name.split('-').map(s => s.charAt(0).toUpperCase() + s.slice(1)).join('');
  }
}
