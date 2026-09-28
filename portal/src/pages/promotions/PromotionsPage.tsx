// The promotions inbox — the curation step between raw lab_experiences
// observations and the library: cluster → pattern → runbook/insight →
// (human + dry run) → skill, with drift able to send a skill back down.
//
// Status rail → candidate list → detail pane. Selection is URL state so
// breadcrumbs, Back and deep links restore the same hierarchy.

import { useMemo, useState } from 'react';
import { Link, useSearchParams, useOutletContext } from 'react-router';
import { ExplorerLayout, ScopeHeader } from '@connorhoehnslalom/ui-components';
import type { DistillationOutletContext } from '../distillation/DistillationModule';
import { promotionReviewHref } from '../distillation/distillationRoutes';
import { AssetRelationships } from '../distillation/AssetRelationships';
import { DetailSection,
  Button,
  Chip,
  ConfirmDialog,
  EmptyState,
  FormField,
  GroupedList,
  SearchInput,
  Select,
  Inline,
  InlineAlert,
  LoadingState,
  Stack,
  StatusPill,
  Textarea,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { useCapabilities } from '../../lib/capabilities';
import { toastError, toastPending, toastSuccess } from '../../lib/toastStore';
import { writeJson } from '../../lib/writeJson';
import {
  KIND_TONE, PROPOSED_LABEL, STATUS_LABEL, STATUS_PILL_STATE,
  allowedActions, filterPromotions, isTerminalStatus, nextStep, readyToPromote, supportLine,
} from './promotionFormat';
import { T } from './Text';
import type { PromotionCandidate } from './types';

const FILTERS: Array<{ value: string; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'candidate', label: 'Candidates' },
  { value: 'approved', label: 'Approved' },
  { value: 'promoted', label: 'Promoted' },
  { value: 'dismissed', label: 'Dismissed' },
];

function ObservationRow({ o }: { o: PromotionCandidate['observations'][number] }) {
  return (
    <Stack gap="xs" id={`observation-${o.id}`} className="border-b border-border py-2 last:border-b-0">
      <Inline gap="xs" wrap={false}>
        <Chip tone="neutral" size="xs">{o.kind}</Chip>
        <T className="min-w-0 truncate text-[12px] font-medium text-text-primary" title={o.title}>{o.title}</T>
      </Inline>
      <T as="div" className="mt-1 text-[11.5px] leading-relaxed text-text-secondary" wrap>{o.body}</T>
      <T as="div" className="mt-1 text-[10.5px] text-text-tertiary">
        {o.repo ?? 'no repo'} · session {o.sessionId}
        {o.initiativeId && <> · <Link to={`/iq/projects/${encodeURIComponent(o.initiativeId)}`} className="text-primary hover:underline">Initiative</Link></>}
        {' · '}<a href={`#observation-${o.id}`} className="text-primary hover:underline">{o.id}</a>
      </T>
    </Stack>
  );
}

