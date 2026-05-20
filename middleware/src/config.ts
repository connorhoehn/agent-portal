import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env.aws (CloudFormation-derived resource IDs) on import. Process env wins.
const envPath = resolve(__dirname, '../.env.aws');
try {
  const text = readFileSync(envPath, 'utf8');
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && process.env[m[1]!] === undefined) {
      process.env[m[1]!] = m[2];
    }
  }
} catch {
  // .env.aws is optional — middleware can run in pure mock mode without it.
}

const env = (key: string, fallback = ''): string => process.env[key] ?? fallback;
const flag = (key: string): boolean => process.env[key] === 'true';

export const config = {
  port: parseInt(env('PORT', '3001'), 10),
  region: env('AWS_REGION', 'us-east-1'),
  accountId: env('AWS_ACCOUNT_ID'),

  // Per-domain mock kill-switches. When true, the provider returns mock data
  // instead of calling AWS. Use for offline dev or when a stack is scaled to zero.
  mock: {
    aurora: flag('MOCK_AURORA'),
    agentcore: flag('MOCK_AGENTCORE'),
    guardrails: flag('MOCK_GUARDRAILS'),
    cloudwatch: flag('MOCK_CLOUDWATCH'),
  },

  aurora: {
    clusterArn: env('AURORA_CLUSTER_ARN'),
    secretArn: env('AURORA_SECRET_ARN'),
    database: env('AURORA_DB_NAME', 'orgiq'),
  },

  foundation: {
    scoresTable: env('SCORES_TABLE', 'orgiq-scores'),
    sessionsTable: env('SESSIONS_TABLE', 'orgiq-sessions'),
    documentsBucket: env('DOCUMENTS_BUCKET'),
    artifactsBucket: env('ARTIFACTS_BUCKET'),
  },

  knowledgeBase: {
    id: env('KNOWLEDGE_BASE_ID'),
  },

  guardrail: {
    id: env('GUARDRAIL_ID'),
    version: env('GUARDRAIL_VERSION', '1'),
    // Per-role guardrail IDs. Middleware passes the matching one to the
    // supervisor on each invoke based on the caller's session role.
    byRole: {
      member: env('GUARDRAIL_ID_MEMBER') || env('GUARDRAIL_ID'),
      'org-leader': env('GUARDRAIL_ID_ORG_LEADER') || env('GUARDRAIL_ID'),
      'hr-admin': env('GUARDRAIL_ID_HR_ADMIN') || env('GUARDRAIL_ID'),
    },
  },

  auth: {
    policyStoreId: env('POLICY_STORE_ID'),
    sessionSigningSecretArn: env('SESSION_SIGNING_SECRET_ARN'),
  },

  agentcore: {
    memoryId: env('MEMORY_ID'),
    browserId: env('BROWSER_ID'),
    browserProfileId: env('BROWSER_PROFILE_ID'),
    codeInterpreterId: env('CODE_INTERPRETER_ID'),
    workloadIdentityArn: env('WORKLOAD_IDENTITY_ARN'),
    policyEngineId: env('POLICY_ENGINE_ID'),
    gatewayId: env('GATEWAY_ID'),
    gatewayUrl: env('GATEWAY_URL'),
  },

  telemetry: {
    qualityEvaluatorId: env('QUALITY_EVALUATOR_ID'),
    toolSelectionEvaluatorId: env('TOOL_SELECTION_EVALUATOR_ID'),
  },

  ecr: {
    supervisor: env('SUPERVISOR_ECR_URI'),
    search: env('SEARCH_ECR_URI'),
    scoring: env('SCORING_ECR_URI'),
    advisor: env('ADVISOR_ECR_URI'),
    ingestion: env('INGESTION_ECR_URI'),
    graphBuilder: env('GRAPH_BUILDER_ECR_URI'),
  },

  canary: {
    subjectAArn: process.env.CANARY_SUBJECT_A_ARN ?? '',
    subjectBArn: process.env.CANARY_SUBJECT_B_ARN ?? '',
    judgeArn: process.env.CANARY_JUDGE_PROMPT_ARN ?? '',
    name: process.env.CANARY_NAME ?? 'orgiq-expert-explainer',
    scoresLogGroup: process.env.CANARY_SCORES_LOG_GROUP ?? '/orgiq/canary/scores',
  },
} as const;
