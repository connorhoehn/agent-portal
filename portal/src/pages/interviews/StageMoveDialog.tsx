// The recruiter's "Move stage" on a candidate's application (lib/interviewsStageMoves.ts; gap audit 2026-11-20 §2): a
// menu that offers only the moves the stage takes (Start screening, Mark hired, Offer declined, Reopen), and the dialog
// that asks once with the reason when the move needs one. Sits beside "Mark withdrawn" on the profile's stage section.
// The server decides; a refusal is shown in the dialog.
import { ConfirmDialog, DropdownMenu, FormField, InlineAlert, Stack, T, Textarea } from '@connorhoehn/ui-components/shared';
import { useEffect, useState } from 'react';
import { STAGE_LABELS, type ApplicationStage, type InterviewState } from '../../lib/interviews';
import {
  STAGE_MOVE_BODY, STAGE_MOVE_LABEL, STAGE_MOVE_LIMITS, STAGE_MOVE_REASON, moveStage, stageMoveReasonProblem, stageMovesFor, type StageMoveKind,
} from '../../lib/interviewsStageMoves';

interface App { applicationId: string; stage: ApplicationStage; history: readonly unknown[]; interviews: ReadonlyArray<{ state: InterviewState }> }

export function StageMoveAction({ app, onDone }: { app: App; onDone: () => void }) {
  const [open, setOpen] = useState<{ move: StageMoveKind; to: ApplicationStage } | null>(null);
  const moves = stageMovesFor(app.stage, app.interviews);
  if (!moves.length) return null;
  return (
    <>
      <DropdownMenu trigger="Move stage ▾" triggerLabel="Move stage" align="end" triggerTestId="interviews-profile-move-stage"
        sections={[{ items: moves.map((m) => ({ label: `${STAGE_MOVE_LABEL[m.move]}…`, onSelect: () => setOpen(m), 'data-testid': `interviews-profile-move-${m.move}` })) }]} />
      <StageMoveDialog app={app} pick={open} onClose={() => setOpen(null)} onDone={onDone} />
    </>
  );
}

function StageMoveDialog({ app, pick, onClose, onDone }: { app: App; pick: { move: StageMoveKind; to: ApplicationStage } | null; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  useEffect(() => { setReason(''); setError(null); setBusy(false); setTouched(false); }, [pick?.move]);
  if (!pick) return null;
  const needs = STAGE_MOVE_REASON[pick.move];
  const problem = needs === null ? null : stageMoveReasonProblem(pick.move, reason);

  const confirm = async () => {
    setTouched(true);
    if (problem) return;
    setBusy(true);
    setError(null);
    const out = await moveStage(app.applicationId, pick.move, app.history.length, reason);
    setBusy(false);
    if (out.ok) { onDone(); onClose(); return; }
    setError(out.error);
  };

  return (
    <ConfirmDialog open onCancel={onClose} onConfirm={() => { void confirm(); }} tone={pick.move === 'decline' ? 'destructive' : 'caution'}
      title={`${STAGE_MOVE_LABEL[pick.move]}?`} confirmLabel={STAGE_MOVE_LABEL[pick.move]} cancelLabel="Keep the stage" confirmDisabled={busy || (needs === true && !!problem && touched)}>
      <Stack gap="sm" data-testid="interviews-stage-move-dialog">
        <T size="sm" tone="secondary" wrap>{`${STAGE_LABELS[app.stage]} to ${STAGE_LABELS[pick.to]}. ${STAGE_MOVE_BODY[pick.move]}`}</T>
        {needs !== null && (
          <FormField label={needs ? 'Reason' : 'Note'} required={needs}
            hint={needs ? `Required, ${STAGE_MOVE_LIMITS.reasonMin} to ${STAGE_MOVE_LIMITS.reasonMax} characters. It shows in the stage history.` : 'Optional. It shows in the stage history.'}
            error={touched ? problem ?? undefined : undefined}>
            {({ labelId: _labelId, ...w }) => <Textarea {...w} minRows={2} autoResize value={reason} onChange={(e) => setReason(e.target.value)} data-testid="interviews-stage-move-reason" />}
          </FormField>
        )}
        {error && <InlineAlert tone="error" data-testid="interviews-stage-move-error">{error}</InlineAlert>}
      </Stack>
    </ConfirmDialog>
  );
}
