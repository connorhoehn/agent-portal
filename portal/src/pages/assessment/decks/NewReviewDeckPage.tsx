// /assessment/decks/new?teamId= — a new review deck, as a page (it replaces the Create review deck dialog): the
// team and the audience inline, then "From this assessment's facts" (the build run: a subset of the rubric
// dimensions) beside "From an example" (a template through the same route with `templateId`). Opens the deck page,
// which follows a build run.

import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { Checkbox, FormField, Inline, Input, Select, Stack, T } from '@connorhoehn/ui-components/shared';
import { NewDeckPage } from '../../../components/decks/NewDeckPage';
import { useFetch } from '../../../hooks/useFetch';
import { useCapabilities } from '../../../lib/capabilities';
import type { TeamDetailResponse, TeamSummary } from '../types';
import { createDeck } from './decksApi';

export default function NewReviewDeckPage() {
  const [params, setParams] = useSearchParams();
  const teamId = params.get('teamId') ?? '';
  const { can } = useCapabilities();
  const [audience, setAudience] = useState('');
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const { data: teams } = useFetch<TeamSummary[]>('/api/assessment/teams');
  const { data: team } = useFetch<TeamDetailResponse>(teamId ? `/api/assessment/teams/${encodeURIComponent(teamId)}` : null);
  const dimensions = team?.dimensions ?? [];
  const teamName = teams?.find((t) => t.id === teamId)?.name ?? teamId;
  const toggle = (id: string, on: boolean) => setPicked((prev) => { const next = new Set(prev); if (on) next.add(id); else next.delete(id); return next; });
  const audienceArg = audience.trim() ? { audience: audience.trim() } : {};

  const subject = (
    <Inline gap="md" align="end" wrap>
      <FormField label="Team">
        {({ id }) => <Select id={id} value={teamId} placeholder="Choose a team" data-testid="assessment-deck-new-team"
          onChange={(e) => { setPicked(new Set()); setParams((prev) => { const next = new URLSearchParams(prev); next.set('teamId', e.target.value); return next; }, { replace: true }); }}
          options={[...(teamId && !teams?.some((t) => t.id === teamId) ? [{ value: teamId, label: teamId }] : []), ...(teams ?? []).map((t) => ({ value: t.id, label: t.name }))]} />}
      </FormField>
      <FormField label="Audience" hint="Optional. Who the review is for.">
        {({ id }) => <Input id={id} value={audience} maxLength={120} placeholder="e.g. the team's leadership" onChange={(e) => setAudience(e.target.value)} data-testid="assessment-deck-new-audience" />}
      </FormField>
    </Inline>
  );

  return (
    <NewDeckPage
      tenant="assessment" testIdPrefix="assessment-deck" title="New review deck" ready={!!teamId}
      description={teamId ? `A PowerPoint review of ${teamName}'s assessment.` : 'A PowerPoint review of one team’s assessment.'}
      subject={subject} titlePlaceholder={`${teamName || 'Team'} assessment review`}
      denied={can('RunAssessmentAgent') ? null : 'Your role can read review decks but not build one — an assessor can.'}
      deckHref={(id) => `/assessment/decks/${encodeURIComponent(id)}`}
      createFromTemplate={async (templateId, title) => (await createDeck(teamId, { templateId, ...(title ? { title } : {}) })).deckId}
      facts={{
        label: "From this assessment's facts", submitLabel: 'Create deck', busyLabel: 'Starting…',
        note: 'Scores, evidence and findings are read from the assessment; the build runs in the background and the deck page follows it.',
        create: async (title) => (await createDeck(teamId, { ...(title ? { title } : {}), ...(picked.size > 0 ? { dimensionIds: [...picked] } : {}), ...audienceArg })).deckId,
        fields: (
          <Stack gap="xs">
            <T size="sm" weight="medium">Dimensions</T>
            <T size="xs" tone="secondary">{!teamId ? 'Choose the team first.' : picked.size === 0 ? 'None selected: every assessed dimension gets a slide.' : `${picked.size} selected.`}</T>
            {dimensions.map((d) => (
              <FormField key={d.id} label={`${d.id}. ${d.title}`} layout="inline">
                {({ labelId, id }) => <Checkbox id={id} checked={picked.has(d.id)} onChange={(on) => toggle(d.id, on)} aria-labelledby={labelId} />}
              </FormField>
            ))}
          </Stack>
        ),
      }}
    />
  );
}
