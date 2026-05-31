import { PresenceAvatars, type PresenceAvatarUser } from '@connorhoehnslalom/ui-components/shared';
import type { PresenceEntry } from '@connorhoehn/realtime-modules/client';

interface PresenceAvatarGroupProps {
  peers: PresenceEntry[];
  maxVisible?: number;
}

export function PresenceAvatarGroup({ peers, maxVisible = 5 }: PresenceAvatarGroupProps) {
  if (peers.length === 0) return null;
  const users: PresenceAvatarUser[] = peers.map((p) => ({
    id: p.clientId,
    name: (p.metadata?.['displayName'] as string | undefined) ?? p.clientId.slice(0, 8),
    online: true,
  }));
  return <PresenceAvatars users={users} maxVisible={maxVisible} size={28} />;
}
