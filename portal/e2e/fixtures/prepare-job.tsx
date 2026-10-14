import '../../src/app.css';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DropdownMenu, Stack } from '@connorhoehnslalom/ui-components/shared';
import { ComposerPromptDeck } from '@connorhoehnslalom/ui-components/social/rich-composer';
import { usePrepareJobDeck } from '../../src/pages/project-detail/usePrepareJobDeck';
import { node } from '../../src/pages/project-detail/__tests__/obsFixture';
import type { EstimateProvenance } from '../../src/components/marketplace/EstimateDrawer';
import type { BotRun } from '../../src/pages/bots/BotsPage';

// Prepare job with no form: the real hook (derivation, forecast, envelope,
// dispatch with its confirm flags) feeding the real library deck. Every
// request is answered by the spec's route stubs.
const codebases = [
  { id: 'fixture-first', repoFullName: 'fixture/observability', orgProjectId: 'p-observability' },
  { id: 'fixture-second', repoFullName: 'fixture/alerts', orgProjectId: 'p-observability' },
];

function Fixture() {
  const params = new URLSearchParams(window.location.search);
  const canDispatch = params.get('role') !== 'member';
  const [request, setRequest] = useState<{ itemId: string; revision: number } | null>(null);
  const [dispatched, setDispatched] = useState<BotRun | null>(null);
  const [saved, setSaved] = useState<EstimateProvenance>({});
  const item = { ...node({ id: 'fixture-item', key: 'OBS-14', title: 'Reduce duplicate alerts', storyPoints: 2,
    summary: 'One page per outage', nextStep: 'Confirm the dependency map' }), ...saved,
    ...(dispatched ? { status: 'in_progress' as const } : {}), epicId: 'fixture-epic', epicTitle: 'SLOs and error budgets' };
  const prompts = usePrepareJobDeck({
    item, codebases, linkedRepo: params.get('linked') ?? 'fixture/alerts', orgProjectId: 'p-observability',
    canDispatch, role: canDispatch ? 'sme' : 'member', run: undefined, request,
    onDispatched: (_, run) => setDispatched(run), onEstimateSaved: (_, value) => setSaved(value),
  });
  return <Stack gap="md" className="mx-auto max-w-4xl p-4">
    <DropdownMenu trigger="⋯" triggerLabel="Work item actions" triggerTestId="initiative-header-menu-trigger" sections={[{ items: [{
      label: canDispatch ? 'Prepare job' : 'View job setup', 'data-testid': 'work-item-prepare-job',
      onSelect: () => setRequest(previous => ({ itemId: item.id, revision: (previous?.revision ?? 0) + 1 })),
    }] }]} />
    <ComposerPromptDeck prompts={prompts} data-testid="prepare-job-deck" />
    <output data-testid="dispatched-run" className="sr-only">{JSON.stringify(dispatched)}</output>
  </Stack>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
