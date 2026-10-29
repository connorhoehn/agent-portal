import { execFileSync } from 'child_process';
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as bedrockagentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import type { Construct } from 'constructs';
import { DEFAULT_MODEL_REGISTRY_FILE, loadModelRegistry, primaryModelFor } from './model-registry';

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
  /** Literal id, or leave unset and pass `memoryIdParameter` (SSM name published by the memory stack). */
  readonly memoryId?: string;
  readonly memoryIdParameter?: string;
  /** Per-role guardrail IDs — supervisor selects one based on caller's role. */
  readonly guardrailIdMember?: string;
  readonly guardrailIdOrgLeader?: string;
  readonly guardrailIdHrAdmin?: string;
  readonly auroraClusterArn: string;
  readonly auroraCredentialsSecretArn: string;
  /**
   * ARN of the `orgiq_graph_reader` credential minted by `OrgIQ-Aurora`.
   *
   * When omitted, resolves `<prefix>-aurora-readonly-secret-arn`.
   * Reader provisioning is a deployment prerequisite, never an admin fallback.
   */
  readonly auroraReadOnlySecretArn?: string;
  readonly knowledgeBaseId: string;
  /**
   * Fleet-wide model override. Unset (the default), each runtime's cold
   * `MODEL_ID` is its role's `primary` in the model registry (DE-3).
   */
  readonly modelId?: string;
  /** Registry file; defaults to `infra/config/model-registry.json` (or `--context modelRegistryFile=`). */
  readonly modelRegistryFile?: string;
  readonly codeInterpreterId?: string;
  readonly codeInterpreterArn?: string;
  readonly browserId?: string;
  readonly browserArn?: string;
  readonly browserProfileId?: string;

  // ── Machine-callback auth (matches middleware-service-stack.ts) ──────────
  // Plain string values, NOT Secrets Manager ARNs — see the long comment
  // where these are consumed below for why. Only supervisor + the two
  // assessment agents call these callbacks today, but every runtime gets the
  // same three env vars (cheap, and future agents may grow a callback too);
  // an unset value is simply omitted rather than sent as "undefined".
  readonly approvalsRequestSecret?: string;
  readonly harnessTraceSecret?: string;
  readonly assessmentRunCompleteSecret?: string;
  /**
   * The middleware as a deployed runtime reaches it (`MIDDLEWARE_URL`,
   * agents/_shared/callbacks.py, approval_tool.py, instrumentation.py).
   * Unset, the agents fall back to `http://middleware:3001` — the compose
   * service name, which resolves nowhere in AWS — so the approval request,
   * its poll and the assessment run-complete callback cannot arrive (traces
   * still do, via stdout → CloudWatch → the middleware's poller). Runtimes run
   * in PUBLIC network mode from AWS addresses no `albAllowCidr` lists, so the
   * reachable value is the CloudFront portal URL (OrgIQ-Portal), which the ALB
   * admits by its origin-verify header: `--context portalPublicUrl=https://…`
   * (or `middlewareCallbackUrl` to name something else). See
   * docs/social-calls-deploy-plan.md §10.
   */
  readonly middlewareUrl?: string;
}

export const AGENT_NAMES = [
  'supervisor',
  'search',
  'scoring',
  'advisor',
  'ingestion',
  'graph-builder',
  'assessment-scorer',
  'assessment-drafter',
] as const;

const ALL_AGENT_NAMES = AGENT_NAMES;

/**
 * The two agents that hand *model-authored* SQL to the RDS Data API.
 *
 * `search` and `advisor` expose `query_graph(sql)`: the model writes the
 * statement, the agent runs it verbatim. `agents/_shared/sql_guard.py`
 * inspects it first and stays in place, but a regex over SQL a prompt
 * injection can influence is an argument about parsing — and the attacker
 * picks the argument. `schema/graph_readonly_role.sql` creates
 * `orgiq_graph_reader`, which holds SELECT on the org-graph tables and nothing
 * else; these two runtimes read as that role.
 *
 * Only these two. Every other agent writes (ingestion syncs the KB,
 * graph-builder upserts the graph, scoring updates score columns) and keeps
 * the admin credential.
 */
const READ_AGENTS = new Set<(typeof ALL_AGENT_NAMES)[number]>(['search', 'advisor']);

