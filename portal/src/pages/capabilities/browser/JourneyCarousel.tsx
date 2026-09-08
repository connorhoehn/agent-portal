import { Button, Card, IconButton, Inline, InlinePlaceholder, MetaLine, Stack } from '@connorhoehnslalom/ui-components/shared';
import type { JourneyStep } from './types';
import { T } from '../Text';

/** One recorded step, big, with a thumbnail strip to jump between them. */
export function JourneyCarousel({
  steps,
  idx,
  onIdx,
}: {
  steps: JourneyStep[];
  idx: number;
  onIdx: (i: number) => void;
}) {
  const step = steps[idx];
  if (!step) return null;

  return (
    <Stack gap="sm">
      <Inline gap="sm" justify="between" wrap={false}>
        <IconButton
          aria-label="Previous step"
          icon="‹"
          variant="ghost"
          onClick={() => onIdx(Math.max(0, idx - 1))}
          disabled={idx === 0}
        />
        <Stack gap="none" align="center" className="flex-1 min-w-0">
          <T className="text-[12px] font-semibold text-text-primary">{step.pageTitle || step.url}</T>
          <T className="truncate font-mono text-[10px] text-text-tertiary">{step.url}</T>
          <MetaLine items={[`Step ${idx + 1} of ${steps.length}`, new Date(step.startedAt).toLocaleTimeString()]} />
        </Stack>
        <IconButton
          aria-label="Next step"
          icon="›"
          variant="ghost"
          onClick={() => onIdx(Math.min(steps.length - 1, idx + 1))}
          disabled={idx === steps.length - 1}
        />
      </Inline>

      {step.imageDataUrl ? (
        <Card padding="none" className="overflow-hidden">
          <img src={step.imageDataUrl} alt={step.pageTitle || step.url} className="block w-full" />
        </Card>
      ) : (
        <InlinePlaceholder align="center" size="sm">No screenshot for this step.</InlinePlaceholder>
      )}

      {step.question && (
        <Card padding="sm" className="bg-surface-hover">
          <Stack gap="xs">
            <T className="text-[11px] font-semibold text-text-tertiary" wrap>Q: {step.question}</T>
            <T className="text-[12px] text-text-primary" wrap>{step.answer}</T>
          </Stack>
        </Card>
      )}

      <Inline gap="xs" wrap={false} className="overflow-x-auto pb-1">
        {steps.map((s, i) => (
          <Button
            key={s.index}
            variant="ghost"
            onClick={() => onIdx(i)}
            title={s.pageTitle || s.url}
            aria-label={`Step ${i + 1}: ${s.pageTitle || s.url}`}
            aria-pressed={i === idx}
            className={`!h-[50px] !w-20 !flex-none !overflow-hidden !rounded !bg-surface !p-0 ${
              i === idx ? '!border-2 !border-primary' : '!border !border-border'
            }`}
          >
            {s.imageDataUrl
              ? <img src={s.imageDataUrl} alt="" className="h-full w-full object-cover" />
              : <T className="text-[9px] text-text-tertiary">{i + 1}</T>}
          </Button>
        ))}
      </Inline>
    </Stack>
  );
}
