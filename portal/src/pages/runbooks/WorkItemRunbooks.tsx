// "Runbooks this run will get": what a dispatch of this work item would give a run, each with the reason it
// was chosen and its drift warning; a pin / unpin control for whoever has the board's write gate; and the
// item's earlier attempts, newest first. Read from GET /api/work-items/:id/brief-preview (the function the
// freeze uses), written with PUT /api/graph/work-items/:id/runbook-pins.
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import {
  Banner, Button, Chip, DetailSection, Inline, InlineAlert, PickerDialog, Stack, StatusPill, T,
} from '@connorhoehn/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { useCapabilities } from '../../lib/capabilities';
import { relativeTime } from '../../lib/relativeTime';
import { writeJson } from '../../lib/writeJson';
import { runbookDisplayTitle } from './runbookTitles';
import { runsListHref } from '../iq/runsModel';
import { HEALTH_LABEL, HEALTH_TONE, runPageHref, runbookHref, scopeLabel } from './runbooksModel';
import { useRunbookNames } from './useRunbookNames';
import type { BriefPreviewResponse, RunbookRow, RunbookScope } from './types';

const OUTCOME_WORDS: Record<string, string> = { done: 'Finished', failed: 'Failed', cancelled: 'Cancelled', 'needs-review': 'Waiting for review' };
const base = (s: string | null | undefined) => (s ?? '').split('/').pop()?.toLowerCase() ?? '';

/** Whether a runbook's scope reaches this item (the pins route asks the same question and refuses the rest). */
export function scopeAdmits(scope: RunbookScope, item: { initiativeId: string | null; repo: string | null; labels: readonly string[] }): boolean {
  if (scope.kind === 'org') return true;
  if (scope.kind === 'initiative') return !!scope.ref && scope.ref === item.initiativeId;
  if (scope.kind === 'repo') return !!scope.ref && !!item.repo && base(scope.ref) === base(item.repo);
  return !!scope.ref && item.labels.some((l) => l.toLowerCase() === scope.ref!.toLowerCase());
}

export function WorkItemRunbooks({ workItemId, preview, onChanged }: { workItemId: string; preview: BriefPreviewResponse; onChanged: () => void }) {
  const { can } = useCapabilities();
  const names = useRunbookNames();
  const canPin = can('DispatchAgentRun');
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const library = useFetch<{ runbooks: RunbookRow[] }>(picking ? '/api/runbooks?status=published&limit=200' : null, 0);
  const { offer, pins, previous_attempts: attempts } = preview;

  const item = useMemo(() => ({ initiativeId: preview.brief.initiative_id, repo: preview.brief.repo, labels: [] as string[] }), [preview.brief.initiative_id, preview.brief.repo]);
  const options = useMemo(() => (library.data?.runbooks ?? [])
    .filter((r) => !pins.includes(r.id) && scopeAdmits(r.scope, item))
    .map((r) => ({ id: r.id, label: runbookDisplayTitle(r.title), description: scopeLabel(r.scope, names) })), [library.data, pins, item, names]);

  const write = async (next: string[]) => {
    setBusy(true); setRefusal(null);
    const res = await writeJson<{ error?: string }>(`/api/graph/work-items/${encodeURIComponent(workItemId)}/runbook-pins`, 'PUT', { runbookIds: next });
    setBusy(false);
    if (!res.ok) { setRefusal(res.error ?? 'The pin was not saved.'); return; }
    onChanged();
  };

  return (
    <Stack gap="lg" className="shrink-0" data-testid="work-item-runbooks">
      <DetailSection as="h2" variant="heading" first title="Runbooks this run will get"
        description="Chosen when the run starts, from this item’s words and labels. At most two are given; a pinned one always goes first."
        data-testid="offered-runbooks">
        <Stack gap="md">
          {offer.runbooks.length === 0 && (
            <T size="sm" tone="secondary" data-testid="offered-none">{`None. ${offer.none_reason ?? 'No published runbook fits this work.'}`}</T>
          )}
          {offer.runbooks.map((r) => (
            <Stack key={r.id} gap="xs" data-testid={`offered-${r.id}`}>
              <Inline gap="sm" align="center" wrap>
                <Link to={runbookHref(r.id)}><T size="sm" weight="semibold">{runbookDisplayTitle(r.title)}</T></Link>
                {r.pinned && <Chip tone="info" size="xs">Pinned</Chip>}
                <StatusPill tone={HEALTH_TONE[r.health]} label={HEALTH_LABEL[r.health]} size="sm" />
                {canPin && r.pinned && (
                  <Button variant="link" size="sm" disabled={busy} onClick={() => { void write(pins.filter((p) => p !== r.id)); }} data-testid={`unpin-${r.id}`}>Unpin</Button>
                )}
              </Inline>
              <T size="xs" tone="secondary" wrap>{r.pinned ? 'pinned' : r.reason}</T>
              {r.warning && <Banner variant="warning" layout="callout" icon title="Recent runs have stumbled on this one" data-testid={`warning-${r.id}`}>{r.warning}</Banner>}
            </Stack>
          ))}
          {canPin && (
            <Inline gap="sm" align="center">
              <Button variant="secondary" size="sm" disabled={busy || pins.length >= 5} onClick={() => setPicking(true)} data-testid="pin-runbook">Pin a runbook</Button>
              {pins.length >= 5 && <T size="xs" tone="tertiary">Five are pinned already.</T>}
            </Inline>
          )}
          {refusal && <InlineAlert tone="error" data-testid="pin-refusal">{refusal}</InlineAlert>}
        </Stack>
      </DetailSection>

      <DetailSection as="h2" variant="heading" title="Previous attempts" hint={`${attempts.length}`} data-testid="previous-attempts">
        {attempts.length === 0 ? <T size="sm" tone="secondary">Nobody has run this item yet.</T> : (
          <Stack gap="md">
            {attempts.map((a) => (
              <Stack key={a.run_ref} gap="xs" data-testid="previous-attempt">
                <Inline gap="sm" align="center" wrap>
                  <T size="sm" weight="semibold">{OUTCOME_WORDS[a.outcome] ?? a.outcome}</T>
                  <T size="xs" tone="tertiary">{relativeTime(a.ended_at)}</T>
                  {a.failure_code && <Chip tone="neutral" size="xs">{a.failure_code.replace(/_/g, ' ')}</Chip>}
                </Inline>
                {a.summary && <T size="xs" tone="secondary" wrap>{a.summary}</T>}
                {a.obstacles.map((o) => <T key={o} size="xs" tone="secondary" wrap>{`In the way: ${o}`}</T>)}
                {a.requested_changes && <T size="xs" tone="secondary" wrap>{`The reviewer asked for: ${a.requested_changes}`}</T>}
                <Link to={runPageHref(a.run_ref)} data-testid="previous-attempt-run">Open this run</Link>
              </Stack>
            ))}
            <Link to={runsListHref({ workItem: workItemId })} data-testid="all-runs-of-item">All runs of this item</Link>
          </Stack>
        )}
      </DetailSection>

      <PickerDialog
        open={picking}
        title="Pin a runbook"
        body="A pinned runbook goes into this item’s next run first, whatever the selector scores it. Only runbooks that apply to this item are offered."
        options={options}
        loading={library.isLoading && !library.data}
        emptyText="No other published runbook applies to this item."
        confirmLabel="Pin"
        onCancel={() => setPicking(false)}
        onPick={(id) => { setPicking(false); void write([...pins, id]); }}
        data-testid="pin-picker"
      />
    </Stack>
  );
}
