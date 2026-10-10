// A work comment is stored once in its initiative conversation. Work-item
// comment feeds project the messages carrying that item's page reference.
import { AppError } from './async-handler.js';
import { getWorkItem } from '../providers/work-items.js';
import { liveMessageId } from './work-thread.js';
import { postThreadMessage, socialChat } from './social-chat.js';
import { clock } from '../mock/core/index.js';
import { config } from '../config.js';

const pending = new Map<string, Promise<unknown>>();

export async function postInitiativeWorkComment(input: {
  projectId: string; workItemId: string; userId: string; displayName: string;
  personId?: string | null; body: string; deliveryId: string;
}) {
  const item = await getWorkItem(input.workItemId);
  if (!item || item.projectId !== input.projectId) throw new AppError(404, 'Work item is not in this initiative');
  const channel = `orgiq:initiative:${input.projectId}`;
  const write = async () => {
    const backend = socialChat(); await backend.ready;
    const prior = (await backend.chatStore.listMessages(channel, 1000)).find(message =>
      message.userId === input.userId && message.metadata?.['clientDeliveryId'] === input.deliveryId);
    if (prior) {
      const page = prior.metadata?.['pageReference'] as { kind?: string; id?: string } | undefined;
      if (prior.message !== input.body || page?.kind !== 'work-item' || page.id !== input.workItemId)
        throw new AppError(409, 'This delivery id already belongs to another comment');
      return prior;
    }
    const at = config.mock.aurora ? clock.nowIso() : new Date().toISOString();
    const message = {
      id: liveMessageId(at), clientId: 'rest', channel, userId: input.userId,
      message: input.body, timestamp: at,
      metadata: {
        displayName: input.displayName,
        ...(input.personId ? { authorPersonId: input.personId } : {}),
        clientDeliveryId: input.deliveryId, workComment: true,
        pageReference: { kind: 'work-item', id: input.workItemId },
      },
    };
    await postThreadMessage(message);
    return message;
  };
  const next = (pending.get(channel) ?? Promise.resolve()).catch(() => undefined).then(write);
  pending.set(channel, next);
  try { return await next; } finally { if (pending.get(channel) === next) pending.delete(channel); }
}
