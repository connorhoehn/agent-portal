// The promotions inbox — the curation step between raw lab_experiences
// observations and the library: cluster → pattern → runbook/insight →
// (human + dry run) → skill, with drift able to send a skill back down.
//
// Status rail → candidate list → detail pane. Selection is URL state so
// breadcrumbs, Back and deep links restore the same hierarchy.

import { useMemo, useState } from 'react';
import { Link, useSearchParams, useOutletContext } from 'react-router';
import { WorkListFilters, type WorkListFilterFacet, ListRailLayout } from '@connorhoehnslalom/ui-components';
import type { DistillationOutletContext } from '../distillation/DistillationModule';
import { promotionReviewHref } from '../distillation/distillationRoutes';
import { AssetRelationships } from '../distillation/AssetRelationships';
import { DetailSection,
  Button,
  PageHeader,
  Chip,
  ConfirmDialog,
  EmptyState,
  FilterPopover,
  FormField,
  GroupedList,
  SearchInput,
  Inline,
  InlineAlert,
  Link as TextLink,
  LoadingState,
  Stack,
  StatusPill,
  Textarea, T,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { CollectionCommandHost } from '../../components/collections/CollectionCommandHost';
import { promotionsCommandAdapter } from '../distillation/distillationCollectionCommands';
import { SectionHeader } from '../../components/shell/SectionContent';
import { RecordNotFound, UnavailableNotice, isNotFoundError } from '../../components/UnavailableNotice';
import { useUrlDraft } from '../distillation/useUrlDraft';
import { useCapabilities } from '../../lib/capabilities';
import { toastError, toastPending, toastSuccess } from '../../lib/toastStore';
import { writeJson } from '../../lib/writeJson';
import {
  KIND_TONE, PROPOSED_LABEL, STATUS_LABEL, STATUS_PILL_STATE,
  allowedActions, filterPromotions, isTerminalStatus, nextStep, supportLine, type PromoteIntent,
} from './promotionFormat';
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
        <T size="xs" className="min-w-0 truncate font-medium text-text-primary" title={o.title}>{o.title}</T>
      </Inline>
      <T size="xs" as="div" className="mt-1 leading-relaxed text-text-secondary" wrap>{o.body}</T>
      <T size="xs" as="div" className="mt-1 text-text-tertiary">
        {o.repo ?? 'no repo'} · session {o.sessionId}
        {o.initiativeId && <> · <Link to={`/iq/projects/${encodeURIComponent(o.initiativeId)}`} className="text-primary hover:underline">Initiative</Link></>}
        {' · '}<TextLink href={`#observation-${o.id}`}>{o.id}</TextLink>
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
  onPromote: (intent: PromoteIntent) => void;
  onDismiss: (reason: string) => void;
}) {
  const [confirmingDismiss, setConfirmingDismiss] = useState(false);
  const [reason, setReason] = useState('');
  const isTerminal = isTerminalStatus(candidate.status);
  const actions = allowedActions(candidate);

  return (
    <Stack gap="md">
      <Stack gap="none">
        {/* The candidate's title is the page's one h1 (member #20, sme #22). */}
        <PageHeader
          title={candidate.title}
          badge={(
            <Inline gap="xs" wrap>
              <Chip tone={KIND_TONE[candidate.proposedKind]} size="xs">{PROPOSED_LABEL[candidate.proposedKind]}</Chip>
              <StatusPill state={STATUS_PILL_STATE[candidate.status]} label={STATUS_LABEL[candidate.status]} size="sm" />
            </Inline>
          )}
          description={candidate.rationale}
        />
        <T size="xs" as="div" className="mt-1.5 text-text-tertiary">{supportLine(candidate)}</T>
      </Stack>

      {candidate.driftedFrom && (
        <InlineAlert tone="warning">
          Drift detection sent this back from the skill <T className="font-mono">{candidate.driftedFrom}</T> —
          its recorded steps no longer matched observed behavior.
        </InlineAlert>
      )}

      <AssetRelationships kind="promotion" id={candidate.id} />
      <DetailSection first title="Review status">
        <T size="xs" className="text-text-secondary">
          Approval: {candidate.status === 'approved' || candidate.status === 'promoted' ? 'Recorded' : candidate.status === 'dismissed' ? 'Not available' : 'Not recorded'}
          {' · '}Dry run: {candidate.dryRunPassed === null ? 'Not recorded' : candidate.dryRunPassed ? 'Passed' : 'Failed'}
        </T>
        <T size="xs" className="text-text-tertiary">Publishing knowledge does not enable execution. Skill activation keeps its separate release requirements.</T>
      </DetailSection>
      <DetailSection title="Contributing observations">
        <Stack gap="xs">
          {candidate.observations.map((o) => <ObservationRow key={o.id} o={o} />)}
        </Stack>
      </DetailSection>

      <DetailSection title="Next step">
        <T size="xs" as="div" className="m-0 font-medium text-text-primary" wrap>{nextStep(candidate)}</T>

        {actionError && (
          <InlineAlert tone="error" className="mt-3">{actionError}</InlineAlert>
        )}

        {!isTerminal && (
          canManage ? (
            <Inline gap="sm" className="mt-3">
              {actions.primary && (
                <Button
                  size="sm"
                  variant="primary"
                  disabled={busy}
                  onClick={() => onPromote(actions.primary!.intent)}
                  title={actions.primary.hint}
                >
                  {actions.primary.label}
                </Button>
              )}
              {actions.canDismiss && (
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => setConfirmingDismiss(true)}>
                  Dismiss
                </Button>
              )}
            </Inline>
          ) : (
            <T size="xs" as="div" className="mt-3 text-text-tertiary">
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

/** Where the rail and the drawer read from, as the clause UnavailableNotice
 *  joins to "…, so this is unknown rather than empty." */
const PROMOTIONS_SOURCE = 'Candidates are clustered from lab observations by the promotions service';

async function readCandidate(id: string): Promise<PromotionCandidate | null> {
  try {
    const res = await fetch(`/api/promotions/${encodeURIComponent(id)}`, { credentials: 'include' });
    return res.ok ? await res.json() as PromotionCandidate : null;
  } catch {
    return null;
  }
}

export default function PromotionsPage() {
  const { can, ready } = useCapabilities();
  // ManageBots — the same gate the server's promote/dismiss routes enforce
  // (middleware/src/routes/promotions.ts). Wait for `ready` so the buttons
  // don't flash visible then disappear once the real grant lands.
  const canManage = ready && can('ManageBots');

  const moduleCtx = useOutletContext<DistillationOutletContext | undefined>();
  const [params, setParams] = useSearchParams();
  const urlFilter = FILTERS.some((f) => f.value === params.get('status')) ? params.get('status')! : 'all';
  const repo = params.get('repo');
  // Both fields are written to the URL (shareable, Back restores them) but
  // read from local drafts: the router commits in a transition, and a field
  // bound to `params` rendered the pre-keystroke value, so each key landed on
  // stale text ("ADOT" → "T") and the list kept the previous status's rows.
  function setFilter(key: string, value: string) {
    setParams((current) => {
      const next = new URLSearchParams(current);
      if (value && !(key === 'status' && value === 'all')) next.set(key, value); else next.delete(key);
      next.delete('item');
      next.delete('nav');
      return next;
    }, { replace: true });
  }
  const [filter, setFilterDraft] = useUrlDraft(urlFilter, (value) => setFilter('status', value), { debounceMs: 0 });
  const [query, setQuery] = useUrlDraft(params.get('q') ?? '', (value) => setFilter('q', value));
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

  async function promote(id: string, intent: PromoteIntent) {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    const tid = toastPending(intent === 'approve' ? 'Recording approval' : 'Promoting');
    try {
      const res = await writeJson<PromotionCandidate>(`/api/promotions/${encodeURIComponent(id)}/promote`, 'POST', {});
      if (!res.ok || !res.data) {
        // The server records the approval even when a skill is refused for
        // its dry-run alone (providers/promotions.ts promoteCandidate), and
        // answers 409 with the dry-run reason. For "Record approval" that is
        // the expected outcome, so read the candidate back and report what
        // actually landed rather than calling a recorded approval a failure.
        const after = intent === 'approve' && res.status === 409 ? await readCandidate(id) : null;
        if (after?.status === 'approved') {
          toastSuccess(tid, 'Approval recorded', nextStep(after));
          return;
        }
        throw new Error(res.error ?? 'unknown error');
      }
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
  // The candidates are a flush list rail beside the section rail; the content
  // column after it opens with the module trail and the page title
  // (docs/layout-cascade.md). Status and repository are the rail's filters.
  const paneBody = 'w-full max-w-3xl px-6 pb-6';
  const trail = [...(moduleCtx?.scope.breadcrumbs ?? [{ label: 'Build' }, { label: 'Distillation' }, { label: 'Review' }]),
    ...(openId ? [listCrumb, { label: openData?.title ?? 'Candidate' }] : [{ label: 'Asset promotions' }])];
  const filterFacets: WorkListFilterFacet[] = [
    {
      id: 'status', label: 'Status',
      options: FILTERS.filter((f) => f.value !== 'all').map((f) => ({ value: f.value, label: f.label, count: filterPromotions(scoped, f.value).length })),
      selected: filter === 'all' ? [] : [filter],
      onChange: (sel) => setFilterDraft(sel.length > 0 ? sel[sel.length - 1]! : 'all'),
    },
    ...(moduleCtx ? [moduleCtx.scope.repoFacet] : []),
  ];
  const activeFilters = (filter === 'all' ? 0 : 1) + (repo ? 1 : 0);
  // The candidate list's command composer, docked flush under the content
  // column: the rail's search and status, refresh, and open-by-exact-ID.
  const commands = promotionsCommandAdapter(candidates, {
    setQuery,
    setStatus: setFilterDraft,
    refresh,
    openCandidate,
  });
  return (
    <ListRailLayout
      header={<SectionHeader breadcrumbs={trail} title="Asset promotions"
        description="Observations that formed a reusable pattern, waiting for a decision before they join the Agent library." />}
      list={{
        title: filter === 'all' ? 'Candidates' : FILTERS.find((f) => f.value === filter)!.label,
        ...(data ? { count: candidates.length } : {}),
        label: 'Asset promotion candidates',
        header: (
          <Inline gap="xs" align="center" wrap={false}>
            <SearchInput value={query} onChange={setQuery} placeholder="Find a candidate" aria-label="Find a candidate" className="min-w-0 flex-1" />
            <FilterPopover
              trigger="icon"
              size="sm"
              label="Filter"
              activeCount={activeFilters}
              onClear={() => { setFilterDraft('all'); moduleCtx?.scope.repoFacet.onChange([]); }}
              panelLabel="Filter asset promotions"
            >
              <WorkListFilters facets={filterFacets} data-testid="promotion-filters" />
            </FilterPopover>
          </Inline>
        ),
        body: promotionsFailure ? <UnavailableNotice error={promotionsFailure} what="asset promotions" source={PROMOTIONS_SOURCE} onRetry={refresh} />
          : isLoading && !data ? <LoadingState label="Loading candidates…" />
          : candidates.length === 0 ? <EmptyState title="No candidates in this view" description={filter === 'dismissed' ? 'Dismissed candidates remain here with their observations and reasons.' : 'Candidates appear when observations form a reusable pattern.'} />
          : <GroupedList size="md" currentStyle="bar" groupHeading="label" groupCountAlign="end" hideEmptyGroups
              groups={(Object.keys(PROPOSED_LABEL) as Array<keyof typeof PROPOSED_LABEL>).map((kind) => ({ id: kind, title: PROPOSED_LABEL[kind], count: candidates.filter((c) => c.proposedKind === kind).length }))}
              rows={candidates.map((c) => ({ id: c.id, groupId: c.proposedKind, title: c.title,
                subline: `${STATUS_LABEL[c.status]} · ${c.supportCount} observations` }))}
              currentId={openId} onOpenRow={(row) => openCandidate(row.id)} />,
      }}
      footer={<CollectionCommandHost adapter={commands} />}
      data-testid="distillation-promotions"
    >
      {openId ? (
        <Stack gap="md" className={paneBody}>
          {openError && isNotFoundError(openError) ? (
            <RecordNotFound heading="Promotion candidate" title="Candidate not found" body={`No promotion candidate has the id "${openId}".`}
              backLabel="All asset promotions" onBack={() => setOpenId(null)} />
          ) : openError ? <UnavailableNotice error={openError} what="this candidate" source={PROMOTIONS_SOURCE} onRetry={refreshOpen} />
            : !openData ? <LoadingState label="Loading candidate…" />
            : <CandidateDrawer key={openId} candidate={openData} busy={busy} canManage={canManage} actionError={actionError?.id === openId ? actionError.message : null}
                onPromote={(intent) => void promote(openId, intent)}
                onDismiss={(reason) => void dismiss(openId, reason)} />}
        </Stack>
      ) : (
        <Stack gap="md" className={paneBody}>
          <EmptyState title="Review a proposed asset" description="Choose a candidate to inspect its observations, approval and dry-run result." />
        </Stack>
      )}
    </ListRailLayout>
  );
}
