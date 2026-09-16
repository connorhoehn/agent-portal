// Distillation → Lineage → the artifact picker's row card. Slice 4
// (docs/distillation-concept-audit-2026-09-16.md §3/§4): the picker used to
// be a flat list of Chips over a title; this is the "enterprise asset row
// card" the audit asked for — a Card that states who owns this artifact,
// what it is allowed to be seen by, what it became in the Library, whether
// anyone has actually used it, and how confident the fleet is in it, with a
// quick-action row backed by routes that exist (Open in Library, Trace
// lineage, Publish, Request review). "Pin to Enterprise doc" and "Export" are
// deliberately absent — the audit found no destination for either, and a
// button with nowhere to go is worse than no button.
import { Link, useNavigate } from 'react-router';
import {
  Button, Card, CardHeader, Chip, DotMeter, Inline, MetaLine, Stack, StatusPill,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import {
  ARTIFACT_CLASSIFICATION_LABEL, ARTIFACT_CLASSIFICATION_TONE, ARTIFACT_STATUS_PILL_STATE, lastUsedLabel,
} from './ArtifactDrawer';
import { T } from './Text';
import { ARTIFACT_TYPE_LABEL, ARTIFACT_TYPE_TONE, artifactFactCount, evidenceLabel } from './distillationFormat';
import type { Artifact } from './types';

/** What this artifact became, resolved from the Library rather than shown as
 *  a bare id — same reasoning as ArtifactDrawer's `PublishedAs`. A second,
 *  per-card fetch (bounded: only artifacts that are actually linked fire it,
 *  and `useFetch` is per-URL, so N cards on the same asset share one call). */
function CollateralLine({ libraryItemId }: { libraryItemId: string | null }) {
  const { data } = useFetch<{ asset: { name: string; kind: string } }>(
    libraryItemId ? `/api/library/${encodeURIComponent(libraryItemId)}` : null, 0,
  );
  if (!libraryItemId) return <T className="text-[11px] text-text-tertiary">not published</T>;
  if (!data?.asset) return <T className="text-[11px] text-text-tertiary">published…</T>;
  return (
    <Inline gap="xs" align="center" wrap={false}>
      <T className="text-[11px] text-text-tertiary">{data.asset.kind}</T>
      <Link
        to={`/iq/library/${encodeURIComponent(libraryItemId)}`}
        className="text-[11px] text-primary no-underline hover:underline"
        onClick={(e) => e.stopPropagation()}
      >
        {data.asset.name}
      </Link>
    </Inline>
  );
}

export interface ArtifactAssetCardProps {
  artifact: Artifact;
  /** Already has a pending sample in the review queue — disables "Request
   *  review" with an honest reason rather than a silent 409 on click. */
  pendingReview: boolean;
  /** Which quick action is in flight on THIS card, if any — disables both
   *  write actions while either is running so a double-click cannot fire the
   *  route twice. */
  busy: 'publish' | 'review' | null;
  onOpen: (id: string) => void;
  onTraceLineage: (id: string) => void;
  onPublish: (id: string) => void;
  onRequestReview: (id: string) => void;
}

export function ArtifactAssetCard({
  artifact: a, pendingReview, busy, onOpen, onTraceLineage, onPublish, onRequestReview,
}: ArtifactAssetCardProps) {
  const navigate = useNavigate();
  const writeBusy = busy !== null;
  return (
    <Card padding="sm" data-testid="artifact-asset-card">
      <CardHeader
        title={a.title}
        meta={(
          <Inline gap="xs" align="center" wrap={false}>
            <Chip tone={ARTIFACT_TYPE_TONE[a.type]} size="xs">{ARTIFACT_TYPE_LABEL[a.type]}</Chip>
            <Chip tone={ARTIFACT_CLASSIFICATION_TONE[a.classification]} size="xs">
              {ARTIFACT_CLASSIFICATION_LABEL[a.classification]}
            </Chip>
            <StatusPill size="sm" state={ARTIFACT_STATUS_PILL_STATE[a.status]} label={a.status} />
          </Inline>
        )}
        action={(
          <Button size="sm" variant="ghost" onClick={() => onOpen(a.id)}>
            Details →
          </Button>
        )}
      />
      <T className="mt-1 block text-[12px] text-text-secondary">{a.summary}</T>
      <Stack gap="xs" className="mt-2">
        <MetaLine
          size="xs"
          items={[
            `owner ${a.owner}`,
            <CollateralLine key="collateral" libraryItemId={a.library_item_id} />,
            lastUsedLabel(a.last_used_at),
            evidenceLabel(artifactFactCount(a)),
            pendingReview ? 'review pending' : a.reviewed_by ? `reviewed by ${a.reviewed_by}` : 'not reviewed',
          ]}
        />
        <DotMeter label="confidence" value={a.confidence} segments={10} tone="surface" />
      </Stack>
      <Inline gap="xs" className="mt-3" wrap>
        {a.library_item_id && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => navigate(`/iq/library/${encodeURIComponent(a.library_item_id!)}`)}
          >
            Open in Library
          </Button>
        )}
        <Button size="sm" variant="secondary" onClick={() => onTraceLineage(a.id)}>
          Trace lineage
        </Button>
        {a.status === 'draft' && (
          <Button size="sm" variant="secondary" disabled={writeBusy} onClick={() => onPublish(a.id)}>
            {busy === 'publish' ? 'Publishing…' : 'Publish'}
          </Button>
        )}
        <Button
          size="sm"
          variant="secondary"
          disabled={writeBusy || pendingReview}
          title={pendingReview ? 'Already has a pending review sample' : undefined}
          onClick={() => onRequestReview(a.id)}
        >
          {busy === 'review' ? 'Requesting…' : pendingReview ? 'Review pending' : 'Request review'}
        </Button>
      </Inline>
    </Card>
  );
}