// Explicit session lifecycle per agent. The service defaults are 900s idle /
// 28800s max — set explicitly so the numbers live in source rather than being
// implicit, and tuned per agent:
//  - supervisor: 1800s idle — it fronts multi-turn AG-UI sessions, and a
//    warm microVM avoids the ~8s cold-start TTFT penalty between user turns.
//  - everything else: 600s idle — sub-agents are invoked per-request (A2A or
//    direct); releasing the workload sooner is pure cost hygiene with no UX
//    cost (they cold-start per invocation anyway).
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
    // DE-3: one versioned registry document in SSM, validated at synth (a
    // non-AWS-native id fails the synth). Agents re-read it every 60 s, so an
    // edit to the parameter rolls no runtime; MODEL_ID below is only the cold
    // fallback. DE-5 gates the parameter write, not the deploy.
    const modelRegistryFile = props.modelRegistryFile
      ?? (this.node.tryGetContext('modelRegistryFile') as string | undefined)
      ?? DEFAULT_MODEL_REGISTRY_FILE;
    const modelRegistry = loadModelRegistry(modelRegistryFile);
    const modelRegistryJson = JSON.stringify(modelRegistry);
    if (Buffer.byteLength(modelRegistryJson, 'utf8') > 4096) {
      throw new Error(`${modelRegistryFile}: registry exceeds the 4 KB SSM standard-tier limit`);
    }
    const modelRegistryParamName = `/${prefix}/models/registry`;
    const modelRegistryParam = new ssm.StringParameter(this, 'ModelRegistryParam', {
      parameterName: modelRegistryParamName,
      stringValue: modelRegistryJson,
      tier: ssm.ParameterTier.STANDARD,
      description: 'OrgIQ model registry (DE-3), written from infra/config/model-registry.json',
    });
    // Optional pin to an SSM parameter version while a DE-5 gate judges a change.
    const modelRegistryVersion = this.node.tryGetContext('modelRegistryVersion') as string | undefined;
    // DE-4: a fleet-wide hard pin to one numbered Bedrock prompt version. DRAFT
    // is refused here (and by prompt_source.py under APP_ENV=production): the
    // working copy is never what the deployed fleet runs.
    const systemPromptVersion = this.node.tryGetContext('systemPromptVersion') as string | undefined;
    if (systemPromptVersion !== undefined && !/^[1-9]\d*$/.test(String(systemPromptVersion))) {
      throw new Error(`systemPromptVersion must be a numbered Bedrock prompt version (got "${systemPromptVersion}"); DRAFT is not deployable`);
    }
    const memoryId = props.memoryIdParameter
      ? ssm.StringParameter.valueForStringParameter(this, props.memoryIdParameter)
      : (props.memoryId ?? '');
    if (props.middlewareUrl !== undefined && !/^https?:\/\/[^/\s]+\/?$/.test(props.middlewareUrl)) {
      throw new Error(`middlewareUrl must be an origin (https://host), got ${props.middlewareUrl}`);
    }

    // Phase 1 (default): create ECR repos + execution roles
    // Phase 2 (after images pushed): add CfnRuntime + CfnRuntimeEndpoint
    //   cdk deploy OrgIQ-AgentCoreRuntime --context deployRuntimes=true
    //
    // Optionally restrict to a subset of agents whose images are actually in
    // ECR via --context onlyAgents=supervisor[,search,...]. When unset, every
    // runtime in ALL_AGENT_NAMES is created (which requires every one of
    // those images to exist).
    const deployRuntimes = this.node.tryGetContext('deployRuntimes') === 'true';
    const onlyAgentsCtx = this.node.tryGetContext('onlyAgents') as string | undefined;
    const onlyAgents = onlyAgentsCtx
      ? new Set(onlyAgentsCtx.split(',').map(s => s.trim()).filter(Boolean))
      : null;
    // A runtime left out of the template is DELETED, so onlyAgents on a live
    // stack removed every runtime it did not name (DE-1). deploy.sh passes the
    // live runtimes' logical ids as liveRuntimeIds; leaving one out is refused
    // unless the operator says allowRuntimeDelete=true. onlyAgents stays the
    // tool for a first partial deploy.
    const liveRuntimeIds = new Set(String(this.node.tryGetContext('liveRuntimeIds') ?? '')
      .split(',').map(s => s.trim()).filter(Boolean));
    const allowRuntimeDelete = this.node.tryGetContext('allowRuntimeDelete') === 'true'
      || this.node.tryGetContext('allowRuntimeDelete') === true;
    if (deployRuntimes && onlyAgents && !allowRuntimeDelete) {
      const dropped = ALL_AGENT_NAMES.filter(name => !onlyAgents.has(name)
        && liveRuntimeIds.has(`${this.pascal(name)}Runtime`));
      if (dropped.length) {
        throw new Error(`onlyAgents=${onlyAgentsCtx} would delete live runtime(s): ${dropped.join(', ')}. `
          + 'Name every live agent, or pass --context allowRuntimeDelete=true to delete them on purpose.');
      }
    }

    // Read-only credentials are mandatory for model-authored SQL. Deploy the
    // Aurora reader secret and apply its role/password before enabling runtimes.
    // A missing prerequisite must fail closed, never restore admin access.
    if (this.node.tryGetContext('readOnlyGraphRole') === 'false') {
      throw new Error('readOnlyGraphRole cannot be disabled; apply docs/readonly-graph-role.md');
    }
    const readOnlySecretArn = props.auroraReadOnlySecretArn
      ?? cdk.Fn.importValue(`${prefix}-aurora-readonly-secret-arn`);

    // Shared base image for every internally-managed agent. Built once via agents/base/build.sh
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
      if (!agentRole) continue;

      const pascal = this.pascal(agentName);
      const runtimeName = `${prefix}-${agentName}`;
      // agentRuntimeName and endpoint name must match [a-zA-Z][a-zA-Z0-9_]{0,47} — no hyphens
      const safeRuntimeName = `${prefix}_${agentName.replace(/-/g, '_')}`;

      const repo: ecr.IRepository = new ecr.Repository(this, `${pascal}Repo`, {
        repositoryName: runtimeName,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        emptyOnDelete: true,
        lifecycleRules: [{ maxImageCount: 5 }],
      });
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
                // Agents resolve their system prompt from Bedrock Prompt
                // Management at run time (agents/_shared/prompt_source.py), so
                // a Prompt Studio edit reaches the deployed agent without an
                // image rebuild. Read-only: an agent must never mutate the
                // library. NOTE: this must live on the *runtime execution*
                // role — the OrgIQ-Agents `<agent>-role` is a different
                // principal and granting it there has no effect at run time.
                sid: 'BedrockPromptRead',
                actions: ['bedrock:GetPrompt', 'bedrock:ListPrompts'],
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

      // DE-3: every agent reads the model registry parameter (read-only).
      executionRole.addToPolicy(new iam.PolicyStatement({
        sid: 'ModelRegistryRead',
        actions: ['ssm:GetParameter'],
        resources: [modelRegistryParam.parameterArn],
      }));

      // DE-4: the agent's own prompt pointers (`/live`, `/candidate`), read
      // with one GetParameters. Read-only, and scoped to this agent's path:
      // no agent can read another's pointer, and none can move one. The
      // pointers themselves are written by infra/scripts/prompt-pointers.ts
      // (bootstrap, candidate, promote, rollback), never by CDK, because a
      // pointer names a version number that only exists after a publish.
      executionRole.addToPolicy(new iam.PolicyStatement({
        sid: 'PromptPointerRead',
        actions: ['ssm:GetParameter', 'ssm:GetParameters'],
        resources: [
          cdk.Stack.of(this).formatArn({
            service: 'ssm',
            resource: 'parameter',
            resourceName: `${prefix}/prompts/${agentName}/*`,
            arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
          }),
        ],
      }));

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
      // Which Aurora credential this runtime may read.
      //
      // For the two read agents with the read-only role turned on, this is an
      // EXCLUSIVE swap, not an addition: they get `orgiq_graph_reader` and
      // lose GetSecretValue on the admin secret entirely. That is the point —
      // a boundary the agent could step around by fetching the other secret is
      // a suggestion. `search` and `advisor` touch Aurora in exactly two
      // places (`query_graph` and the `knowledge_bases` lookup in
      // `_shared/kb_resolver.py`), both pure SELECTs, so neither has any
      // remaining use for a writable login.
      const useReadOnlySecret = readOnlySecretArn !== undefined && READ_AGENTS.has(agentName);
      executionRole.addToPolicy(new iam.PolicyStatement({
        sid: 'AuroraSecret',
        actions: ['secretsmanager:GetSecretValue'],
        resources: [useReadOnlySecret ? readOnlySecretArn! : props.auroraCredentialsSecretArn],
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
          OTEL_SERVICE_NAME: `${prefix}-${agentName}`,
          OTEL_PYTHON_LOG_CORRELATION: 'true',
          OTEL_RESOURCE_ATTRIBUTES: `deployment.environment=dev,service.namespace=orgiq,agent.id=${prefix}-${agentName}`,
          OTEL_PYTHON_DISABLED_INSTRUMENTATIONS: '',
          AGENT_NAME: agentName,
          // Live system prompts (DE-4): each agent reads the promoted version
          // through its pointer, `/${prefix}/prompts/<agent>/live` (and the
          // `/candidate` arm while a promotion is in flight), every
          // PROMPT_REFRESH_S. The pointer carries the Bedrock prompt id and a
          // numbered version, so the fleet never lists prompts and never runs
          // the studio's DRAFT working copy: a `PUT …/draft` reaches production
          // only once publish + promote move the pointer. SYSTEM_PROMPT_NAME
          // stays for `agentcore dev` and the name lookup when no pointer is
          // set; `--context systemPromptVersion=<n>` is a fleet-wide hard pin.
          // Set PROMPT_SOURCE_DISABLED=1 to pin an agent to its baked prompt.
          SYSTEM_PROMPT_NAME: `${prefix}-${agentName}-system-prompt`,
          SYSTEM_PROMPT_POINTER: `/${prefix}/prompts/${agentName}`,
          ...(systemPromptVersion && { SYSTEM_PROMPT_VERSION: systemPromptVersion }),
          PROMPT_REFRESH_S: '60',
          MEMORY_ID: memoryId,
          // Sub-agents run without a guardrail — the supervisor enforces at the
          // edge based on the caller's role. Supervisor still gets per-role IDs
          // via GUARDRAIL_ID_MEMBER/ORG_LEADER/HR_ADMIN below.
          // DRAFT means agents always see the latest portal edits without rebuild.
          // Switch to a numbered version (e.g. "2") for audited rollouts.
          GUARDRAIL_VERSION: 'DRAFT',
          MODEL_ID: props.modelId ?? primaryModelFor(modelRegistry, agentName, modelId),
          MODEL_REGISTRY_PARAM: modelRegistryParamName,
          ...(modelRegistryVersion && { MODEL_REGISTRY_VERSION: String(modelRegistryVersion) }),
          AURORA_CLUSTER_ARN: props.auroraClusterArn,
          AURORA_SECRET_ARN: props.auroraCredentialsSecretArn,
          APP_ENV: 'production',
          // Read agents cannot fall back to the administrator credential.
          ...(useReadOnlySecret && { AURORA_READONLY_SECRET_ARN: readOnlySecretArn! }),
          KB_ID: props.knowledgeBaseId,
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
          // Machine-callback auth, mirroring middleware-service-stack.ts's
          // APPROVALS_REQUEST_SECRET / HARNESS_TRACE_SECRET /
          // ASSESSMENT_RUN_COMPLETE_SECRET container secrets. These arrive
          // here as PLAIN STRINGS via CDK context (--context
          // approvalsRequestSecret=..., see app.ts), not as Secrets Manager
          // ARNs, for two reasons:
          //   1. Ordering: this stack is instantiated (and normally deployed
          //      — see CLAUDE.md's "genuine second phase" gotcha) before
          //      OrgIQ-MiddlewareService in app.ts, and neither stack
          //      declares a dependency on the other. An Fn.importValue here
          //      would reference a CloudFormation export that doesn't exist
          //      yet on this stack's first deploy, breaking `deployRuntimes`
          //      well before the ordering problem this comment describes was
          //      even relevant.
          //   2. Even with the ARN in hand, AWS::BedrockAgentCore::Runtime's
          //      EnvironmentVariables is a bare string map — unlike ECS
          //      TaskDefinition, this resource type has no `Secret` /
          //      fromSecretsManager equivalent that pulls the value at
          //      container start. The only way to get a Secrets Manager
          //      value in here at all is a raw CloudFormation dynamic
          //      reference resolved by the CFN service before the
          //      CreateAgentRuntime/UpdateAgentRuntime call — which would
          //      still land as plaintext in the runtime's environment
          //      (visible to anyone with bedrock-agentcore:GetAgentRuntime),
          //      defeating the point of Secrets Manager, on a resource type
          //      new enough that dynamic-reference support isn't confirmed.
          //      Rather than invent that mechanism, this stays a plain
          //      context value the operator copies in by hand.
          //
          // Runbook: after `OrgIQ-MiddlewareService` mints the three
          // secrets, `aws secretsmanager get-secret-value` each one and
          // redeploy this stack with all three --context values set. See
          // docs/agentcore-preview-surface.md for the full sequencing.
          ...(props.approvalsRequestSecret && { APPROVALS_REQUEST_SECRET: props.approvalsRequestSecret }),
          ...(props.harnessTraceSecret && { HARNESS_TRACE_SECRET: props.harnessTraceSecret }),
          ...(props.assessmentRunCompleteSecret && { ASSESSMENT_RUN_COMPLETE_SECRET: props.assessmentRunCompleteSecret }),
          // Where those callbacks go — see `middlewareUrl` on the props.
          ...(props.middlewareUrl && { MIDDLEWARE_URL: props.middlewareUrl }),
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
