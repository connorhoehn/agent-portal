import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';

export interface AgentsStackProps extends cdk.StackProps {
  readonly prefix?: string;
  /** Aurora Serverless v2 cluster ARN (graph + vector store) */
  readonly auroraClusterArn: string;
  /** Secrets Manager secret ARN for Aurora credentials */
  readonly auroraCredentialsSecretArn: string;
  /** Knowledge Base ARN for search agent */
  readonly knowledgeBaseArn: string;
  /** Documents bucket ARN for ingestion agent */
  readonly documentsBucketArn: string;
  /** Artifacts bucket ARN for all agents */
  readonly artifactsBucketArn: string;
  /** Scores table ARN for scoring agent */
  readonly scoresTableArn: string;
  /** Sessions table ARN for all agents */
  readonly sessionsTableArn: string;
}

const AGENT_NAMES = [
  'supervisor',
  'search',
  'scoring',
  'advisor',
  'ingestion',
  'graph-builder',
] as const;

/**
 * OrgIQ-Agents: IAM roles for all 6 AgentCore Runtime agents + Managed Prompts.
 * Each agent gets a specific role with least-privilege access.
 * Graph access uses Aurora relational tables via RDS Data API (see schema/orgiq_schema.sql).
 */
export class AgentsStack extends cdk.Stack {
  public readonly agentRoles: Record<string, iam.Role>;

