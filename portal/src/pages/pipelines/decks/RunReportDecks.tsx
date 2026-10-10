// The run detail page's "Report decks" section: a Generate action for RunPipeline
// holders (with an optional Nova narrative) and the run's existing decks.
// Generation is synchronous; on success it opens the new deck.

import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Button, Checkbox, DetailSection, FormField, InlineAlert, Inline, Input, Modal, Stack, Text } from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../../hooks/useFetch';
import { useCapabilities } from '../../../lib/capabilities';
import { toastError, toastSuccess } from '../../../lib/toastStore';
import { createRunDeck, narrativeNotice, runDeckPaths, type RunDeckSummary } from './pipelineDecksApi';

export function RunReportDecks({ runId, runTitle }: { runId: string; runTitle: string }) {
  const navigate = useNavigate();
  const { can } = useCapabilities();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [narrative, setNarrative] = useState(false);
  const [busy, setBusy] = useState(false);
  const decks = useFetch<RunDeckSummary[]>(runDeckPaths.list(runId));
  const rows = decks.data ?? [];

  async function submit() {
    setBusy(true);
    try {
      const out = await createRunDeck(runId, { ...(title.trim() ? { title: title.trim() } : {}), ...(narrative ? { narrative: true } : {}) });
      const notice = narrativeNotice(out.narrative);
      if (notice) toastSuccess(null, 'Run report built', notice);
      setOpen(false);
      navigate(runDeckPaths.page(out.deckId));
    } catch (err) {
      toastError(null, 'Could not build the run report', (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <DetailSection
      title="Report decks" hint={`${rows.length}`} data-testid="pipeline-run-decks"
      {...(can('RunPipeline') ? { actions: <Button size="sm" variant="secondary" onClick={() => setOpen(true)} data-testid="run-deck-generate">Run report deck</Button> } : {})}
    >
      {rows.length === 0
        ? <Text className="text-sm text-[var(--color-text-muted)]">No report deck for this run yet. Every number in one comes from the run record.</Text>
        : <Stack gap="xs">
          {rows.map((d) => (
            <Inline key={d.id} gap="sm" align="center">
              <Button size="sm" variant="ghost" onClick={() => navigate(runDeckPaths.page(d.id))} data-testid="run-deck-open">{d.title}</Button>
              <Text className="text-xs text-[var(--color-text-muted)]">{d.latestRevision?.label ?? 'no version'}</Text>
            </Inline>
          ))}
        </Stack>}
      <Modal
        open={open} onClose={() => setOpen(false)} title="Run report deck" maxWidth={480}
        footer={(
          <Inline gap="sm" justify="end">
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
            <Button variant="primary" onClick={() => void submit()} disabled={busy} data-testid="run-deck-submit">{busy ? 'Building…' : 'Build deck'}</Button>
          </Inline>
        )}
      >
        <Stack gap="md">
          <FormField label="Title">
            {({ id }) => <Input id={id} value={title} placeholder={`${runTitle} — run report`} onChange={(e) => setTitle(e.target.value)} />}
          </FormField>
          <FormField label="Write a narrative with Nova" layout="inline">
            {({ labelId, id }) => <Checkbox id={id} checked={narrative} onChange={setNarrative} aria-labelledby={labelId} data-testid="run-deck-narrative" />}
          </FormField>
          <InlineAlert tone="info">Counts, durations, cost and status are read from the run record. Nova only writes prose, and only quotes the record.</InlineAlert>
        </Stack>
      </Modal>
    </DetailSection>
  );
}
