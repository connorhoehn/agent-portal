// The Calls view on a page's conversation surface (beside Chat | Pinned | Files):
// that page lobby's call history — when each call started, how long it ran, who
// was in it, which ones you missed — and, while a huddle is on that you are not
// in, a live card with Join. Library composites only (CallActivityCard,
// EmptyState, LoadingState, ErrorState); the rows are the BFF's call-log rows
// (hooks/usePageCalls.ts), listed under the page's own read authority.
import { useEffect } from 'react';
import { EmptyState, ErrorState, LoadingState, Stack, T } from '@connorhoehnslalom/ui-components/shared';
import { CallActivityCard } from '@connorhoehnslalom/ui-components/social';
import { useCallHost } from '../../lib/conversationCall';
import { pageHuddleStart } from '@connorhoehnslalom/ui-components/integrations/realtime';
import { pageCallCard, type PageCallsResponse } from '../../lib/pageCalls';
import type { NameOf } from '../../pages/social/socialPlatform';

export interface PageCallsViewProps {
  lobby: string;
  calls: { data: PageCallsResponse | null; isLoading: boolean; error: string | null; refresh: () => void };
  me: string;
  nameOf: NameOf;
  testId?: string;
}

export function PageCallsView({ lobby, calls, me, nameOf, testId = 'page-calls' }: PageCallsViewProps) {
  const host = useCallHost();
  const { data, isLoading, error, refresh } = calls;
  // A huddle on in this page's lobby: discovered while idle (Join), or the one you are in.
  const bound = !!host && host.lobby?.lobbyName === lobby;
  const live = bound ? host.call.call : null;
  const inCall = bound && host.call.phase !== 'idle' && host.call.phase !== 'ended' && host.call.phase !== 'failed';
  const liveParticipants = (live?.participants ?? []).filter(p => p.state === 'in-call' || p.state === 'reconnecting')
    .map(p => ({ userId: p.userId, displayName: p.isLocal ? 'You' : p.displayName, ...(p.avatarUrl ? { avatarUrl: p.avatarUrl } : {}) }));
  // A huddle that just ended reports its row a moment later; ask again once it has.
  const phase = bound ? host.call.phase : 'idle';
  useEffect(() => {
    if (phase !== 'ended' && phase !== 'idle') return;
    const timer = window.setTimeout(refresh, 2_000);
    return () => window.clearTimeout(timer);
  }, [phase, refresh]);
  return (
    <Stack gap="sm" data-testid={testId}>
      {live && (liveParticipants.length > 0 || !inCall) && (
        <CallActivityCard callId={live.callId} live participants={liveParticipants}
          {...(live.startedAt ? { startedAt: live.startedAt } : {})}
          {...(live.host ? { startedBy: live.host === me ? 'You' : nameOf(live.host) } : {})}
          lobbyName={lobby}
          {...(!inCall && host ? { onJoin: () => { pageHuddleStart(host.call); } } : {})}
          data-testid={`${testId}-live`} />
      )}
      {isLoading && !data ? <LoadingState label="Loading calls…" /> : error && !data ? (
        <ErrorState title="Calls could not be loaded" description={error} actionLabel="Try again" onAction={refresh} />
      ) : (data?.calls.length ?? 0) === 0 ? (
        !live && <EmptyState testId={`${testId}-empty`} align="start" title="No calls yet"
          description="Huddles you join on this page, and the calls you missed, are listed here." />
      ) : (
        <Stack gap="xs" data-testid={`${testId}-list`}>
          {data!.calls.map(row => (
            <CallActivityCard key={`${row.callId}:${row.startedAt}`} {...pageCallCard(row, me, nameOf)} data-testid={`${testId}-row`} />
          ))}
          <T className="text-xs text-text-muted">Only calls you were part of are listed.</T>
        </Stack>
      )}
    </Stack>
  );
}
