// The huddle send contract, composed around the library chat service for the
// `orgiq:huddle:<callId>` namespace only (every other channel is untouched),
// a meeting room's chat `orgiq:huddle:<callId>~breakout~<roomId>` included:
// the same contract, with the room's seat check (CallChatRuntime.assertRoomSeat).
// Authority is CallChatRuntime's (call-chat.ts); this adds what a huddle send
// promises beyond the library's own persisted acknowledgement.
import { defineFeature, type RealtimeFeature } from '@connorhoehnslalom/realtime-modules/server';
import { AppError } from './async-handler.js';
import { canonicalCallPage, type CallPageDescriptor } from './call-pages.js';
import { dmPageDescriptor } from './dm-page-references.js';
import { huddleChatOf, inCallChatNamespace, METADATA_KEYS, type CallChatRuntime } from './call-chat.js';

/** What a client may do on a huddle channel through the chat service. */
const HUDDLE_ACTIONS: ReadonlySet<string> = new Set(['join', 'leave', 'send', 'history', 'typing', 'read', 'receipts']);
/** The one blank character a reference-only huddle message stores (the chat service needs a non-empty body). */
export const REFERENCE_ONLY_BODY = ' ';
const DELIVERY_ID = /^[a-zA-Z0-9_-]{1,128}$/;
type HuddleSend = { text: string; deliveryId: string; page: CallPageDescriptor | null; metadata: Record<string, unknown> };
/** A huddle send names its delivery id and at most an exact {kind,id} page; other metadata is allowlisted. */
export function huddleSendInput(data: Record<string, unknown>): HuddleSend | string {
  const raw = data.metadata;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'A huddle message needs a delivery id';
  const row = raw as Record<string, unknown>;
  if (typeof row.clientDeliveryId !== 'string' || !DELIVERY_ID.test(row.clientDeliveryId)) return 'A huddle message needs a valid delivery id';
  let page: CallPageDescriptor | null = null;
  if (row.pageReference !== undefined) {
    page = dmPageDescriptor(row.pageReference);
    if (!page) return 'A page reference contains only initiative/work-item kind and id';
  }
  if (typeof data.message !== 'string') return 'Message must be a string';
  // A reference-only message (the composer's "this page" with no words) has no
  // text. The chat service refuses an empty body unless attachments ride with
  // it, so the stored body is one blank character: the reference is the
  // message, and no sentence is invented for it.
  const text = data.message === '' && page ? REFERENCE_ONLY_BODY : data.message;
  const metadata: Record<string, unknown> = { clientDeliveryId: row.clientDeliveryId, ...(page ? { pageReference: page } : {}) };
  for (const key of METADATA_KEYS) if (key !== 'clientDeliveryId' && key !== 'displayName' && row[key] !== undefined) metadata[key] = row[key];
  return { text, deliveryId: row.clientDeliveryId, page, metadata };
}
const samePage = (a: unknown, b: CallPageDescriptor | null) => {
  const left = dmPageDescriptor(a);
  return left === null ? b === null : !!b && left.kind === b.kind && left.id === b.id;
};

/**
 * Compose around the public chat service for the huddle namespace; every
 * other channel is untouched. The library keeps storage, history floors,
 * receipts, typing and its own persisted acknowledgement (`sent` after the
 * store write); this adds what a huddle send promises on top:
 *   - only the actions in HUDDLE_ACTIONS (no member management, edits or deletes);
 *   - a delivery id, an exact page descriptor the sender can resolve now, and
 *     allowlisted metadata;
 *   - one send at a time per call, so a retry with the same delivery id is
 *     answered with the original message and acknowledgement (a different
 *     payload under that id is refused) instead of storing a second copy;
 *   - a message stored but never acknowledged (the sender lost authority
 *     during persistence) is withdrawn from replay.
 */
