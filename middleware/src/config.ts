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
/**
 * Keys the file supplied a value for that the process environment had already
 * claimed. "Process env wins" is the rule, and it is invisible: an operator who
 * edits .env.aws and restarts sees no change and no explanation. Recorded here
 * because module load is the only moment where the two sources are still
 * distinguishable — afterwards process.env is one flat map.
 */
const shadowedByShell = new Map<string, { shell: string; file: string }>();

try {
  if (process.env['DEV_OFFLINE'] === 'true') throw new Error('offline');
  const text = readFileSync(envPath, 'utf8');
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!m) continue;
    const key = m[1]!;
    const fileValue = m[2]!;
    const shellValue = process.env[key];
    if (shellValue === undefined) {
      process.env[key] = fileValue;
    } else if (shellValue !== fileValue) {
      shadowedByShell.set(key, { shell: shellValue, file: fileValue });
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

  // The message-queue service (~/projects/message-queue) that carries the
  // distillation compaction jobs. `url` is the bare origin (the /api/v1 prefix
  // lives in lib/mq-client.ts). `mock` (MOCK_QUEUE=true, on under dev:mock)
  // swaps in the in-process queue with the same semantics; so does an unset
  // url, with a boot warning, so a laptop without the service still compacts.
  // Kept out of `mock` above on purpose: that object is reported verbatim by
  // /api/health and read by the wire capture as "which AWS providers are
  // intercepted", and a queue is not an AWS provider.
  messageQueue: {
    url: env('MESSAGE_QUEUE_URL'),
    serviceId: env('MESSAGE_QUEUE_SERVICE_ID', 'orgiq-middleware'),
    secret: env('MESSAGE_QUEUE_AUTH_SECRET'),
    mock: flag('MOCK_QUEUE'),
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

// ---------------------------------------------------------------------------
// Startup capability check — make a stale id loud.
//
// Every AgentCore capability id above is minted fresh when
// OrgIQ-AgentCoreCapabilities is recreated, and nothing regenerates .env.aws.
// The resulting failures are quiet, and each one is quiet differently: the
// Code Interpreter says "not found" naming an id nobody recognises, a dead
// browser *profile* surfaces as a bare 500, and site-survey's browser fallback
// fails SOFT — a dead BROWSER_ID is indistinguishable from "this site has no
// JavaScript-only pages". Three symptoms, one cause, and the cause is never
// named at the point of failure.
//
// So ask at boot instead of at the 500. /api/capabilities/reconcile already
// answers this on demand; the answer is only useful if somebody thinks to go
// look, and after a rebuild nobody does. This logs it unprompted.
//
// It must never be able to break a boot, so:
//   - it runs on a deferred, unref'd timer, so it cannot delay listen() or
//     hold the process open;
//   - the AWS SDK is pulled in by dynamic import, so a mock/offline run never
//     loads it and the module cycle (config -> reconcile -> config) resolves
//     after this module is fully initialised;
//   - every failure is swallowed. A probe that cannot reach AWS reports
//     'unknown', and 'unknown' is deliberately not logged as a problem — a
//     laptop with expired credentials must not read as "your fleet is gone".
//
// Silent under `npm run dev:mock` (DEV_OFFLINE + MOCK_AGENTCORE, where none of
// these ids means anything), silent under jest, and switchable off entirely
// with CAPABILITY_STARTUP_CHECK=off.
//
// For the operator-facing version — which also proposes the fix and can
// rewrite .env.aws — see schema/reconcile_capabilities.py.
// ---------------------------------------------------------------------------

/**
 * What a dead id actually looks like from the outside. This is the whole point
 * of the check: the symptoms do not resemble each other and none of them
 * mentions configuration, so an operator who hits one has no reason to suspect
 * the others share a cause.
 */
const CAPABILITY_SYMPTOM: Readonly<Record<string, string>> = {
  MEMORY_ID: 'agent memory reads/writes fail and conversations lose continuity',
  BROWSER_ID: 'site-survey\'s browser fallback fails SOFT, reading as "this site has no JavaScript-only pages"',
  BROWSER_PROFILE_ID: '"Browser profile not found", surfaced as a bare 500',
  CODE_INTERPRETER_ID: 'the Code Interpreter says "not found", naming an id nobody recognises',
  GUARDRAIL_ID_MEMBER: 'answers to members go out without their guardrail',
  GUARDRAIL_ID_ORG_LEADER: 'answers to org leaders go out without their guardrail',
  GUARDRAIL_ID_HR_ADMIN: 'answers to HR admins go out without their guardrail',
};

const CAPABILITY_ENV_KEYS = Object.keys(CAPABILITY_SYMPTOM);

/** Why the check is not going to run, or null if it will. */
export function capabilityCheckSkipReason(
  e: NodeJS.ProcessEnv = process.env,
): string | null {
  if (e['CAPABILITY_STARTUP_CHECK'] === 'off') return 'disabled';
  // Jest sets both; neither should ever produce boot noise or an AWS call.
  if (e['NODE_ENV'] === 'test' || e['JEST_WORKER_ID'] !== undefined) return 'test';
  // The two flags `npm run dev:mock` sets. Offline, none of these ids means
  // anything and every one of them would report as broken — which is how a
  // check like this gets ignored, and then muted, and then deleted.
  if (e['DEV_OFFLINE'] === 'true') return 'offline';
  if (e['MOCK_AGENTCORE'] === 'true') return 'mock';
  if (!CAPABILITY_ENV_KEYS.some((k) => (e[k] ?? '').trim() !== '')) return 'unconfigured';
  return null;
}

export interface StaleCapability {
  envVar: string;
  configuredId: string | null;
  detail: string;
}

/**
 * The boot warning, as lines. Pure, so it is testable without AWS.
 *
 * One line per dead id, because the thing an operator needs is the id, what it
 * breaks, and where the value came from — not a paragraph they will scroll
 * past. Provenance is on the line for a specific reason: config.ts only fills
 * vars that are `undefined`, so a shell export beats the file, and telling
 * someone to rewrite .env.aws when the process is reading their shell would be
 * a new way to be confidently wrong.
 */
export function staleCapabilityLines(
  stale: readonly StaleCapability[],
  shadowed: ReadonlyMap<string, { shell: string; file: string }> = shadowedByShell,
): string[] {
  if (stale.length === 0) return [];
  const lines = stale.map((c) => {
    const source = shadowed.has(c.envVar)
      ? 'exported by your shell, overriding .env.aws'
      : 'from middleware/.env.aws';
    const symptom = CAPABILITY_SYMPTOM[c.envVar] ?? c.detail;
    return `[capabilities] ${c.envVar}=${c.configuredId ?? '(unset)'} (${source}) does not exist in this account — ${symptom}.`;
  });
  const blocked = stale.filter((c) => shadowed.has(c.envVar)).map((c) => c.envVar);
  lines.push(
    `[capabilities] Fix: .venv-synth/bin/python -m schema.reconcile_capabilities --write` +
      (blocked.length ? ` — and \`unset ${blocked.join(' ')}\` first, or the file edit will have no effect.` : ''),
  );
  return lines;
}

function startupCapabilityCheck(): void {
  if (capabilityCheckSkipReason() !== null) return;

  const timer = setTimeout(() => {
    void (async () => {
      try {
        const { reconcileCapabilities } = await import('./providers/capability-reconcile.js');
        const { capabilities } = await reconcileCapabilities();
        // Only 'missing' is a verdict. 'unknown' means AWS could not be asked
        // and 'unconfigured' means the capability was never set up; shouting
        // about either is how a boot warning earns its way into a filter.
        for (const line of staleCapabilityLines(capabilities.filter((c) => c.state === 'missing'))) {
          console.warn(line);
        }
      } catch {
        // Unreachable AWS, a throttle, a module that failed to load — none of
        // it is news about the ids, and none of it may reach the caller.
      }
    })();
  }, 2_000);
  // Boot diagnostics must not be the reason a process refuses to exit.
  timer.unref?.();
}

startupCapabilityCheck();
