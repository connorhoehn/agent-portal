/**
 * The signed-request replay table (OrgIQ-Foundation), shared by two writers:
 *
 *   - the middleware's service-envelope nonces (middleware/src/lib/service-nonce-store.ts,
 *     SERVICE_AUTH_REPLAY_TABLE), keys prefixed `service-envelope#`;
 *   - the agents' signed-invoke nonces (agents/_shared/replay_store.py,
 *     AGENT_INVOKE_REPLAY_TABLE), keys a bare SHA-256 hex digest.
 *
 * Each writer gets `dynamodb:PutItem` only (every write is conditional; nobody
 * reads, scans or deletes — TTL expires the items), pinned by
 * `dynamodb:LeadingKeys` to its own side of the key split, so neither can spend
 * the other's nonces.
 *
 * The name and ARN are derived from the prefix rather than exported, like the
 * sessions table: no new cross-stack export to lock.
 */
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';

export const REPLAY_PARTITION_KEY = 'nonce_hash';
export const REPLAY_TTL_ATTRIBUTE = 'expires_at';
/** Must match REPLAY_KEY_PREFIX in middleware/src/lib/service-nonce-store.ts. */
export const MIDDLEWARE_REPLAY_KEY_PREFIX = 'service-envelope#';

export function replayTableName(prefix: string): string {
  return `${prefix}-signed-request-replay`;
}

export function replayTableArn(stack: cdk.Stack, prefix: string): string {
  return `arn:${stack.partition}:dynamodb:${stack.region}:${stack.account}:table/${replayTableName(prefix)}`;
}

/** The one statement each writer gets: a put, on this table, on its own keys. */
export function replayPutStatement(stack: cdk.Stack, prefix: string, writer: 'middleware' | 'agent'): iam.PolicyStatement {
  const keys = `${MIDDLEWARE_REPLAY_KEY_PREFIX}*`;
  return new iam.PolicyStatement({
    sid: 'SignedRequestReplayPut',
    actions: ['dynamodb:PutItem'],
    resources: [replayTableArn(stack, prefix)],
    // `Null: false` because ForAllValues over an absent key set is vacuously true.
    conditions: {
      Null: { 'dynamodb:LeadingKeys': 'false' },
      ...(writer === 'middleware'
        ? { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [keys] } }
        : { 'ForAllValues:StringNotLike': { 'dynamodb:LeadingKeys': [keys] } }),
    },
  });
}
