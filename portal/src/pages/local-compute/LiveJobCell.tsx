// What a job is doing, right now, in one table cell.
//
// The status column used to be a single static Chip. That is honest for a
// settled job and useless for a live one: "running" looked the same at second
// two and at minute nine, so the only way to tell a working machine from a
// wedged one was to reload and compare. This renders the same Chip for settled
// states and, for the three in-flight ones, adds a line that moves on its own
// — elapsed time counting up, the lane position while queued, and the retry
// number when this is not the first attempt.
//
// No progress bar: the wire carries no notion of how far through a run is, and
// a bar that fills on a timer would be inventing one.
import { Chip, Inline, MetaLine, Stack, ThinkingDots } from '@connorhoehnslalom/ui-components/shared';
import { statusLabel, statusTone, liveProgress, type JobStatus } from './localComputeFormat';

export interface LiveJob {
  status: JobStatus;
  createdAt: string;
  claimedAt?: string | null;
  startedAt?: string | null;
  attempts?: number;
  maxAttempts?: number;
}

export function LiveJobCell({ job, now, lanePosition }: { job: LiveJob; now: number; lanePosition?: number }) {
  const live = liveProgress(job, now, lanePosition);
  const chip = (
    <Chip tone={statusTone(job.status)} size="xs">{statusLabel(job.status)}</Chip>
  );
  if (!live) return chip;
  return (
    <Stack gap="none" data-testid="live-job">
      <Inline gap="xs" align="center">
        {chip}
        {live.active && <ThinkingDots size="sm" />}
      </Inline>
      {/* aria-live on the row that actually changes, so a screen-reader user
          hears "running 1m 04s" advance instead of being told once that the
          job started and then left in silence. Polite, not assertive: this is
          progress, not an alarm. */}
      <MetaLine
        size="xs"
        tone="tertiary"
        aria-live="polite"
        items={[live.label, live.attemptNote].filter(Boolean) as string[]}
      />
    </Stack>
  );
}
