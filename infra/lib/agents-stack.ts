import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';

export interface AgentsStackProps extends cdk.StackProps {
  readonly prefix?: string;
  /** Neptune Analytics graph ARN for graph-builder and search agents */
  readonly neptuneGraphArn: string;
  /** Knowledge Base ARN for search agent */
  readonly knowledgeBaseArn: string;
  /** Guardrail ARN to apply to all agents */
  readonly guardrailArn: string;
  /** Documents bucket ARN for ingestion agent */
  readonly documentsBucketArn: string;
  /** Artifacts bucket ARN for all agents */
  readonly artifactsBucketArn: string;
  /** Scores table ARN for scoring agent */
  readonly scoresTableArn: string;
  /** Sessions table ARN for all agents */
  readonly sessionsTableArn: string;
}

/**
 * Agent names as defined in CLAUDE.md:
 * orgiq-supervisor, orgiq-search, orgiq-scoring, orgiq-advisor,
 * orgiq-ingestion, orgiq-graph-builder
 */
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
 */
export class AgentsStack extends cdk.Stack {
  /** Map of agent name to its IAM role */
  public readonly agentRoles: Record<string, iam.Role>;

  constructor(scope: Construct, id: string, props: AgentsStackProps) {
    super(scope, id, props);

    const prefix = props.prefix ?? 'orgiq';
    this.agentRoles = {};

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

      // Common permissions: Bedrock invoke + guardrail apply
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

      // Session table access for all agents
      role.addToPolicy(new iam.PolicyStatement({
        sid: 'SessionsAccess',
        effect: iam.Effect.ALLOW,
        actions: [
          'dynamodb:GetItem',
          'dynamodb:PutItem',
          'dynamodb:UpdateItem',
          'dynamodb:Query',
        ],
        resources: [props.sessionsTableArn, `${props.sessionsTableArn}/index/*`],
      }));

      this.agentRoles[agentName] = role;
    }

    // -------------------------------------------------------------------
    // Agent-specific permissions
    // -------------------------------------------------------------------

    // Supervisor: can invoke other agents (A2A)
    this.agentRoles['supervisor'].addToPolicy(new iam.PolicyStatement({
      sid: 'A2AInvoke',
      effect: iam.Effect.ALLOW,
      actions: [
        'bedrock:InvokeAgent',
        'bedrock:InvokeFlow',
      ],
      resources: ['*'],
    }));

    // Search: Knowledge Base retrieve + Neptune read
    this.agentRoles['search'].addToPolicy(new iam.PolicyStatement({
      sid: 'KnowledgeBaseRetrieve',
      effect: iam.Effect.ALLOW,
      actions: ['bedrock:Retrieve', 'bedrock:RetrieveAndGenerate'],
      resources: [props.knowledgeBaseArn],
    }));
    this.agentRoles['search'].addToPolicy(new iam.PolicyStatement({
      sid: 'NeptuneRead',
      effect: iam.Effect.ALLOW,
      actions: [
        'neptune-graph:ReadDataViaQuery',
        'neptune-graph:GetQueryStatus',
        'neptune-graph:GetGraphSummary',
      ],
      resources: [props.neptuneGraphArn],
    }));

    // Scoring: DynamoDB scores table + Neptune read for graph metrics
    this.agentRoles['scoring'].addToPolicy(new iam.PolicyStatement({
      sid: 'ScoresTableAccess',
      effect: iam.Effect.ALLOW,
      actions: [
        'dynamodb:GetItem',
        'dynamodb:PutItem',
        'dynamodb:UpdateItem',
        'dynamodb:Query',
        'dynamodb:BatchWriteItem',
      ],
      resources: [props.scoresTableArn, `${props.scoresTableArn}/index/*`],
    }));
    this.agentRoles['scoring'].addToPolicy(new iam.PolicyStatement({
      sid: 'NeptuneRead',
      effect: iam.Effect.ALLOW,
      actions: [
        'neptune-graph:ReadDataViaQuery',
        'neptune-graph:GetGraphSummary',
      ],
      resources: [props.neptuneGraphArn],
    }));

    // Advisor: Neptune read + KB retrieve (combines graph context with docs)
    this.agentRoles['advisor'].addToPolicy(new iam.PolicyStatement({
      sid: 'NeptuneRead',
      effect: iam.Effect.ALLOW,
      actions: [
        'neptune-graph:ReadDataViaQuery',
        'neptune-graph:GetGraphSummary',
      ],
      resources: [props.neptuneGraphArn],
    }));
    this.agentRoles['advisor'].addToPolicy(new iam.PolicyStatement({
      sid: 'KnowledgeBaseRetrieve',
      effect: iam.Effect.ALLOW,
      actions: ['bedrock:Retrieve'],
      resources: [props.knowledgeBaseArn],
    }));

