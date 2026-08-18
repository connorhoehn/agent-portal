// AWS credential liveness probe for /api/health.
//
// aws-azure-login sessions expire silently under a long-lived middleware
// process; every AWS-backed route then 500s with no indication of why (this
// bit us twice — the portal showed scattered 500s while the real problem was
// an expired SAML session). The health endpoint surfaces it explicitly so the
// portal header can say "AWS credentials expired" instead.
//
// STS calls are cheap but not free — cache the verdict for 60s.
//
// Recreating the STSClient after a failure does NOT recover a re-login, which
// an earlier version of this comment claimed. Verified the hard way: with a
// valid ~/.aws/credentials on disk, a brand-new STSClient inside the running
// process still returned ExpiredToken, while the same code in a fresh process
// resolved the new key immediately. The credentials file parse is memoized
// process-wide, below the client, so no amount of client churn re-reads it.
//
// This only bites local dev, where aws-azure-login rewrites the file under a
// long-lived `tsx watch` process; deployed, the task role refreshes itself and
// there is no INI file in play. So the honest remedy is the one reported to
// the operator: re-login, then restart the middleware. The client is still
// dropped on failure because it costs nothing and keeps the probe from
// pinning a dead connection.

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
    // Drop the dead client. This does not recover a re-login on its own (see
    // the note above) — the process has to restart for that.
    client = null;
    cached = { status: { ok: false, error: name }, checkedAt: now };
  }
  return cached.status;
}
