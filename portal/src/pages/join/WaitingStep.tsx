// The waiting page (docs/interviews-tenant-plan.md row I2.3; contract C2). Knocks on arrival, then asks for the
// admission every few seconds, for at most half an hour, and stops when the page leaves this step. It says the
// interviewer has been told only once the server says so (a bell went out or a seat is in the call; gap audit
// 2026-11-20 §4), and that they will be told while the server holds the knock but nobody knows yet; until then each tick of the same poll
// knocks again (the knock is idempotent), so a knock lost on the way is made good without a retry of its own
// (steps.ts waitingAfterKnock, waitingAfterRead). A link taken back goes to the dead-link page. Turned away: one
// plain line and a way to knock again. While waiting the candidate may go back and change an answer. It says who the
// candidate is meeting and when (UI round 2): the lead's name and how many others, the set time and the length;
// nothing else of the panel's.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Card, Inline, InlineAlert, KeyValue, Stack, T } from '@connorhoehn/ui-components/shared';
import { knock, readWaiting } from './guestApi.ts';
import { ADMISSION_MAX_POLLS, ADMISSION_POLL_MS, waitingAfterKnock, waitingAfterRead, waitingLine } from './steps.ts';

export function WaitingStep({ meeting, when, minutes, onAdmitted, onChangeAnswers, onAnswersNeeded, onHeld, onLinkDead }: {
  /** "You are meeting Hugo Marchetti and one other interviewer."; null says nothing. */
  meeting: string | null;
  /** The set time, in words. */
  when: string;
  minutes: number;
  onAdmitted: () => void;
  onChangeAnswers: () => void;
  /** The server would not take the knock: the answers no longer stand (the notice changed). */
  onAnswersNeeded: () => void;
  /** The server would not take the knock: the answers say no to a part this interview needs (row I6.4). */
  onHeld: () => void;
  /** The knock answered not-found: the link was taken back. */
  onLinkDead: () => void;
}) {
  const [view, setView] = useState<'waiting' | 'turned-away'>('waiting');
  /** The server's last answer holds the knock. */
  const [knocked, setKnocked] = useState(false);
  /** The server says the seats know (a bell went out, or a seat is in the call). */
  const [told, setTold] = useState(false);
  const [stalled, setStalled] = useState(false);
  const [round, setRound] = useState(0);
  // The callbacks are read through a ref, so a parent's re-render never re-runs the knock.
  const on = useRef({ onAdmitted, onAnswersNeeded, onHeld, onLinkDead });
  on.current = { onAdmitted, onAnswersNeeded, onHeld, onLinkDead };

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ticks = 0;
    let holds = false;
    // One tick: knock while the server does not hold the knock, else read the admission.
    const tick = async () => {
      if (stopped) return;
      ticks += 1;
      let heard: boolean | null = null;
      let next;
      if (holds) {
        const read = await readWaiting().catch(() => null);
        if (read) heard = read.told;
        next = waitingAfterRead(read?.admission ?? null);
      } else {
        const outcome = await knock();
        if (outcome.kind === 'knocked') heard = outcome.told ?? false;
        next = waitingAfterKnock(outcome);
      }
      if (stopped) return;
      if (heard !== null) setTold(heard);
      switch (next.kind) {
        case 'admitted': on.current.onAdmitted(); return;
        case 'held': on.current.onHeld(); return;
        case 'answers-needed': on.current.onAnswersNeeded(); return;
        case 'dead': on.current.onLinkDead(); return;
        case 'turned-away': setView('turned-away'); return;
        case 'wait': break;
      }
      holds = next.knocked;
      setKnocked(holds);
      if (ticks >= ADMISSION_MAX_POLLS) { setStalled(true); return; }
      timer = setTimeout(() => { void tick(); }, ADMISSION_POLL_MS);
    };
    setStalled(false);
    setView('waiting');
    setKnocked(false);
    setTold(false);
    void tick();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [round]);

  const again = useCallback(() => setRound((r) => r + 1), []);
  const line = waitingLine(knocked, told);

  return (
    <Stack gap="md" data-testid="join-waiting">
      <Card padding="lg">
        {view === 'turned-away' ? (
          <T size="sm" as="p" data-testid="join-turned-away">Your interviewer could not let you in just now.</T>
        ) : (
          <Stack gap="md">
            <Stack gap="sm">
              {line === 'told' && <T size="base" weight="semibold" as="p" data-testid="join-waiting-told">The interviewer has been told you are here.</T>}
              {line === 'will-tell' && <T size="base" weight="semibold" as="p" data-testid="join-waiting-will-tell">You are in the waiting room. The interviewer will be told you are here.</T>}
              {line === 'telling' && <T size="base" weight="semibold" as="p" data-testid="join-waiting-telling">Letting the interviewer know you are here.</T>}
              {meeting && <T size="sm" as="p" data-testid="join-waiting-meeting">{meeting}</T>}
              <T size="sm" tone="secondary" as="p">Keep this page open. It moves on by itself when you are let in.</T>
            </Stack>
            <KeyValue aria-label="Your interview" data-testid="join-waiting-when" items={[
              { label: 'When', value: when },
              { label: 'Length', value: `${minutes} minutes` },
            ]} />
          </Stack>
        )}
      </Card>
      {stalled && view === 'waiting' && (
        <InlineAlert tone="info" data-testid="join-waiting-stalled">This page has stopped checking. Check again when you are ready.</InlineAlert>
      )}
      <Inline gap="sm" align="center">
        {view === 'turned-away' && <Button variant="primary" onClick={again} data-testid="join-knock-again">Ask to join again</Button>}
        {stalled && view === 'waiting' && <Button variant="primary" onClick={again} data-testid="join-check-again">Check again</Button>}
        <Button variant="ghost" onClick={onChangeAnswers} data-testid="join-change-answers">Change my answers</Button>
      </Inline>
    </Stack>
  );
}
