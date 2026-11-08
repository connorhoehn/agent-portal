import '../../src/app.css';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CallDock, RosterPanel, type CallDockParticipant } from '@connorhoehn/ui-components/video';
import { ContextComposer } from '@connorhoehn/ui-components';
import { Button } from '@connorhoehn/ui-components/shared';
import { HangoutCallView, type HangoutCallPane } from '../../src/pages/social/HangoutCallView';
const noop = () => {};
function Fixture() {
  const [count, setCount] = useState(1);
  const [pane, setPane] = useState<HangoutCallPane>('people');
  const [mic, setMic] = useState(false);
  const [camera, setCamera] = useState(true);
  const people: CallDockParticipant[] = Array.from({ length: count }, (_, i) => ({ id: `p${i}`, userId: `p${i}`, displayName: i ? `Participant ${i}` : 'You',
    avatarUrl: '/avatars/photos/p-005.jpg', cameraOn: camera, audioOn: mic, screenSharing: false, presenting: false, connection: 'connected',
    videoElement: <video data-testid={`media-${i}`} poster="/avatars/photos/p-005.jpg" muted /> }));
  return <main className="flex h-dvh min-h-0 flex-col gap-4 bg-surface p-4 text-text-primary">
    <nav className="flex shrink-0 gap-2" aria-label="Fixture people">{[1,2,6,12].map(n => <Button key={n} size="sm" onClick={() => setCount(n)}>{n} people</Button>)}</nav>
    <HangoutCallView title="Design studio" count={count} pane={pane} onPaneChange={setPane}
      stage={<CallDock layout="stage" title="Design studio" phase="active" participantCount={count} elapsedMs={181_000} participants={people} localParticipantId="p0"
        mic={{ on: mic, onToggle: () => setMic(v => !v), devices: [], onSelectDevice: noop, permission: 'granted' }}
        camera={{ on: camera, onToggle: () => setCamera(v => !v), devices: [], onSelectDevice: noop, permission: 'granted' }}
        screenShare={{ on: false, onToggle: noop }} onOpenPeople={() => setPane('people')} onOpenSettings={noop} onPopOut={noop} onLeave={noop} />}
      people={<RosterPanel title="Participants" className="w-full border-l-0" participants={people.map(p => ({ id: p.id, displayName: p.displayName, avatarUrl: p.avatarUrl, isLocal: p.id === 'p0' }))} />}
      conversation={<div className="flex min-h-0 flex-1 flex-col"><div className="flex-1 p-4">Call conversation</div><ContextComposer context={{ kind: 'conversation', id: 'gallery-test', title: 'Design studio' }} defaultMode="chat" onSend={() => false} collapsible expanded /></div>} />
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
