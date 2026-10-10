import '../../src/app.css';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { DropdownMenu } from '@connorhoehnslalom/ui-components/shared';
import { RunDraft, type RunChoice } from '../../src/pages/project-detail/RunDraft';
import { WorkItemDetail, type DetailTab, type PrepareJobRequest, type WorkItemPatch } from '../../src/pages/project-detail/WorkItemDetail';
import { node } from '../../src/pages/project-detail/__tests__/obsFixture';
import { DEFAULT_DEVBOX_MODEL, DEVBOX_MODELS } from '../../src/lib/devboxModels';
import type { EstimateProvenance } from '../../src/components/marketplace/EstimateDrawer';
import type { WorkItemThread } from '../../src/pages/project-detail/useWorkItemThread';

const codebases = [
  { id: 'fixture-first', repoFullName: 'fixture/observability', orgProjectId: 'p-observability' },
  { id: 'fixture-second', repoFullName: 'fixture/alerts', orgProjectId: 'p-observability' },
];
const forbidden = () => { throw new Error('This fixture cannot change work, message or dispatch.'); };
const thread: WorkItemThread = {
  criteria: [], criteriaLoading: false, criteriaError: null,
  comments: [], commentCount: 0, commentsLoading: false, commentsError: null,
  toggle: forbidden, add: forbidden, edit: forbidden, remove: forbidden, move: forbidden,
  postComment: async () => { forbidden(); return false; }, refreshComments: forbidden,
};

function Fixture() {
  const params = new URLSearchParams(window.location.search);
  const canDispatch = params.get('role') !== 'member';
  const [tab, setTab] = useState<DetailTab>('history');
  const [choice, setChoice] = useState<RunChoice | null>(null);
  const [review, setReview] = useState<RunChoice | null>(null);
  const [prepareJobRequest, setPrepareJobRequest] = useState<PrepareJobRequest | null>(null);
  const [patch, setPatch] = useState<WorkItemPatch | null>(null);
  const [workOverrides, setWorkOverrides] = useState<WorkItemPatch>({});
  const [saved, setSaved] = useState<EstimateProvenance>(() => params.get('estimate') === 'stored'
    ? { estimateModel: DEVBOX_MODELS[1]!.id, estimatedAt: '2026-10-10T12:00:00Z',
        estimateForecast: { basis: 'prior', sampleCount: 0, costUsdP25: 0.5, costUsdP75: 1.5,
          minutesP25: 2, minutesP75: 5, points: 2, scaled: false, confidence: 'prior' } }
    : {});
  const item = { ...node({ id: 'fixture-item', title: 'Reduce duplicate alerts', storyPoints: 2 }),
    ...saved, ...workOverrides, epicId: 'fixture-epic', epicTitle: 'SLOs and error budgets' };
  return <main className="mx-auto max-w-4xl p-4">
    <WorkItemDetail item={item} thread={thread} decisions={{ data: [] }} contributors={[]} runs={[]}
      canEdit={canDispatch} tab={tab} onTabChange={setTab}
      onPatch={fields => { setPatch(fields); setWorkOverrides(previous => ({ ...previous, ...fields })); }} onOpenEpic={forbidden}
      onOpenDecisions={forbidden} onDraftCriteria={forbidden} onAddContext={forbidden}
      onAddNote={forbidden} onOpenDiscussion={forbidden}
      prepareJobRequest={prepareJobRequest} headActions={<DropdownMenu trigger="⋯" triggerLabel="Work item actions"
        triggerTestId="initiative-header-menu-trigger" sections={[{ items: [{
          label: canDispatch ? 'Prepare job' : 'View job setup', 'data-testid': 'work-item-prepare-job',
          onSelect: () => setPrepareJobRequest(previous => ({ itemId: item.id, revision: (previous?.revision ?? 0) + 1 })),
        }] }]} />}
      runSetup={{ hint: 'Choose a codebase and review the forecast', body: <RunDraft
        item={item} codebases={codebases} run={undefined} canDispatch={canDispatch}
        showGrantCue={params.get('grant') === 'missing'} onChoiceChange={setChoice}
        onEstimateSaved={(_, value) => setSaved(value)} onAuthorize={setReview} /> }} />
    <output data-testid="prepared-choice" className="sr-only">{JSON.stringify(choice)}</output>
    <output data-testid="review-choice" className="sr-only">{JSON.stringify(review)}</output>
    <output data-testid="work-patch" className="sr-only">{JSON.stringify(patch)}</output>
    <output data-testid="default-model" className="sr-only">{DEFAULT_DEVBOX_MODEL}</output>
  </main>;
}
createRoot(document.getElementById('root')!).render(<MemoryRouter><Fixture /></MemoryRouter>);
