// Rendering-only regression: actual MediaStreams from owned canvases, with no
// camera, microphone, desktop capture, call signalling or SFU substitution.
import '../../src/app.css';
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { conversationCallDockProps, type ConversationCallDockState } from '@connorhoehn/realtime-modules/client/video';
import { CallDock, StreamVideo, MeetingToolbar, ChatBubbleIcon, UsersIcon, MeetingHandIcon, MeetingReactIcon } from '@connorhoehn/ui-components/video';
import { ConversationComposer } from '../../src/lib/conversationComposer';
import { separateCallScreenTiles } from '../../src/lib/callScreenTiles';

function source(label: string, color: string) {
  const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
  const context = canvas.getContext('2d')!;
  context.fillStyle = color; context.fillRect(0, 0, 640, 360);
  context.fillStyle = 'white'; context.font = '36px sans-serif'; context.fillText(label, 32, 180);
  return canvas.captureStream(5);
}
const noop = () => {};
function Fixture() {
  const meeting = new URLSearchParams(location.search).has('meeting');
  const [sources, setSources] = useState<MediaStream[] | null>(null);
  const [sharing, setSharing] = useState(false), [cameraOn, setCameraOn] = useState(true);
  useEffect(() => {
    const streams = [source('Vera camera', '#34475e'), source('Nora camera', '#445943'), source('Shared work', '#606190')];
    setSources(streams);
    return () => { streams.forEach(stream => stream.getTracks().forEach(track => track.stop())); };
  }, []);
  if (!sources) return null;
  const [camera, remote, screen] = sources;
  const state = {
    phase: 'live', call: { participantCount: 2, participants: [
      { id: 'vera', userId: 'vera', displayName: 'Vera Green', state: 'in-call', isLocal: true, audioOn: true, cameraOn, screenSharing: sharing, stream: camera, screenStream: sharing ? screen : null },
      { id: 'nora', userId: 'nora', displayName: 'Nora DaSilva', state: 'in-call', isLocal: false, audioOn: true, cameraOn: true, screenSharing: false, stream: remote, screenStream: null },
    ] }, self: { audioOn: true, cameraOn, screenSharing: sharing }, elapsedMs: 20_000,
    activeSpeakerId: null, callingTo: null, error: null,
    devices: { prefs: {}, set: noop, list: { microphones: [], cameras: [], permission: { microphone: 'granted', camera: 'granted' } } },
    toggleMic: noop, toggleCamera: () => setCameraOn(value => !value), toggleScreenShare: () => setSharing(value => !value), leave: noop, rejoin: noop,
  } as ConversationCallDockState;
  const dock = separateCallScreenTiles(state, conversationCallDockProps(state, {
    title: 'Cost Optimization', onOpenPeople: noop, onOpenSettings: noop,
    tile: person => person.stream ? <StreamVideo stream={person.stream} muted /> : undefined,
    compact: true,
  }), person => <div data-call-stream="screen" className="h-full w-full"><StreamVideo stream={person.screenStream!} muted /></div>)!;
  return <div className="p-6">
    <button onClick={() => setSharing(value => !value)}>{sharing ? 'Stop screen sharing' : 'Start screen sharing'}</button>
    <button onClick={() => setCameraOn(value => !value)}>Toggle camera</button>
    <div className={meeting ? 'initiative-composer-dock max-w-6xl' : 'initiative-composer-dock max-w-3xl'}>
      <ConversationComposer channel={null} context={{ kind: 'initiative', id: 'fixture', title: '' }} capabilities={{ maySend: false, agent: { allowed: true } }}
        onAgent={() => true} defaultMode="agent" expanded allowEmoji={false} className="conversation-call-composer" data-testid="fixture-composer"
        callBlock={<div data-testid="shell-call-media" data-placement="composer">
          {meeting && <MeetingToolbar start={<span>Recording · by attending you agree to be included</span>} items={[
            { id: 'chat', label: 'Chat', icon: <ChatBubbleIcon />, onClick: noop },
            { id: 'people', label: 'People', icon: <UsersIcon />, count: 1, badge: 1, onClick: noop },
            { id: 'raise', label: 'Lower hand', icon: <MeetingHandIcon />, pressed: true, count: 1, onClick: noop },
            { id: 'react', label: 'React', icon: <MeetingReactIcon />, onClick: noop },
          ]} />}
          <CallDock {...dock} layout={meeting ? 'shelf' : 'stack'} data-testid="fixture-call-dock" />
        </div>} />
    </div>
  </div>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
