// An opening's details (docs/interviews-tenant-plan.md row I1.3): title, level, team, where, who decides,
// its state and the spend cap per interview. Controlled; the server's problems arrive by field name.
// Shared by the opening's editor and New opening.

import { FormField, Inline, Input, NumberInput, Select, Stack } from '@connorhoehn/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { INTERVIEWS_API, type ItemsResponse, type PersonRef } from '../../lib/interviews';
import { OPENING_STATE_LABELS, type OpeningDetails, type OpeningState } from '../../lib/interviewsKit';

const NOT_NAMED = '';

export function OpeningDetailsForm({ details, onChange, problems }: {
  details: OpeningDetails;
  onChange: (d: OpeningDetails) => void;
  problems: ReadonlyMap<string, string>;
}) {
  const managers = useFetch<ItemsResponse<PersonRef>>(`${INTERVIEWS_API}/hiring-managers`);
  const set = (patch: Partial<OpeningDetails>) => onChange({ ...details, ...patch });
  const text = (key: 'title' | 'level' | 'team' | 'location', label: string, hint?: string) => (
    <FormField label={label} required hint={hint} error={problems.get(key)} className="min-w-[16rem] flex-1">
      {(w) => <Input {...w} size="sm" value={details[key]} onChange={(e) => set({ [key]: e.target.value })} data-testid={`interviews-opening-${key}`} />}
    </FormField>
  );
  return (
    <Stack gap="md" className="max-w-[56rem] pb-6" data-testid="interviews-opening-details-form">
      <Inline gap="sm" align="start">
        {text('title', 'Title')}
        {text('level', 'Level', 'For example Senior or Manager.')}
      </Inline>
      <Inline gap="sm" align="start">
        {text('team', 'Team')}
        {text('location', 'Where they will work')}
      </Inline>
      <Inline gap="sm" align="start">
        <FormField label="Hiring manager" error={problems.get('hiringManagerId')} hint="They decide each candidate's stage and see this opening's rounds." className="min-w-[16rem] flex-1">
          {(w) => <Select {...w} size="sm" value={details.hiringManagerId ?? NOT_NAMED} data-testid="interviews-opening-hiring-manager"
            options={[{ value: NOT_NAMED, label: 'Not named yet' }, ...(managers.data?.items ?? []).map((p) => ({ value: p.id, label: p.name }))]}
            onChange={(e) => set({ hiringManagerId: e.target.value || null })} />}
        </FormField>
        <FormField label="State" error={problems.get('state')} className="min-w-[10rem]">
          {(w) => <Select {...w} size="sm" value={details.state}
            options={(Object.keys(OPENING_STATE_LABELS) as OpeningState[]).map((s) => ({ value: s, label: OPENING_STATE_LABELS[s] }))}
            onChange={(e) => set({ state: e.target.value as OpeningState })} />}
        </FormField>
        <FormField label="Spend cap per interview" error={problems.get('budgetCapUsd')} hint="In US dollars. Leave empty for no cap." className="min-w-[12rem]">
          {(w) => <NumberInput id={w.id} size="sm" value={details.budgetCapUsd ?? undefined} min={0} max={1000} step={1} unit="$"
            onChange={(v) => set({ budgetCapUsd: v })} onClear={() => set({ budgetCapUsd: null })} />}
        </FormField>
      </Inline>
    </Stack>
  );
}
