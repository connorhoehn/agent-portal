// The conversation call, bound once to this portal's realtime-modules video
// hooks: the library's call block host (ui-components 2.439
// `createCallBlockHost`) — the shell's ONE `useConversationCall`, rings, the
// pre-join device check, the one media sink and `useCallBlock(channel)` for a
// composer's `callBlock` slot (the dock and the ring toast are drawn by the host).
import * as video from '@connorhoehn/realtime-modules/client/video';
import { useMeeting } from '@connorhoehn/realtime-modules/client/meeting';
import { createElement } from 'react';
import { createCallBlockHost } from '@connorhoehnslalom/ui-components/integrations/realtime';
import { StreamVideo } from '@connorhoehnslalom/ui-components/video';
import { separateCallScreenTiles } from './callScreenTiles';
import { documentRecordingNavigation } from '../components/recordings/documentRecordingContext';

// Keep the native capture/publish lifecycle. The installed dock mapping's
// screenTile option replaces a camera; this app presents both native streams.
const conversationCallDockProps: typeof video.conversationCallDockProps = (state, ui) => separateCallScreenTiles(
  state, video.conversationCallDockProps(state, { ...ui, screenTile: undefined }),
  participant => createElement('div', { 'data-call-stream': 'screen', className: 'h-full w-full' },
    createElement(StreamVideo, { stream: participant.screenStream!, muted: true, className: 'h-full w-full object-contain' })),
);
// The native platform binds each media participant to a currently accepted
// gateway seat before associating a completed recording with a call.
const useConversationCall: typeof video.useConversationCall = opts => video.useConversationCall({ ...opts, bindRecordingCall: true,
  // The original call channel survives an incoming Accept and page navigation.
  // This is only a hint: native authority checks the stored channel and source.
  documentSourceId: documentRecordingNavigation(opts.lobbyName, opts.channel)?.documentSourceId,
});
// `useMeeting` (realtime-modules 0.134) lets the host run a meeting beside the
// call when ShellCallHost turns it on for the lobby (lib/meetingRooms.ts).
export const calls = createCallBlockHost({ ...video, useConversationCall, conversationCallDockProps, useMeeting });
export const {
  CallHostProvider, CallMediaOutlet, CallBlock,
  useCallHost, useCallBlock, useCallLobby, useCallMediaPanel, useCallBlockPlacement, useCallBlockPageClaimed, useClaimCallBlock,
} = calls;
export { callCounts, callDrawn } from '@connorhoehnslalom/ui-components/integrations/realtime';
export type { CallHostMeeting, CallLobby, OnCallHostEvent } from '@connorhoehnslalom/ui-components/integrations/realtime';
