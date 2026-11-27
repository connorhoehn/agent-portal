// What the preview found, as ONE compact line above the slides: "7 things to
// check before sharing" with the kinds that matter named, and the list grouped
// by kind behind the library's Disclosure, collapsed by default. Speaker notes
// and style advice are listed but never counted (deckFindings.ts).

import { Disclosure, Stack, T } from '@connorhoehn/ui-components/shared';
import { findingsSummary, groupDeckWarnings, slideRange } from './deckFindings';

export function DeckFindingsLine({ warnings, slideCount, testId }: { warnings: readonly string[]; slideCount: number; testId: string }) {
  const findings = groupDeckWarnings(warnings);
  const summary = findingsSummary(findings, slideCount);
  if (!summary) return null;
  return (
    <Disclosure
      density="compact" tone={summary.tone === 'warning' ? 'warning' : undefined}
      summary={<T as="span" size="xs" weight="medium">{summary.title}</T>}
      hint={summary.hint}
      data-testid={testId} data-count={String(findings.count)}
    >
      <Stack gap="xs">
        {findings.groups.map(group => (
          <Stack key={group.kind} gap="none" data-testid={`${testId}-${group.kind}`}>
            <T size="xs" weight="medium" wrap>{`${group.label}: ${slideRange(group.slides, slideCount) || 'the deck'}`}</T>
            {(group.kind === 'overflow' || group.kind === 'unfinished' || group.kind === 'advice') && group.sentences.map((s, i) => (
              <T key={i} size="xs" tone="secondary" wrap>{/[.!?]$/.test(s) ? s : `${s}.`}</T>
            ))}
          </Stack>
        ))}
      </Stack>
    </Disclosure>
  );
}
