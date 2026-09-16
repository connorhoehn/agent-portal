// Shared row/page pieces for the harness detail views — was copy-pasted as
// local `PassChip`/`SchemaChip`/`ErrorBlock` functions in both RunDetailPage
// and CompareRunsPage.

import type { ReactNode } from 'react';
import { Link } from 'react-router';
import {
  Card, Chip, Inline, InlineAlert, PageSection,
} from '@connorhoehnslalom/ui-components/shared';
import { T } from '../Text';

/**
 * `labeled` preserves RunDetailPage's "✓ pass"/"✗ fail" text — CompareRunsPage
 * wants the bare icon in its dense side-by-side columns, which is the default.
 */
export function PassChip({ passed, labeled = false }: { passed: boolean | null; labeled?: boolean }) {
  if (passed === null) return <Chip tone="warning" size="xs">—</Chip>;
  if (passed) return <Chip tone="success" size="xs">{labeled ? '✓ pass' : '✓'}</Chip>;
  return <Chip tone="danger" size="xs">{labeled ? '✗ fail' : '✗'}</Chip>;
}

export function SchemaChip({ valid }: { valid: boolean | null }) {
  if (valid === null) return <Chip tone="warning" size="xs">—</Chip>;
  return valid ? (
    <Chip tone="success" size="xs">✓</Chip>
  ) : (
    <Chip tone="danger" size="xs">✗</Chip>
  );
}

/**
 * Full-page "could not load" body for a harness detail route. `context` is
 * the per-page run-id header line — RunDetailPage's single `runId` and
 * CompareRunsPage's `runIdA`/`runIdB` pair render differently enough (one
 * label vs two, dash fallback vs none) that callers build it themselves
 * rather than this component guessing a shape that fits both.
 */
export function ErrorBlock({
  title,
  detail,
  context,
}: {
  title: string;
  detail: string;
  context?: ReactNode;
}) {
  return (
    <PageSection
      title={title}
      actions={
        <Link
          to="/admin/observability/harness"
          className="text-[12px] text-primary no-underline px-2 py-0.5 rounded hover:underline"
        >
          ← Back to harness
        </Link>
      }
    >
      <Card padding="md">
        {context}
        <InlineAlert tone="error" className="mt-2">{detail}</InlineAlert>
      </Card>
    </PageSection>
  );
}

/** RunDetailPage's run-id header line, kept here so it sits beside the block it feeds. */
export function RunIdLine({ runId }: { runId?: string }) {
  if (!runId) return null;
  return (
    <Inline gap="sm" align="center" className="text-[12px] text-text-secondary">
      <T>run id:</T> <T className="font-mono text-[11.5px]">{runId}</T>
    </Inline>
  );
}

/** CompareRunsPage's run-id-pair header line. */
export function RunIdPairLine({ runIdA, runIdB }: { runIdA?: string; runIdB?: string }) {
  if (!runIdA && !runIdB) return null;
  return (
    <Inline gap="sm" wrap className="text-[12px] text-text-secondary">
      <T>runIdA:</T> <T className="font-mono text-[11.5px]">{runIdA ?? '—'}</T>
      <T className="text-text-tertiary">·</T>
      <T>runIdB:</T> <T className="font-mono text-[11.5px]">{runIdB ?? '—'}</T>
    </Inline>
  );
}
