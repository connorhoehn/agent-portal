import '../../src/app.css';
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, useLocation, useSearchParams } from 'react-router';
import { GatewayContext, type GatewayContextValue } from '@connorhoehnslalom/realtime-modules/client';
import { Stack } from '@connorhoehnslalom/ui-components/shared';
import { SessionProvider, useSession } from '../../src/lib/auth';
import { CanvasDocumentPane } from '../../src/pages/assessment/knowledge/CanvasDocumentPane';
import { conversationChannelForDoc } from '../../src/pages/assessment/knowledge/knowledgeFormat';
import { documentCallLobby, documentCallChannel } from '../../src/pages/assessment/knowledge/documentCommentsModel';
import { PostCallRecordingMonitor } from '../../src/components/recordings/PostCallRecording';
import { CallHostProvider, fixtureLifecycle, useCallHost } from './recording-runtime';

// Read-only native SDK hooks with no socket, devices or send transport.
const gateway = {
  connectionState: 'disconnected', sessionEpoch: 0, rest: null,
  send: (frame: unknown) => { const action = (frame as { action?: string })?.action; if (action && !['join', 'leave', 'history', 'receipts', 'subscribe', 'unsubscribe'].includes(action)) throw new Error('Fixture forbids gateway writes.'); },
  onMessage: () => () => {},
} as unknown as GatewayContextValue;
function Content({ clearHost }: { clearHost(): void }) {
  const host = useCallHost(), { session, refresh } = useSession();
  const [params] = useSearchParams(), location = useLocation();
  const sourceId = params.get('doc') ?? 'page:100002';
  const title = 'Document architecture review';
  const lobby = documentCallLobby('assessment:', conversationChannelForDoc(sourceId));
  useEffect(() => { host?.bind({ lobbyName: lobby, title, channel: documentCallChannel(`${location.pathname}?doc=${encodeURIComponent(sourceId)}`) }); }, [host?.bind, lobby, sourceId, location.pathname]);
  return <Stack gap="sm" className="h-screen min-h-0 p-4">
    <div><button onClick={() => fixtureLifecycle.setPhase('live')}>Show joined fixture call</button> <button onClick={() => { fixtureLifecycle.setPhase('idle'); clearHost(); }}>End and clear native host</button> <button onClick={() => void refresh()}>Refresh fixture identity</button></div>
    <output data-testid="fixture-route">{location.pathname + location.search}</output><output data-testid="fixture-actor">{session?.sub}</output>
    <CanvasDocumentPane key={`${session?.sub}:${sourceId}`} node={{ id: sourceId, title, classification: 'general', is_dir: false }} mode="workspace" sourceConfigured={false}
      sseEvents={[]} sseConnected={false} sseGapped={false} onBack={() => {}} onTreeChanged={() => {}} path={[]} sectionKey="workspace_drafts" />
    <PostCallRecordingMonitor />
  </Stack>;
}
function Fixture() {
  const { session } = useSession(); const [cleared, setCleared] = useState(false);
  return <GatewayContext.Provider value={gateway}><CallHostProvider scopeKey={`${session?.sub}:${session?.tenant}`} self={session && !cleared ? { userId: session.sub, displayName: session.name } : null} tenant={session?.tenant ?? null}
    platformApiUrl={null} videoUrl={null} getIdToken={() => ''} gateway={null} gatewayConfigured={false} connectionState="disconnected">
    <Content clearHost={() => setCleared(true)} />
  </CallHostProvider></GatewayContext.Provider>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><BrowserRouter><SessionProvider><Fixture /></SessionProvider></BrowserRouter></StrictMode>);
