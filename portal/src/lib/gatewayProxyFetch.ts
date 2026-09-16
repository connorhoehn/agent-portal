// Thin fetch wrapper for the middleware gateway-proxy routes.
// Calls /api/gateway/* (relative — goes through Vite proxy → middleware → gateway).
// No auth headers needed from the browser; middleware adds HMAC signing.

const BASE = '/api/gateway';

/**
 * Presence entry as returned by GET /api/gateway/presence/:channel.
 * Matches the gateway's PresenceEntry wire shape; `metadata` may carry
 * a `displayName` field set by clients via the WS presence protocol.
 */
export interface PresenceEntry {
  clientId: string;
  status: string;
  metadata: Record<string, unknown>;
  channels: string[];
  nodeId: string;
  timestamp: string;
  lastSeen: string;
  lastHeartbeat: number;
}

/**
 * Fetch the current presence roster for a channel.
 * Gateway returns `{ users: PresenceEntry[] }`.
 */
export async function fetchPresence(channel: string): Promise<PresenceEntry[]> {
  const res = await fetch(`${BASE}/presence/${encodeURIComponent(channel)}`, { credentials: 'include' });
  if (!res.ok) throw new Error(`fetchPresence failed: ${res.status}`);
  const body = await res.json() as { users?: PresenceEntry[] } | PresenceEntry[];
  if (Array.isArray(body)) return body;
  return body.users ?? [];
}

/**
 * Publish a message to a gateway channel.
 * Calls POST /api/gateway/channels/:channel/messages.
 */
export async function publishToChannel(
  channel: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await fetch(`${BASE}/channels/${encodeURIComponent(channel)}/messages`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export interface ActivityEntry {
  eventId: string;
  channel: string;
  actorId: string;
  action: string;
  data: Record<string, unknown>;
  timestamp: string;
}

export async function fetchActivityHistory(channel: string, limit = 20): Promise<ActivityEntry[]> {
  const res = await fetch(
    `${BASE}/activity/${encodeURIComponent(channel)}/history?limit=${limit}`,
    { credentials: 'include' },
  );
  if (!res.ok) throw new Error(`fetchActivityHistory failed: ${res.status}`);
  const body = await res.json() as { events?: ActivityEntry[] } | ActivityEntry[];
  if (Array.isArray(body)) return body;
  return body.events ?? [];
}
