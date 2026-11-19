// The candidate's one pane (decisions 3, 4 and 21; contract U1's widths; UI round 2, lane GUEST): the library's
// `SidePane`, on the far right of the room the way the panel's pane is (the panel's room page,
// `RoomPane`), with the library's tabs. A technical round: Pad, then Chat; the pad with Run, Cancel and the output
// exactly as the panel sees them (pages/interviews/pad/RunnablePad.tsx on the guest's routes, mounted by lane WIRE,
// moved here unchanged). A behavioural round: Chat alone, so no tab row. Both bodies stay mounted, so switching never
// drops the pad's document, the run stream or a draft message. Nothing of the panel's side: no questions, no Milo,
// no transcript, no notes. The pad never depends on the call: with no call (not joined yet, or it failed) the pad stays and
// the chat says it opens with the call. The page owns the open state: × closes it, the bar's chat toggle opens it on Chat.
import { useEffect, useState } from 'react';
import { SidePane, useSidePaneHost } from '@connorhoehn/ui-components';
import { EmptyState, Stack } from '@connorhoehn/ui-components/shared';
import { GUEST_PAD_BASE } from '../../lib/interviewsPad';
import { roomPaneWidth } from '../../lib/interviewsRoom';
import { RunnablePad } from '../interviews/pad/RunnablePad';
import { InterviewBoard } from '../interviews/board/InterviewBoard';
import { surfaceOf } from '../../lib/interviewsBoard';
import { GuestRoomChatBody } from './GuestRoomChat';
import { withUnreadBadges } from '../../components/calls/UnreadTabBadge';
import type { GuestRoom } from './steps.ts';

export type GuestPaneTab = 'pad' | 'chat';
const TECHNICAL_TABS = [{ id: 'pad', label: 'Pad' }, { id: 'chat', label: 'Chat' }] as const;
const BOARD_TABS = [{ id: 'pad', label: 'Board' }, { id: 'chat', label: 'Chat' }] as const;

export function GuestRoomPane({ room, callId, tab, onTab, onClose }: {
  /** The call joined now, or null (not joined, or the call failed): the pad stays, the chat waits for the call. */
  room: GuestRoom; callId: string | null; tab: GuestPaneTab; onTab(tab: GuestPaneTab): void; onClose(): void;
}) {
  const { reveal } = useSidePaneHost();
  // Shown whenever the page asks for it, even where the window is narrow.
  useEffect(() => { reveal(); }, [reveal]);
  const type = room.round.type;
  const technical = type === 'technical';
  // A system design round draws on the shared whiteboard where the pad would be (WHITEBOARD-PLAN step 1).
  const board = surfaceOf(room.round) === 'board';
  const shown: GuestPaneTab = technical ? tab : 'chat';
  // The Chat tab's unread bubble (a behavioural round's pane is the chat alone: no tab, no bubble).
  const [unread, setUnread] = useState(0);
  return <SidePane title={room.round.name} subtitle={`${room.round.minutes} min · ${technical ? 'Technical' : 'Behavioural'} round`}
    paneId="interview-room" widthPx={roomPaneWidth(type)} onClose={onClose} closeLabel={technical ? (board ? 'Hide the board and chat' : 'Hide the pad and chat') : 'Hide the chat'}
    {...(technical ? { tabs: withUnreadBadges<{ id: string; label: string }>(board ? BOARD_TABS : TECHNICAL_TABS, { chat: unread }), value: shown, onValueChange: (id: string) => onTab(id === 'chat' ? 'chat' : 'pad') } : {})}
    data-testid="join-room-pane">
    {technical && <Stack gap="none" className={shown === 'pad' ? 'min-h-0 flex-1' : 'hidden'} data-testid="join-room-pad">
      {board
        ? <InterviewBoard interviewId={room.interviewId} self={room.self} seat="candidate" />
        : <RunnablePad interviewId={room.interviewId} base={GUEST_PAD_BASE} self={room.self} seat="candidate" />}
    </Stack>}
    <Stack gap="none" className={shown === 'chat' ? 'min-h-0 flex-1' : 'hidden'} data-testid="join-room-chat">
      {callId
        ? <GuestRoomChatBody callId={callId} self={room.self} seen={shown === 'chat'} onUnread={setUnread} />
        : <EmptyState title="The chat opens with the call" body="Join the call from the bar at the bottom of the window to send messages." testId="join-room-chat-waiting" />}
    </Stack>
  </SidePane>;
}
