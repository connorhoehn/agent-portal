// Browser lifecycle fixture: the production host and installed call hooks,
// with an explicit inert signalling transport and stubbed platform receipts.
// It deliberately does not claim WebRTC/SFU media acceptance.
import React, { useEffect, useState } from 'react';
import '../../src/app.css';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, Route, Routes, useLocation } from 'react-router';
import { GatewayContext, type GatewayContextValue } from '@connorhoehn/realtime-modules/client';
import { useLVSContext } from '@connorhoehn/realtime-modules/client/video';
import { Stack } from '@connorhoehn/ui-components/shared';
import { SessionProvider, useSession } from '../../src/lib/auth';
import { useCallHost } from '../../src/lib/conversationCall';
import { ShellCallHost } from '../../src/components/shell/ShellCallHost';
import { SocialFooter } from '../../src/components/shell/SocialFooter';
import { SidePane, SidePaneProvider } from '@connorhoehn/ui-components';
import { ConversationInputProvider, useComposerFocus } from '@connorhoehn/ui-components/social/rich-composer';
import { ConversationPaneBody, useConversationPane } from '../../src/components/shell/ConversationPane';
import { ConversationComposer } from '../../src/lib/conversationComposer';
import { usePageHuddleComposer } from '../../src/components/shell/HuddleComposerDock';
import { HuddleChatSplit, useHuddleChat } from '../../src/components/shell/HuddleChat';

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
  const huddle = useHuddleChat();
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
    <output data-testid="fixture-huddle-draft" hidden>{huddle?.draft.html}</output>
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

function CentralComposer() {
  const huddle = usePageHuddleComposer();
  const focus = useComposerFocus();
  return <>
    <button onClick={() => focus.request({ mode: 'agent' })}>Ask fixture agent</button>
    <ConversationComposer key={huddle.editorKey} channel="fixture:page" context={{ kind: 'conversation', id: 'fixture-page', title: 'Page' }}
      identity={{ userId: 'u-vera', displayName: 'Vera Green' }} capabilities={{ maySend: true, agent: { allowed: !huddle.unavailableHuddle } }}
      recipients={[{ id: 'discussion', label: 'Page discussion', channel: 'fixture:page', send: () => false }, ...(huddle.recipient ? [huddle.recipient] : [])]}
      {...huddle.composerProps} onAgent={() => false} answersFocus claim={{ label: 'the page composer' }}
      draftKey="fixture-page-draft" inputLabel="Fixture chat" data-testid="fixture-central-composer" />
  </>;
}

function OwnedDiscussion() {
  const [tab, setTab] = useState('discussion');
  const pane = useConversationPane({ onReveal: () => setTab('discussion') });
  const focus = useComposerFocus();
  return <>
    <button onClick={() => focus.request({ mode: 'chat', target: { kind: 'discussion' } })}>Open page discussion</button>
    <SidePane title="Fixture discussion" data-testid="fixture-owned-pane"
      tabs={[{ id: 'discussion', label: 'Discussion' }, { id: 'details', label: 'Details' }]} value={tab} onValueChange={setTab}>
      <Stack hidden={tab !== 'discussion'} className="min-h-0 flex-1">
        <ConversationPaneBody pane={pane} pageLabel="Page discussion">
          <textarea aria-label="Page discussion draft" defaultValue="" />
        </ConversationPaneBody>
      </Stack>
      {tab === 'details' && <div>Fixture details</div>}
    </SidePane>
  </>;
}
function DraftPage() {
  const location = useLocation();
  return <><textarea aria-label="Unsaved draft" defaultValue="" />
    {new URLSearchParams(location.search).has('centralComposer') && <CentralComposer />}
    {new URLSearchParams(location.search).has('ownedPane') && <OwnedDiscussion />}</>;
}

createRoot(document.getElementById('root')!).render(
  <SessionProvider>
    <GatewayContext.Provider value={gateway}>
      <BrowserRouter><ConversationInputProvider><SidePaneProvider>
        <ShellCallHost>
          <Stack gap="none" className="h-dvh min-h-0">
            <Stack gap="none" className="flex-1 min-h-0">
              <Controls />
              <HuddleChatSplit><Routes><Route path="*" element={<DraftPage />} /></Routes></HuddleChatSplit>
            </Stack>
            <SocialFooter />
          </Stack>
        </ShellCallHost>
      </SidePaneProvider></ConversationInputProvider></BrowserRouter>
    </GatewayContext.Provider>
  </SessionProvider>,
);
