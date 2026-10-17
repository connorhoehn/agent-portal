// Recording playback reads platform-api's existing `call-reactions` table.
// Capture the library's accepted, untargeted reaction in that same row shape.
// No client-supplied lobby/tenant is trusted. Chat reaction chips remain chat state.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { CallStateStore } from '@connorhoehn/realtime-modules/call';
import type { Reaction } from '@connorhoehn/realtime-modules/reactions';

export interface RecordedCallReaction {
  tenant: string; reactionId: string; channel: string; lobbyName: string;
  userId: string; displayName?: string; emoji: string; effect: string; at: string;
}
export interface CallReactionCapture { put(row: RecordedCallReaction): Promise<void> }

/** Resolve the actual call and accepted socket before persisting an event.
 * Recording asset activity is queried by this lobby and the recording's time window. */
export function captureCallReaction(options: {
  calls: Pick<CallStateStore, 'getCall'>;
  context(clientId: string): Record<string, unknown> | null;
  store: CallReactionCapture | null;
}): (reaction: Reaction) => Promise<void> {
  return async reaction => {
    if (reaction.targetId || !options.store) return;
    const match = /^orgiq:huddle:([^\s/:?#]{1,128})$/.exec(reaction.channel);
    if (!match || !reaction.userId || !Number.isFinite(Date.parse(reaction.timestamp))) return;
    const ctx = options.context(reaction.clientId);
    if (!ctx || ctx['userId'] !== reaction.userId || typeof ctx['org'] !== 'string') return;
    const call = await options.calls.getCall(match[1]!);
    if (!call || !call.participantClientIds.includes(reaction.clientId)) return;
    const tenant = ctx['org'];
    if (!call.lobbyName.startsWith(`${tenant}:`)) return;
    await options.store.put({ tenant, reactionId: reaction.id, channel: reaction.channel, lobbyName: call.lobbyName,
      userId: reaction.userId, ...(reaction.displayName ? { displayName: reaction.displayName } : {}),
      emoji: reaction.emoji, effect: reaction.effect, at: reaction.timestamp });
  };
}

/** Official platform-api CallReactionRepository key/retention contract.
 * Explicit configuration only: adding the hook never enables AWS writes by default. */
export function configuredCallReactionCapture(env: NodeJS.ProcessEnv = process.env): CallReactionCapture | null {
  const endpoint = env['CALL_REACTION_DYNAMODB_ENDPOINT']?.trim();
  const explicitTable = env['CALL_REACTION_TABLE']?.trim();
  if (!endpoint && !explicitTable) return null;
  const table = explicitTable || `${env['CALL_REACTION_TABLE_PREFIX']?.trim() ?? ''}call-reactions`;
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({
    region: env['AWS_REGION'] || 'us-east-1', maxAttempts: 3,
    ...(endpoint ? { endpoint, credentials: { accessKeyId: 'localbootstrap', secretAccessKey: 'localbootstrap' } } : {}),
  }), { marshallOptions: { removeUndefinedValues: true } });
  return { put: async row => {
    await client.send(new PutCommand({ TableName: table, Item: recordedCallReactionItem(row) }), { abortSignal: AbortSignal.timeout(5_000) });
  } };
}

export function recordedCallReactionItem(row: RecordedCallReaction): Record<string, unknown> {
  return { ...row, lobbyKey: `${row.tenant}|${row.lobbyName}`, sk: `${row.at}#${row.reactionId}`,
    ttl: Math.floor(Date.parse(row.at) / 1000) + 90 * 86400 };
}