function CandidateDrawer({
  candidate, busy, canManage, actionError, onPromote, onDismiss,
}: {
  candidate: PromotionCandidate;
  busy: boolean;
  /** ManageBots — the same gate the server's promote/dismiss routes enforce.
   *  Without this, a member saw live-looking Approve/Dismiss buttons that
   *  always 403'd with no feedback at all (DEFECTS.md #3). */
  canManage: boolean;
  /** Server text from the last failed promote/dismiss on THIS candidate —
   *  e.g. a 409 "already promoted" on a stale retry (DEFECTS.md #1). Cleared
   *  by the page whenever the drawer opens a (possibly different) candidate. */
  actionError: string | null;
  onPromote: (dryRunPassed?: boolean) => void;
  onDismiss: (reason: string) => void;
}) {
  const [confirmingDismiss, setConfirmingDismiss] = useState(false);
  const [reason, setReason] = useState('');
  const isTerminal = isTerminalStatus(candidate.status);
  const actions = allowedActions(candidate);

  return (
    <Stack gap="md">
      <Stack as="header" gap="none">
        <Inline gap="xs" wrap>
          <T className="text-[15px] font-semibold text-text-primary">{candidate.title}</T>
          <Chip tone={KIND_TONE[candidate.proposedKind]} size="xs">{PROPOSED_LABEL[candidate.proposedKind]}</Chip>
          <StatusPill state={STATUS_PILL_STATE[candidate.status]} label={STATUS_LABEL[candidate.status]} size="sm" />
        </Inline>
        <T as="div" className="mt-1.5 mb-0 text-[12.5px] leading-relaxed text-text-secondary" wrap>{candidate.rationale}</T>
        <T as="div" className="mt-1.5 text-[11px] text-text-tertiary">{supportLine(candidate)}</T>
      </Stack>

      {candidate.driftedFrom && (
        <InlineAlert tone="warning">
          Drift detection sent this back from the skill <T className="font-mono">{candidate.driftedFrom}</T> —
          its recorded steps no longer matched observed behavior.
        </InlineAlert>
      )}

      <AssetRelationships kind="promotion" id={candidate.id} />
      <DetailSection first title="Review status">
        <T className="text-[12px] text-text-secondary">
          Approval: {candidate.status === 'approved' || candidate.status === 'promoted' ? 'Recorded' : candidate.status === 'dismissed' ? 'Not available' : 'Not recorded'}
          {' · '}Dry run: {candidate.dryRunPassed === null ? 'Not recorded' : candidate.dryRunPassed ? 'Passed' : 'Failed'}
        </T>
        <T className="text-[12px] text-text-tertiary">Publishing knowledge does not enable execution. Skill activation keeps its separate release requirements.</T>
      </DetailSection>
      <DetailSection title="Contributing observations">
        <Stack gap="xs">
          {candidate.observations.map((o) => <ObservationRow key={o.id} o={o} />)}
        </Stack>
      </DetailSection>

      <DetailSection title="Next step">
        <T as="div" className="m-0 text-[12.5px] font-medium text-text-primary" wrap>{nextStep(candidate)}</T>

        {actionError && (
          <InlineAlert tone="error" className="mt-3">{actionError}</InlineAlert>
        )}

        {!isTerminal && (
          canManage ? (
            <Inline gap="sm" className="mt-3">
              {actions.canApproveWithDryRun && (
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => onPromote(true)}>
                  Approve + record a passing dry run
                </Button>
              )}
              {actions.canApprove && (
                <Button
                  size="sm"
                  variant="primary"
                  disabled={busy}
                  onClick={() => onPromote()}
                  title={!readyToPromote(candidate) && candidate.proposedKind === 'skill' ? 'Records approval — still needs a passing dry run' : undefined}
                >
                  {readyToPromote(candidate) ? 'Promote' : 'Approve'}
                </Button>
              )}
              {actions.canDismiss && (
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => setConfirmingDismiss(true)}>
                  Dismiss
                </Button>
              )}
            </Inline>
          ) : (
            <T as="div" className="mt-3 text-[11px] text-text-tertiary">
              Promoting or dismissing a candidate needs Manage bots.
            </T>
          )
        )}
      </DetailSection>

      <ConfirmDialog
        open={confirmingDismiss}
        onCancel={() => { setConfirmingDismiss(false); setReason(''); }}
        onConfirm={() => { onDismiss(reason.trim()); setConfirmingDismiss(false); setReason(''); }}
        title="Dismiss this candidate?"
        body="It drops out of the inbox. The observations underneath it stay put — a fresh session can still surface the same pattern later."
        confirmLabel="Dismiss"
        confirmDisabled={reason.trim().length === 0}
        tone="destructive"
      >
        <FormField label="Reason" required>
          {(wiring) => (
            <Textarea
              {...wiring}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why this isn't worth promoting…"
              minRows={2}
              autoResize
            />
          )}
        </FormField>
      </ConfirmDialog>
    </Stack>
  );
}

