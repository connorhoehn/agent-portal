// A work comment (/comment) is a record on its work item, stored once:
//   * unbound initiative: in the initiative conversation `orgiq:initiative:<id>`,
//     whose work-item comment feeds project the messages carrying that item's
//     page reference (providers/work-items.ts visibleThread);
//   * an initiative bound to a Social channel (leftovers 2): the old thread is
//     nobody's conversation any more, so the note goes on the item's own
//     thread `orgiq:work:<id>`, which the same feed reads. The page then posts
//     a one-line reference in the channel through the route every channel
//     message takes (the gateway, governed by the channel's posting rule);
//     `discussion: 'channel'` in the answer tells it to.
//
// "Bound" here is the binding as THIS caller may know it (sweep 12, L2,
// lib/initiative-discussion.ts visibleBoundChannel): a public channel, or a
// private one they are a member of. A caller the binding read and the
// discussion-home read both answer "unbound" sees the old initiative thread
// in their pane, so their note goes there and the answer says
// `discussion: 'thread'`, exactly as on an unbound initiative: the reply never
// reveals a private binding, and the note lands where that caller's pane
// shows it. The work item's feed reads both threads, so channel members still
// find the note on the item.
import { AppError } from './async-handler.js';
import { getWorkItem } from '../providers/work-items.js';
import { liveMessageId, workThreadChannel } from './work-thread.js';
import { visibleBoundChannel } from './initiative-discussion.js';
import { postThreadMessage, socialChat } from './social-chat.js';
import { clock } from '../mock/core/index.js';
import { config } from '../config.js';

const pending = new Map<string, Promise<unknown>>();

export async function postInitiativeWorkComment(input: {
  projectId: string; workItemId: string; userId: string; displayName: string;
  personId?: string | null; body: string; deliveryId: string;
  /** The caller's session subject, for channel membership (defaults to userId). */
  sub?: string;
}) {
  const item = await getWorkItem(input.workItemId);
  if (!item || item.projectId !== input.projectId) throw new AppError(404, 'Work item is not in this initiative');
  const bound = await visibleBoundChannel(input.projectId, input.sub ?? input.userId);
  const channel = bound ? workThreadChannel(input.workItemId) : `orgiq:initiative:${input.projectId}`;
  const discussion = bound ? 'channel' as const : 'thread' as const;
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
  try { return { ...(await next), discussion }; } finally { if (pending.get(channel) === next) pending.delete(channel); }
}
