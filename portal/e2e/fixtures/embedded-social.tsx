// Production embedding and installed conversation/call hooks with an explicit
// inert gateway/media fixture. Real BFF/WS acceptance lives in a separate spec.
import '../../src/app.css';
import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, Route, Routes } from 'react-router';
import { GatewayContext, type GatewayContextValue } from '@connorhoehnslalom/realtime-modules/client';
import { Stack } from '@connorhoehnslalom/ui-components/shared';
import { SessionProvider, useSession } from '../../src/lib/auth';
import { realtimeTokenSource } from '../../src/lib/realtimeToken';
import { ShellCallHost } from '../../src/components/shell/ShellCallHost';
import { SocialFooter } from '../../src/components/shell/SocialFooter';
import { HuddleChatSplit } from '../../src/components/shell/HuddleChat';
import { EmbeddedSocialProvider, useEmbeddedSocial } from '../../src/components/shell/EmbeddedSocial';
import { SharedNotificationsProvider } from '../../src/components/shell/SharedNotifications';
import { useCallHost } from '../../src/lib/conversationCall';
import ContactsPage from '../../src/pages/social/ContactsPage';
import SocialChatWorkspace from '../../src/pages/social/SocialChatWorkspace';

const listeners = new Set<(frame: Record<string, unknown>) => void>(), sent: Record<string, unknown>[] = [];
const receive = (frame: Record<string, unknown>) => { for (const listener of listeners) listener(frame); };
const noop = () => {};
let hold = false; const held: (() => void)[] = [];
const jwt = (sub: string, tenant: string, role: string) => `header.${btoa(JSON.stringify({ sub, org: tenant, role, epoch: 1 }))}.fixture`;
function Gateway({ children }: { children: React.ReactNode }) {
  const { session } = useSession();
  const [token, setToken] = useState<string | null>(null);
  useEffect(() => { if (session) setToken(jwt(session.sub, session.tenant, session.role)); }, [session?.sub, session?.tenant, session?.role]);
  const gateway = useMemo(() => ({
    connectionState: 'connected', sessionToken: 'opaque-fixture-session', authToken: token ?? undefined, clientId: 'fixture-client',
    lastError: null, currentChannel: '', switchChannel: noop, subscribe: noop, unsubscribe: noop, disconnect: noop,
    reconnect: () => { void realtimeTokenSource.get().then(value => setToken(value.token)); }, sendMessage: noop, publish: noop,
    onMessage: (listener: (frame: Record<string, unknown>) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    send: (frame: Record<string, unknown>) => {
      sent.push(frame);
      if (frame.service === 'chat' && frame.action === 'join') queueMicrotask(() => {
        receive({ type: 'chat', action: 'joined', channel: frame.channel }); receive({ type: 'chat', action: 'history', channel: frame.channel, messages: [] });
      });
      if (frame.service === 'chat' && frame.action === 'send') {
        const id = `fixture-message-${sent.length}`, message = { id, channel: frame.channel, userId: session?.sub, clientId: 'fixture-client',
          message: frame.message, metadata: frame.metadata, timestamp: new Date().toISOString() };
        queueMicrotask(() => {
          receive({ type: 'chat', action: 'message', channel: frame.channel, message });
          const ack = () => receive({ type: 'chat', action: 'sent', channel: frame.channel, messageId: id });
          if (hold) held.push(ack); else ack();
        });
      }
    },
  } as unknown as GatewayContextValue), [token, session?.sub]);
  return <GatewayContext.Provider value={gateway}>{children}</GatewayContext.Provider>;
}
function Controls() {
  const session = useSession(), social = useEmbeddedSocial(), host = useCallHost();
  useEffect(() => { host?.bind({ lobbyName: 'orgiq:dm:u-vera:u-nora', title: 'Fixture huddle', channel: 'initiative:p-auth-migration' }); }, [host?.bind]);
  (window as unknown as { socialFixture: unknown }).socialFixture = { sent, receive, actions: session,
    hold: () => { hold = true; }, release: () => { hold = false; held.splice(0).forEach(ack => ack()); },
    // The footer's Social button navigates for a granted user, so the panel opens through the same provider call the bell and People actions use.
    openPanel: () => { social?.selectPage(false); social?.openMessage(); },
    sendToPerson: (userId: string, text: string) => social?.sendToPerson(userId, text),
  };
  return <Stack gap="none" className="w-fit max-w-sm">
    <div data-testid="fixture-actor">{session.session?.sub}</div>
    <div data-testid="fixture-tenant">{session.session?.tenant}</div>
    <div data-testid="fixture-can-message">{String(social?.canMessagePeople)}</div>
    <div data-testid="fixture-call-id">{host?.call.call?.callId}</div>
    <button onClick={() => void host?.call.start([{ userId: 'u-nora', displayName: 'Nora' }])}>Start fixture call</button>
    <button onClick={() => void session.refresh()}>Refresh fixture session</button>
    <Link to="/iq/projects/p-auth-migration">Initiative</Link><Link to="/admin/bots">Admin</Link><Link to="/settings">Settings</Link>
    <Link to="/social/contacts">Contacts fixture</Link><Link to="/social/channels">Chat workspace fixture</Link>
  </Stack>;
}
createRoot(document.getElementById('root')!).render(<SessionProvider><Gateway><BrowserRouter><ShellCallHost><SharedNotificationsProvider>
  <EmbeddedSocialProvider><Stack gap="none" className="h-dvh min-h-0">
    <Stack gap="none" className="flex-1 min-h-0"><HuddleChatSplit><Stack gap="none" className="h-full min-h-0 overflow-auto"><Controls /><Routes>
      <Route path="/social/contacts" element={<ContactsPage />} />
      <Route path="/social/channels" element={<SocialChatWorkspace route="channels" />} />
      <Route path="*" element={<textarea aria-label="Page draft" />} /></Routes></Stack></HuddleChatSplit></Stack>
    <SocialFooter /></Stack></EmbeddedSocialProvider>
</SharedNotificationsProvider></ShellCallHost></BrowserRouter></Gateway></SessionProvider>);
