import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { Button, Inline, InlineAlert, InlinePopover, Stack, StatusDot, T, WarningIcon } from '@connorhoehn/ui-components/shared';
import { MonitorIcon } from '@connorhoehn/ui-components/video';
import type { ConversationCallGateway } from '@connorhoehn/realtime-modules/client/video';
import { CallPageSession, callPageScopeKey, canStopSharingCallPage, createCallPageClient, currentCallPage } from '../../lib/callPages';

export interface CallPageSharingProps {
  callId: string | null;
  tenant: string | null;
  actorId: string | null;
  callerId?: string | null;
  /** The authenticated host identity, including masquerade provenance. */
  identityKey?: string;
  gateway: ConversationCallGateway;
  connectionState: string;
  /** The footer's icon-first control: the words move to its accessible name. */
  compact?: boolean;
  screenShare?: { on: boolean; onToggle: () => void; disabledReason?: string };
}

/** One controller beside the shell's one call dock; it owns no media or navigation-following. */
export function CallPageSharing({ callId, tenant, actorId, callerId = null, identityKey, gateway, connectionState, compact = false, screenShare }: CallPageSharingProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const [session] = useState(() => new CallPageSession(createCallPageClient()));
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const scope = useMemo(() => callId && tenant === 'orgiq' && actorId ? { callId, tenant, actorId, identityKey } : null,
    [callId, tenant, actorId, identityKey]);
  const scopeKey = callPageScopeKey(scope);
  const current = useMemo(() => tenant === 'orgiq' ? currentCallPage(location.pathname, location.search) : null,
    [tenant, location.pathname, location.search]);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    session.setScope(scope);
    setOpen(false);
    return () => session.setScope(null);
  }, [session, scope]);

  // Subscription precedes replay so an intervening peer update wins by revision.
  useEffect(() => gateway.onMessage(frame => {
    session.receive(frame);
    // The call's initial GET may precede the service's participant registration.
    if (frame.type === 'call' && ['accepted', 'participant-state', 'active-call'].includes(String(frame.action ?? ''))) {
      const data = frame.data && typeof frame.data === 'object' ? frame.data as Record<string, unknown> : frame;
      if (data.callId === callId && !session.getSnapshot().loaded) void session.refresh({ retryRegistration: true });
    }
  }), [gateway.onMessage, session, callId]);

  useEffect(() => {
    if (scope && connectionState === 'connected') void session.refresh({ retryRegistration: true });
  }, [session, scope, connectionState, gateway.sessionEpoch]);

  if (!scope || state.scopeKey !== scopeKey) return null;
  const page = state.snapshot?.page ?? null;
  const samePage = !!page && current?.kind === page.kind && current.id === page.id;
  const writable = state.loaded && connectionState === 'connected' && !state.pending;
  const canStop = canStopSharingCallPage(page, actorId, callerId);
  const screenSharing = screenShare?.on === true;
  const sharingNow = !!page || screenSharing;
  const sharing = current?.kind === 'work-item' ? 'work item' : 'initiative';
  const initiative = currentCallPage(location.pathname);

  // One footer control (docs/design/initiative-huddle-shell-plan.md, "Sharing
  // popover"): the words say whether a page is shared; the popover opens
  // upward from the footer (InlinePopover flips a bottom placement above it).
  const label = 'Share';
  return (
    <Inline gap="none" align="center" wrap={false} data-testid="call-page-sharing" className="min-w-0">
      <Button ref={trigger} variant="ghost" size="sm" className={sharingNow ? 'text-primary' : undefined}
        aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(value => !value)}
        aria-label="Share with the huddle" title={screenSharing ? 'Sharing your screen' : page ? `Sharing ${page.title}` : label}
        data-testid="call-page-sharing-trigger" data-shared={sharingNow ? 'true' : 'false'} data-screen-sharing={screenSharing ? 'true' : 'false'}>
        <Inline gap="xs" align="center" wrap={false}>
          <MonitorIcon size={18} />
          {sharingNow && <StatusDot color="var(--color-success)" size="xs" aria-label={screenSharing ? 'Screen shared' : 'Page shared'} />}
          {!compact && <T>{label}</T>}
          {state.error && <WarningIcon size={14} className="text-danger" aria-label="Sharing needs attention" />}
        </Inline>
      </Button>
      {/* InlinePopover measures once when it opens and flips above the footer
          from that height; a content change (page loaded, shared, error)
          re-measures it so it never grows down past the window. */}
      <InlinePopover key={`${page?.kind ?? ''}:${page?.id ?? ''}:${state.loaded}:${!!state.error}:${connectionState}:${samePage}`}
        trigger={trigger} open={open} onClose={() => setOpen(false)} placement="bottom-end" offset={12}
        aria-label="Shared with this huddle" className="w-80 max-w-full" data-testid="call-page-sharing-popover">
        <Stack gap="md" className="p-4">
          <T size="sm" weight="semibold">Share with the huddle</T>
          {state.refreshing && !state.loaded && <T size="xs" tone="tertiary">Loading shared page…</T>}
          {state.error && <InlineAlert tone="error" data-testid="call-page-sharing-error">
            <Inline gap="sm" wrap>
              <T size="xs">{state.error}</T>
              <Button variant="link" size="sm" className="text-xs" disabled={state.refreshing || state.pending}
                onClick={() => void session.refresh({ retryRegistration: true })}>Refresh</Button>
            </Inline>
          </InlineAlert>}
          {page ? <>
            <T size="xs" tone="tertiary" wrap>{page.breadcrumbs.map(crumb => crumb.title).join(' › ')}</T>
            <T size="sm" weight="semibold" tone="primary" wrap data-testid="call-page-sharing-title">{page.title}</T>
            <T size="xs" tone="secondary" wrap>Shared by {page.presenter.displayName}</T>
            <Inline gap="sm" wrap>
              <Button variant="secondary" size="sm" onClick={() => { navigate(page.href); setOpen(false); }}
                data-testid="call-page-sharing-open">Open page</Button>
              {canStop && <Button variant="ghost" size="sm" disabled={!writable}
                onClick={() => void session.share(null)} data-testid="call-page-sharing-stop">
                {state.pending ? 'Saving…' : 'Stop sharing'}
              </Button>}
            </Inline>
          </> : <T size="sm" tone="secondary" wrap>Share an initiative or work item with this call.</T>}
          <Stack gap="xs">
            {current && <Button variant="ghost" size="sm" className="!h-auto justify-start !py-2 text-left" disabled={!writable || samePage}
              onClick={() => { void session.share(current); }} data-testid="call-page-sharing-share">
              <Stack gap="xs" className="text-left"><T size="sm" weight="medium">{samePage ? 'Current page is shared' : `Current ${sharing}`}</T><T size="xs" tone="secondary" wrap>Open the same page for everyone in this huddle.</T></Stack>
            </Button>}
            {current?.kind === 'work-item' && initiative && <Button variant="ghost" size="sm" className="!h-auto justify-start !py-2 text-left" disabled={!writable}
              onClick={() => { void session.share(initiative); }}><Stack gap="xs" className="text-left"><T size="sm" weight="medium">Initiative overview</T><T size="xs" tone="secondary">Share the broader project context.</T></Stack></Button>}
            {screenShare && <Button variant="ghost" size="sm" className="!h-auto justify-start !py-2 text-left" disabled={!!screenShare.disabledReason}
              title={screenShare.disabledReason} onClick={() => { setOpen(false); screenShare.onToggle(); }} data-testid="call-screen-sharing">
              <Stack gap="xs" className="text-left"><T size="sm" weight="medium">{screenShare.on ? 'Stop screen sharing' : 'Screen, window, or tab'}</T><T size="xs" tone="secondary">Choose a source in your browser.</T></Stack>
            </Button>}
            {initiative && <Button variant="ghost" size="sm" className="!h-auto justify-start !py-2 text-left" onClick={() => {
              navigate(`/iq/projects/${encodeURIComponent(initiative.id)}?tab=docs`); setOpen(false);
            }}><Stack gap="xs" className="text-left"><T size="sm" weight="medium">Document or presentation</T><T size="xs" tone="secondary">Open the initiative’s files to choose one.</T></Stack></Button>}
          </Stack>
          {connectionState !== 'connected' && <T size="xs" tone="tertiary" wrap>Reconnect to change the shared page.</T>}
          {!state.loaded && !state.refreshing && !state.error && <Button variant="secondary" size="sm"
            onClick={() => void session.refresh({ retryRegistration: true })}>Load shared page</Button>}
        </Stack>
      </InlinePopover>
    </Inline>
  );
}
