import { useMemo } from 'react';
import { usePresence } from '@connorhoehnslalom/realtime-modules/client';
import { PresenceAvatars } from '@connorhoehnslalom/ui-components/shared';
import { scopePresenceUsers } from './scopePresenceModel';

/** Announces on `channel` while mounted and shows who else is here. Renders
 * nothing when the gateway is offline or nobody has announced. */
export function ScopePresence({ channel }: { channel: string }) {
  const { roster } = usePresence(channel, { join: true });
  const users = useMemo(() => scopePresenceUsers(roster), [roster]);
  if (users.length === 0) return null;
  return <PresenceAvatars users={users.map((u) => ({ ...u, online: !u.idle }))} maxVisible={5} size={28} />;
}
