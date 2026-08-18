// AWS credential liveness probe for /api/health.
//
// aws-azure-login sessions expire silently under a long-lived middleware
// process; every AWS-backed route then 500s with no indication of why (this
// bit us twice — the portal showed scattered 500s while the real problem was
// an expired SAML session). The health endpoint surfaces it explicitly so the
// portal header can say "AWS credentials expired" instead.
//
// STS calls are cheap but not free — cache the verdict for 60s. On the first
// failure after expiry we also recreate the client, because SDK v3 clients
// cache resolved credentials and never re-read ~/.aws/credentials on their
// own; a fresh client is what picks up a re-login without a process restart.

import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';

const TTL_MS = 60_000;

export interface CredsStatus {
  ok: boolean;
  /** Error name when not ok (e.g. ExpiredToken, CredentialsProviderError). */
  error?: string;
}

let client: STSClient | null = null;
let cached: { status: CredsStatus; checkedAt: number } | null = null;

export async function checkAwsCredentials(): Promise<CredsStatus> {
  const now = Date.now();
  if (cached && now - cached.checkedAt < TTL_MS) return cached.status;

  if (!client) client = new STSClient({});
  try {
    await client.send(new GetCallerIdentityCommand({}));
    cached = { status: { ok: true }, checkedAt: now };
  } catch (err) {
    const name = (err as { name?: string }).name ?? 'UnknownError';
    // Drop the client so the next probe resolves credentials fresh — this is
    // what lets a re-login be noticed without restarting the middleware.
    client = null;
    cached = { status: { ok: false, error: name }, checkedAt: now };
  }
  return cached.status;
}
