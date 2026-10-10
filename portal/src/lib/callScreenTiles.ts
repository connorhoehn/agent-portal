import type { ReactNode } from 'react';
import type { ConversationCallDockProps, ConversationCallDockState } from '@connorhoehnslalom/realtime-modules/client/video';

type Participant = NonNullable<ConversationCallDockState['call']>['participants'][number];

/** Native screen publication is separate from the camera. Keep both in the
 * library's tile list without treating a shared surface as another person. */
export function separateCallScreenTiles(
  state: ConversationCallDockState,
  dock: ConversationCallDockProps | null,
  screenTile: (participant: Participant) => ReactNode,
): ConversationCallDockProps | null {
  if (!dock) return null;
  const sources = new Map((state.call?.participants ?? []).map(participant => [participant.id, participant]));
  return {
    ...dock,
    participants: dock.participants.flatMap(camera => {
      const person = sources.get(camera.id);
      // Sharing must not force an off camera to appear enabled.
      const cameraTile = { ...camera, screenSharing: false };
      if (!person?.screenSharing || !person.screenStream?.getVideoTracks().some(track => track.readyState === 'live')) return [cameraTile];
      return [cameraTile, {
        id: `${camera.id}:screen`, userId: `${camera.userId}:screen`,
        displayName: person.isLocal ? 'Your screen' : `${person.displayName} · screen`,
        isLocal: false, isMuted: true,
        videoElement: screenTile(person),
        cameraOn: true, audioOn: false, screenSharing: true, presenting: true,
        connection: camera.connection,
      }];
    }),
  };
}
