import '../../src/app.css';
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, useLocation, useSearchParams } from 'react-router';
import { Stack } from '@connorhoehnslalom/ui-components/shared';
import { SessionProvider, useSession } from '../../src/lib/auth';
import { InitiativeFiles } from '../../src/pages/projects/InitiativeFiles';
import { PageRecordings } from '../../src/components/recordings/PageRecordings';
import { PostCallRecordingMonitor } from '../../src/components/recordings/PostCallRecording';
import { CallHostProvider, fixtureLifecycle, useCallHost } from './recording-runtime';
function Content({ clearHost }: { clearHost(): void }) {
  const host = useCallHost(), { session, refresh } = useSession();
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const lobby = session?.tenant === 'assessment' ? 'assessment:team:TEAM-005' : 'orgiq:initiative:p-observability';
  useEffect(() => { host?.bind({ lobbyName: lobby, title: 'Notifications review', channel: 'initiative:p-observability' }); }, [host?.bind, lobby]);
  return <Stack gap="md" className="p-4 max-w-[980px] mx-auto" data-tenant={session?.tenant ?? 'orgiq'}>
    <div><button onClick={() => fixtureLifecycle.setPhase('live')}>Show joined fixture call</button> <button onClick={() => { fixtureLifecycle.setPhase('idle'); clearHost(); }}>End and clear native host</button> <button onClick={() => void refresh()}>Refresh fixture identity</button></div>
    <output data-testid="fixture-phase">{host?.call.phase}</output><output data-testid="fixture-route">{location.pathname + location.search}</output><output data-testid="fixture-actor">{session?.sub}</output>
    {params.has('files') && !params.get('recording') ? <InitiativeFiles projectId="p-observability" projectName="Observability Platform" itemIds={[]} workspaceHref="/iq/workspace" onOpenRecording={id => { const next = new URLSearchParams(params); if (id) next.set('recording', id); else next.delete('recording'); setParams(next); }} /> : <PageRecordings lobby={lobby} subjectName="Observability Platform" onOpen={id => { const next = new URLSearchParams(params); if (id) next.set('recording', id); else next.delete('recording'); setParams(next); }} />}
    <PostCallRecordingMonitor />
  </Stack>;
}
function Fixture() {
  const { session } = useSession(); const [cleared, setCleared] = useState(false);
  return <CallHostProvider scopeKey={`${session?.sub}:${session?.tenant}`} self={session && !cleared ? { userId: session.sub, displayName: session.name } : null} tenant={session?.tenant ?? null}
    platformApiUrl={null} videoUrl={null} getIdToken={() => ''} gateway={null} gatewayConfigured={false} connectionState="disconnected">
    <Content clearHost={() => setCleared(true)} />
  </CallHostProvider>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><BrowserRouter><SessionProvider><Fixture /></SessionProvider></BrowserRouter></StrictMode>);
