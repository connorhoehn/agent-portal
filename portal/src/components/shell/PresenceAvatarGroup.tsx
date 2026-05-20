import type { PresenceEntry } from '../../hooks/useSessionPresence';

// 6 accessible-ish palette colours for avatar backgrounds.
const PALETTE = ['#4f7cff','#22c55e','#f59e0b','#ef4444','#a855f7','#14b8a6'];

function colorFor(clientId: string): string {
  let h = 0;
  for (let i = 0; i < clientId.length; i++) h = (h * 31 + clientId.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

function initialsFor(peer: PresenceEntry): string {
  const name = (peer.metadata?.['displayName'] as string | undefined) ?? peer.clientId;
  return name.slice(0, 2).toUpperCase();
}

interface Props {
  peers: PresenceEntry[];
  maxVisible?: number;
}

export function PresenceAvatarGroup({ peers, maxVisible = 5 }: Props) {
  if (peers.length === 0) return null;
  const visible = peers.slice(0, maxVisible);
  const overflow = peers.length - visible.length;
  const label = peers.length === 1 ? '1 other here' : `${peers.length} others here`;
  return (
    <div title={label} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      {visible.map(peer => (
        <div
          key={peer.clientId}
          title={(peer.metadata?.['displayName'] as string | undefined) ?? peer.clientId}
          style={{
            width: 28, height: 28, borderRadius: '50%',
            background: colorFor(peer.clientId),
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 11, fontWeight: 700, color: '#fff',
            border: '2px solid var(--color-surface, #fff)',
            marginLeft: visible.indexOf(peer) > 0 ? -6 : 0,
            cursor: 'default', userSelect: 'none',
          }}
        >
          {initialsFor(peer)}
        </div>
      ))}
      {overflow > 0 && (
        <div style={{
          width: 28, height: 28, borderRadius: '50%',
          background: '#6b7280',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 10, fontWeight: 700, color: '#fff',
          border: '2px solid var(--color-surface, #fff)',
          marginLeft: -6, cursor: 'default', userSelect: 'none',
        }}>
          +{overflow}
        </div>
      )}
    </div>
  );
}
