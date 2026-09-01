import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Load .env.aws (CloudFormation-derived resource IDs) on import. Process env
 * wins — except that "process env wins" is only true for a var that is SET,
 * and the offline scripts were trying to unset by blanking:
 * `SESSION_SIGNING_SECRET_ARN= npm run …`. An empty assignment does not
 * survive every shell/npm path reliably, and when it is dropped the var is
 * `undefined`, so the loader below helpfully supplies the deployed ARN and the
 * offline server tries to reach Secrets Manager. Sessions then 500 with
 * `UnrecognizedClientException` — an AWS error, in the mode whose whole point
 * is not needing AWS.
 *
 * DEV_OFFLINE skips the file outright. That is what the offline scripts
 * actually mean, and it covers the whole family at once rather than one var at
 * a time: the policy store, the signing key, Cognito, and the capability ids
 * (BROWSER_ID, MEMORY_ID, CODE_INTERPRETER_ID) that CLAUDE.md records as
 * silently rotting across rebuilds.
 */
const envPath = resolve(__dirname, '../.env.aws');
try {
  if (process.env['DEV_OFFLINE'] === 'true') throw new Error('offline');
  const text = readFileSync(envPath, 'utf8');
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && process.env[m[1]!] === undefined) {
      process.env[m[1]!] = m[2];
    }
  }
} catch {
  // .env.aws is optional — middleware runs in pure mock mode without it, and
  // DEV_OFFLINE takes this path deliberately.
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
    // @deprecated — prefer /api/admin/kb-registry for multi-KB routing.
    // Kept for backward-compat with existing ingest routes and agents.
    id: env('KNOWLEDGE_BASE_ID'),
    // IAM role ARN that Bedrock assumes when accessing Aurora + S3 for new KBs.
    // Must be passed as iam:PassRole when calling CreateKnowledgeBase.
    serviceRoleArn: env('KB_SERVICE_ROLE_ARN'),
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

  // Cognito Hosted UI (OIDC) — the enterprise sign-in path. When these are set
  // the BFF exposes /api/auth/login → Cognito → /api/auth/callback and mints a
  // session from the federated identity. When unset, the user picker is the
  // only login surface (demo/local dev). See lib/oidc.ts + routes/auth.ts.
  cognito: {
    userPoolId: env('COGNITO_USER_POOL_ID'),
    clientId: env('COGNITO_CLIENT_ID'),
    clientSecret: env('COGNITO_CLIENT_SECRET'),
    // Hosted-UI domain host, e.g. orgiq-auth-647757222309.auth.us-east-1.amazoncognito.com
    domain: env('COGNITO_DOMAIN'),
    // Where Cognito redirects after login. MUST be registered as a callback URL
    // on the app client and match exactly. Defaults to this middleware's own
    // origin when PUBLIC_BASE_URL is set.
    callbackUrl: env('COGNITO_CALLBACK_URL') || (env('PUBLIC_BASE_URL') ? `${env('PUBLIC_BASE_URL')}/api/auth/callback` : ''),
    // Where the BFF sends the browser after a successful login (the portal).
    postLoginUrl: env('COGNITO_POST_LOGIN_URL', '/'),
    // The portal's origin, when it is NOT the same as this middleware's.
    //
    // In production both sit behind one ALB origin, so a relative redirect
    // ('/admin/budgets') resolves to the portal and this stays empty. In local
    // dev the portal is on :5183 and the middleware on :3001, so that same
    // relative redirect resolved against :3001 and every SSO login landed on a
    // middleware 404 — the login itself having succeeded. Set this and the
    // callback absolutises its redirect against it.
    //
    // Never taken from the request: it is configuration, so it cannot become
    // an open redirect the way a caller-supplied returnTo could.
    portalOrigin: env('PORTAL_ORIGIN', ''),
    // Where Cognito sends the browser after logout (must be a registered sign-out URL).
    logoutRedirectUrl: env('COGNITO_LOGOUT_URL', '/'),
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
