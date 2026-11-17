// The room pane's `pad` tab (contract U1; decision 21: in a technical round the pane is the code pad with the run
// output under it). Lane WIRE: the shared pad (U2, `InterviewPad`) with Run, Cancel and the output, and the pad log
// reports (pages/interviews/pad/RunnablePad.tsx, the same component the candidate's room mounts). The lead gets
// "Insert a question" with the round's chosen questions; the read-only questions are the Questions tab's.
// Nobody but ROOM and WIRE edits this file.
import { useMemo, type JSX } from 'react';
import { EmptyState } from '@connorhoehn/ui-components/shared';
import { useOptionalSession } from '../../../lib/auth';
import { staffPadBase } from '../../../lib/interviewsPad';
import type { RoomView } from '../../../lib/interviewsRoom';
import { RunnablePad } from '../pad/RunnablePad';

export function PadTab({ room }: { room: RoomView }): JSX.Element {
  const session = useOptionalSession();
  const questions = useMemo(() => room.questions.map((q) => ({ id: q.id, prompt: q.prompt, starter: q.starter })), [room.questions]);
  if (!session) return <EmptyState title="The code pad" body="The code pad opens once you are signed in." testId="interview-room-pad-idle" />;
  return <RunnablePad interviewId={room.id} base={staffPadBase(room.id)} self={{ userId: session.sub, displayName: session.name }}
    seat={room.seat} {...(room.seat === 'lead' ? { questions } : {})} />;
}
