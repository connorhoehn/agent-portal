// "I can't make this time" (gap audit 2026-11-20 §6): on the candidate's landing, before the round starts. One action with an
// optional note; the recruiter is told and will be in touch. Nothing else changes: the time stays until the recruiter moves it.
import { useState } from 'react';
import { Button, FormField, InlineAlert, Inline, Stack, T, Textarea } from '@connorhoehn/ui-components/shared';
import { CANT_MAKE_NOTE_MAX, sendCantMake } from './guestApi.ts';

const TOLD = 'The recruiter has been told you cannot make this time. They will be in touch about what happens next.';

export function CantMakeTime({ sentAt, onLinkDead }: { sentAt: string | null; onLinkDead(): void }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [told, setTold] = useState<string | null>(sentAt ? TOLD : null);
  const [error, setError] = useState<string | null>(null);
  const tooLong = note.trim().length > CANT_MAKE_NOTE_MAX;

  if (told) return <T size="sm" tone="secondary" wrap data-testid="join-cant-make-told">{told}</T>;
  if (!open) {
    return (
      <Inline gap="sm">
        <Button variant="secondary" onClick={() => setOpen(true)} data-testid="join-cant-make">I can't make this time</Button>
      </Inline>
    );
  }
  const send = async () => {
    setBusy(true);
    setError(null);
    const out = await sendCantMake(note);
    setBusy(false);
    if (out.kind === 'dead') { onLinkDead(); return; }
    if (out.kind === 'told') { setTold(out.message); return; }
    setError(out.message);
  };
  return (
    <Stack gap="sm" data-testid="join-cant-make-form">
      <T size="sm" tone="secondary" wrap>We will tell the recruiter. Your interview keeps its time until they get in touch.</T>
      <FormField label="Note for the recruiter" hint={`Optional, up to ${CANT_MAKE_NOTE_MAX} characters. For example, times that would suit you.`}
        error={tooLong ? `Keep the note under ${CANT_MAKE_NOTE_MAX} characters.` : undefined}>
        {({ labelId: _labelId, ...w }) => <Textarea {...w} minRows={2} autoResize value={note} onChange={(e) => setNote(e.target.value)} data-testid="join-cant-make-note" />}
      </FormField>
      {error && <InlineAlert tone="error">{error}</InlineAlert>}
      <Inline gap="sm">
        <Button variant="primary" disabled={busy || tooLong} onClick={() => { void send(); }} data-testid="join-cant-make-send">Tell the recruiter</Button>
        <Button variant="ghost" disabled={busy} onClick={() => setOpen(false)}>Back</Button>
      </Inline>
    </Stack>
  );
}
