// Pure derivations for the KB registry screens. No React, no fetch — every
// function here is a value in, a value out, so the rules that decide what a
// status LOOKS like are readable (and testable) without mounting a page.

import type { ChipTone } from '@connorhoehnslalom/ui-components/shared';
import type { Reconciled } from '../../knowledge/knowledgeFormat';
import type { KbRegistryEntry, KbStatus, KbTenant } from './types';

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

/** The dot colour and chip tone a lifecycle state wears, in one place.
 *  These were previously two separate maps that had drifted: the detail page
 *  had dot colours only and the registry had both, so a status added to one
 *  silently rendered grey on the other. */
const STATUS_STYLE: Record<KbStatus, { dot: string; tone: ChipTone }> = {
  ACTIVE:   { dot: 'var(--color-success)', tone: 'success' },
  CREATING: { dot: 'var(--color-warning)', tone: 'warning' },
  UPDATING: { dot: 'var(--color-warning)', tone: 'warning' },
  PENDING:  { dot: 'var(--color-text-tertiary)', tone: 'neutral' },
  DELETING: { dot: 'var(--color-text-tertiary)', tone: 'neutral' },
  FAILED:   { dot: 'var(--color-danger)', tone: 'danger' },
};

export function statusStyle(status: KbStatus): { dot: string; tone: ChipTone } {
  return STATUS_STYLE[status] ?? STATUS_STYLE.PENDING;
}

/** What the detail header's badge and the pipeline chain's Bedrock KB stage
 *  actually show. The registry row's own `status` column is what the last
 *  provisioning call reported — it says nothing about whether that Bedrock
 *  knowledge base still exists. `reconciled` (the matching row from
 *  `GET /api/admin/kb-registry/reconcile`, keyed by `kb.id`) is the thing
 *  that actually checked, so a KB whose Bedrock id was deleted out from
 *  under it reads "Broken" here even while the registry still says ACTIVE
 *  (DEFECTS.md #18). Anything the reconcile didn't flag falls back to the
 *  registry's own lifecycle status. */
export function effectiveStatus(
  kb: KbRegistryEntry,
  reconciled: Reconciled | null | undefined,
): { label: string; tone: ChipTone } {
  if (reconciled?.drift === 'missing') {
    return { label: 'Broken — Bedrock knowledge base not found', tone: 'danger' };
  }
  if (reconciled?.drift === 'status-drift') {
    return {
      label: `${kb.status} (account reports ${reconciled.liveStatus ?? 'unknown'})`,
      tone: 'warning',
    };
  }
  const s = statusStyle(kb.status);
  return { label: kb.status, tone: s.tone };
}

/** The chain diagram greys a stage that has not been provisioned yet, rather
 *  than painting it with the KB's overall status. */
export function stageDot(status: KbStatus, reached: boolean): string {
  return reached ? statusStyle(status).dot : STATUS_STYLE.PENDING.dot;
}

export function tenantTone(_tenant: KbTenant): ChipTone {
  return 'success';
}

/** Bedrock ingestion-job states. COMPLETE is the only clean terminal state;
 *  FAILED is the only red one; everything else is still in flight. */
export function jobTone(status: string): ChipTone {
  if (status === 'COMPLETE') return 'success';
  if (status === 'FAILED') return 'danger';
  return 'warning';
}

export function syncTone(status: string): ChipTone {
  return status === 'COMPLETE' ? 'success' : 'warning';
}

/** `amazon.titan-embed-text-v2:0` → `titan-embed-text-v2`. The vendor prefix
 *  and revision suffix are the same on every row, so they carry no signal in a
 *  header line — the full id is still on the Configuration tab. */
export function shortModel(model: string): string {
  return model.replace('amazon.', '').replace(':0', '');
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function docCountLabel(count: number | undefined): string {
  return count === undefined ? '—' : count.toLocaleString();
}

/** Which lifecycle states offer which verb. The registry rows and the detail
 *  header disagreed about this before — the row offered Provision on
 *  PENDING/FAILED while the header recomputed the same rule inline. */
export function canProvision(kb: KbRegistryEntry): boolean {
  return kb.status === 'PENDING' || kb.status === 'FAILED';
}

export function canSync(kb: KbRegistryEntry): boolean {
  return kb.status === 'ACTIVE' && !!kb.bedrockKbId && !!kb.dataSourceId;
}

/** Delete is the escape hatch for rows that never came up, so it is offered
 *  wherever the KB is not live. */
export function canDelete(kb: KbRegistryEntry): boolean {
  return kb.status !== 'ACTIVE';
}

/** The rows the Configuration tab prints, in reading order: identity first,
 *  then the AWS handles, then the embedding settings, then timestamps. */
export function configRows(kb: KbRegistryEntry): { label: string; value: string }[] {
  return [
    { label: 'ID', value: kb.id },
    { label: 'Slug', value: kb.slug },
    { label: 'Aurora Table', value: kb.auroraTable },
    { label: 'Bedrock KB ID', value: kb.bedrockKbId ?? '—' },
    { label: 'Data Source ID', value: kb.dataSourceId ?? '—' },
    { label: 'Embedding Model', value: kb.embeddingModel },
    { label: 'Chunking Strategy', value: kb.chunkingStrategy },
    { label: 'Max Tokens', value: String(kb.maxTokens) },
    { label: 'S3 Prefix', value: kb.s3Prefix },
    { label: 'Created At', value: formatDate(kb.createdAt) },
    { label: 'Updated At', value: formatDate(kb.updatedAt) },
  ];
}
