// The run detail page's "Report decks" section: the run's existing decks and, for RunPipeline holders, a New
// action that opens the new-deck page for this run (the build from the run's facts, or an example), not a dialog.

import { useNavigate } from 'react-router';
import { IconButton, Tooltip, DocumentAddIcon, T, EmptyState, LoadingState, Button, DetailSection, InlineAlert, Inline, Stack } from '@connorhoehn/ui-components/shared';
import { useFetch } from '../../../hooks/useFetch';
import { useCapabilities } from '../../../lib/capabilities';
import { runDeckPaths, type RunDeckSummary } from './pipelineDecksApi';

export function RunReportDecks({ runId }: { runId: string; runTitle?: string }) {
  const navigate = useNavigate();
  const { can } = useCapabilities();
  const decks = useFetch<RunDeckSummary[]>(runDeckPaths.list(runId));
  const rows = decks.data ?? [];

  return (
    <DetailSection
      title="Report decks" hint={`${rows.length}`} data-testid="pipeline-run-decks"
      {...(can('RunPipeline') ? { actions: <Tooltip content="Run report deck"><IconButton size="sm" aria-label="Run report deck" icon={<DocumentAddIcon />} onClick={() => navigate(runDeckPaths.newPage(runId))} data-testid="run-deck-generate" /></Tooltip> } : {})}
    >
      {decks.error ? <InlineAlert tone="error">Report decks could not be loaded. <Button size="sm" variant="link" onClick={decks.refresh}>Retry</Button></InlineAlert>
        : !decks.data && decks.isLoading ? <LoadingState label="Loading report decks…" />
        : rows.length === 0
        ? <EmptyState align="start" title="No report decks yet" description="Build a report from this run’s recorded results." />
        : <Stack gap="xs">
          {rows.map((d) => (
            <Inline key={d.id} gap="sm" align="center">
              <Button size="sm" variant="link" onClick={() => navigate(runDeckPaths.page(d.id))} data-testid="run-deck-open">{d.title}</Button>
              <T size="xs" tone="secondary">{d.latestRevision?.label ?? 'no version'}</T>
            </Inline>
          ))}
        </Stack>}
    </DetailSection>
  );
}
