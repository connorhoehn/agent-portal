// useSessionPresence — session-scoped presence for a named channel.
//
// Wires WS presence subscription + initial roster fetch so pages can show
// who else is viewing the same section. Uses the GatewaySocketProvider's
// shared WS connection (no extra socket opened).
//
// Usage:
//   const { peers, isLoading } = useSessionPresence('newsroom-briefs');
//
// Presence protocol (gateway):
//   subscribe  → send({ service: 'subscribe', action: 'subscribe', channel: 'presence:channel' })
//   set        → send({ service: 'presence', action: 'set', channel, data: { displayName } })
//   clear      → send({ service: 'presence', action: 'clear', channel })
//   inbound    → { type: 'presence', action: 'update'|'offline', channel, data: { clientId, ... } }

import { useEffect, useRef, useState, useCallback } from 'react';
import type { GatewayMessage } from '@connorhoehn/realtime-modules/client/ws';
import { useGatewaySocket } from './useGatewaySocket';
import { fetchPresence } from '../lib/gatewayProxyFetch';
import type { PresenceEntry } from '../lib/gatewayProxyFetch';

export type { PresenceEntry };

export interface UseSessionPresenceReturn {
  peers: PresenceEntry[];
  isLoading: boolean;
}

/**
 * Track session presence for `channel`.  Subscribes to the gateway's
 * `presence:<channel>` WS topic, announces this client's presence on
 * connect, fetches the initial roster, and updates state on inbound
 * presence frames.
 *
 * Returns entries for ALL clients on the channel (including the current
 * client). Callers who want to show only *other* peers can filter by
 * `clientId !== ctx.clientId`.
 */
export function useSessionPresence(channel: string): UseSessionPresenceReturn {
  const { connectionState, clientId, userSub, send, subscribe, unsubscribe, addMessageListener, removeMessageListener } =
    useGatewaySocket();

  const [peers, setPeers] = useState<PresenceEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Track whether we've already subscribed for this mount cycle so
  // React StrictMode double-invoke doesn't double-subscribe.
  const subscribedRef = useRef(false);

  // Stable channel ref — avoids stale closure in the message listener.
  const channelRef = useRef(channel);
  useEffect(() => {
    channelRef.current = channel;
  }, [channel]);

  // Initial roster fetch — runs once per channel when loading starts.
  const fetchRoster = useCallback(async () => {
    try {
      const entries = await fetchPresence(channel);
      setPeers(entries);
    } catch {
      // Gateway may not be reachable; treat as empty roster rather than error.
      setPeers([]);
    } finally {
      setIsLoading(false);
    }
  }, [channel]);

  // Subscribe / set presence / fetch roster when connected.
  useEffect(() => {
    if (connectionState !== 'connected') return;
    if (subscribedRef.current) return;
    subscribedRef.current = true;

    subscribe(`presence:${channel}`);
    send({
      service: 'presence',
      action: 'set',
      channel,
      data: { displayName: userSub ?? 'anonymous' },
    });
    void fetchRoster();
  }, [connectionState, channel, userSub, subscribe, send, fetchRoster]);

  // Reset subscription flag when disconnected so we re-subscribe on reconnect.
  useEffect(() => {
    if (connectionState === 'disconnected' || connectionState === 'idle') {
      subscribedRef.current = false;
    }
  }, [connectionState]);

  // Inbound WS presence message listener.
  useEffect(() => {
    const listener = (message: GatewayMessage) => {
      const raw = message as Record<string, unknown>;
      if (raw['type'] !== 'presence') return;
      if (raw['channel'] !== channelRef.current) return;

      const action = raw['action'] as string | undefined;
      const data = raw['data'] as Record<string, unknown> | undefined;
      if (!data || typeof data['clientId'] !== 'string') return;

      const incomingClientId = data['clientId'] as string;

      if (action === 'update') {
        // Upsert: replace existing entry for this clientId or append.
        setPeers(prev => {
          const idx = prev.findIndex(p => p.clientId === incomingClientId);
          const entry: PresenceEntry = {
            clientId: incomingClientId,
            status: typeof data['status'] === 'string' ? data['status'] : 'online',
            metadata: typeof data['metadata'] === 'object' && data['metadata'] !== null
              ? data['metadata'] as Record<string, unknown>
              : {},
            channels: Array.isArray(data['channels']) ? data['channels'] as string[] : [],
            nodeId: typeof data['nodeId'] === 'string' ? data['nodeId'] : '',
            timestamp: typeof data['timestamp'] === 'string' ? data['timestamp'] : new Date().toISOString(),
            lastSeen: typeof data['lastSeen'] === 'string' ? data['lastSeen'] : new Date().toISOString(),
            lastHeartbeat: typeof data['lastHeartbeat'] === 'number' ? data['lastHeartbeat'] : Date.now(),
          };
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = entry;
            return next;
          }
          return [...prev, entry];
        });
      } else if (action === 'offline') {
        setPeers(prev => prev.filter(p => p.clientId !== incomingClientId));
      }
    };

    addMessageListener(listener);
    return () => {
      removeMessageListener(listener);
    };
  }, [addMessageListener, removeMessageListener]);

  // Cleanup: unsubscribe + clear presence on unmount.
  useEffect(() => {
    return () => {
      if (subscribedRef.current) {
        send({ service: 'presence', action: 'clear', channel });
        unsubscribe(`presence:${channel}`);
        subscribedRef.current = false;
      }
    };
    // Only run on unmount — intentionally empty deps except channel/send/unsubscribe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel, send, unsubscribe]);

  // Exclude current client from the peers list shown to the user.
  const otherPeers = clientId
    ? peers.filter(p => p.clientId !== clientId)
    : peers;

  return { peers: otherPeers, isLoading };
}
