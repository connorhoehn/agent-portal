// Connected sources — credentials for the systems an org's knowledge lives in.
//
// Ingestion has assumed, until now, that documents arrive by crawling a public
// URL or by someone exporting files by hand. Real organisational knowledge is
// behind a login: Confluence, Jira, GitHub. Reaching it needs a credential,
// and the tempting shortcuts are all bad — a token in .env.aws, a secret in
// the repo, or a browser profile holding a logged-in session.
//
// AgentCore Identity is the mechanism built for this. A credential provider
// holds the secret in a token vault; nothing here ever stores it. At call time
// the workload proves who it is and exchanges that for the credential, which
// lives in memory for the length of one request.
//
// Two hops, and both matter:
//   1. GetWorkloadAccessToken  — this process proves it is the OrgIQ workload
//   2. GetResourceApiKey       — that proof is exchanged for the stored secret
//
// The practical consequence is that rotating a token is a console action, not
// a redeploy, and a leaked repo contains nothing worth having.

import {
  BedrockAgentCoreControlClient,
  CreateApiKeyCredentialProviderCommand,
  DeleteApiKeyCredentialProviderCommand,
  ListApiKeyCredentialProvidersCommand,
  ListOauth2CredentialProvidersCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';
import {
  BedrockAgentCoreClient,
  GetWorkloadAccessTokenCommand,
  GetResourceApiKeyCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import { config } from '../config.js';
import { clock } from '../mock/core/index.js';
import { connectedSourceRows } from '../mock/connected-sources.js';

let _control: BedrockAgentCoreControlClient | null = null;
const control = (): BedrockAgentCoreControlClient =>
  (_control ??= new BedrockAgentCoreControlClient({ region: config.region }));

let _data: BedrockAgentCoreClient | null = null;
const data = (): BedrockAgentCoreClient =>
  (_data ??= new BedrockAgentCoreClient({ region: config.region }));

/** Workload this process presents as when asking the vault for a credential. */
function workloadName(): string {
  const arn = config.agentcore.workloadIdentityArn;
  const name = arn.split('/').pop();
  if (!name) throw new Error('WORKLOAD_IDENTITY_ARN is not set — cannot reach the credential vault');
  return name;
}

export type SourceKind = 'github' | 'confluence' | 'jira';

/** Provider names are namespaced so one vault can serve several sources. */
export function providerNameFor(kind: SourceKind, label: string): string {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  return `orgiq-${kind}-${slug || 'default'}`;
}

export interface ConnectedSource {
  name: string;
  kind: SourceKind | 'unknown';
  /** How the secret is held. OAuth providers are listed but not created here. */
  authType: 'api-key' | 'oauth2';
  createdAt: string | null;
}

function kindOf(name: string): SourceKind | 'unknown' {
  if (name.includes('-github-')) return 'github';
  if (name.includes('-confluence-')) return 'confluence';
  if (name.includes('-jira-')) return 'jira';
  return 'unknown';
}

export async function listConnectedSources(): Promise<ConnectedSource[]> {
  if (config.mock.agentcore) {
    return connectedSourceRows.rows().slice().sort((a, b) => a.name.localeCompare(b.name));
  }
  const [keys, oauth] = await Promise.all([
    control().send(new ListApiKeyCredentialProvidersCommand({ maxResults: 50 }))
      .then((r) => r.credentialProviders ?? []).catch(() => []),
    control().send(new ListOauth2CredentialProvidersCommand({ maxResults: 50 }))
      .then((r) => r.credentialProviders ?? []).catch(() => []),
  ]);

  const out: ConnectedSource[] = [];
  for (const p of keys) {
    const name = p.name ?? '';
    out.push({
      name, kind: kindOf(name), authType: 'api-key',
      createdAt: p.createdTime ? new Date(p.createdTime).toISOString() : null,
    });
  }
  for (const p of oauth) {
    const name = p.name ?? '';
    out.push({
      name, kind: kindOf(name), authType: 'oauth2',
      createdAt: p.createdTime ? new Date(p.createdTime).toISOString() : null,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Store a token in the vault.
 *
 * The secret passes through this process once, on its way to AWS, and is not
 * written down here or returned to the caller afterwards. There is deliberately
 * no read-back: a vault you can read from a web request is a vault that leaks
 * through that web request.
 */
export async function connectApiKeySource(
  kind: SourceKind, label: string, apiKey: string,
): Promise<{ name: string }> {
  const name = providerNameFor(kind, label);
  if (config.mock.agentcore) {
    // The secret is dropped on the floor, deliberately: the mock stores the
    // provider's existence so the connect → list → disconnect loop is walkable
    // offline, and never the credential, which is the one thing the vault is
    // for. `rows()` is the live array, so the new row is in the next GET.
    const rows = connectedSourceRows.rows();
    const existing = rows.findIndex((s) => s.name === name);
    const row: ConnectedSource = { name, kind, authType: 'api-key', createdAt: clock.nowIso() };
    if (existing >= 0) rows[existing] = row; else rows.push(row);
    return { name };
  }
  await control().send(new CreateApiKeyCredentialProviderCommand({ name, apiKey }));
  return { name };
}

export async function disconnectSource(name: string): Promise<void> {
  if (config.mock.agentcore) {
    const rows = connectedSourceRows.rows();
    const i = rows.findIndex((s) => s.name === name);
    if (i >= 0) rows.splice(i, 1);
    return;
  }
  await control().send(new DeleteApiKeyCredentialProviderCommand({ name }));
}

/**
 * Fetch a stored credential for immediate use.
 *
 * Never cached and never logged. Callers should hold the result no longer than
 * the request that needed it — the point of the vault is that the secret has
 * one short-lived home at a time.
 */
export async function borrowApiKey(providerName: string): Promise<string> {
  if (config.mock.agentcore) {
    // Deliberately NOT a fake token. Handing one out would send the GitHub
    // connector at api.github.com with a credential that cannot work, and the
    // 401 that comes back would read as "your token is wrong" rather than
    // "there is no vault here". The routes that call this (`/check`,
    // `/github/*`) surface this message instead.
    throw new Error(
      `no credential vault in mock mode — ${providerName} is a fixture, not a stored secret. ` +
      'Run the middleware against AWS (npm run dev) to exercise a real credential.',
    );
  }
  const token = await data().send(new GetWorkloadAccessTokenCommand({
    workloadName: workloadName(),
  }));
  if (!token.workloadAccessToken) {
    throw new Error('The workload could not obtain an access token — check WORKLOAD_IDENTITY_ARN and its IAM grants');
  }

  const key = await data().send(new GetResourceApiKeyCommand({
    workloadIdentityToken: token.workloadAccessToken,
    resourceCredentialProviderName: providerName,
  }));
  if (!key.apiKey) throw new Error(`No credential stored under ${providerName}`);
  return key.apiKey;
}