  constructor(scope: Construct, id: string, props: AgentsStackProps) {
    super(scope, id, props);

    const prefix = props.prefix ?? 'orgiq';
    this.agentRoles = {};

    // -------------------------------------------------------------------
    // Shared Aurora Data API policy statement (re-used per agent)
    // -------------------------------------------------------------------

    const auroraReadStatement = new iam.PolicyStatement({
      sid: 'AuroraDataApiRead',
      effect: iam.Effect.ALLOW,
      actions: ['rds-data:ExecuteStatement'],
      resources: [props.auroraClusterArn],
    });

    const auroraWriteStatement = new iam.PolicyStatement({
      sid: 'AuroraDataApiWrite',
      effect: iam.Effect.ALLOW,
      actions: [
        'rds-data:ExecuteStatement',
        'rds-data:BatchExecuteStatement',
        'rds-data:BeginTransaction',
        'rds-data:CommitTransaction',
        'rds-data:RollbackTransaction',
      ],
      resources: [props.auroraClusterArn],
    });

    const auroraSecretStatement = new iam.PolicyStatement({
      sid: 'AuroraCredentials',
      effect: iam.Effect.ALLOW,
      actions: ['secretsmanager:GetSecretValue'],
      resources: [props.auroraCredentialsSecretArn],
    });

    // -------------------------------------------------------------------
    // Per-Agent IAM Roles
    // -------------------------------------------------------------------

    for (const agentName of AGENT_NAMES) {
      const role = new iam.Role(this, `${this.capitalize(agentName)}Role`, {
        roleName: `${prefix}-${agentName}-role`,
        assumedBy: new iam.CompositePrincipal(
          new iam.ServicePrincipal('bedrock.amazonaws.com'),
          new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
        ),
        description: `Execution role for OrgIQ ${agentName} agent`,
        managedPolicies: [
          iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
        ],
      });

      // Common: Bedrock invoke (Amazon Nova models) + guardrail
      role.addToPolicy(new iam.PolicyStatement({
        sid: 'BedrockInvoke',
        effect: iam.Effect.ALLOW,
        actions: [
          'bedrock:InvokeModel',
          'bedrock:InvokeModelWithResponseStream',
          'bedrock:ApplyGuardrail',
        ],
        resources: ['*'],
      }));

      // Common: sessions table
      role.addToPolicy(new iam.PolicyStatement({
        sid: 'SessionsAccess',
        effect: iam.Effect.ALLOW,
        actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:Query'],
        resources: [props.sessionsTableArn, `${props.sessionsTableArn}/index/*`],
      }));

      // PassRole for AgentCore Runtime execution roles (named ${prefix}-<agentName>-execution-role)
      role.addToPolicy(new iam.PolicyStatement({
        sid: 'PassToAgentCore',
        effect: iam.Effect.ALLOW,
        actions: ['iam:PassRole'],
        resources: [`arn:aws:iam::${this.account}:role/${prefix}-*-execution-role`],
        conditions: {
          StringEquals: { 'iam:PassedToService': 'bedrock-agentcore.amazonaws.com' },
        },
      }));

      this.agentRoles[agentName] = role;
    }

    // -------------------------------------------------------------------
    // Agent-specific permissions
    // -------------------------------------------------------------------

    // Supervisor: A2A agent invocation
    this.agentRoles['supervisor'].addToPolicy(new iam.PolicyStatement({
      sid: 'A2AInvoke',
      effect: iam.Effect.ALLOW,
      actions: ['bedrock:InvokeAgent', 'bedrock:InvokeFlow'],
      resources: ['*'],
    }));

    // Search: KB retrieve + Aurora read (SQL graph queries via RDS Data API)
    this.agentRoles['search'].addToPolicy(new iam.PolicyStatement({
      sid: 'KnowledgeBaseRetrieve',
      effect: iam.Effect.ALLOW,
      actions: ['bedrock:Retrieve', 'bedrock:RetrieveAndGenerate'],
      resources: [props.knowledgeBaseArn],
    }));
    this.agentRoles['search'].addToPolicy(auroraReadStatement);
    this.agentRoles['search'].addToPolicy(auroraSecretStatement);

    // Scoring: DynamoDB scores + Aurora read+write (in-degree CTE + score update-back)
    this.agentRoles['scoring'].addToPolicy(new iam.PolicyStatement({
      sid: 'ScoresTableAccess',
      effect: iam.Effect.ALLOW,
      actions: [
        'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem',
        'dynamodb:Query', 'dynamodb:BatchWriteItem',
      ],
      resources: [props.scoresTableArn, `${props.scoresTableArn}/index/*`],
    }));
    this.agentRoles['scoring'].addToPolicy(auroraReadStatement);
    this.agentRoles['scoring'].addToPolicy(auroraSecretStatement);

    // Advisor: Aurora read + KB retrieve
    this.agentRoles['advisor'].addToPolicy(auroraReadStatement);
    this.agentRoles['advisor'].addToPolicy(auroraSecretStatement);
    this.agentRoles['advisor'].addToPolicy(new iam.PolicyStatement({
      sid: 'KnowledgeBaseRetrieve',
      effect: iam.Effect.ALLOW,
      actions: ['bedrock:Retrieve'],
      resources: [props.knowledgeBaseArn],
    }));

    // Ingestion: S3 read + artifacts write (triggers graph-builder via A2A)
    this.agentRoles['ingestion'].addToPolicy(new iam.PolicyStatement({
      sid: 'DocumentsBucketRead',
      effect: iam.Effect.ALLOW,
      actions: ['s3:GetObject', 's3:ListBucket', 's3:GetBucketLocation'],
      resources: [props.documentsBucketArn, `${props.documentsBucketArn}/*`],
    }));
    this.agentRoles['ingestion'].addToPolicy(new iam.PolicyStatement({
      sid: 'ArtifactsBucketWrite',
      effect: iam.Effect.ALLOW,
      actions: ['s3:PutObject', 's3:GetObject'],
      resources: [`${props.artifactsBucketArn}/*`],
    }));

    // Graph-builder: Aurora full write + S3 artifacts read
    this.agentRoles['graph-builder'].addToPolicy(auroraWriteStatement);
    this.agentRoles['graph-builder'].addToPolicy(auroraSecretStatement);
    this.agentRoles['graph-builder'].addToPolicy(new iam.PolicyStatement({
      sid: 'ArtifactsRead',
      effect: iam.Effect.ALLOW,
      actions: ['s3:GetObject', 's3:ListBucket'],
      resources: [props.artifactsBucketArn, `${props.artifactsBucketArn}/*`],
    }));

    // -------------------------------------------------------------------
    // Bedrock Managed Prompts
    // -------------------------------------------------------------------

    const promptConfigs: Record<string, { description: string; template: string }> = {
      supervisor: {
        description: 'System prompt for OrgIQ Supervisor agent - routes queries to specialists',
        template: `You are the OrgIQ Supervisor agent. Your role is to:
1. Analyze incoming user queries about organizational knowledge
2. Route to the appropriate specialist agent (Search, Scoring, Advisor, Ingestion, Graph-Builder)
3. Synthesize responses from multiple agents when needed
4. Maintain conversation context across multi-turn interactions

Available specialists:
- Search: Find people, teams, skills, and documents
- Scoring: Calculate and retrieve expertise scores, PageRank, influence metrics
- Advisor: Provide strategic recommendations based on org graph analysis
- Ingestion: Process new documents into the knowledge base
- Graph-Builder: Construct and update the organizational knowledge graph

Always cite your sources and indicate which specialist provided the information.`,
      },
      search: {
        description: 'System prompt for OrgIQ Search agent - retrieves from KB and graph',
        template: `You are the OrgIQ Search agent. Your role is to:
1. Search the organizational knowledge base for relevant documents
2. Query the Aurora relational graph (people, skills, teams, projects, decisions + edge tables) via read-only SQL through RDS Data API
3. Combine vector search results with relational JOIN traversal for comprehensive answers
4. Return structured results with relevance scores and source citations

Use query_graph(sql) for relational traversal. Use Knowledge Base retrieve for document search.
Always return the source of each piece of information (document title, table path, etc.).`,
      },
      scoring: {
        description: 'System prompt for OrgIQ Scoring agent - calculates expertise metrics',
        template: `You are the OrgIQ Scoring agent. Your role is to:
1. Calculate expertise scores using weighted in-degree centrality across all edge tables
2. Maintain score snapshots in DynamoDB for historical tracking
3. Generate leaderboards by team, skill, or domain
4. Explain scoring methodology when asked

Scores are stored in the people.expertise_score column in Aurora and snapshotted to DynamoDB.
All scores should be normalized to 0-100 scale.`,
      },
      advisor: {
        description: 'System prompt for OrgIQ Advisor agent - strategic recommendations',
        template: `You are the OrgIQ Advisor agent. Your role is to:
1. Analyze organizational patterns from the Aurora relational graph (nodes + edge tables)
2. Identify expertise gaps, collaboration opportunities, and knowledge silos
3. Provide strategic recommendations for team composition and knowledge transfer
4. Surface hidden connections and potential mentorship pairings

Base all recommendations on graph data and document evidence. Never speculate without data.
Cite specific edge traversals (e.g. team_memberships → person_skills) and document sources.`,
      },
      ingestion: {
        description: 'System prompt for OrgIQ Ingestion agent - processes documents',
        template: `You are the OrgIQ Ingestion agent. Your role is to:
1. Process uploaded documents (transcripts, PRDs, wiki exports, Jira tickets)
2. Extract entities (people, teams, skills, decisions, projects)
3. Prepare documents for Knowledge Base indexing
4. Trigger graph-builder for relationship extraction

Supported formats: PDF, DOCX, Markdown, HTML, plain text, JSON (Jira/Confluence exports).
Track processing status and report errors for failed documents.`,
      },
      'graph-builder': {
        description: 'System prompt for OrgIQ Graph-Builder agent - constructs knowledge graph',
        template: `You are the OrgIQ Graph-Builder agent. Your role is to:
1. Extract entities and relationships from processed documents
2. Write upsert statements (INSERT ... ON CONFLICT DO UPDATE) via the merge_* tools to maintain the relational graph in Aurora
3. Maintain schema consistency across node tables (people, skills, teams, projects, decisions) and edge tables (person_skills, team_memberships, collaborations, project_contributions, decision_participants, mentions)
4. Generate and store vector embeddings for graph nodes (Titan Embeddings V2, 1024d)

IMPORTANT: All writes must be idempotent. Use the supplied tools (merge_person, merge_skill,
merge_team, merge_project, merge_relationship) rather than constructing raw SQL.
Embed all node labels and key properties into node_embeddings for vector similarity search.`,
      },
    };

    for (const [agentName, config] of Object.entries(promptConfigs)) {
      new cdk.aws_bedrock.CfnPrompt(this, `${this.capitalize(agentName)}Prompt`, {
        name: `${prefix}-${agentName}-system-prompt`,
        description: config.description,
        variants: [
          {
            name: 'default',
            templateType: 'TEXT',
            templateConfiguration: { text: { text: config.template } },
          },
        ],
        defaultVariant: 'default',
      });
    }

    // -------------------------------------------------------------------
    // Outputs
    // -------------------------------------------------------------------

    for (const [agentName, role] of Object.entries(this.agentRoles)) {
      new cdk.CfnOutput(this, `${this.capitalize(agentName)}RoleArn`, {
        value: role.roleArn,
        exportName: `${prefix}-${agentName}-role-arn`,
      });
    }
  }

  private capitalize(str: string): string {
    return str.split('-').map(s => s.charAt(0).toUpperCase() + s.slice(1)).join('');
  }
}