export default function PromotionsPage() {
  const { can, ready } = useCapabilities();
  // ManageBots — the same gate the server's promote/dismiss routes enforce
  // (middleware/src/routes/promotions.ts). Wait for `ready` so the buttons
  // don't flash visible then disappear once the real grant lands.
  const canManage = ready && can('ManageBots');

  const moduleCtx = useOutletContext<DistillationOutletContext | undefined>();
  const [params, setParams] = useSearchParams();
  const filter = FILTERS.some((f) => f.value === params.get('status')) ? params.get('status')! : 'all';
  const repo = params.get('repo');
  const query = params.get('q') ?? '';
  function setFilter(key: string, value: string) {
    const next = new URLSearchParams(params);
    next.set(key, value);
    next.delete('item');
    next.delete('nav');
    setParams(next, { replace: true });
  }
  const openId = params.get('item');
  const setOpenId = (id: string | null) => {
    const next = new URLSearchParams(params);
    next.delete('nav');
    if (id) next.set('item', id); else next.delete('item');
    setParams(next);
  };
  const [busy, setBusy] = useState(false);
  // Last failed promote/dismiss on the OPEN candidate — shown as an
  // InlineAlert in the drawer (DEFECTS.md #1). Reset whenever the drawer
  // opens a (possibly different) candidate so a past failure doesn't bleed
  // into the next one.
  const [actionError, setActionError] = useState<{ id: string; message: string } | null>(null);

  function openCandidate(id: string) {
    setActionError(null);
    setOpenId(id);
  }

  // Fetched unfiltered and narrowed client-side by `filterPromotions` — a
  // pure, tested predicate the Status row can drive directly, rather than a
  // round trip per click that a stale/aborted fetch could silently swallow.
  const { data, isLoading, error, degraded, refresh } = useFetch<{ candidates: PromotionCandidate[] }>('/api/promotions', 30_000);
  const promotionsFailure = error ?? degraded;
  const scoped = useMemo(() => (data?.candidates ?? []).filter((c) => !repo || c.observations.some((o) => o.repo === repo)), [data, repo]);
  const candidates = useMemo(() => filterPromotions(scoped, filter).filter((c) =>
    `${c.title} ${c.rationale}`.toLowerCase().includes(query.trim().toLowerCase())), [scoped, filter, query]);

  const { data: openData, error: openError, refresh: refreshOpen } = useFetch<PromotionCandidate>(
    openId ? `/api/promotions/${encodeURIComponent(openId)}` : null, 0);

  async function promote(id: string, dryRunPassed?: boolean) {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    const tid = toastPending('Promoting', 'recording approval');
    try {
      const res = await writeJson<PromotionCandidate>(`/api/promotions/${encodeURIComponent(id)}/promote`, 'POST', { dryRunPassed });
      if (!res.ok || !res.data) throw new Error(res.error ?? 'unknown error');
      toastSuccess(tid, res.data.status === 'promoted' ? 'Promoted' : 'Approval recorded', nextStep(res.data));
    } catch (err) {
      const message = (err as Error).message;
      toastError(tid, 'Could not promote', message);
      setActionError({ id, message });
    } finally {
      setBusy(false);
      // Re-read regardless of outcome: the mock provider can record a
      // partial state change (e.g. approvedBy) even on a call that ends in
      // an error, so a failed request can still leave the drawer stale.
      refresh();
      refreshOpen();
      moduleCtx?.refreshPromotions();
    }
  }

  async function dismiss(id: string, reason: string) {
    if (busy || !reason) return;
    setBusy(true);
    setActionError(null);
    const tid = toastPending('Dismissing');
    try {
      const res = await writeJson(`/api/promotions/${encodeURIComponent(id)}/dismiss`, 'POST', { reason });
      if (!res.ok) throw new Error(res.error ?? 'unknown error');
      toastSuccess(tid, 'Dismissed');
    } catch (err) {
      const message = (err as Error).message;
      toastError(tid, 'Could not dismiss', message);
      setActionError({ id, message });
    } finally {
      setBusy(false);
      refresh();
      refreshOpen();
      moduleCtx?.refreshPromotions();
    }
  }

  const listParams = new URLSearchParams(params);
  listParams.delete('item');
  const listCrumb = {
    label: 'Asset promotions',
    href: promotionReviewHref(listParams),
    onClick: (event: React.MouseEvent) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
      event.preventDefault();
      setOpenId(null);
    },
  };
  return (
    <ExplorerLayout
      railTitle="Asset promotions" railHeading="caption" railWidth="ms"
      railLabel="Asset promotion candidates" panePadding="none"
      className="min-h-0 min-w-0 flex-1" data-testid="distillation-promotions"
      paneHeader={moduleCtx && <ScopeHeader variant="crumbs"
        breadcrumbs={[...moduleCtx.scope.breadcrumbs, ...(openId ? [listCrumb, { label: openData?.title ?? 'Candidate' }] : [{ label: 'Asset promotions' }])]}
        controls={moduleCtx.scope.controls} link={moduleCtx.scope.link} />}
      railHeader={(
        <Stack gap="sm" className="px-3 pb-2">
          <Select size="sm" aria-label="Promotion status" value={filter}
            options={FILTERS.map((f) => ({ value: f.value, label: `${f.label} (${filterPromotions(scoped, f.value).length})` }))}
            onChange={(e) => setFilter('status', e.target.value)} />
          <SearchInput size="sm" value={query} onChange={(value) => setFilter('q', value)} placeholder="Find a candidate" aria-label="Find a candidate" />
        </Stack>
      )}
      rail={promotionsFailure ? <UnavailableNotice error={promotionsFailure} what="asset promotions" source="Promotion candidates" onRetry={refresh} />
        : isLoading && !data ? <LoadingState label="Loading candidates…" />
        : candidates.length === 0 ? <EmptyState size="sm" title="No candidates in this view" description={filter === 'dismissed' ? 'Dismissed candidates remain here with their observations and reasons.' : 'Candidates appear when observations form a reusable pattern.'} />
        : <GroupedList size="md" currentStyle="bar" groupHeading="label"
            groups={[{ id: 'candidates', title: FILTERS.find((f) => f.value === filter)!.label, count: candidates.length }]}
            rows={candidates.map((c) => ({ id: c.id, groupId: 'candidates', title: c.title,
              subline: `${PROPOSED_LABEL[c.proposedKind]} · ${STATUS_LABEL[c.status]} · ${c.supportCount} observations` }))}
            currentId={openId} onOpenRow={(row) => openCandidate(row.id)} />}
    >
      {openId ? (
        <Stack gap="md" className="mx-auto w-full max-w-3xl p-5">
          {openError ? <UnavailableNotice error={openError} what="this candidate" source="Promotion candidates" onRetry={refreshOpen} />
            : !openData ? <LoadingState label="Loading candidate…" />
            : <CandidateDrawer key={openId} candidate={openData} busy={busy} canManage={canManage} actionError={actionError?.id === openId ? actionError.message : null}
                onPromote={(dryRunPassed) => void promote(openId, dryRunPassed)}
                onDismiss={(reason) => void dismiss(openId, reason)} />}
        </Stack>
      ) : <EmptyState size="sm" title="Review a proposed asset" description="Choose a candidate to inspect its observations, approval and dry-run result." />}
    </ExplorerLayout>
  );
}
