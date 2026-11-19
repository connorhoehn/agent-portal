// The room pane's `pad` tab in a system design round (WHITEBOARD-PLAN step 1): the shared whiteboard where the code
// pad would be. The lead gets "Start from a board" with the round's chosen questions that carry one, and the lead's
// room checkpoints the board while the round is live; `onCheckpoints` hands the room those checkpoints, so ending the
// round posts the closing board first.
import { useMemo, type JSX } from 'react';
import { EmptyState } from '@connorhoehn/ui-components/shared';
import { useOptionalSession } from '../../../lib/auth';
import type { BoardCheckpoints } from '../../../lib/interviewsBoard';
import type { RoomView } from '../../../lib/interviewsRoom';
import { InterviewBoard } from '../board/InterviewBoard';

export function BoardTab({ room, onCheckpoints }: { room: RoomView; onCheckpoints?: (c: BoardCheckpoints | null) => void }): JSX.Element {
  const session = useOptionalSession();
  const questions = useMemo(() => room.questions.map((q) => ({ id: q.id, prompt: q.prompt, board: q.board })), [room.questions]);
  if (!session) return <EmptyState title="The whiteboard" body="The whiteboard opens once you are signed in." testId="interview-room-board-idle" />;
  return <InterviewBoard interviewId={room.id} self={{ userId: session.sub, displayName: session.name }} seat={room.seat}
    {...(room.seat === 'lead' ? { questions, checkpoint: room.state === 'live', onCheckpoints } : {})} />;
}
