// /iq/decks/new?projectId= — a new initiative deck, as a page (it replaces the Status deck dialog): the
// initiative inline, then "From this initiative's facts" (the status deck build: focus, Nova narrative, budget
// figures for the budgets tier) beside "From an example" (a template, created through the same route with
// `templateId`; such a deck never carries budget figures). Opens the editor on success.

import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { Checkbox, FormField, Input, Select, T } from '@connorhoehn/ui-components/shared';
import { NewDeckPage } from '../../../components/decks/NewDeckPage';
import { useFetch } from '../../../hooks/useFetch';
import { useCapabilities } from '../../../lib/capabilities';
import { toastSuccess } from '../../../lib/toastStore';
import { DECK_FOCUS_MAX, createInitiativeDeck, deckCreateBody, focusDetail, initiativeDeckPaths, narrativeNotice } from './initiativeDecksApi';

interface InitiativeOption { id: string; name: string }

export default function NewInitiativeDeckPage() {
  const [params, setParams] = useSearchParams();
  const projectId = params.get('projectId') ?? '';
  const { can } = useCapabilities();
  const canBuild = can('DispatchAgentRun');
  const canBudget = can('ManageBudgets');
  const [focus, setFocus] = useState('');
  const [narrative, setNarrative] = useState(false);
  const [budget, setBudget] = useState(true);
  const { data } = useFetch<InitiativeOption[] | { projects?: InitiativeOption[] }>('/api/graph/projects?limit=100');
  const initiatives = Array.isArray(data) ? data : data?.projects ?? [];
  const named = initiatives.find((p) => p.id === projectId);
  const name = named?.name ?? 'the initiative';

  const subject = (
    <FormField label="Initiative" hint={projectId ? undefined : 'The deck belongs to one initiative; its people can edit it.'}>
      {({ id }) => <Select id={id} value={projectId} placeholder="Choose an initiative" data-testid="initiative-deck-new-initiative"
        onChange={(e) => setParams((prev) => { const next = new URLSearchParams(prev); next.set('projectId', e.target.value); return next; }, { replace: true })}
        options={[...(projectId && !named ? [{ value: projectId, label: projectId }] : []), ...initiatives.map((p) => ({ value: p.id, label: p.name }))]} />}
    </FormField>
  );

  return (
    <NewDeckPage
      tenant="orgiq" testIdPrefix="initiative-deck" title="New presentation" ready={!!projectId}
      description={projectId ? `A deck for ${name}.` : 'A deck for one initiative.'}
      subject={subject} titlePlaceholder={`${named?.name ?? 'Initiative'} — status`}
      denied={canBuild ? null : 'Your role can read status decks but not build one — an SME or program owner can.'}
      deckHref={initiativeDeckPaths.page}
      createFromTemplate={async (templateId, title) => (await createInitiativeDeck(projectId, { templateId, ...(title ? { title } : {}) })).deckId}
      facts={{
        label: "From this initiative's facts", submitLabel: 'Build deck', busyLabel: 'Building…',
        note: `Counts, points, estimates, sprints and decisions are read from the initiative record. Nova only writes prose, and only quotes the record.${canBudget ? ' A deck with budget figures is visible only to roles that can read budgets and cannot be shared to a channel.' : ' Your role gets a deck without budget figures.'}`,
        create: async (title) => {
          const out = await createInitiativeDeck(projectId, deckCreateBody({ title, narrative, includeBudget: !(canBudget && !budget), focus }));
          const notice = [narrativeNotice(out.narrative), focusDetail(out.brief)].filter(Boolean).join(' ');
          if (notice) toastSuccess(null, 'Status deck built', notice);
          return out.deckId;
        },
        fields: (
          <>
            <FormField label="Focus" hint="Optional. What the deck should cover; it steers the Nova narrative, so a focus turns the narrative on.">
              {({ id }) => <Input id={id} value={focus} maxLength={DECK_FOCUS_MAX} placeholder="e.g. progress this past sprint" onChange={(e) => setFocus(e.target.value)} data-testid="initiative-deck-focus" />}
            </FormField>
            <FormField label="Write a narrative with Nova" layout="inline">
              {({ labelId, id }) => <Checkbox id={id} checked={narrative} onChange={setNarrative} aria-labelledby={labelId} data-testid="initiative-deck-narrative" />}
            </FormField>
            {canBudget && (
              <FormField label="Include budget and maintenance figures" layout="inline">
                {({ labelId, id }) => <Checkbox id={id} checked={budget} onChange={setBudget} aria-labelledby={labelId} data-testid="initiative-deck-budget" />}
              </FormField>
            )}
            {!projectId && <T size="xs" tone="secondary">Choose the initiative first.</T>}
          </>
        ),
      }}
    />
  );
}
