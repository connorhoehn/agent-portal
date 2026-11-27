// The pad's Run button and what its runner is, said before anyone presses it (both seats mount these through
// RunnablePad). The button stays alone in the toolbar: the toolbar is one unwrapped row, and a sentence beside Run
// pushed the button off the pane at 900px and at phone width (journey piece G1). The sentence sits over the output
// instead, where the result of Run is read. Simulated: the line. Unavailable: the line, and Run is disabled with it
// as its reason. Real, or the runner not yet known: nothing extra.
import { Button, InlineAlert, Tooltip } from '@connorhoehn/ui-components/shared';
import { runnerLabel, type RunnerKind } from '../../../lib/interviewsPad';

export function PadRunControl({ runner, busy, onRun }: { runner: RunnerKind | null; busy: boolean; onRun: () => void }) {
  const label = runnerLabel(runner);
  const unavailable = runner === 'unavailable';
  const button = <Button size="sm" variant="primary" onClick={onRun} disabled={busy || unavailable} data-testid="interview-pad-run">Run</Button>;
  return label && unavailable ? <Tooltip content={label} placement="bottom">{button}</Tooltip> : button;
}

/** The runner's line over the output pane; nothing for a real runner or one not yet known. */
export function PadRunnerNote({ runner }: { runner: RunnerKind | null }) {
  const label = runnerLabel(runner);
  if (!label) return null;
  return <InlineAlert tone={runner === 'unavailable' ? 'warning' : 'info'} data-testid="interview-pad-runner-label" data-runner={runner}>{label}</InlineAlert>;
}
