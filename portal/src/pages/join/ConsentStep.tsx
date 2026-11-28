// The notice and the three consents (docs/interviews-tenant-plan.md decision 5, row I2.3). The notice text, then
// three separate yes-or-no questions with one line each on what saying no means. Nothing is chosen for the
// candidate; the transcript/Milo dependency is shown as it happens; Continue only when all three are answered.
// A part the deployment requires (row I6.4) carries one line saying so; saying no to it is still allowed and saved.
// UI round 2: the notice sits BESIDE the questions and scrolls in its own column, so the three questions and
// Continue stay in view at 1280×800 (the frame gives this step a fixed-height body).
// Hardening H2 (I2.3f): a refused save whose stored answers still stand (the call started, or another window saved
// first) offers "Back to waiting" on those answers, and the page keeps asking for the admission meanwhile, so the
// lead's Admit reaches it without a reload.
import { useEffect, useRef, useState } from 'react';
import { Button, Card, Divider, InlineAlert, Inline, RadioGroup, Stack, T } from '@connorhoehn/ui-components/shared';
import { ADMISSION_MAX_POLLS, ADMISSION_POLL_MS, allAnswered, answersStand, choose, miloLocked, REQUIRED_LINE, type ConsentChoices, type ConsentPart, type GuestConsents } from './steps.ts';
import { LinkDead, readAdmission, saveConsents } from './guestApi.ts';

type YesNo = 'yes' | 'no' | '';

const QUESTIONS: { part: ConsentPart; question: string; ifNo: string }[] = [
  { part: 'recording', question: 'May the call be recorded?', ifNo: 'If you say no, nothing of the call is recorded.' },
  { part: 'transcription', question: 'May what is said be turned into a transcript?', ifNo: 'If you say no, there is no transcript, and Milo is off too.' },
  { part: 'milo', question: 'May Milo help the people interviewing you?', ifNo: 'If you say no, your interviewer runs the interview without Milo.' },
];

const asYesNo = (v: boolean | null): YesNo => (v === null ? '' : v ? 'yes' : 'no');

export function ConsentStep({ consents, onSaved, onLinkDead, onBack, onAdmitted }: {
  consents: GuestConsents;
  onSaved: (saved: GuestConsents) => void;
  onLinkDead: () => void;
  /** A refused change: go back to waiting on the answers the server holds. */
  onBack: (held: GuestConsents) => void;
  /** The lead let the candidate in while the page sat on a refused change. */
  onAdmitted: () => void;
}) {
  const [notice, setNotice] = useState(consents.notice);
  const [required, setRequired] = useState<readonly ConsentPart[]>(consents.required ?? []);
  const [answers, setAnswers] = useState<ConsentChoices>(consents.answers);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // The answers the server holds after a refused save, when they still stand.
  const [held, setHeld] = useState<GuestConsents | null>(null);
  const admitted = useRef(onAdmitted);
  admitted.current = onAdmitted;

  useEffect(() => {
    if (!held) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let polls = 0;
    const poll = async () => {
      polls += 1;
      const admission = await readAdmission().catch(() => null);
      if (stopped) return;
      if (admission?.state === 'admitted') { admitted.current(); return; }
      if (polls < ADMISSION_MAX_POLLS) timer = setTimeout(() => { void poll(); }, ADMISSION_POLL_MS);
    };
    void poll();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [held]);

  const save = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await saveConsents(notice.version, answers);
      if (result.kind === 'saved') { onSaved(result.consents); return; }
      if (result.kind === 'refused') {
        // Show what the server holds now: the current notice and the answers that stand under it.
        setNotice(result.consents.notice);
        setAnswers(result.consents.answers);
        setRequired(result.consents.required ?? []);
        setHeld(answersStand(result.consents) ? result.consents : null);
      }
      setMessage(result.message);
    } catch (error) {
      if (error instanceof LinkDead) { onLinkDead(); return; }
      setMessage('Your answers could not be saved just now. Check your connection, then try again.');
    } finally {
      setBusy(false);
    }
  };

  // Side by side from 768 wide; below it (a phone) the notice sits over the questions, each scrolling in its own share.
  return (
    <Inline gap="lg" align="stretch" wrap={false} className="min-h-0 flex-1 max-md:flex-col" data-testid="join-consents">
      <Card padding="lg" className="min-h-0 min-w-0 flex-1 overflow-y-auto max-md:min-h-[12rem]" data-testid="join-notice" tabIndex={0} aria-label={notice.title}>
        <Stack gap="sm">
          <T size="base" weight="semibold" as="p">{notice.title}</T>
          {notice.paragraphs.map((p) => <T key={p} size="sm" as="p">{p}</T>)}
        </Stack>
      </Card>
      <Stack gap="md" className="min-h-0 w-[26rem] shrink-0 overflow-y-auto max-md:w-full max-md:shrink" data-testid="join-questions">
        <Card padding="lg">
          <Stack gap="md">
            {QUESTIONS.map(({ part, question, ifNo }, i) => {
              const locked = part === 'milo' && miloLocked(answers);
              return (
                <Stack gap="sm" key={part} data-testid={`join-consent-${part}`}>
                  {i > 0 && <Divider />}
                  {/* Not in a FormField, so the group is named by its question through aria-labelledby. */}
                  <T size="sm" weight="medium" as="p" id={`join-consent-${part}-question`}>{question}</T>
                  {required.includes(part) && <T size="xs" tone="secondary" as="p" data-testid={`join-consent-${part}-required`}>{REQUIRED_LINE}</T>}
                  <RadioGroup<YesNo>
                    name={`consent-${part}`}
                    aria-labelledby={`join-consent-${part}-question`}
                    orientation="horizontal"
                    value={asYesNo(answers[part])}
                    onChange={(v) => setAnswers((a) => choose(a, part, v === 'yes'))}
                    options={[{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }]}
                    disabled={busy || locked}
                    data-testid={`join-consent-${part}-choice`}
                  />
                  <T size="xs" tone="secondary" as="p">
                    {locked ? 'Milo is off because you said no to the transcript: Milo needs it.' : ifNo}
                  </T>
                </Stack>
              );
            })}
          </Stack>
        </Card>
        {message && <InlineAlert tone="warning" data-testid="join-consents-message">{message}</InlineAlert>}
        <Inline gap="sm" align="center">
          <Button variant="primary" disabled={!allAnswered(answers) || busy} onClick={() => { void save(); }} data-testid="join-consents-continue">
            Continue
          </Button>
          {held && <Button variant="secondary" disabled={busy} onClick={() => onBack(held)} data-testid="join-consents-back">Back to waiting</Button>}
          {!allAnswered(answers) && <T size="xs" tone="secondary">Answer all three questions to continue.</T>}
        </Inline>
      </Stack>
    </Inline>
  );
}
