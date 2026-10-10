import type { SharedPeople } from '../components/shell/tenantDirectModel.ts';

type PortraitMessage = { userId?: string; metadata?: Record<string, unknown> };

/** Current directory photos decorate the view; persisted message metadata stays untouched. */
export function withMessagePortraits<T extends PortraitMessage>(messages: T[], directory: SharedPeople | null): T[] {
  if (!directory) return messages;
  const portraits = new Map([directory.me, ...directory.people].map(person => [person.userId, person.avatarUrl]));
  let changed = false;
  const decorated = messages.map(message => {
    const avatarUrl = message.userId ? portraits.get(message.userId) : undefined;
    if (!avatarUrl || message.metadata?.avatarUrl === avatarUrl) return message;
    changed = true;
    return { ...message, metadata: { ...message.metadata, avatarUrl } };
  });
  return changed ? decorated : messages;
}
