// The candidate's pane in a technical round (decisions 3 and 21; rows I4.2–I4.4): the code pad with Run, Cancel and
// the output exactly as the panel sees them (pages/interviews/pad/RunnablePad.tsx, on the guest's routes), and the
// call's chat as the second tab, in the library's pane tab row (`PaneHeader`, the row the panel's `SidePane` draws).
// Both tabs stay mounted, so switching never drops the pad's document, the run stream or a draft message. No
// "Insert a question" for the candidate. The width is the panel's technical pane's lower bound (U1: 560px).
import { PaneHeader, Stack } from '@connorhoehn/ui-components/shared';
import { GUEST_PAD_BASE } from '../../lib/interviewsPad';
import { RunnablePad } from '../interviews/pad/RunnablePad';
import { GuestRoomChatBody } from './GuestRoomChat';
import type { GuestRoom } from './steps.ts';

export type GuestPaneTab = 'pad' | 'chat';
const TABS = [{ id: 'pad', label: 'Pad' }, { id: 'chat', label: 'Chat' }] as const;

export function GuestPadPane({ room, callId, tab, onTab }: { room: GuestRoom; callId: string; tab: GuestPaneTab; onTab(tab: GuestPaneTab): void }) {
  return <Stack as="aside" gap="none" aria-label="Code pad and chat" className="min-h-0 w-[560px] shrink-0 border-l border-border bg-surface" data-testid="join-room-pane">
    <PaneHeader tabs={TABS} value={tab} onValueChange={(id) => onTab(id === 'chat' ? 'chat' : 'pad')} label="Code pad and chat" data-testid="join-room-pane-tabs" />
    <Stack gap="none" className={tab === 'pad' ? 'min-h-0 flex-1' : 'hidden'} data-testid="join-room-pad">
      <RunnablePad interviewId={room.interviewId} base={GUEST_PAD_BASE} self={room.self} seat="candidate" />
    </Stack>
    <Stack gap="none" className={tab === 'chat' ? 'min-h-0 flex-1' : 'hidden'} data-testid="join-room-chat">
      <GuestRoomChatBody callId={callId} self={room.self} />
    </Stack>
  </Stack>;
}
