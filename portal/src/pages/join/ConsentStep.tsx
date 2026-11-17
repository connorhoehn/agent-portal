// The notice and the three consents (docs/interviews-tenant-plan.md decision 5, row I2.3). The notice text, then
// three separate yes-or-no questions with one line each on what saying no means. Nothing is chosen for the
// candidate; the transcript/Milo dependency is shown as it happens; Continue only when all three are answered.
// A part the deployment requires (row I6.4) carries one line saying so; saying no to it is still allowed and saved.
// UI round 2: the notice sits BESIDE the questions and scrolls in its own column, so the three questions and
// Continue stay in view at 1280×800 (the frame gives this step a fixed-height body).
import { useState } from 'react';
import { Button, Card, Divider, InlineAlert, Inline, RadioGroup, Stack, T } from '@connorhoehn/ui-components/shared';
import { allAnswered, choose, miloLocked, REQUIRED_LINE, type ConsentChoices, type ConsentPart, type GuestConsents } from './steps.ts';
import { LinkDead, saveConsents } from './guestApi.ts';

type YesNo = 'yes' | 'no' | '';

const QUESTIONS: { part: ConsentPart; question: string; ifNo: string }[] = [
  { part: 'recording', question: 'May the call be recorded?', ifNo: 'If you say no, nothing of the call is recorded.' },
  { part: 'transcription', question: 'May what is said be turned into a transcript?', ifNo: 'If you say no, there is no transcript, and Milo is off too.' },
  { part: 'milo', question: 'May Milo help the people interviewing you?', ifNo: 'If you say no, your interviewer runs the interview without Milo.' },
];

const asYesNo = (v: boolean | null): YesNo => (v === null ? '' : v ? 'yes' : 'no');

export function ConsentStep({ consents, onSaved, onLinkDead }: {
  consents: GuestConsents;
  onSaved: (saved: GuestConsents) => void;
  onLinkDead: () => void;
}) {
  const [notice, setNotice] = useState(consents.notice);
  const [required, setRequired] = useState<readonly ConsentPart[]>(consents.required ?? []);
  const [answers, setAnswers] = useState<ConsentChoices>(consents.answers);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

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
      }
      setMessage(result.message);
    } catch (error) {
      if (error instanceof LinkDead) { onLinkDead(); return; }
      setMessage('Your answers could not be saved just now. Check your connection, then try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Inline gap="lg" align="stretch" wrap={false} className="min-h-0 flex-1" data-testid="join-consents">
      <Card padding="lg" className="min-h-0 min-w-0 flex-1 overflow-y-auto" data-testid="join-notice" tabIndex={0} aria-label={notice.title}>
        <Stack gap="sm">
          <T size="base" weight="semibold" as="p">{notice.title}</T>
          {notice.paragraphs.map((p) => <T key={p} size="sm" as="p">{p}</T>)}
        </Stack>
      </Card>
      <Stack gap="md" className="min-h-0 w-[26rem] shrink-0 overflow-y-auto" data-testid="join-questions">
        <Card padding="lg">
          <Stack gap="md">
            {QUESTIONS.map(({ part, question, ifNo }, i) => {
              const locked = part === 'milo' && miloLocked(answers);
              return (
                <Stack gap="sm" key={part} data-testid={`join-consent-${part}`}>
                  {i > 0 && <Divider />}
                  <T size="sm" weight="medium" as="p">{question}</T>
                  {required.includes(part) && <T size="xs" tone="secondary" as="p" data-testid={`join-consent-${part}-required`}>{REQUIRED_LINE}</T>}
                  <RadioGroup<YesNo>
                    name={`consent-${part}`}
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
          {!allAnswered(answers) && <T size="xs" tone="secondary">Answer all three questions to continue.</T>}
        </Inline>
      </Stack>
    </Inline>
  );
}
