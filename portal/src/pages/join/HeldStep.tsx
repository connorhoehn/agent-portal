// The held page (docs/interviews-tenant-plan.md decision 5, row I6.4): the candidate's answers say no to a part this
// deployment requires, so the interview cannot start as it is set up. Shown instead of the waiting room. It says the
// answer is saved, the recruiter has been told and will be in touch, and the answer can change here until the
// interview starts. No blame, no pressure, no countdown; nothing is knocked.
import { Button, Card, Inline, Stack, T } from '@connorhoehn/ui-components/shared';
import { heldLines, type ConsentPart } from './steps.ts';

export function HeldStep({ declined, onChangeAnswers }: { declined: readonly ConsentPart[]; onChangeAnswers: () => void }) {
  const [saved, ...rest] = heldLines(declined);
  return (
    <Stack gap="md" data-testid="join-held">
      <Card padding="lg">
        <Stack gap="sm">
          <T size="base" weight="semibold" as="p">{saved}</T>
          {rest.map((line) => <T key={line} size="sm" as="p">{line}</T>)}
        </Stack>
      </Card>
      <Inline gap="sm" align="center">
        <Button variant="ghost" onClick={onChangeAnswers} data-testid="join-held-change-answers">Change my answers</Button>
      </Inline>
    </Stack>
  );
}
