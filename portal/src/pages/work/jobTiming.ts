import type { WorkflowStep } from '@connorhoehnslalom/ui-components/shared';
import { absoluteTime } from '../../lib/relativeTime.ts';

interface JobTiming {
  status: string;
  createdAt: string;
  claimedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

/** Only recorded milestones count as reached; a missing timestamp is never inferred. */
export function jobTimingSteps(job: JobTiming): WorkflowStep[] {
  const failed = ['failed', 'dead'].includes(job.status);
  const cancelled = job.status === 'cancelled' || job.status === 'skipped';
  const completed = job.status === 'done' || job.status === 'completed';
  const terminal = failed || cancelled || completed || job.status === 'awaiting_review';
  const times = [job.createdAt, job.claimedAt, job.startedAt, job.finishedAt];
  const latest = terminal ? 3 : job.status === 'running' ? 2 : job.status === 'claimed' ? 1 : 0;
  const labels = ['Queued', 'Claimed', 'Started', failed ? 'Failed' : cancelled ? (job.status === 'skipped' ? 'Skipped' : 'Cancelled') : job.status === 'awaiting_review' ? 'Ready for review' : 'Finished'];
  return labels.map((label, index) => ({
    step: index + 1, label,
    description: times[index] ? absoluteTime(times[index]) : terminal || index < latest ? 'Not recorded' : 'Not yet',
    done: !!times[index] && (index < latest || index === 3 && completed),
    active: index === latest && !completed,
    ...(index === 3 && failed ? { outcome: 'failed' as const } : index === 3 && cancelled ? { outcome: 'cancelled' as const } : {}),
  }));
}
