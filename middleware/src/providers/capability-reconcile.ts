// Do the capabilities this app is configured for actually exist?
//
// Every AgentCore capability is reached through an id in `.env.aws`, and those
// ids are minted fresh whenever the capabilities stack is recreated. Nothing
// regenerates the file, so after a rebuild the middleware keeps calling
// resources that are gone — and each one fails in a way that points somewhere
// other than the config:
//
//   - the Code Interpreter says "not found", naming an id nobody recognises
//   - the browser surfaces a bare 500 from a dead *profile* id
//   - the site survey's browser fallback fails soft, which is indistinguishable
//     from "this site has no JavaScript-only pages"
//
// All three happened in one afternoon, and each was diagnosed separately. This
// asks the question directly, once, so the answer is on a page instead of in
// three different stack traces.

import {
  BedrockAgentCoreControlClient,
  ListBrowsersCommand,
  ListBrowserProfilesCommand,
  ListCodeInterpretersCommand,
  ListMemoriesCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';
import { BedrockClient, ListGuardrailsCommand } from '@aws-sdk/client-bedrock';
import { config } from '../config.js';

let _client: BedrockAgentCoreControlClient | null = null;
const client = (): BedrockAgentCoreControlClient =>
  (_client ??= new BedrockAgentCoreControlClient({ region: config.region }));

let _bedrock: BedrockClient | null = null;
const bedrock = (): BedrockClient => (_bedrock ??= new BedrockClient({ region: config.region }));

const HEALTHY_STATUSES = new Set(['READY', 'ACTIVE', 'AVAILABLE']);

export type CapabilityState =
  /** Configured, and AWS confirms it exists. */
  | 'ok'
  /** Configured, but AWS has never heard of it — almost always a stale id. */
  | 'missing'
  /** Nothing configured. Not broken, just not set up. */
  | 'unconfigured'
  /** AWS could not be asked. Says nothing about the resource. */
  | 'unknown';

export interface CapabilityStatus {
  key: 'browser' | 'browserProfile' | 'codeInterpreter' | 'memory'
     | 'guardrailMember' | 'guardrailOrgLeader' | 'guardrailHrAdmin';
  label: string;
  /** The id this process will actually use. */
  configuredId: string | null;
  state: CapabilityState;
  /** AWS's own status string, when it answered. */
  awsStatus: string | null;
  /** One sentence, safe to render verbatim. */
  detail: string;
  /** Which env var to correct when this is wrong. */
  envVar: string;
}

/**
 * Ask by listing, not by fetching the id directly.
 *
 * A Get on an id that does not exist comes back as AccessDenied in this
 * account, not ResourceNotFound — IAM evaluates the resource ARN against the
 * policy and refuses before the service can 404. So the exact case this exists
 * to catch, a stale id after a rebuild, was being reported as "could not
 * check". Listing is a different action, it is permitted, and membership in
 * the result is a definite answer either way.
 */
async function probe(
  key: CapabilityStatus['key'],
  label: string,
  envVar: string,
  configuredId: string,
  list: () => Promise<Array<{ id: string; status: string | null }>>,
): Promise<CapabilityStatus> {
  if (!configuredId) {
    return {
      key, label, envVar, configuredId: null, state: 'unconfigured', awsStatus: null,
      detail: `${envVar} is not set — this capability is unavailable to the app.`,
    };
  }
  try {
    const all = await list();
    const hit = all.find((r) => r.id === configuredId);
    if (!hit) {
      const alternatives = all.map((r) => r.id);
      return {
        key, label, envVar, configuredId, state: 'missing', awsStatus: null,
        detail: alternatives.length
          ? `${configuredId} does not exist in this account. ${envVar} in middleware/.env.aws is stale — the live one is ${alternatives.join(', ')}.`
          : `${configuredId} does not exist, and this account has none of these at all.`,
      };
    }
    return {
      key, label, envVar, configuredId, state: 'ok', awsStatus: hit.status,
      // READY and ACTIVE are both healthy — the services use different words
      // for the same thing, and flagging one of them reads as a problem.
      detail: hit.status && !HEALTHY_STATUSES.has(hit.status)
        ? `Exists, but AWS reports ${hit.status}.`
        : 'Configured and present in this account.',
    };
  } catch (err) {
    const name = (err as { name?: string }).name ?? 'UnknownError';
    return {
      key, label, envVar, configuredId, state: 'unknown', awsStatus: null,
      detail: `Could not list ${label.toLowerCase()} resources (${name}) — this says nothing about whether the configured id is valid.`,
    };
  }
}

/** Guardrail ids, listed once per reconciliation rather than per role. */
async function listGuardrails(): Promise<Array<{ id: string; status: string | null }>> {
  const r = await bedrock().send(new ListGuardrailsCommand({ maxResults: 50 }));
  return (r.guardrails ?? []).map((g) => ({ id: g.id ?? '', status: g.status ?? null }));
}

/**
 * Check every configured capability id against AWS.
 *
 * Probes run together; one unreachable service must not hide the others.
 */
export async function reconcileCapabilities(): Promise<{ capabilities: CapabilityStatus[] }> {
  const ac = config.agentcore;
  const capabilities = await Promise.all([
    probe('browser', 'Browser', 'BROWSER_ID', ac.browserId, async () => {
      const r = await client().send(new ListBrowsersCommand({ maxResults: 50 }));
      return (r.browserSummaries ?? []).map((b) => ({ id: b.browserId ?? '', status: b.status ?? null }));
    }),
    probe('browserProfile', 'Browser profile', 'BROWSER_PROFILE_ID', ac.browserProfileId, async () => {
      const r = await client().send(new ListBrowserProfilesCommand({ maxResults: 50 }));
      return (r.profileSummaries ?? []).map((b) => ({ id: b.profileId ?? '', status: b.status ?? null }));
    }),
    probe('codeInterpreter', 'Code Interpreter', 'CODE_INTERPRETER_ID', ac.codeInterpreterId, async () => {
      const r = await client().send(new ListCodeInterpretersCommand({ maxResults: 50 }));
      return (r.codeInterpreterSummaries ?? []).map((c) => ({ id: c.codeInterpreterId ?? '', status: c.status ?? null }));
    }),
    probe('memory', 'Memory', 'MEMORY_ID', ac.memoryId, async () => {
      const r = await client().send(new ListMemoriesCommand({ maxResults: 50 }));
      return (r.memories ?? []).map((m) => ({ id: m.id ?? '', status: m.status ?? null }));
    }),

    // Guardrails belong here for the same reason as the rest, and they matter
    // more: the supervisor attaches a role-specific guardrail when it builds
    // the model, so a stale id here means answers going out without the policy
    // they are supposed to carry. All three were stale after the last rebuild
    // and nothing said so — the capability page reported "not set up" while
    // the endpoint behind it was returning a 500.
    probe('guardrailMember', 'Guardrail (member)', 'GUARDRAIL_ID_MEMBER',
      process.env['GUARDRAIL_ID_MEMBER'] ?? '', listGuardrails),
    probe('guardrailOrgLeader', 'Guardrail (org leader)', 'GUARDRAIL_ID_ORG_LEADER',
      process.env['GUARDRAIL_ID_ORG_LEADER'] ?? '', listGuardrails),
    probe('guardrailHrAdmin', 'Guardrail (HR admin)', 'GUARDRAIL_ID_HR_ADMIN',
      process.env['GUARDRAIL_ID_HR_ADMIN'] ?? '', listGuardrails),
  ]);
  return { capabilities };
}
