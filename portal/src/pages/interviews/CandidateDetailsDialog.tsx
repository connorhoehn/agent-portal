// The recruiter's edit of a candidate's name, email, headline and location (gap audit 2026-11-20 §6), behind the profile's
// "Edit details…". The server checks; its sentence for each field, or for the whole edit, is shown in the dialog.
import { ConfirmDialog, FormField, InlineAlert, Input, Stack, T } from '@connorhoehn/ui-components/shared';
import { useEffect, useState } from 'react';
import { detailsChanged, detailsOf, editCandidate, type CandidateDetails } from '../../lib/interviewsCandidates';

type Candidate = { id: string; name: string; email?: string; headline: string; location: string; version?: string };

export function CandidateDetailsDialog({ candidate, open, onClose, onSaved }: { candidate: Candidate; open: boolean; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState<CandidateDetails>(detailsOf(candidate));
  const [problems, setProblems] = useState<Map<string, string>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setForm(detailsOf(candidate)); setProblems(new Map()); setError(null); setBusy(false); } }, [open, candidate]);
  if (!open) return null;

  const save = async () => {
    if (!candidate.version) { setError('This page is out of date. Reload it and try again.'); return; }
    setBusy(true);
    setError(null);
    const out = await editCandidate(candidate.id, candidate.version, form);
    setBusy(false);
    if (out.ok) { onSaved(); onClose(); return; }
    setProblems(new Map(out.fields.map((f) => [f.path, f.message])));
    setError(out.error);
    if (out.stale) onSaved();
  };

  const field = (key: keyof CandidateDetails, label: string, required: boolean) => (
    <FormField label={label} required={required} error={problems.get(key)}>
      {(w) => <Input {...w} size="sm" value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} data-testid={`interviews-profile-edit-${key}`} />}
    </FormField>
  );

  return (
    <ConfirmDialog open onCancel={onClose} onConfirm={() => { void save(); }} tone="caution" title="Edit the candidate's details"
      confirmLabel="Save details" cancelLabel="Keep as it is" confirmDisabled={busy || !detailsChanged(detailsOf(candidate), form)}>
      <Stack gap="sm" data-testid="interviews-profile-edit-dialog">
        <T size="sm" tone="secondary" wrap>Fix a typo in the name or the address. Interviewers see the name and headline; only you, the hiring manager and the admin see the email.</T>
        {field('name', 'Name', true)}
        {field('email', 'Email', true)}
        {field('headline', 'Current role', false)}
        {field('location', 'Based in', false)}
        {error && <InlineAlert tone="error" data-testid="interviews-profile-edit-error">{error}</InlineAlert>}
      </Stack>
    </ConfirmDialog>
  );
}
