// The dialog behind a round's Cancel, "Did not take place" and the recruiter's End (lib/interviewsCancel.ts; gap audit
// 2026-11-20 §1), and the menu items that open it. One component so the profile's rounds table, the upcoming list and
// the room ask the same question the same way. The server decides; a refusal is shown in the dialog.
import { ConfirmDialog, FormField, InlineAlert, RadioGroup, Stack, T, Textarea, type DropdownMenuItem } from '@connorhoehn/ui-components/shared';
import { useEffect, useState } from 'react';
import type { InterviewRow } from '../../lib/interviews';
import {
  CANCEL_NOTE_MAX, CANCEL_OPTIONS, NOT_HELD_OPTIONS, canCancel, canEndAsRecruiter, canMarkNotHeld, cancelRound, endRound, markNotHeld, noteProblem,
  type CancelOutcome, type CancelPick, type NotHeldPick,
} from '../../lib/interviewsCancel';

export type RoundCloseMode = 'cancel' | 'not-held' | 'end';
type Round = Pick<InterviewRow, 'id' | 'revision' | 'state' | 'scheduledAt'> & { round: { name: string } };

/** The items a round's Actions menu gains. `asRecruiter`: the viewer holds AssignInterviews; `isLead`: the viewer leads the round. */
export function roundCloseItems(r: Round, who: { asRecruiter: boolean; isLead: boolean }, open: (mode: RoundCloseMode) => void, nowMs: number = Date.now()): DropdownMenuItem[] {
  const items: DropdownMenuItem[] = [];
  if (who.asRecruiter && canEndAsRecruiter(r.state)) items.push({ label: 'End interview…', onSelect: () => open('end'), 'data-testid': 'interviews-round-end' });
  if ((who.asRecruiter || who.isLead) && canMarkNotHeld(r, nowMs)) items.push({ label: 'Did not take place…', onSelect: () => open('not-held'), 'data-testid': 'interviews-round-not-held' });
  if (who.asRecruiter && canCancel(r.state)) items.push({ label: 'Cancel round…', danger: true, onSelect: () => open('cancel'), 'data-testid': 'interviews-round-cancel' });
  return items;
}

const TITLES: Record<RoundCloseMode, string> = { cancel: 'Cancel this round?', 'not-held': 'Mark as not having taken place?', end: 'End this interview?' };
const BODIES: Record<RoundCloseMode, string> = {
  cancel: 'The round stops here. Its interviewers are told, nobody owes a scorecard, the candidate\'s link stops working, and you can assign the round again.',
  'not-held': 'The round is closed without a result. If it is live the call ends for everyone. Nobody owes a scorecard, and you can assign the round again.',
  end: 'The call ends for everyone, as the lead\'s End does. Every interviewer then owes a scorecard.',
};
const CONFIRMS: Record<RoundCloseMode, string> = { cancel: 'Cancel round', 'not-held': 'Mark as not held', end: 'End interview' };

export function RoundCloseDialog({ round, mode, onClose, onDone }: {
  round: Round | null;
  mode: RoundCloseMode | null;
  onClose: () => void;
  onDone: (interview: InterviewRow | null) => void;
}) {
  const [cancelReason, setCancelReason] = useState<CancelPick>('rescheduling');
  const [notHeldReason, setNotHeldReason] = useState<NotHeldPick>('no_show');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setNote(''); setError(null); setBusy(false); }, [round?.id, mode]);
  if (!round || !mode) return null;
  const problem = noteProblem(note);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    const out: CancelOutcome = mode === 'cancel' ? await cancelRound(round.id, round.revision, cancelReason, note)
      : mode === 'not-held' ? await markNotHeld(round.id, round.revision, notHeldReason, note)
        : await endRound(round.id, round.revision);
    setBusy(false);
    if (out.ok) { onDone(out.interview); onClose(); return; }
    setError(out.error);
  };

  return (
    <ConfirmDialog open onCancel={onClose} onConfirm={() => { void confirm(); }} tone={mode === 'end' ? 'caution' : 'destructive'}
      title={TITLES[mode]} confirmLabel={CONFIRMS[mode]} cancelLabel="Keep it" confirmDisabled={busy || !!problem}>
      <Stack gap="sm" data-testid="interviews-round-close-dialog">
        <T size="sm" tone="secondary" wrap>{`${round.round.name}. ${BODIES[mode]}`}</T>
        {mode === 'cancel' && (
          <RadioGroup<CancelPick> name="cancel-reason" value={cancelReason} onChange={setCancelReason} options={[...CANCEL_OPTIONS]} data-testid="interviews-round-cancel-reason" />
        )}
        {mode === 'not-held' && (
          <RadioGroup<NotHeldPick> name="not-held-reason" value={notHeldReason} onChange={setNotHeldReason} options={[...NOT_HELD_OPTIONS]} data-testid="interviews-round-not-held-reason" />
        )}
        {mode !== 'end' && (
          <FormField label="Note" hint={`Optional, up to ${CANCEL_NOTE_MAX} characters. The interviewers read it.`} error={problem ?? undefined}>
            {({ labelId: _labelId, ...w }) => <Textarea {...w} minRows={2} autoResize value={note} onChange={(e) => setNote(e.target.value)} data-testid="interviews-round-close-note" />}
          </FormField>
        )}
        {error && <InlineAlert tone="error" data-testid="interviews-round-close-error">{error}</InlineAlert>}
      </Stack>
    </ConfirmDialog>
  );
}
