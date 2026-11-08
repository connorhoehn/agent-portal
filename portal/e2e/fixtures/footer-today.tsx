// Mounted production footer; all identities/calls below are inert fixtures.
import '@connorhoehn/ui-components/styles.css';
import '../../src/app.css';
import { useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, useLocation } from 'react-router';
import { Button, ChatIcon, Inline, Stack, T } from '@connorhoehn/ui-components/shared';
import { SidePaneProvider } from '@connorhoehn/ui-components';
import { callCounts, callDrawn } from '@connorhoehn/ui-components/integrations/realtime';
import { SessionProvider, useSession } from '../../src/lib/auth';
import { TodayPlacementProvider } from '../../src/components/shell/FooterTodayStrip';
import { SocialFooter } from '../../src/components/shell/SocialFooter';
export { callCounts, callDrawn };
type Model = { phase: 'idle' | 'live'; micOn: boolean; cameraOn: boolean; starts: number; leaves: number };
let model: Model = { phase: 'idle', micOn: false, cameraOn: false, starts: 0, leaves: 0 };
const handlers = new Set<() => void>();
const set = (value: Partial<Model>) => { model = { ...model, ...value }; handlers.forEach(handler => handler()); };
function useModel() { return useSyncExternalStore(handler => { handlers.add(handler); return () => { handlers.delete(handler); }; }, () => model); }
const noop = () => {};
export function useCallHost() {
  const state = useModel();
  const self = { id: 'fixture-reader', displayName: 'Fixture Reviewer', isLocal: true, state: 'in-call', audioOn: state.micOn, cameraOn: state.cameraOn, screenSharing: false };
  return { tenant: document.documentElement.dataset.tenant ?? 'orgiq', self: null,
    lobby: { lobbyName: 'inert:today', title: 'Inert project', channel: 'inert:today' },
    startBound: () => set({ phase: 'live', starts: state.starts + 1 }), checkDevices: noop,
    call: { phase: state.phase, call: state.phase === 'idle' ? null : { callId: 'inert-today-call', host: self.id, participants: [self], participantCount: 1, startedAt: Date.now() }, self,
      media: { error: null }, error: null, elapsedMs: 0, activeSpeakerId: null, callingTo: { displayNames: [], participantCount: 0 },
      devices: { prefs: {}, set: noop, list: { microphones: [], cameras: [], permission: { microphone: 'granted', camera: 'granted' } } },
      toggleMic: () => set({ micOn: !state.micOn }), toggleCamera: () => set({ cameraOn: !state.cameraOn }), toggleScreenShare: noop,
      leave: () => set({ phase: 'idle', leaves: state.leaves + 1 }), rejoin: noop } };
}
export function useCallBlockPlacement() { return 'footer'; }
export function useCallMediaPanel() { return { open: false, toggle: noop }; }
export function useHuddleChat() { return null; }
export function useHuddleReact() { return null; }
export function useHuddleChatToggle() { return null; }
export function HuddleReactionBar() { return null; }
export function ShellCallMedia() { return null; }
export function EmbeddedSocialEntry() { return <Inline gap="sm" align="center" wrap={false}><Button variant="ghost" size="sm"><ChatIcon size={16} />Social</Button><T size="xs">0 online</T></Inline>; }
function Surface() {
  const state = useModel(), { session, refresh } = useSession(), location = useLocation();
  const [refreshed, setRefreshed] = useState(0);
  document.documentElement.dataset.tenant = session?.tenant ?? 'orgiq';
  if (new URLSearchParams(location.search).get('theme') === 'dark') document.documentElement.dataset.theme = 'dark';
  return <Stack gap="none" className="h-dvh min-h-0"><main className="flex-1 p-6">
    <button onClick={async () => { await refresh(); setRefreshed(value => value + 1); }}>Refresh fixture identity</button>
    <button onClick={() => set({ phase: state.phase === 'idle' ? 'live' : 'idle' })}>Toggle inert huddle</button>
    <button>Outside focus target</button>
    <output data-testid="today-location">{location.pathname}</output><output data-testid="today-identity">{JSON.stringify({ sub: session?.sub, tenant: session?.tenant, refreshed })}</output>
    <output data-testid="today-call">{JSON.stringify(state)}</output>
  </main><SocialFooter /></Stack>;
}
createRoot(document.getElementById('root')!).render(<BrowserRouter><SessionProvider><SidePaneProvider><TodayPlacementProvider><Surface /></TodayPlacementProvider></SidePaneProvider></SessionProvider></BrowserRouter>);
