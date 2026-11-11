// What the run that wrote a proposal said, beside the runbook: what got in its way and the one sentence it
// learned (GET /api/runs/:ref/report). A run with no stored report says so rather than showing nothing.
import { Link } from 'react-router';
import { Stack, T } from '@connorhoehn/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { runPageHref } from './runbooksModel';
import type { RunReportLite } from './types';

export function RunSaid({ runRef, runName }: { runRef: string; runName: string }) {
  const feed = useFetch<{ report: RunReportLite }>(`/api/runs/${encodeURIComponent(runRef)}/report`, 0);
  if (!feed.data && !feed.error) return <T size="sm" tone="secondary">Reading the run’s report…</T>;
  const r = feed.data?.report;
  if (!r) return <T size="sm" tone="secondary" wrap data-testid="run-said-none">This run has no stored report to read beside the runbook.</T>;
  return (
    <Stack gap="md" data-testid="run-said">
      <Link to={runPageHref(runRef)}><T size="sm" weight="semibold">{runName}</T></Link>
      {r.learned && <T size="sm" wrap data-testid="run-said-learned">{`What it learned: ${r.learned}`}</T>}
      {r.obstacles.length > 0 ? (
        <Stack gap="xs" data-testid="run-said-obstacles">
          <T size="xs" tone="tertiary">What got in its way</T>
          {r.obstacles.map((o) => <T key={o} size="sm" tone="secondary" wrap>{o}</T>)}
        </Stack>
      ) : <T size="sm" tone="secondary">The run reported nothing in its way.</T>}
    </Stack>
  );
}
