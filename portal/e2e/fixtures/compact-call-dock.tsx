import '../../src/app.css';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CallDock, type CallDockPhase } from '@connorhoehn/ui-components/video';

const noop = () => {};
function Fixture() {
  const [count, setCount] = useState(1);
  const [phase, setPhase] = useState<CallDockPhase>('active');
  const [mic, setMic] = useState(false);
  const [camera, setCamera] = useState(true);
  return <main className="p-4">
    <nav className="mb-4 flex flex-wrap gap-3" aria-label="Fixture controls">
      <button onClick={() => setCount(count === 1 ? 6 : 1)}>Toggle participants</button>
      {(['active', 'connecting', 'reconnecting'] as const).map(value => <button key={value} onClick={() => setPhase(value)}>{value}</button>)}
    </nav>
    <CallDock layout="compact" title="Internal Tools huddle: infrastructure review" phase={phase} participantCount={count} elapsedMs={181_000}
      participants={Array.from({ length: count }, (_, index) => ({ id: `p${index}`, userId: `p${index}`, displayName: index ? `Person ${index}` : 'Demo User',
        cameraOn: true, audioOn: false, screenSharing: false, presenting: false, connection: 'connected' as const }))}
      localParticipantId="p0" mic={{ on: mic, onToggle: () => setMic(value => !value), devices: [], onSelectDevice: noop, permission: 'granted' }}
      camera={{ on: camera, onToggle: () => setCamera(value => !value), devices: [], onSelectDevice: noop, permission: 'granted' }}
      screenShare={{ on: false, onToggle: noop }} onOpenPeople={noop} onOpenSettings={noop} onPopOut={noop} onLeave={noop} />
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
