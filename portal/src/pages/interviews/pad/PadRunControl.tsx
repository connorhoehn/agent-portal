// The pad's Run button with what the runner is, said before anyone presses it (both seats mount this through
// RunnablePad). Simulated: one plain line beside Run. Unavailable: the line, and Run is disabled with that as its
// reason. Real, or the runner not yet known: nothing extra.
import { Button, Inline, T, Tooltip } from '@connorhoehn/ui-components/shared';
import { runnerLabel, type RunnerKind } from '../../../lib/interviewsPad';

export function PadRunControl({ runner, busy, onRun }: { runner: RunnerKind | null; busy: boolean; onRun: () => void }) {
  const label = runnerLabel(runner);
  const unavailable = runner === 'unavailable';
  const button = <Button size="sm" variant="primary" onClick={onRun} disabled={busy || unavailable} data-testid="interview-pad-run">Run</Button>;
  return <Inline gap="xs" align="center" wrap={false} data-testid="interview-pad-run-control">
    {label && <T size="xs" tone={unavailable ? 'danger' : 'secondary'} data-testid="interview-pad-runner-label" data-runner={runner}>{label}</T>}
    {label && unavailable ? <Tooltip content={label} placement="bottom">{button}</Tooltip> : button}
  </Inline>;
}
