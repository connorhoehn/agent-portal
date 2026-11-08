// "New sprint" — the ManageSprints create path.

import { useEffect, useState } from 'react';
import {
  Button,
  FormField,
  FormRow,
  Inline,
  InlineAlert,
  Input,
  Modal,
  Select,
  Stack,
  Textarea,
} from '@connorhoehn/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { toastError, toastSuccess } from '../../lib/toastStore';
import { SPRINT_STATUSES, validateNewSprint, type NewSprintForm } from './sprintForm';
import { PeopleSelect, usePeopleOptions } from './PeopleSelect';
import { writeJson } from '../../lib/writeJson';
import type { InitiativeOption, Sprint } from './types';

const EMPTY_FORM: NewSprintForm = {
  initiativeId: '', name: '', startsOn: '', endsOn: '', stewardPersonId: '', goal: '', status: 'planned',
};

export function NewSprintModal({ open, onClose, onCreated }: {
  open: boolean; onClose: () => void; onCreated: (created: Sprint) => void;
}) {
  const [form, setForm] = useState<NewSprintForm>(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Every initiative — not only ones that already have a sprint — so a first
  // sprint can be created. Only fetched while the modal is open.
  const { data: initiatives } = useFetch<InitiativeOption[]>(open ? '/api/graph/projects?limit=100' : null);
  // Steward options: the chosen initiative's contributors surfaced first, plus
  // the whole org roster, so a cross-initiative SME who doesn't contribute here
  // is still pickable (RM-5).
  const { groups, isLoading: peopleLoading } = usePeopleOptions(open && form.initiativeId ? form.initiativeId : null);

  useEffect(() => { if (open) { setForm(EMPTY_FORM); setError(null); } }, [open]);

  const set = (patch: Partial<NewSprintForm>) => setForm((f) => ({ ...f, ...patch }));

  async function submit() {
    const check = validateNewSprint(form);
    if (!check.ok) { setError(check.error); return; }
    setBusy(true);
    setError(null);
    const res = await writeJson<{ sprint: Sprint }>('/api/sprints', 'POST', check.value);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      // A 403 is shown inline (above) AND toasted so it isn't missed if the
      // modal is dismissed; other failures stay inline next to the form.
      if (res.status === 403) toastError(null, 'Not permitted', res.error ?? '');
      return;
    }
    toastSuccess(null, 'Sprint created', `${check.value.name} is ready to plan.`);
    // Hand the created row up so the page can drop a filter that would hide it
    // (a new sprint defaults to 'planned', which the active-only list omits).
    if (res.data?.sprint) onCreated(res.data.sprint);
    onClose();
  }

  return (
    <Modal open={open} onClose={onClose} title="New sprint" maxWidth={520}
      footer={
        <Inline gap="sm" justify="end">
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={() => void submit()} disabled={busy}>
            {busy ? 'Creating…' : 'Create sprint'}
          </Button>
        </Inline>
      }
    >
      <Stack gap="md">
        {error ? <InlineAlert tone="error" onDismiss={() => setError(null)}>{error}</InlineAlert> : null}

        <FormField label="Initiative" required>
          {({ id }) => (
            <Select
              id={id}
              value={form.initiativeId}
              onChange={(e) => set({ initiativeId: e.target.value, stewardPersonId: '' })}
              options={[
                { value: '', label: 'Select an initiative…' },
                ...(initiatives ?? []).map((p) => ({ value: p.id, label: p.name })),
              ]}
            />
          )}
        </FormField>

        <FormField label="Name" required>
          {({ id }) => (
            <Input
              id={id}
              value={form.name}
              placeholder="e.g. Sprint 7 — auth hardening"
              onChange={(e) => set({ name: e.target.value })}
            />
          )}
        </FormField>

        <FormRow>
          <FormField label="Starts" required>
            {({ id }) => (
              <Input id={id} type="date" value={form.startsOn}
                onChange={(e) => set({ startsOn: e.target.value })} />
            )}
          </FormField>
          <FormField label="Ends" required>
            {({ id }) => (
              <Input id={id} type="date" value={form.endsOn}
                onChange={(e) => set({ endsOn: e.target.value })} />
            )}
          </FormField>
        </FormRow>

        <FormRow>
          <FormField
            label="Steward"
            hint="The SME accountable — anyone in the org, not only this initiative's contributors"
          >
            {({ id }) => (
              <PeopleSelect
                id={id}
                value={form.stewardPersonId ?? ''}
                onChange={(v) => set({ stewardPersonId: v })}
                groups={groups}
                loading={peopleLoading}
                emptyLabel="Unassigned"
              />
            )}
          </FormField>
          <FormField label="Status">
            {({ id }) => (
              <Select
                id={id}
                value={form.status}
                onChange={(e) => set({ status: e.target.value })}
                options={SPRINT_STATUSES.map((s) => ({ value: s, label: s }))}
              />
            )}
          </FormField>
        </FormRow>

        <FormField label="Goal" hint="Optional — one line on what this sprint is for">
          {({ id }) => (
            <Textarea
              id={id}
              rows={2}
              value={form.goal ?? ''}
              onChange={(e) => set({ goal: e.target.value })}
            />
          )}
        </FormField>
      </Stack>
    </Modal>
  );
}
