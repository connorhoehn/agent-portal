// useActivityFeed — live activity feed for a gateway channel.
//
// Fetches recent history on connect and subscribes to real-time
// `activity:<channel>` events. New events are prepended so the feed
// shows newest-first (callers can reverse if needed).
//
// Usage:
//   const { entries, isLoading } = useActivityFeed('newsroom-researcher');

import { useEffect, useRef, useState, useCallback } from 'react';
import type { GatewayMessage } from '@connorhoehn/realtime-modules/client/ws';
import { useGateway } from '@connorhoehn/realtime-modules/client/ws';
import { fetchActivityHistory } from '../lib/gatewayProxyFetch';
import type { ActivityEntry } from '../lib/gatewayProxyFetch';

export type { ActivityEntry };

export interface UseActivityFeedReturn {
  entries: ActivityEntry[];
  isLoading: boolean;
}

export function useActivityFeed(channel: string, limit = 20): UseActivityFeedReturn {
  const { connectionState, subscribe, unsubscribe, onMessage } = useGateway();

  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const subscribedRef = useRef(false);
  const channelRef = useRef(channel);
  useEffect(() => { channelRef.current = channel; }, [channel]);

  const fetchHistory = useCallback(async () => {
    try {
      const data = await fetchActivityHistory(channel, limit);
      // API returns ascending; reverse to newest-first.
      setEntries([...data].reverse());
    } catch {
      setEntries([]);
    } finally {
      setIsLoading(false);
    }
  }, [channel, limit]);

  // Subscribe + fetch when connected.
  useEffect(() => {
    if (connectionState !== 'connected') return;
    if (subscribedRef.current) return;
    subscribedRef.current = true;
    subscribe(`activity:${channel}`);
    void fetchHistory();
  }, [connectionState, channel, subscribe, fetchHistory]);

  // Reset on disconnect.
  useEffect(() => {
    if (connectionState === 'disconnected' || connectionState === 'idle') {
      subscribedRef.current = false;
    }
  }, [connectionState]);

  // Inbound activity events — prepend to keep newest-first.
  useEffect(() => {
    const listener = (message: GatewayMessage) => {
      const raw = message as Record<string, unknown>;
      if (raw['type'] !== 'activity') return;
      if (raw['channel'] !== channelRef.current) return;
      const data = raw['data'] as Record<string, unknown> | undefined;
      if (!data || typeof data['eventId'] !== 'string') return;
      const entry: ActivityEntry = {
        eventId: data['eventId'] as string,
        channel: typeof data['channel'] === 'string' ? data['channel'] : channelRef.current,
        actorId: typeof data['actorId'] === 'string' ? data['actorId'] : 'unknown',
        action: typeof data['action'] === 'string' ? data['action'] : '',
        data: typeof data['data'] === 'object' && data['data'] !== null
          ? data['data'] as Record<string, unknown> : {},
        timestamp: typeof data['timestamp'] === 'string' ? data['timestamp'] : new Date().toISOString(),
      };
      setEntries(prev => [entry, ...prev].slice(0, 100)); // cap at 100
    };
    return onMessage(listener);
  }, [onMessage]);

  // Cleanup: unsubscribe on unmount.
  useEffect(() => {
    return () => {
      if (subscribedRef.current) {
        unsubscribe(`activity:${channel}`);
        subscribedRef.current = false;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel, unsubscribe]);

  return { entries, isLoading };
}