export function withHuddleChat(feature: RealtimeFeature, current: () => CallChatRuntime | null): RealtimeFeature {
  return defineFeature({ ...feature, create(context) {
    const service = feature.create(context) as ReturnType<RealtimeFeature['create']> & {
      sendToClient(clientId: string, message: unknown): void;
      channelCaches?: Map<string, { delete(id: string): unknown }>;
    };
    const handle = service.handleAction.bind(service);
    const acknowledged = new Set<string>();
    const sendToClient = service.sendToClient.bind(service);
    service.sendToClient = (clientId, message) => {
      const frame = message as Record<string, unknown> | null;
      if (frame?.type === 'chat' && frame.action === 'sent' && typeof frame.channel === 'string' && huddleChatOf(frame.channel)
        && typeof frame.messageId === 'string') acknowledged.add(`${clientId}\0${frame.messageId}`);
      sendToClient(clientId, message);
    };
    const queues = new Map<string, Promise<unknown>>();
    const enqueue = (callId: string, work: () => Promise<void>) => {
      const next = (queues.get(callId) ?? Promise.resolve()).catch(() => undefined).then(work);
      queues.set(callId, next);
      void next.finally(() => { if (queues.get(callId) === next) queues.delete(callId); }).catch(() => undefined);
      return next;
    };
    const refuse = (clientId: string, action: string, channel: string, message: string, status = 403): void => {
      void context.router.sendToClient(clientId, { type: 'error', service: 'chat', action, channel, code: 'HUDDLE_CHAT_DENIED',
        error: { code: 'HUDDLE_CHAT_DENIED', message }, status });
    };
    service.handleAction = async (clientId, action, data) => {
      const channel = typeof data?.channel === 'string' ? data.channel : '';
      if (!inCallChatNamespace(channel)) return handle(clientId, action, data);
      const ref = huddleChatOf(channel);
      if (!ref || !HUDDLE_ACTIONS.has(action)) return refuse(clientId, action, channel, 'This is not offered in a huddle conversation');
      const { callId, roomId } = ref;
      if (action !== 'send') return handle(clientId, action, data);
      const input = huddleSendInput(data);
      if (typeof input === 'string') return refuse(clientId, action, channel, input, 400);
      const captured = context.router.getClientData?.(clientId)?.userContext;
      const userId = typeof captured?.['userId'] === 'string' ? captured['userId'] : '';
      await enqueue(callId, async () => {
        const owner = current();
        try {
          if (!owner || !userId) throw new AppError(503, 'Huddle chat is unavailable');
          await (roomId ? owner.assertRoomSeat(callId, roomId, clientId, true) : owner.assertSeat(callId, clientId, true));
          if (input.page) {
            if (!await owner.pageReferencesAllowed(callId)) throw new AppError(403, 'This huddle does not carry page references');
            await canonicalCallPage(input.page);
          }
          await (roomId ? owner.assertRoomSeat(callId, roomId, clientId, true) : owner.assertSeat(callId, clientId, true));
          if (context.router.getClientData?.(clientId)?.userContext !== captured) return;
          const find = async () => (await owner.messages.listMessages(channel, 200)).find(message => message.userId === userId
            && message.metadata?.['clientDeliveryId'] === input.deliveryId && !message.deletedAt && message.metadata?.['deleted'] !== true) ?? null;
          const prior = await find();
          if (prior) {
            if (prior.message !== input.text || !samePage(prior.metadata?.['pageReference'], input.page)) {
              throw new AppError(409, 'This delivery id already belongs to another message');
            }
            // The same delivery again: answer with the original, never a second copy.
            context.router.sendToClient(clientId, { type: 'chat', action: 'message', channel, message: prior });
            context.router.sendToClient(clientId, { type: 'chat', action: 'sent', messageId: prior.id, channel, timestamp: prior.timestamp });
            return;
          }
          await handle(clientId, action, { channel, message: input.text, metadata: input.metadata });
          const stored = await find();
          if (stored && !acknowledged.has(`${clientId}\0${stored.id}`)) {
            // Persisted, then refused before its acknowledgement: withdraw it.
            service.channelCaches?.get(channel)?.delete(stored.id);
            await owner.messages.updateMessage(channel, stored.id, { message: '', metadata: { deleted: true }, deletedAt: new Date().toISOString() });
          }
          if (stored) acknowledged.delete(`${clientId}\0${stored.id}`);
        } catch (error) {
          if (context.router.getClientData?.(clientId)?.userContext !== captured) return;
          const status = error instanceof AppError ? error.status : 503;
          refuse(clientId, action, channel, error instanceof AppError ? error.message : 'Huddle message verification is unavailable', status);
        }
      });
    };
    return service;
  } });
}
