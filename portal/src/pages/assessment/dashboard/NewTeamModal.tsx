// "New team" — the dashboard's ScoreAssessment create path, `POST /teams`
// (routes/assessment.ts). Deterministic id (`TEAM-0NN`) is minted server-side;
// this modal only sends name/cohort/assessment_lead.

import { useEffect, useState } from 'react';
import {
  Button,
  FormField,
  Inline,
  InlineAlert,
  Input,
  Modal,
  Select,
  Stack,
} from '@connorhoehnslalom/ui-components/shared';
import { toastError, toastSuccess } from '../../../lib/toastStore';
import { validateNewTeamForm, type NewTeamFormState } from '../assessmentFormat';
import { MOTIONS, type Cohort } from '../types';

const EMPTY_FORM: NewTeamFormState = { name: '', cohort: '', assessment_lead: '' };

export interface CreatedTeam {
  id: string;
  name: string;
}

export function NewTeamModal({ open, onClose, onCreated }: {
  open: boolean;
  onClose: () => void;
  onCreated: (team: CreatedTeam) => void;
}) {
  const [form, setForm] = useState<NewTeamFormState>(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (open) { setForm(EMPTY_FORM); setError(null); } }, [open]);

  const set = (patch: Partial<NewTeamFormState>) => setForm((f) => ({ ...f, ...patch }));

  async function submit() {
    const check = validateNewTeamForm(form);
    if (!check.ok) { setError(check.error); return; }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/assessment/teams', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(check.value),
      });
      const body = (await res.json().catch(() => ({}))) as { id?: string; name?: string; error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      toastSuccess(null, 'Team created', `${check.value.name} is ready to assess.`);
      if (body.id) onCreated({ id: body.id, name: body.name ?? check.value.name });
      onClose();
    } catch (err) {
      setError((err as Error).message);
      toastError(null, 'Could not create team', (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New team"
      maxWidth={480}
      footer={
        <Inline gap="sm" justify="end">
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={() => void submit()} disabled={busy}>
            {busy ? 'Creating…' : 'Create team'}
          </Button>
        </Inline>
      }
    >
      <Stack gap="md">
        {error ? <InlineAlert tone="error" onDismiss={() => setError(null)}>{error}</InlineAlert> : null}

        <FormField label="Name" required>
          {({ id }) => (
            <Input
              id={id}
              value={form.name}
              placeholder="e.g. Checkout Experience"
              onChange={(e) => set({ name: e.target.value })}
            />
          )}
        </FormField>

        <FormField label="Cohort" required>
          {({ id }) => (
            <Select
              id={id}
              value={form.cohort}
              onChange={(e) => set({ cohort: e.target.value as Cohort })}
              options={[
                { value: '', label: 'Select a cohort…' },
                ...MOTIONS.map((m) => ({ value: m.cohort, label: m.title })),
              ]}
            />
          )}
        </FormField>

        <FormField label="Assessment lead" hint="Optional — can be set later from the scorecard's Actions menu">
          {({ id }) => (
            <Input
              id={id}
              value={form.assessment_lead}
              placeholder="e.g. Dana Ko"
              onChange={(e) => set({ assessment_lead: e.target.value })}
            />
          )}
        </FormField>
      </Stack>
    </Modal>
  );
}
