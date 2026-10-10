// Browser lifecycle fixture: the production host and installed call hooks,
// with an explicit inert signalling transport and stubbed platform receipts.
// It deliberately does not claim WebRTC/SFU media acceptance.
import React, { useEffect } from 'react';
import '../../src/app.css';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, Route, Routes, useLocation } from 'react-router';
import { GatewayContext, type GatewayContextValue } from '@connorhoehnslalom/realtime-modules/client';
import { useLVSContext } from '@connorhoehnslalom/realtime-modules/client/video';
import { Stack } from '@connorhoehnslalom/ui-components/shared';
import { SessionProvider, useSession } from '../../src/lib/auth';
import { useCallHost } from '../../src/lib/conversationCall';
import { ShellCallHost } from '../../src/components/shell/ShellCallHost';
import { SocialFooter } from '../../src/components/shell/SocialFooter';
import { HuddleChatSplit } from '../../src/components/shell/HuddleChat';

const listeners = new Set<(frame: unknown) => void>();
const sent: unknown[] = [];
const noop = () => {};
const gateway = {
  connectionState: 'connected', lastError: null, sessionToken: null,
  clientId: 'fixture-client', currentChannel: '',
  switchChannel: noop, subscribe: noop, unsubscribe: noop, disconnect: noop,
  reconnect: noop, sendMessage: noop, publish: noop,
  send: (frame: unknown) => { sent.push(frame); },
  onMessage: (listener: (frame: unknown) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
} as unknown as GatewayContextValue;

function Controls() {
  const host = useCallHost();
  const actions = useSession();
  const { session, refresh } = actions;
  const location = useLocation();
  const lvs = useLVSContext();
  useEffect(() => {
    host?.bind({ lobbyName: `${session?.tenant}:dm:${session?.sub}:u-nora`, title: 'Fixture huddle', channel: 'initiative:p-auth-migration' },
      { start: () => void host.call.start([{ userId: 'u-nora', displayName: 'Nora' }]) });
  }, [host?.bind, session?.sub, session?.tenant]);
  (window as unknown as { callFixture: unknown }).callFixture = {
    sent,
    actions,
    receive: (frame: unknown) => { for (const listener of listeners) listener(frame); },
  };
  return <>
    <div data-testid="fixture-actor">{session?.sub ?? ''}</div>
    <div data-testid="fixture-name">{session?.name ?? ''}</div>
    <div data-testid="fixture-tenant">{session?.tenant ?? ''}</div>
    <div data-testid="fixture-video-endpoint">{lvs?.baseUrl ?? 'no-provider'}</div>
    <div data-testid="fixture-platform-endpoint">{host?.platformApiUrl ?? ''}</div>
    <div data-testid="fixture-route">{location.pathname}</div>
    <div data-testid="fixture-call-id">{host?.call.call?.callId ?? ''}</div>
    <div data-testid="fixture-call-phase">{host?.call.phase ?? ''}</div>
    <button onClick={() => void host?.call.start([{ userId: 'u-nora', displayName: 'Nora' }])}>Start fixture call</button>
    <button onClick={() => void refresh()}>Refresh fixture session</button>
    <button onClick={() => host?.lobby && host.unbind(host.lobby.lobbyName)}>Drop fixture context</button>
    <Link to="/iq/projects/p-auth-migration">Initiative</Link>
    <Link to="/admin/bots">Admin</Link>
    <Link to="/settings">Settings</Link>
  </>;
}

function DraftPage() {
  return <textarea aria-label="Unsaved draft" defaultValue="" />;
}

createRoot(document.getElementById('root')!).render(
  <SessionProvider>
    <GatewayContext.Provider value={gateway}>
      <BrowserRouter>
        <ShellCallHost>
          <Stack gap="none" className="h-dvh min-h-0">
            <Stack gap="none" className="flex-1 min-h-0">
              <Controls />
              <HuddleChatSplit><Routes><Route path="*" element={<DraftPage />} /></Routes></HuddleChatSplit>
            </Stack>
            <SocialFooter />
          </Stack>
        </ShellCallHost>
      </BrowserRouter>
    </GatewayContext.Provider>
  </SessionProvider>,
);
