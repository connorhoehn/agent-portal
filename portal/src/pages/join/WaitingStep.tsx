// The waiting page (docs/interviews-tenant-plan.md row I2.3; contract C2). Knocks once on arrival, then asks
// for the admission every few seconds, for at most half an hour, and stops when the page leaves this step. A
// missing route or answer is still waiting, never an error. Turned away: one plain line and a way to knock
// again. While waiting the candidate may go back and change an answer.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Card, Inline, InlineAlert, Stack, T } from '@connorhoehn/ui-components/shared';
import { knock, readAdmission } from './guestApi.ts';
import { ADMISSION_MAX_POLLS, ADMISSION_POLL_MS, waitingView } from './steps.ts';

export function WaitingStep({ onAdmitted, onChangeAnswers, onAnswersNeeded }: {
  onAdmitted: () => void;
  onChangeAnswers: () => void;
  /** The server would not take the knock: the answers no longer stand (the notice changed). */
  onAnswersNeeded: () => void;
}) {
  const [view, setView] = useState<'waiting' | 'turned-away'>('waiting');
  const [stalled, setStalled] = useState(false);
  const [round, setRound] = useState(0);
  // The callbacks are read through a ref, so a parent's re-render never re-runs the knock.
  const on = useRef({ onAdmitted, onAnswersNeeded });
  on.current = { onAdmitted, onAnswersNeeded };

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let polls = 0;
    const settle = (state: ReturnType<typeof waitingView>): boolean => {
      if (state === 'admitted') { on.current.onAdmitted(); return true; }
      setView(state);
      return state === 'turned-away';
    };
    const poll = async () => {
      if (stopped) return;
      polls += 1;
      const admission = await readAdmission().catch(() => null);
      if (stopped) return;
      if (settle(waitingView(admission))) return;
      if (polls >= ADMISSION_MAX_POLLS) { setStalled(true); return; }
      timer = setTimeout(() => { void poll(); }, ADMISSION_POLL_MS);
    };
    void (async () => {
      setStalled(false);
      setView('waiting');
      const knocked = await knock().catch(() => ({ admission: null, refused: false }));
      if (stopped) return;
      if (knocked.refused) { on.current.onAnswersNeeded(); return; }
      if (knocked.admission && settle(waitingView(knocked.admission))) return;
      timer = setTimeout(() => { void poll(); }, ADMISSION_POLL_MS);
    })();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [round]);

  const again = useCallback(() => setRound((r) => r + 1), []);

  return (
    <Stack gap="md" className="max-w-xl" data-testid="join-waiting">
      <Card padding="lg">
        {view === 'turned-away' ? (
          <T size="sm" as="p" data-testid="join-turned-away">Your interviewer could not let you in just now.</T>
        ) : (
          <Stack gap="sm">
            <T size="base" weight="semibold" as="p">The interviewer has been told you are here.</T>
            <T size="sm" tone="secondary" as="p">Keep this page open. It moves on by itself when you are let in.</T>
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
