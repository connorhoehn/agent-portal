// The pad with its runs, the same on both sides (rows I4.2–I4.4; decision 3: the candidate reaches the pad and its
// runs; decision 21: in a technical round the pane is the pad with the run output under it). The panel's room
// (room/PadTab.tsx) and the candidate's (pages/join/JoinRoom.tsx) mount this one component; only `base` and the
// seat differ. Run sends the pad's text at that moment as the one file named for its language with a fresh id,
// and a snapshot to the pad log; Cancel shows while a run of this interview is queued, compiling or running; a
// refusal is the server's sentence, shown over the output. The output is the library's `CodeRunOutput`, about a
// third of the column, scrolling on its own; the editor keeps the rest.
import { useCallback, useRef, useState } from 'react';
import { CodeRunOutput } from '@connorhoehn/ui-components/code-pad';
import { Button, Inline, InlineAlert, Stack, Switch, T, Tooltip } from '@connorhoehn/ui-components/shared';
import { useFetch } from '../../../hooks/useFetch';
import { miloSettingsPath, PAD_HELP_LABEL, PAD_HELP_TOOLTIP, setCandidateMayAsk, type MiloSettingsView } from '../../../lib/interviewsMilo';
import { padLanguageOf } from '../../../lib/interviewsPad';
import { InterviewPad, type InterviewPadHandle, type PadQuestion, type PadSeat } from './InterviewPad';
import { useInterviewRuns } from './useInterviewRuns';
import { usePadLogReporter } from './usePadLogReporter';

export interface RunnablePadProps {
  interviewId: string;
  /** The side's path: `staffPadBase(id)` for the panel, `GUEST_PAD_BASE` for the candidate. */
  base: string;
  self: { userId: string; displayName: string };
  seat: PadSeat;
  /** The lead's "Insert a question" menu. */
  questions?: readonly PadQuestion[];
}

/**
 * The lead's switch in the pad toolbar: whether the candidate may ask Milo to change the pad (test cases, an import, a helper).
 * Off by default; the lead may always ask. Shown to the lead only.
 */
function PadHelpSwitch({ interviewId }: { interviewId: string }) {
  const { data, refresh } = useFetch<MiloSettingsView>(miloSettingsPath(interviewId));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!data) return null;
  const flip = async (on: boolean) => {
    setSaving(true); setError(null);
    const out = await setCandidateMayAsk(interviewId, on);
    setSaving(false);
    if (!out.ok) setError(out.error);
    refresh();
  };
  return <Tooltip content={error ?? PAD_HELP_TOOLTIP} placement="bottom">
    <Inline gap="xs" align="center" wrap={false} data-testid="interview-pad-milo-help">
      <Switch size="sm" checked={data.settings.candidateMayAsk} disabled={saving} onChange={(on) => void flip(on)} aria-label={PAD_HELP_LABEL} data-testid="interview-pad-milo-help-switch" />
      <T size="xs" tone={error ? 'danger' : 'secondary'}>{PAD_HELP_LABEL}</T>
    </Inline>
  </Tooltip>;
}

export function RunnablePad({ interviewId, base, self, seat, questions }: RunnablePadProps) {
  const pad = useRef<InterviewPadHandle | null>(null);
  const runs = useInterviewRuns(base, self.userId);
  const read = useCallback(() => (pad.current ? { text: pad.current.getText(), language: pad.current.getLanguage() } : null), []);
  const log = usePadLogReporter(base, read);
  const { start } = runs;
  const run = useCallback(() => {
    const handle = pad.current;
    if (!handle) return;
    const text = handle.getText();
    const language = padLanguageOf(handle.getLanguage());
    log.snapshot(text, language);
    void start(language, text);
  }, [log, start]);

  const toolbarEnd = <Inline gap="xs" align="center" wrap={false} className="shrink-0">
    {seat === 'lead' && <PadHelpSwitch interviewId={interviewId} />}
    {runs.canCancel && <Button size="sm" variant="secondary" onClick={() => void runs.cancel()} disabled={runs.cancelling} data-testid="interview-pad-cancel">Cancel</Button>}
    <Button size="sm" variant="primary" onClick={run} disabled={runs.starting} data-testid="interview-pad-run">Run</Button>
  </Inline>;

  const o = runs.output;
  const below = <Stack gap="none" className="h-1/3 min-h-40 shrink-0 border-t border-border" data-testid="interview-pad-output">
    {runs.refusal && <InlineAlert tone="warning" data-testid="interview-pad-refusal">{runs.refusal}</InlineAlert>}
    <CodeRunOutput variant="flush" className="min-h-0 flex-1" data-testid="interview-pad-run-output"
      status={o.status} stdout={o.stdout} stderr={o.stderr} compileOutput={o.compileOutput} truncated={o.truncated}
      exitCode={o.exitCode} timeMs={o.timeMs} peakMemoryMb={o.peakMemoryMb}
      {...(o.runBy ? { runBy: o.runBy } : {})} {...(o.languageLabel ? { languageLabel: o.languageLabel } : {})}
      {...(o.runtimeVersion ? { runtimeVersion: o.runtimeVersion } : {})} />
  </Stack>;

  return <InterviewPad ref={pad} interviewId={interviewId} self={self} seat={seat} {...(questions?.length ? { questions } : {})}
    toolbarEnd={toolbarEnd} below={below}
    onLocalEdit={log.onLocalEdit} onPaste={log.onPaste} onLanguageChange={log.onLanguageChange} onInsert={log.onInsert} />;
}
