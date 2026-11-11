// The evidence line at the top of the Library: what the last 30 days of run reports say about the loop,
// every figure with the count it comes from (GET /api/runbooks/evidence). Counted at read time from run rows.
import { DetailSection, Stack, T } from '@connorhoehn/ui-components/shared';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { useFetch } from '../../hooks/useFetch';
import { evidenceSentences } from './runbooksModel';
import type { LoopEvidence } from './types';

export function EvidenceLine({ refreshKey = 0 }: { refreshKey?: number }) {
  const feed = useFetch<{ evidence: LoopEvidence }>(`/api/runbooks/evidence?k=${refreshKey}`, 0);
  if (feed.error && !feed.data) return <UnavailableNotice error={feed.error} what="the evidence line" source="Evidence is counted from run reports" onRetry={feed.refresh} />;
  if (!feed.data) return null;
  const lines = evidenceSentences(feed.data.evidence);
  return (
    <DetailSection as="h2" variant="heading" first title="What the runs said" description="Counted from run reports, with the number each figure comes from." data-testid="runbooks-evidence">
      <Stack gap="xs">{lines.map((l) => <T key={l} size="sm" tone="secondary" wrap data-testid="evidence-sentence">{l}</T>)}</Stack>
    </DetailSection>
  );
}
