import { Inline, MetaLine, Stack } from '@connorhoehnslalom/ui-components/shared';
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
        <button
          type="button"
          key={step.index}
          onClick={() => onJump(i)}
          aria-label={`Jump to step ${i + 1}`}
          className="w-full cursor-pointer rounded border border-border bg-surface p-2 text-left hover:border-border-emphasis"
        >
          <Inline gap="md" align="start" wrap={false}>
            <span className="h-[76px] w-[120px] flex-none overflow-hidden rounded bg-surface-inset">
              {step.imageDataUrl ? (
                <img src={step.imageDataUrl} alt="" className="h-full w-full object-cover" />
              ) : (
                <span className="flex h-full items-center justify-center text-[10px] text-text-tertiary">
                  no shot
                </span>
              )}
            </span>
            <Stack gap="none" className="min-w-0 flex-1">
              <Inline gap="sm" wrap={false}>
                <span className="text-[10px] font-semibold text-text-tertiary">#{i + 1}</span>
                <span className="text-[13px] font-medium text-text-primary">{step.pageTitle || step.url}</span>
              </Inline>
              <span className="truncate font-mono text-[10px] text-text-tertiary">{step.url}</span>
              <MetaLine items={[new Date(step.startedAt).toLocaleTimeString()]} />
              {step.question && (
                <span className="mt-1.5 line-clamp-2 text-[11px] text-text-secondary">
                  <b>Q:</b> {step.question}
                </span>
              )}
            </Stack>
          </Inline>
        </button>
      ))}
    </Stack>
  );
}
