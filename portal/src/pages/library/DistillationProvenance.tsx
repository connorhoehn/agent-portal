// "Distilled from" — the Library side of the distillation ladder's
// provenance link. Every L2 artifact with a `libraryItemId` names a real
// Library asset; this is that asset looking back at the artifact (and its
// lineage) that produced it. Distinct from the older `derivedFrom` summary
// above (raw observations/patterns attached directly to any asset) — this
// one is specifically "you were published FROM this distillation artifact,"
// which only some assets have.
//
// GET /api/distillation/library/:libraryItemId/provenance 404s for an asset
// that was never distilled — that's the common case, not an error, so no
// section renders at all rather than an EmptyState nobody asked for.
import { Chip, DetailSection, Inline, Stack } from '@connorhoehnslalom/ui-components/shared';
import { Link } from 'react-router';
import { useFetch } from '../../hooks/useFetch';
import {
  ARTIFACT_STATUS_LABEL, ARTIFACT_STATUS_TONE, ARTIFACT_TYPE_LABEL, ARTIFACT_TYPE_TONE,
} from '../distillation/distillationFormat';
import { T } from '../distillation/Text';
import type { ProvenanceResponse } from '../distillation/types';

export function DistillationProvenance({ libraryItemId }: { libraryItemId: string }) {
  const { data, error } = useFetch<ProvenanceResponse>(
    `/api/distillation/library/${encodeURIComponent(libraryItemId)}/provenance`,
    0,
  );

  // A 404 ("never distilled") and any other transient error both render
  // nothing — this is a supplementary section, not load-bearing content, and
  // guarding on shape (does `artifact` exist) rather than presence keeps a
  // missing/renamed field from crashing the drawer.
  if (error || !data?.artifact) return null;
  const { artifact: a } = data;

  return (
    <DetailSection title="Distilled from" hint="via the distillation ladder">
      <Stack gap="xs">
        <Inline gap="xs" wrap align="center">
          <Chip tone={ARTIFACT_TYPE_TONE[a.type]} size="xs">{ARTIFACT_TYPE_LABEL[a.type]}</Chip>
          <Chip tone={ARTIFACT_STATUS_TONE[a.status]} size="xs" dot="static">{ARTIFACT_STATUS_LABEL[a.status]}</Chip>
          <T className="min-w-0 truncate text-[12px] font-medium text-text-primary" title={a.title}>{a.title}</T>
        </Inline>
        <T className="text-[11.5px] text-text-tertiary">
          {a.cluster_ids.length} cluster{a.cluster_ids.length === 1 ? '' : 's'} · {data.lineage.nodes.length} lineage node{data.lineage.nodes.length === 1 ? '' : 's'}
        </T>
        <Link
          to={`/iq/distillation/lineage?focus=${encodeURIComponent(a.id)}`}
          className="text-primary no-underline hover:underline text-[12px]"
        >
          Open lineage →
        </Link>
      </Stack>
    </DetailSection>
  );
}
