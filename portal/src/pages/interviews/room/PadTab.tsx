// The room pane's `pad` tab (contract U1). Round 1 (lane ROOM): the round's coding questions with their starter
// code, read-only, to read aloud. Lane WIRE replaces this body with the shared pad (U2, `InterviewPad`) and its
// run output; nobody but ROOM and WIRE edits this file.
import type { JSX } from 'react';
import { CodeBlock, Disclosure, PageSection, Stack, T } from '@connorhoehn/ui-components/shared';
import { PAD_LANGUAGE_LABELS } from '../../../lib/interviewsKit';
import { codeBlockLanguage, type RoomView } from '../../../lib/interviewsRoom';

export function PadTab({ room }: { room: RoomView }): JSX.Element {
  const { questions } = room;
  if (!questions.length) return <PageSection size="sm" title="Coding questions" empty="No questions were chosen for this round." />;
  return <Stack gap="lg" data-testid="interview-room-coding">
    {questions.map((q, n) => <PageSection key={q.id} size="sm" title={`Question ${n + 1}`} description={q.competency ?? undefined}>
      <Stack gap="sm">
        <T size="sm" wrap>{q.prompt}</T>
        {q.starter.map((s) => <Stack key={s.language} gap="xs">
          <T size="xs" weight="medium" tone="secondary">{`Starter code · ${PAD_LANGUAGE_LABELS[s.language]}`}</T>
          <CodeBlock code={s.code} language={codeBlockLanguage(s.language)} copyButton ariaLabel={`Starter code in ${PAD_LANGUAGE_LABELS[s.language]}`} />
        </Stack>)}
        {q.followUps.length > 0 && <Disclosure summary={<T size="xs" tone="secondary">{`Follow-ups (${q.followUps.length})`}</T>} density="compact">
          <Stack as="ul" gap="xs">{q.followUps.map((f) => <T as="li" key={f} size="sm" wrap>{f}</T>)}</Stack>
        </Disclosure>}
      </Stack>
    </PageSection>)}
  </Stack>;
}
