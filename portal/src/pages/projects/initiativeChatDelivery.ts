import { sendAndWaitForSocialChatAck } from '../social/socialChatDelivery.ts';

export interface InquiryPerson { userId: string; displayName: string }

export interface InitiativeChatDestination { recipient: string | null; mode: 'agent' | 'chat' }
interface DestinationStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
const destinationKey = (scope: string) => `initiative-composer-destination:${scope}`;

/** This preference labels the native draft; it stores no message body or authority. */
export function readInitiativeDestination(storage: DestinationStorage | null, scope: string): InitiativeChatDestination | null {
  try {
    const value = JSON.parse(storage?.getItem(destinationKey(scope)) ?? 'null') as unknown;
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    if (record.mode !== 'agent' && record.mode !== 'chat') return null;
    if (record.recipient !== null && (typeof record.recipient !== 'string' || record.recipient.length > 512
      || !/^(discussion|(?:person|huddle):[^\s]+)$/.test(record.recipient))) return null;
    return { recipient: record.recipient as string | null, mode: record.mode };
  } catch { return null; }
}
export function rememberInitiativeDestination(storage: DestinationStorage | null, scope: string, value: InitiativeChatDestination): void {
  try { storage?.setItem(destinationKey(scope), JSON.stringify(value)); } catch { /* Native draft remains usable when storage is unavailable. */ }
}

export interface InquiryInvitationReceipt { requestId: string; callId: string; userIds: readonly string[] }
export interface InquiryInvitationState { requestId: string; callId: string; userId: string; displayName: string;
  state: 'requested' | 'accepted' | 'declined' | 'busy' | 'failed'; error?: string }
/** Only native correlated state can replace a locally requested invitation receipt. */
export function inquiryInvitationFeedback(receipt: InquiryInvitationReceipt, rows: readonly InquiryInvitationState[], error: string | null): string | null {
  const matching = rows.filter(row => row.requestId === receipt.requestId && row.callId === receipt.callId && receipt.userIds.includes(row.userId));
  const settled = matching.filter(row => row.state !== 'requested').map(row => {
    if (row.state === 'failed') return `Invitation to ${row.displayName} failed: ${row.error ?? 'The request was refused.'}`;
    if (row.state === 'accepted') return `${row.displayName} accepted the invitation.`;
    if (row.state === 'busy') return `${row.displayName} is busy.`;
    return `${row.displayName} declined the invitation.`;
  });
  if (settled.length) return settled.join(' ');
  return error ? `Invitation request is unconfirmed: ${error}` : null;
}

/** Mentions address the current conversation; choosing an inquiry remains explicit. */
export function mentionedInquiryPeople(text: string, people: readonly InquiryPerson[]): InquiryPerson[] {
  const found = new Map<string, InquiryPerson>();
  const names = [...people].filter(p => p.userId && p.displayName).sort((a, b) => b.displayName.length - a.displayName.length);
  let remaining = text;
  for (const person of names) {
    const escaped = person.displayName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(^|[\\s,;(])@${escaped}(?=$|[\\s,;.!?])`, 'giu');
    if (pattern.test(remaining)) {
      found.set(person.userId, person);
      remaining = remaining.replace(pattern, '$1');
    }
  }
  return [...found.values()];
}

/** Slash invitations name exact current-directory people, not arbitrary user ids. */
export function invitationTargets(text: string, people: readonly InquiryPerson[]): InquiryPerson[] | string {
  const targets = mentionedInquiryPeople(text, people);
  if (!targets.length) return 'Use /invite followed by an exact @name from the people menu.';
  let remaining = text;
  for (const person of targets) remaining = remaining.replace(new RegExp(`@${person.displayName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'giu'), '');
  if (remaining.replace(/[\s,;]+/g, '')) return 'Use /invite @Name to request an invitation. Send your message separately.';
  return targets;
}

/** The initiative uses the existing message+persisted-ack contract, including retry delivery ids. */
export class InitiativeDiscussionDelivery {
  private attempts = new Map<string, string>();
  async send(input: {
    scopeKey: string; channel: string; userId: string; text: string; metadata: Record<string, unknown>;
    signal: AbortSignal; current(): boolean;
    listen: (handler: (frame: Record<string, unknown>) => void) => () => void;
    sendMessage(text: string, metadata: Record<string, unknown>): void;
    newId(): string; timeoutMs?: number;
  }): Promise<boolean> {
    if (!input.current() || input.signal.aborted) return false;
    const signature = JSON.stringify([input.scopeKey, input.channel, input.userId, input.text, input.metadata]);
    const deliveryId = this.attempts.get(signature) ?? input.newId();
    this.attempts.set(signature, deliveryId);
    if (this.attempts.size > 32) this.attempts.delete(this.attempts.keys().next().value!);
    await sendAndWaitForSocialChatAck({ channel: input.channel, userId: input.userId, deliveryId,
      listen: input.listen, signal: input.signal, timeoutMs: input.timeoutMs,
      send: () => input.sendMessage(input.text, { ...input.metadata, clientDeliveryId: deliveryId }) });
    if (!input.current() || input.signal.aborted) return false;
    this.attempts.delete(signature);
    return true;
  }
}