    // Ingestion: S3 read + write, Neptune write
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

    // Graph-builder: Neptune full write + S3 artifacts read
    this.agentRoles['graph-builder'].addToPolicy(new iam.PolicyStatement({
      sid: 'NeptuneFullAccess',
      effect: iam.Effect.ALLOW,
      actions: [
        'neptune-graph:ReadDataViaQuery',
        'neptune-graph:WriteDataViaQuery',
        'neptune-graph:DeleteDataViaQuery',
        'neptune-graph:GetQueryStatus',
        'neptune-graph:CancelQuery',
        'neptune-graph:GetGraphSummary',
      ],
      resources: [props.neptuneGraphArn],
    }));
    this.agentRoles['graph-builder'].addToPolicy(new iam.PolicyStatement({
      sid: 'ArtifactsRead',
      effect: iam.Effect.ALLOW,
      actions: ['s3:GetObject', 's3:ListBucket'],
      resources: [props.artifactsBucketArn, `${props.artifactsBucketArn}/*`],
    }));

    // -------------------------------------------------------------------
    // Bedrock Managed Prompts (versioned system prompts for each agent)
    // -------------------------------------------------------------------

    const promptConfigs: Record<string, { description: string; template: string }> = {
      supervisor: {
        description: 'System prompt for OrgIQ Supervisor agent — routes queries to specialists',
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
        description: 'System prompt for OrgIQ Search agent — retrieves from KB and graph',
        template: `You are the OrgIQ Search agent. Your role is to:
1. Search the organizational knowledge base for relevant documents
2. Query the Neptune knowledge graph for people, teams, skills, and relationships
3. Combine vector search results with graph traversal for comprehensive answers
4. Return structured results with relevance scores and source citations

Use openCypher queries for graph traversal. Use Knowledge Base retrieve for document search.
Always return the source of each piece of information (document title, graph path, etc.).`,
      },
      scoring: {
        description: 'System prompt for OrgIQ Scoring agent — calculates expertise metrics',
        template: `You are the OrgIQ Scoring agent. Your role is to:
1. Calculate expertise scores using PageRank, betweenness centrality, and custom algorithms
2. Maintain score snapshots in DynamoDB for historical tracking
3. Generate leaderboards by team, skill, or domain
4. Explain scoring methodology when asked

Scores are stored as properties on Person nodes in the graph.
Use the Code Interpreter for complex graph algorithms.
All scores should be normalized to 0-100 scale.`,
      },
      advisor: {
        description: 'System prompt for OrgIQ Advisor agent — strategic recommendations',
        template: `You are the OrgIQ Advisor agent. Your role is to:
1. Analyze organizational patterns from the knowledge graph
2. Identify expertise gaps, collaboration opportunities, and knowledge silos
3. Provide strategic recommendations for team composition and knowledge transfer
4. Surface hidden connections and potential mentorship pairings

Base all recommendations on graph data and document evidence. Never speculate without data.
Cite specific graph relationships and document sources.`,
      },
      ingestion: {
        description: 'System prompt for OrgIQ Ingestion agent — processes documents',
        template: `You are the OrgIQ Ingestion agent. Your role is to:
1. Process uploaded documents (transcripts, PRDs, wiki exports, Jira tickets)
2. Extract entities (people, teams, skills, decisions, projects)
3. Prepare documents for Knowledge Base indexing
4. Trigger graph-builder for relationship extraction

Supported formats: PDF, DOCX, Markdown, HTML, plain text, JSON (Jira/Confluence exports).
Track processing status and report errors for failed documents.`,
      },
      'graph-builder': {
        description: 'System prompt for OrgIQ Graph-Builder agent — constructs knowledge graph',
        template: `You are the OrgIQ Graph-Builder agent. Your role is to:
1. Extract entities and relationships from processed documents
2. Write openCypher MERGE statements to build the knowledge graph
3. Maintain graph schema consistency (Person, Team, Skill, Decision, Project nodes)
4. Generate and store vector embeddings for graph nodes (Titan Embeddings V2, 1024d)

IMPORTANT: Use MERGE over CREATE for idempotent graph writes.
Neptune Analytics is openCypher ONLY — never use Gremlin or SPARQL.
Embed all node labels and key properties for vector similarity search.`,
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
            templateConfiguration: {
              text: {
                text: config.template,
              },
            },
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
