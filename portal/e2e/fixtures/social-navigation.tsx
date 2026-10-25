// Actual shell/workspace/native inbox with disconnected inert transport.
// Every HTTP read is intercepted by the spec; there is no socket. Native
// subscription/presence discovery frames are inert; messages/calls are forbidden.
import '@connorhoehnslalom/ui-components/styles.css';
import '../../src/app.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router';
import { GatewayContext, type GatewayContextValue } from '@connorhoehn/realtime-modules/client';
import { SessionProvider } from '../../src/lib/auth';
import { SharedNotificationsProvider } from '../../src/components/shell/SharedNotifications';
import { Layout } from '../../src/components/shell/Layout';
import SocialChatWorkspace from '../../src/pages/social/SocialChatWorkspace';
const listeners = new Set<(frame: unknown) => void>();
const frames: unknown[] = [];
const gateway = { connectionState: 'disconnected', sessionEpoch: 0, rest: null,
  send: (frame: { service?: string; action?: string }) => {
    if ((frame.service === 'chat' && ['send', 'typing'].includes(frame.action ?? '')) ||
      // The current call hook discovers existing calls with watch/unwatch.
      // These are subscription-only; starting, joining and signalling calls stay forbidden.
      (frame.service === 'call' && !['status', 'list', 'watch', 'unwatch'].includes(frame.action ?? ''))) {
      throw new Error('Social navigation fixture forbids messages and calls.');
    }
    frames.push(frame);
  },
  onMessage: (handler: (frame: unknown) => void) => { listeners.add(handler); return () => { listeners.delete(handler); }; },
} as unknown as GatewayContextValue;
(window as unknown as { socialNavigationFixture: unknown }).socialNavigationFixture = {
  receive(frame: unknown) { listeners.forEach(handler => handler(frame)); },
  frames,
};
createRoot(document.getElementById('root')!).render(<StrictMode><BrowserRouter><SessionProvider><GatewayContext.Provider value={gateway}><SharedNotificationsProvider>
  <Routes><Route element={<Layout />}>
    <Route path="/social/dms/:lobby" element={<SocialChatWorkspace route="dms" />} />
    <Route path="/social/dms/*" element={<SocialChatWorkspace route="dms" />} />
    <Route path="/social/embedded/dms/:lobby" element={<SocialChatWorkspace route="dms" embedding={{
      title: 'Communication', breadcrumbs: [{ label: 'Communication' }], pageCalls: null, pageMissed: 0,
    }} />} />
    <Route path="/social/channels/*" element={<SocialChatWorkspace route="channels" />} />
    <Route path="/social/rooms/*" element={<SocialChatWorkspace route="rooms" />} />
    <Route path="/social/teams/*" element={<SocialChatWorkspace route="teams" />} />
    <Route path="/social/calls/*" element={<SocialChatWorkspace route="calls" />} />
    <Route path="/social/recordings/*" element={<SocialChatWorkspace route="recordings" />} />
  </Route></Routes>
</SharedNotificationsProvider></GatewayContext.Provider></SessionProvider></BrowserRouter></StrictMode>);
