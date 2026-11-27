// /pipelines/decks/new?runId= — a new run report deck, as a page (it replaces the Run report deck dialog): the run
// inline, then "From this run's facts" (the run report build, with an optional Nova narrative) beside "From an
// example" (a template through the same route with `templateId`). Opens the editor on success.

import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { Checkbox, FormField, Select } from '@connorhoehn/ui-components/shared';
import { NewDeckPage } from '../../../components/decks/NewDeckPage';
import { useFetch } from '../../../hooks/useFetch';
import { useCapabilities } from '../../../lib/capabilities';
import { toastSuccess } from '../../../lib/toastStore';
import { createRunDeck, narrativeNotice, runDeckPaths } from './pipelineDecksApi';

interface RunOption { id: string; title?: string; definitionId?: string; context?: { title?: string } }
export const runLabel = (r: RunOption): string => r.context?.title || r.title || r.definitionId || r.id;

export default function NewRunDeckPage() {
  const [params, setParams] = useSearchParams();
  const runId = params.get('runId') ?? '';
  const { can } = useCapabilities();
  const [narrative, setNarrative] = useState(false);
  const { data } = useFetch<{ runs?: RunOption[] }>('/api/pipelines/runs');
  const runs = data?.runs ?? [];
  const run = runs.find((r) => r.id === runId);
  const name = run ? runLabel(run) : runId;

  const subject = (
    <FormField label="Run">
      {({ id }) => <Select id={id} value={runId} placeholder="Choose a run" data-testid="run-deck-new-run"
        onChange={(e) => setParams((prev) => { const next = new URLSearchParams(prev); next.set('runId', e.target.value); return next; }, { replace: true })}
        options={[...(runId && !run ? [{ value: runId, label: runId }] : []), ...runs.map((r) => ({ value: r.id, label: runLabel(r) }))]} />}
    </FormField>
  );

  return (
    <NewDeckPage
      tenant="pipelines" testIdPrefix="run-deck" title="New run report" ready={!!runId}
      description={runId ? `A report deck for ${name}.` : 'A report deck for one pipeline run.'}
      subject={subject} titlePlaceholder={`${name || 'Run'} — run report`}
      denied={can('RunPipeline') ? null : 'Your role can read run reports but not build one.'}
      deckHref={runDeckPaths.page}
      createFromTemplate={async (templateId, title) => (await createRunDeck(runId, { templateId, ...(title ? { title } : {}) })).deckId}
      facts={{
        label: "From this run's facts", submitLabel: 'Build deck', busyLabel: 'Building…',
        note: 'Counts, durations, cost and status are read from the run record. Nova only writes prose, and only quotes the record.',
        create: async (title) => {
          const out = await createRunDeck(runId, { ...(title ? { title } : {}), ...(narrative ? { narrative: true } : {}) });
          const notice = narrativeNotice(out.narrative);
          if (notice) toastSuccess(null, 'Run report built', notice);
          return out.deckId;
        },
        fields: (
          <FormField label="Write a narrative with Nova" layout="inline">
            {({ labelId, id }) => <Checkbox id={id} checked={narrative} onChange={setNarrative} aria-labelledby={labelId} data-testid="run-deck-narrative" />}
          </FormField>
        ),
      }}
    />
  );
}
