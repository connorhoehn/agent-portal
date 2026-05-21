import { AvatarGroup } from '@connorhoehnslalom/ui-components/shared';
import type { PresenceEntry } from '../../hooks/useSessionPresence';

interface PresenceAvatarGroupProps {
  peers: PresenceEntry[];
  maxVisible?: number;
}

export function PresenceAvatarGroup({ peers, maxVisible = 5 }: PresenceAvatarGroupProps) {
  if (peers.length === 0) return null;
  const names = peers.map(p =>
    (p.metadata?.['displayName'] as string | undefined) ?? p.clientId.slice(0, 8)
  );
  return <AvatarGroup names={names} maxVisible={maxVisible} size={28} />;
}
