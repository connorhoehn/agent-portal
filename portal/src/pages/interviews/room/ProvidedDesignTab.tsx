// The room pane's "Provided design" tab (the master template's part C), for the lead and the panel of a board round
// whose questions carry an answer key: the reference design on a read-only canvas of its own, the design questions
// with their answers, and the red flags by group. The candidate never receives any of it (the room sends `answerKey`
// to seats only). The lead of the live round may "Reveal to the candidate": after the library's confirm dialog the
// server hands over the design (POST /board/reveal), the Board tab opens with it put beside what is drawn, and the
// board's ack is logged for the record once (lib/interviewsAnswerKey.ts). Whether it was shown comes from the server.
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Button, Chip, ConfirmDialog, DetailSection, Inline, InlineAlert, Stack, T } from '@connorhoehn/ui-components/shared';
import { answerKeyQuestions, loadReveals, onReveals, queueBoardReveal, redFlagGroups, revealProvidedDesign, wasRevealed, type AnswerKey } from '../../../lib/interviewsAnswerKey';
import type { RoomQuestion, RoomView } from '../../../lib/interviewsRoom';
import { BoardScene } from '../board/BoardScene';
import { questionTitle } from '../board/InterviewBoard';

/** `inset`: the page's side inset while the shell's gutter is folded (the room draws it). */
export function ProvidedDesignTab({ room, onRevealed, inset = '' }: { room: RoomView; onRevealed: () => void; inset?: string }) {
  const questions = answerKeyQuestions(room.questions);
  useEffect(() => { void loadReveals(room.id); }, [room.id]);
  return <Stack gap="lg" className={`min-h-0 flex-1 overflow-y-auto py-4 ${inset}`} data-testid="interview-room-tab-design">
    {questions.map((q, i) => <AnswerKeyPart key={q.id} room={room} question={q} answerKey={q.answerKey} first={i === 0} onRevealed={onRevealed} />)}
  </Stack>;
}

function AnswerKeyPart({ room, question, answerKey, first, onRevealed }: { room: RoomView; question: RoomQuestion; answerKey: AnswerKey; first: boolean; onRevealed: () => void }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const shown = useSyncExternalStore(onReveals, () => wasRevealed(room.id, question.id));
  const canReveal = room.seat === 'lead' && room.state === 'live' && !!answerKey.providedDesign;
  const reveal = async () => {
    setAsking(false);
    setBusy(true);
    const answer = await revealProvidedDesign(room.id, question.id);
    setBusy(false);
    if (!answer.ok) { setFailed(answer.error ?? 'The provided design could not be shown. The round may have ended.'); return; }
    setFailed(null);
    queueBoardReveal(room.id, question.id, answer.board);
    onRevealed();
  };
  const title = questionTitle(question) || 'This question';
  const action = canReveal
    ? <Button size="sm" variant="secondary" disabled={busy || shown} onClick={() => setAsking(true)} className="whitespace-nowrap" data-testid="interview-design-reveal">
        {shown ? 'Shown to the candidate' : busy ? 'Revealing…' : 'Reveal to the candidate'}
      </Button>
    : null;
  const flags = redFlagGroups(answerKey.redFlags);
  return <Stack gap="md" data-testid="interview-design-question" data-question={question.id}>
    <DetailSection variant="heading" as="h2" first={first} title={title} actions={action}
      hint={shown ? 'On the shared board, right of the candidate’s design.' : 'Only the interviewers see this. The candidate sees it only if the lead reveals it.'}>
      {failed && <InlineAlert tone="error" data-testid="interview-design-reveal-failed">{failed}</InlineAlert>}
      {answerKey.providedDesign && <BoardScene sceneId={`answer-${question.id}`} elements={answerKey.providedDesign.elements}
        className="h-[30rem] min-h-0 shrink-0 overflow-hidden" data-testid="interview-design-canvas" />}
    </DetailSection>
    {!!answerKey.designQuestions?.length && <DetailSection variant="heading" as="h3" title="Questions and answers" data-testid="interview-design-answers">
      <Stack gap="sm">
        {answerKey.designQuestions.map((d, n) => <Stack key={n} gap="xs" data-testid="interview-design-answer">
          <Inline gap="sm" align="baseline" wrap={false}>
            <T size="sm" weight="medium" wrap>{`${n + 1}. ${d.text}`}</T>
            {d.enhancement && <Chip size="sm" tone="info">Enhancement</Chip>}
          </Inline>
          {d.answer ? <T size="sm" tone="secondary" wrap>{d.answer}</T> : <T size="sm" tone="tertiary">No answer written.</T>}
        </Stack>)}
      </Stack>
    </DetailSection>}
    {flags.length > 0 && <DetailSection variant="heading" as="h3" title="Red flags" hint="What a weak design shows. The lead ticks the ones seen on the scorecard." data-testid="interview-design-flags">
      <Stack gap="sm">
        {flags.map((g) => <Stack key={g.group} gap="xs" data-testid="interview-design-flag-group">
          <T size="sm" weight="medium">{g.label}</T>
          {g.items.map((text) => <T key={text} size="sm" tone="secondary" wrap>{`• ${text}`}</T>)}
        </Stack>)}
      </Stack>
    </DetailSection>}
    <ConfirmDialog open={asking} onCancel={() => setAsking(false)} onConfirm={() => { void reveal(); }} tone="caution"
      title="Reveal the provided design?" confirmLabel="Reveal to the candidate"
      body={`The reference design for ${title} goes on the shared board, beside the candidate’s, and the record notes when. It cannot be hidden again.`} />
  </Stack>;
}
