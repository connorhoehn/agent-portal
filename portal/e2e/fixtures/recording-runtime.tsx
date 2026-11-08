// Native host with explicit inert lifecycle data. No signalling, device,
// call, recording, message or job mutation is implemented by this fixture.
import { useSyncExternalStore } from 'react';
import { createCallBlockHost, type CallBlockCall, type CallBlockModules } from '@connorhoehn/ui-components/integrations/realtime';
import { conversationCallDockProps } from '@connorhoehn/realtime-modules/client/video';
let phase: 'idle' | 'live' | 'failed' | 'reconnecting' = 'idle';
const listeners = new Set<() => void>();
const prohibited = () => { throw new Error('Inert recording fixture forbids actions.'); };
export const fixtureLifecycle = { setPhase(next: typeof phase) { phase = next; for (const listener of listeners) listener(); } };
const settings = { settings: {}, update: prohibited, previewStream: null, previewError: null, micLevel: 0, testMic: async () => prohibited(), testSound: async () => prohibited(), testMicState: 'idle' };
export const calls = createCallBlockHost({
  LVSProvider: ({ children }: { children?: import('react').ReactNode }) => <>{children}</>,
  useConversationCall: () => {
    const current = useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => phase);
    return { phase: current, recordingBinding: location.search.includes('binding=unavailable') ? { status: 'unavailable', callId: 'call-exact' } : undefined, call: current !== 'idle' ? { callId: 'call-exact', host: 'fixture-reader', startedAt: 1, participantCount: 1, participants: [] } : null,
      error: null, callingTo: null, elapsedMs: 0, activeSpeakerId: null, self: { audioOn: false, cameraOn: false, screenSharing: false },
      devices: { prefs: {}, set: prohibited, list: { microphones: [], cameras: [], speakers: [], permission: { microphone: 'unavailable', camera: 'unavailable' } } },
      start: async () => prohibited(), accept: async () => prohibited(), rejoin: async () => prohibited(), leave: async () => {}, toggleMic: prohibited, toggleCamera: prohibited, toggleScreenShare: prohibited,
    } as CallBlockCall;
  },
  useIncomingConversationCalls: () => ({ rings: [], accept: prohibited, decline: prohibited }),
  useMediaDevices: () => ({ microphones: [], cameras: [], speakers: [], permission: { microphone: 'unavailable', camera: 'unavailable' }, speakerSelectionSupported: false }),
  useAudioVideoSettings: (() => settings) as unknown as CallBlockModules['useAudioVideoSettings'], conversationCallDockProps,
} as CallBlockModules);
export const { CallHostProvider, CallMediaOutlet, CallBlock, useCallHost, useCallBlock, useCallLobby,
  useCallMediaPanel, useCallBlockPlacement, useCallBlockPageClaimed, useClaimCallBlock } = calls;
export { callCounts, callDrawn } from '@connorhoehn/ui-components/integrations/realtime';
