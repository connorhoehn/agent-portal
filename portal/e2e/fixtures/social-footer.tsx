// Production footer/native controls with explicit inert call state. No media,
// gateway, API mutations, or message sends are performed by this fixture.
import '../../src/app.css';
import { StrictMode, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { Button, ChatIcon, Inline, PresenceDot, Stack, T } from '@connorhoehnslalom/ui-components/shared';
import { SidePane, SidePaneProvider } from '@connorhoehnslalom/ui-components';
import { CallDock } from '@connorhoehnslalom/ui-components/video';
import { conversationCallDockProps } from '@connorhoehnslalom/realtime-modules/client/video';
import { callCounts, callDrawn } from '@connorhoehnslalom/ui-components/integrations/realtime';
import { SessionProvider } from '../../src/lib/auth';
import { SocialFooter } from '../../src/components/shell/SocialFooter';
export { callCounts, callDrawn };

type Model = { phase: 'idle' | 'calling' | 'live' | 'failed'; context: boolean; placement: 'footer' | 'composer' | 'page' | 'block' | 'pane'; mediaOpen: boolean; chatOpen: boolean; micOn: boolean; cameraOn: boolean; settings: number; starts: number; leaves: number; chats: number };
let state: Model = { phase: 'idle', context: true, placement: 'footer', mediaOpen: false, chatOpen: false, micOn: false, cameraOn: false, settings: 0, starts: 0, leaves: 0, chats: 0 };
const subscribers = new Set<() => void>();
const set = (next: Partial<Model>) => { state = { ...state, ...next }; subscribers.forEach(handler => handler()); };
function useModel() { return useSyncExternalStore(handler => { subscribers.add(handler); return () => { subscribers.delete(handler); }; }, () => state); }
const noop = () => {};
export function useCallHost() {
  const model = useModel();
  const self = { id: 'fixture-reader', displayName: 'Fixture Reviewer', isLocal: true, state: 'in-call', audioOn: model.micOn, cameraOn: model.cameraOn, screenSharing: false };
  return { tenant: document.documentElement.dataset.tenant ?? 'orgiq', self: null,
    lobby: model.context ? { lobbyName: 'inert:footer', title: 'Observability Platform', channel: 'inert:footer' } : null,
    startBound: () => set({ phase: 'calling', starts: model.starts + 1 }), checkDevices: () => set({ settings: model.settings + 1 }),
    call: { phase: model.phase, call: model.phase === 'idle' ? null : { callId: 'inert-footer-call', host: self.id, participantCount: 2,
      participants: [self, { ...self, id: 'fixture-peer', displayName: 'Fixture Peer', isLocal: false }], startedAt: Date.now() - 10_000 },
      self, media: { error: null }, error: model.phase === 'failed' ? { message: 'Inert media connection failure' } : null,
      elapsedMs: 10_000, activeSpeakerId: null, callingTo: { displayNames: [], participantCount: 0 },
      devices: { prefs: {}, set: noop, list: { microphones: [], cameras: [], permission: { microphone: 'granted', camera: 'granted' } } },
      toggleMic: () => set({ micOn: !model.micOn }), toggleCamera: () => set({ cameraOn: !model.cameraOn }), toggleScreenShare: noop,
      rejoin: () => set({ phase: 'live' }), leave: () => set({ phase: 'idle', leaves: model.leaves + 1 }) } };
}
export function useCallBlockPlacement() { return useModel().placement; }
export function useCallMediaPanel() { const model = useModel(); return { open: model.mediaOpen, toggle: () => set({ mediaOpen: !model.mediaOpen }) }; }
export function useHuddleChatToggle() { const model = useModel(); return model.phase === 'live' ? { open: model.chatOpen, toggle: () => set({ chatOpen: !model.chatOpen, chats: model.chats + 1 }) } : null; }
export function HuddleReactionBar() { return null; }
export function ShellCallMedia() { return null; }
export function EmbeddedSocialEntry() { return <Inline gap="sm" align="center" wrap={false} data-testid="shell-social-bar">
  <Button variant="ghost" size="sm" data-testid="shell-social-open"><ChatIcon size={16} />Social</Button>
  <Inline gap="xs" className="border-l border-border pl-3" align="center"><PresenceDot state="offline" pulse={false} size="sm" /><T size="xs" tone="secondary">0 online</T></Inline>
</Inline>; }
function Surface() {
  const model = useModel();
  const host = useCallHost();
  const dock = conversationCallDockProps(host.call, { title: 'Observability Platform', onOpenPeople: noop, onOpenSettings: noop, tile: () => undefined });
  const query = new URLSearchParams(location.search);
  const tenant = query.get('tenant');
  document.documentElement.dataset.tenant = tenant && ['assessment', 'social', 'pipelines'].includes(tenant) ? tenant : 'orgiq';
  if (query.get('theme') === 'dark') document.documentElement.dataset.theme = 'dark';
  return <Stack gap="none" className="h-dvh min-h-0">
    <Stack gap="md" className="flex-1 min-h-0 p-6"><T size="lg" weight="semibold">Contextual footer fixture</T>
      <output data-testid="footer-model">{JSON.stringify(model)}</output>
      <button onClick={() => set({ phase: 'live' })}>Show inert live call</button>
      <button onClick={() => set({ phase: 'failed' })}>Show inert failure</button>
      <button onClick={() => set({ context: false })}>Remove inert page context</button>
      <button onClick={() => set({ placement: 'page' })}>Show a full native bar on the page</button>
      <button onClick={() => set({ placement: 'composer' })}>Show a full native bar in the composer</button>
      <button onClick={() => set({ placement: 'block' })}>Show a full native standalone block</button>
      <button onClick={() => set({ placement: 'pane' })}>Move media to the pane</button>
      {dock && ['page', 'block', 'composer'].includes(model.placement) && <CallDock {...dock} layout="shelf" data-testid="fixture-full-call-bar" />}
      <SidePane title="Page discussion" tabs={[{ id: 'discussion', label: 'Discussion' }]} value="discussion"><T>Inert page discussion</T></SidePane>
    </Stack><SocialFooter />
  </Stack>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><BrowserRouter><SessionProvider><SidePaneProvider><Surface /></SidePaneProvider></SessionProvider></BrowserRouter></StrictMode>);
