// One asset, in the drawer: what it takes, where it came from, and what sits
// next to it.
//
// The three panels answer the three questions the list cannot:
//
//   CONTRACT   — what inputs it takes, and crucially which of them are FENCED.
//                A variable's source is the trust boundary, so it is rendered
//                as a badge rather than buried in a schema view.
//   PROVENANCE — for a distilled asset, the observations it stands on, with
//                their support. A runbook built from nine observations across
//                four sessions is a different claim from one built on three,
//                and the ladder is only trustworthy if that is visible.
//   RELATED    — the top-k neighbours, each carrying WHY it is a neighbour.
//                An unexplained similarity list is not actionable.

import {
  Button, Chip, DetailSection, EmptyState, Inline, LoadingState, MetaLine, ProgressBar, Stack,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { AssetEvals } from './AssetEvals';
import { DistillationProvenance } from './DistillationProvenance';
import { relativeTime } from '../../lib/relativeTime';
import { Link } from 'react-router';
import { T } from './Text';
import {
  KIND_HINT, KIND_LABEL, KIND_TONE, SOURCE_HINT, SOURCE_TONE,
  TIER_HINT, TIER_LABEL, TIER_TONE, evalLabel, isFenced, readinessRows, usageLine,
} from './libraryFormat';
import type { AssetDetail } from './types';

export function AssetDrawer({ id, onOpenAsset }: { id: string; onOpenAsset: (id: string) => void }) {
  const { data, isLoading, error } = useFetch<AssetDetail>(`/api/library/${encodeURIComponent(id)}`, 0);

  if (error) return <EmptyState title="Could not load this asset" description={error} />;
  if (isLoading || !data) return <LoadingState label="Loading…" />;

  const { asset: a, readiness, related } = data;
  const rows = readinessRows(readiness);
  const vars = a.contract?.variables ?? [];
  const fencedCount = vars.filter((v) => isFenced(v.source)).length;

  return (
    <Stack gap="lg">
      <header>
        <Inline gap="xs" wrap>
          <T className="text-[15px] font-semibold text-text-primary">{a.name}</T>
          <Chip tone={KIND_TONE[a.kind]} size="xs" title={KIND_HINT[a.kind]}>{KIND_LABEL[a.kind]}</Chip>
          <Chip tone={TIER_TONE[a.tier]} size="xs" title={TIER_HINT[a.tier]}>{TIER_LABEL[a.tier]}</Chip>
        </Inline>
        <T as="p" className="mt-1.5 mb-0 text-[12.5px] leading-relaxed text-text-secondary">{a.description}</T>
        <MetaLine
          className="mt-1.5"
          items={[`v${a.version}`, a.lifecycleStatus, a.ownerName ?? 'no owner', `updated ${relativeTime(a.updatedAt)}`]}
        />
      </header>

      <DetailSection
        first
        title="Contract"
        hint={vars.length === 0 ? 'takes no input' : fencedCount > 0 ? `${fencedCount} fenced` : undefined}
      >
        {vars.length === 0 ? (
          <T className="text-[12px] text-text-tertiary">
            No variables — the template ships as written.
          </T>
        ) : (
          <Stack gap="none" className="overflow-hidden rounded-md border border-border">
            {vars.map((v) => (
              <Inline key={v.name} gap="xs" wrap={false} className="items-start gap-2.5 border-b border-border px-3 py-2 last:border-b-0">
                <T className="font-mono text-[12px] text-text-primary">{v.name}</T>
                <T className="text-[11px] text-text-tertiary">{v.type}</T>
                {v.required && <Chip tone="neutral" size="xs">required</Chip>}
                <T className="flex-1" />
                <Chip tone={SOURCE_TONE[v.source]} size="xs" title={SOURCE_HINT[v.source]}>
                  {isFenced(v.source) ? `⚠ ${v.source}` : v.source}
                </Chip>
              </Inline>
            ))}
          </Stack>
        )}
        {fencedCount > 0 && (
          <T as="p" className="mt-2 mb-0 text-[11px] leading-relaxed text-text-tertiary">
            Fenced values are wrapped in a labelled block and defanged before they reach the model,
            so they cannot share a channel with the instructions.
          </T>
        )}
        {a.contract?.guardrailId && (
          <T as="div" className="mt-2 text-[11px] text-text-tertiary">Guardrail: {a.contract.guardrailId}</T>
        )}
      </DetailSection>

      {a.derivedFrom && (
        <DetailSection
          title="Distilled from"
          hint={`${a.derivedFrom.supportCount} observations across ${a.derivedFrom.sessionCount} sessions`}
        >
          <Stack gap="xs">
            {a.derivedFrom.top.map((t) => (
              <Stack key={t.id} gap="none" className="rounded-md border border-border px-3 py-2">
                <Inline gap="xs" wrap={false}>
                  <Chip tone="neutral" size="xs">{t.kind}</Chip>
                  <T className="min-w-0 truncate text-[12px] text-text-secondary" title={t.title}>{t.title}</T>
                  <T className="flex-1" />
                  <T className="text-[10px] tabular-nums text-text-tertiary">{Math.round(t.weight * 100)}%</T>
                </Inline>
                {t.repo && <T as="div" className="mt-0.5 font-mono text-[10px] text-text-tertiary">{t.repo}</T>}
              </Stack>
            ))}
          </Stack>
        </DetailSection>
      )}

      <DistillationProvenance libraryItemId={a.id} />

      {/* The gate, as a checklist. A tier is a promise about blast radius, so
          the page shows what that promise costs rather than one verdict. */}
      {rows.length > 0 && (
        <DetailSection
          title="Release readiness"
          hint={readiness.ok ? 'shippable at this tier' : readiness.reason}
        >
          <Stack gap="none" className="overflow-hidden rounded-md border border-border">
            {rows.map((r) => (
              <Inline key={r.label} gap="xs" wrap={false} className="items-center gap-2.5 border-b border-border px-3 py-2 last:border-b-0">
                <T className={r.met ? 'text-success' : 'text-danger'} aria-hidden>
                  {r.met ? '✓' : '✕'}
                </T>
                <T className="text-[12px] text-text-primary">{r.label}</T>
                {r.detail && <T className="text-[11px] text-text-tertiary">{r.detail}</T>}
              </Inline>
            ))}
          </Stack>
          {a.designReviewId && (
            <T as="div" className="mt-2 text-[11px] text-text-tertiary">
              Ratified by{' '}
              <Link to={`/iq/designs/${a.designReviewId}`} className="text-primary no-underline hover:underline">
                {a.designReviewId}
              </Link>
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
            <T as="div" className="mb-1 text-[11px] text-text-tertiary">
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
              <T className="text-[11px] text-text-tertiary">
                Never evaluated — which blocks deploy above the sandbox tier.
              </T>
            )}
          </div>
          <T as="div" className="text-[12px] text-text-secondary">Used by: {usageLine(a)}</T>
          {a.roles.length > 0 && (
            <Inline gap="xs" wrap>
              <T className="text-[11px] text-text-tertiary">For:</T>
              {a.roles.map((r) => <Chip key={r} tone="info" size="xs">{r}</Chip>)}
            </Inline>
          )}
        </Stack>
      </DetailSection>

      {related.length > 0 && (
        <DetailSection title="Related" hint="closest by shared provenance, then tags">
          <Stack gap="xs">
            {related.map((r) => (
              <Button
                key={r.asset.id}
                variant="ghost"
                fullWidth
                onClick={() => onOpenAsset(r.asset.id)}
                className="cursor-pointer items-start rounded-md px-3 py-2 text-left font-normal transition-colors hover:border-primary/50"
              >
                <Stack gap="none" className="min-w-0 w-full">
                  <Inline gap="xs" wrap={false}>
                    <Chip tone={KIND_TONE[r.asset.kind]} size="xs">{KIND_LABEL[r.asset.kind]}</Chip>
                    <T className="min-w-0 truncate text-[12px] font-medium text-text-primary">{r.asset.name}</T>
                  </Inline>
                  {/* The reason is the point: a neighbour you cannot explain is
                      not a neighbour you can act on. */}
                  <T as="div" className="mt-0.5 text-[11px] text-text-tertiary">{r.reason}</T>
                </Stack>
              </Button>
            ))}
          </Stack>
        </DetailSection>
      )}
    </Stack>
  );
}
