// One asset, in the drawer: what it takes and what sits next to it.
//
// The panels answer the questions the list cannot:
//
//   CONTRACT   — what inputs it takes, and crucially which of them are FENCED.
//                A variable's source is the trust boundary, so it is rendered
//                as a badge rather than buried in a schema view.
//   RELATED    — the top-k neighbours, each carrying WHY it is a neighbour.
//                An unexplained similarity list is not actionable.

import {
  Card, Chip, ChoiceList, ChoiceRow, DetailSection, Inline, InlinePlaceholder, LoadingState, MetaLine, PageHeader, ProgressBar, Stack, T,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { RecordNotFound, UnavailableNotice, isNotFoundError } from '../../components/UnavailableNotice';
import { AssetEvals } from './AssetEvals';
import { relativeTime } from '../../lib/relativeTime';
import { Link } from 'react-router';
import {
  KIND_HINT, KIND_LABEL, KIND_TONE, SOURCE_HINT, SOURCE_TONE,
  LIBRARY_SOURCE, TIER_HINT, TIER_LABEL, TIER_TONE, evalLabel, isFenced, readinessRows, usageLine,
} from './libraryFormat';
import type { AssetDetail } from './types';

/** The design review that ratified the asset, by its title (the id only while the title loads or cannot be read). */
function RatifyingDesign({ id }: { id: string }) {
  const { data } = useFetch<{ title?: string }>(`/api/designs/${encodeURIComponent(id)}`);
  return (
    <Link to={`/iq/designs/${id}`} className="text-primary no-underline hover:underline">
      {data?.title ?? 'its design review'}
    </Link>
  );
}

export function AssetDrawer({ id, onOpenAsset, onBack }: { id: string; onOpenAsset: (id: string) => void; onBack: () => void }) {
  const { data, isLoading, error, refresh } = useFetch<AssetDetail>(`/api/library/${encodeURIComponent(id)}`, 0);

  if (error && isNotFoundError(error)) {
    return <RecordNotFound heading="Asset" size="md" title="Asset not found" body={`No library asset has the id "${id}".`} backLabel="All assets" onBack={onBack} />;
  }
  if (error) return <UnavailableNotice error={error} what="this asset" source={LIBRARY_SOURCE} onRetry={refresh} />;
  if (isLoading || !data) return <LoadingState label="Loading…" />;

  const { asset: a, readiness, related } = data;
  const rows = readinessRows(readiness);
  const vars = a.contract?.variables ?? [];
  const fencedCount = vars.filter((v) => isFenced(v.source)).length;

  return (
    <Stack gap="lg">
      <Stack gap="none">
        {/* The catalog layout's trail band draws the page's one 20px h1; the asset's name is its 14/600 headline. */}
        <PageHeader
          size="sm"
          title={a.name}
          badge={(
            <Inline gap="xs" wrap>
              <Chip tone={KIND_TONE[a.kind]} size="xs" title={KIND_HINT[a.kind]}>{KIND_LABEL[a.kind]}</Chip>
              <Chip tone={TIER_TONE[a.tier]} size="xs" title={TIER_HINT[a.tier]}>{TIER_LABEL[a.tier]}</Chip>
            </Inline>
          )}
          description={a.description}
        />
        <MetaLine
          className="mt-1.5"
          items={[`v${a.version}`, a.lifecycleStatus, a.ownerName ?? 'no owner', `updated ${relativeTime(a.updatedAt)}`]}
        />
      </Stack>

      <DetailSection
        first
        title="Contract"
        hint={vars.length === 0 ? 'takes no input' : fencedCount > 0 ? `${fencedCount} fenced` : undefined}
      >
        {vars.length === 0 ? (
          <InlinePlaceholder>No variables — the template ships as written.</InlinePlaceholder>
        ) : (
          <Card padding="none">
            {vars.map((v) => (
              <Inline key={v.name} gap="xs" wrap={false} className="items-start gap-2.5 border-b border-border px-3 py-2 last:border-b-0">
                <T size="xs" className="font-mono text-text-primary">{v.name}</T>
                <T size="xs" className="text-text-tertiary">{v.type}</T>
                {v.required && <Chip tone="neutral" size="xs">required</Chip>}
                <T className="flex-1" />
                <Chip tone={SOURCE_TONE[v.source]} size="xs" title={SOURCE_HINT[v.source]}>
                  {isFenced(v.source) ? `⚠ ${v.source}` : v.source}
                </Chip>
              </Inline>
            ))}
          </Card>
        )}
        {fencedCount > 0 && (
          <T size="xs" as="p" className="mt-2 mb-0 leading-relaxed text-text-tertiary">
            Fenced values are wrapped in a labelled block and defanged before they reach the model,
            so they cannot share a channel with the instructions.
          </T>
        )}
        {a.contract?.guardrailId && (
          <T size="xs" as="div" className="mt-2 text-text-tertiary">Guardrail: {a.contract.guardrailId}</T>
        )}
      </DetailSection>

      {/* The gate, as a checklist. A tier is a promise about blast radius, so
          the page shows what that promise costs rather than one verdict. */}
      {rows.length > 0 && (
        <DetailSection
          title="Release readiness"
          hint={readiness.ok ? 'shippable at this tier' : readiness.reason}
        >
          <Card padding="none">
            {rows.map((r) => (
              <Inline key={r.label} gap="xs" wrap={false} className="items-center gap-2 border-b border-border px-3 py-2 last:border-b-0">
                {/* A 12px glyph box: px-3 + 12 + gap-2 puts every label on the 32px inset. */}
                <T className={`w-3 shrink-0 text-center ${r.met ? 'text-success' : 'text-danger'}`} aria-hidden>
                  {r.met ? '✓' : '✕'}
                </T>
                <T size="xs" className="text-text-primary">{r.label}</T>
                {r.detail && <T size="xs" className="text-text-tertiary">{r.detail}</T>}
              </Inline>
            ))}
          </Card>
          {a.designReviewId && (
            <T size="xs" as="div" className="mt-2 text-text-tertiary">
              Ratified by&nbsp;
              <RatifyingDesign id={a.designReviewId} />
            </T>
          )}
        </DetailSection>
      )}

      {/* The eval set that produces the pass rate the gate reads. It sits
          directly above Health & usage because "89%" is meaningless until you
          can see which cases produced it. */}
      <DetailSection title="Evals">
        <AssetEvals assetId={a.id} version={a.version} />
      </DetailSection>

      <DetailSection title="Health & usage">
        <Stack gap="sm">
          <div>
            <T size="xs" as="div" className="mb-1 text-text-tertiary">
              Eval pass rate — {evalLabel(a.evalPassRate)}
            </T>
            {a.evalPassRate != null ? (
              <ProgressBar
                value={Math.round(a.evalPassRate * 100)}
                max={100}
                size="sm"
                showRatio={false}
                color={a.evalPassRate < 0.8 ? 'var(--color-danger)' : undefined}
                aria-label="Eval pass rate"
              />
            ) : (
              <InlinePlaceholder>Never evaluated — which blocks deploy above the sandbox tier.</InlinePlaceholder>
            )}
          </div>
          <T size="xs" as="div" className="text-text-secondary">Used by: {usageLine(a)}</T>
          {a.roles.length > 0 && (
            <Inline gap="xs" wrap>
              <T size="xs" className="text-text-tertiary">For:</T>
              {a.roles.map((r) => <Chip key={r} tone="info" size="xs">{r}</Chip>)}
            </Inline>
          )}
        </Stack>
      </DetailSection>

      {related.length > 0 && (
        <DetailSection title="Related" hint="closest by shared tags, then kind">
          {/* ChoiceRow: name + one line (kind and why it is related). This was
              a two-line label in a ghost `Button`, which the one-box-per-size
              button (2.407.14) clips. */}
          <ChoiceList data-testid="asset-related">
            {related.map((r) => (
              <ChoiceRow
                key={r.asset.id}
                title={r.asset.name}
                description={`${KIND_LABEL[r.asset.kind]} · ${r.reason}`}
                onSelect={() => onOpenAsset(r.asset.id)}
                data-testid={`asset-related-${r.asset.id}`}
              />
            ))}
          </ChoiceList>
        </DetailSection>
      )}
    </Stack>
  );
}
