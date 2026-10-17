// Native call layout with explicit inert call data. No SDK call, media,
// message, gateway, device acquisition or platform endpoint is used.
import { createCallBlockHost, type CallBlockCall, type CallBlockModules } from '@connorhoehnslalom/ui-components/integrations/realtime';
import { conversationCallDockProps } from '@connorhoehn/realtime-modules/client/video';
export const runtime = { active: true, prohibitedActions: 0,
  session: { sub: 'fixture-reviewer', name: 'Alex Reviewer', tenant: 'orgiq', role: 'Member', masquerading: null },
  frames: { configured: false, connectionState: 'disconnected', gateway: { onMessage: () => () => {}, sessionEpoch: 0 } },
};
const prohibited = () => { runtime.prohibitedActions++; throw new Error('Inert fixture forbids real actions.'); };
function fakeCall(lobbyName: string): CallBlockCall {
  const bound = lobbyName !== '__unbound__';
  const live = bound && runtime.active;
  const people = [
    { id: 'fixture-self', userId: 'fixture-reviewer', displayName: 'Alex Reviewer', isLocal: true },
    { id: 'fixture-peer', userId: 'fixture-teammate', displayName: 'Sam Teammate', isLocal: false },
  ].map(person => ({ ...person, state: 'in-call' as const, audioOn: true, cameraOn: false, screenSharing: false, participantId: person.id, stream: null, screenStream: null }));
  return {
    phase: live ? 'live' : bound ? 'ended' : 'idle',
    call: bound ? { callId: 'fixture-review-call', host: 'fixture-reviewer', startedAt: 1, participantCount: people.length, participants: people } : null,
    error: null, callingTo: null, elapsedMs: 60000, activeSpeakerId: null,
    self: { audioOn: true, cameraOn: false, screenSharing: false },
    devices: { prefs: {}, set: prohibited, list: { microphones: [], cameras: [], speakers: [], permission: { microphone: 'unavailable', camera: 'unavailable' } } },
    start: async () => prohibited(), accept: async () => prohibited(), rejoin: async () => prohibited(), leave: async () => prohibited(),
    toggleMic: prohibited, toggleCamera: prohibited, toggleScreenShare: prohibited,
  };
}
const settings = { settings: {}, update: prohibited, previewStream: null, previewError: null, micLevel: 0,
  testMic: async () => prohibited(), testSound: async () => prohibited(), testMicState: 'idle' };
export const calls = createCallBlockHost({
  LVSProvider: ({ children }: { children?: import('react').ReactNode }) => <>{children}</>,
  useConversationCall: ({ lobbyName }: { lobbyName: string }) => fakeCall(lobbyName),
  useIncomingConversationCalls: () => ({ rings: [], accept: prohibited, decline: prohibited }),
  useMediaDevices: () => ({ microphones: [], cameras: [], speakers: [], permission: { microphone: 'unavailable', camera: 'unavailable' }, speakerSelectionSupported: false }),
  useAudioVideoSettings: (() => settings) as unknown as CallBlockModules['useAudioVideoSettings'],
  conversationCallDockProps,
} as CallBlockModules);
export const { useCallBlock, useCallHost, useCallBlockPageClaimed, useCallMediaPanel, useClaimCallBlock, CallBlock } = calls;
export const callDrawn = () => runtime.active;

(window as any).__deckReviewRuntimeExports = { calls, runtime };
