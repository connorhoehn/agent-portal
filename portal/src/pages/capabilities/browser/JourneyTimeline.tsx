import { Inline, MetaLine, SelectableCard, Stack } from '@connorhoehnslalom/ui-components/shared';
import type { JourneyStep } from './types';
import { T } from '../Text';

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
                <T className="text-[10px] text-text-tertiary">no shot</T>
              )}
            </Stack>
            <Stack gap="none" className="min-w-0 flex-1">
              <Inline gap="sm" wrap={false}>
                <T className="text-[10px] font-semibold text-text-tertiary">#{i + 1}</T>
                <T className="text-[13px] font-medium text-text-primary">{step.pageTitle || step.url}</T>
              </Inline>
              <T className="truncate font-mono text-[10px] text-text-tertiary">{step.url}</T>
              <MetaLine items={[new Date(step.startedAt).toLocaleTimeString()]} />
              {step.question && (
                <T className="mt-1.5 line-clamp-2 text-[11px] text-text-secondary" wrap>
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
