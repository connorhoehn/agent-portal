import { Inline, MetaLine, SelectableCard, Stack, T } from '@connorhoehnslalom/ui-components/shared';
import type { JourneyStep } from './types';

/** The whole journey as a scrollable list, newest step last. Clicking a row
 *  hands the index back so the caller can switch to the carousel on it. */
export function JourneyTimeline({
  steps,
  onJump,
}: {
  steps: JourneyStep[];
  onJump: (i: number) => void;
}) {
  return (
    <Stack gap="sm" className="max-h-[480px] overflow-y-auto">
      {steps.map((step, i) => (
        <SelectableCard
          key={step.index}
          padding="sm"
          onSelect={() => onJump(i)}
          aria-label={`Jump to step ${i + 1}`}
        >
          <Inline gap="md" align="start" wrap={false} className="w-full">
            <Stack gap="none" align="center" justify="center" className="h-[76px] w-[120px] flex-none overflow-hidden rounded bg-surface-inset">
              {step.imageDataUrl ? (
                <img src={step.imageDataUrl} alt="" className="h-full w-full object-cover" />
              ) : (
                <T size="xs" className="text-text-tertiary">no shot</T>
              )}
            </Stack>
            <Stack gap="none" className="min-w-0 flex-1">
              <Inline gap="sm" wrap={false}>
                <T size="xs" weight="semibold" className="text-text-tertiary">#{i + 1}</T>
                <T size="sm" weight="medium" className="text-text-primary">{step.pageTitle || step.url}</T>
              </Inline>
              <T size="xs" className="truncate font-mono text-text-tertiary">{step.url}</T>
              <MetaLine items={[new Date(step.startedAt).toLocaleTimeString()]} />
              {step.question && (
                <T size="xs" className="mt-1.5 line-clamp-2 text-text-secondary" wrap>
                  <b>Q:</b>&nbsp;{step.question}
                </T>
              )}
            </Stack>
          </Inline>
        </SelectableCard>
      ))}
    </Stack>
  );
}
