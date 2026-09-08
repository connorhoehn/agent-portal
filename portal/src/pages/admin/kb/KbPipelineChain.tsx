// S3 → data source → Bedrock KB → agents, as one row.
//
// This was ~70 lines of hand-rolled boxes plus an `Arrow()` component that
// rendered the literal string "──▶". StackDiagram is the library's version of
// exactly that shape, so the whole thing is now the four layer specs.
//
// A stage that has not been provisioned yet stays neutral rather than taking
// the KB's overall colour — a green "Bedrock KB: (not provisioned)" is a lie.

import { Card, CardHeader, Stack, StackDiagram } from '@connorhoehnslalom/ui-components/shared';
import type { ChipTone, StackLayerSpec } from '@connorhoehnslalom/ui-components/shared';
import type { Reconciled } from '../../knowledge/knowledgeFormat';
import { statusStyle } from './kbFormat';
import type { KbRegistryEntry } from './types';

const NOT_PROVISIONED = '(not provisioned)';

export function KbPipelineChain({
  kb,
  reconciled,
}: {
  kb: KbRegistryEntry;
  /** The matching row from the reconcile API, when known — see
   *  `kbFormat.effectiveStatus`. A Bedrock id the account does not
   *  recognise draws this stage (and everything downstream of it) in
   *  danger, not the registry's own optimistic status (DEFECTS.md #18). */
  reconciled?: Reconciled | null;
}) {
  const live = statusStyle(kb.status).tone;
  const stage = (reached: boolean): ChipTone => (reached ? live : 'neutral');
  const kbBroken = reconciled?.drift === 'missing';

  const layers: StackLayerSpec[] = [
    { id: 's3', label: 'S3 landing zone', description: kb.s3Prefix, tone: stage(!!kb.s3Prefix) },
    { id: 'ds', label: 'Data source', description: kb.dataSourceId ?? NOT_PROVISIONED, tone: stage(!!kb.dataSourceId) },
    {
      id: 'kb',
      label: 'Bedrock KB',
      description: kbBroken ? `${kb.bedrockKbId} — not found in this account` : (kb.bedrockKbId ?? NOT_PROVISIONED),
      tone: kbBroken ? 'danger' : stage(!!kb.bedrockKbId),
    },
    { id: 'agents', label: 'Agents', description: 'search · advisor', tone: kbBroken ? 'neutral' : stage(kb.status === 'ACTIVE') },
  ];

  return (
    <Card padding="md">
      <Stack gap="md">
        <CardHeader title="Pipeline chain" />
        {/* UPSTREAM BUG (ui-components 2.119.0, StackDiagram.tsx): the wrapper
            around each layer is hardcoded `flex flex-col` no matter the
            orientation, so in `horizontal` mode every arrow renders UNDER its
            box instead of between two boxes. The child override below puts the
            box and its connector back on one line. Delete it once StackDiagram
            picks its layer direction from `orientation`. */}
        <StackDiagram
          layers={layers}
          orientation="horizontal"
          connector="arrow"
          className="overflow-x-auto [&>div]:flex-row [&>div]:items-center"
        />
      </Stack>
    </Card>
  );
}
