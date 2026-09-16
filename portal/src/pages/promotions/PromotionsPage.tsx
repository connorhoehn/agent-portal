// The promotions inbox — the curation step between raw lab_experiences
// observations and the library: cluster → pattern → runbook/insight →
// (human + dry run) → skill, with drift able to send a skill back down.
//
// One page, list + drawer, same shape as the library: the list is the queue
// to triage, the drawer is where a candidate actually gets promoted or
// dismissed — a route per candidate would make "what do I do next" a
// navigation instead of a click.

import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { DetailSection, Tooltip,
  Button,
  Card,
  Chip,
  ConfirmDialog,
  DataTable,
  Drawer,
  EmptyState,
  FilterChip,
  FormField,
  Inline,
  InlineAlert,
  LoadingState,
  PageSection,
  Stack,
  StatusPill,
  Textarea,
  Toolbar,
  ToolbarGroup,
  ToolbarLabel,
  type DataTableColumn,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { useCapabilities } from '../../lib/capabilities';
import { toastError, toastPending, toastSuccess } from '../../lib/toastStore';
import {
  KIND_TONE, PROPOSED_LABEL, STATUS_LABEL, STATUS_PILL_STATE, STATUS_TONE,
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

async function post(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function ObservationRow({ o }: { o: PromotionCandidate['observations'][number] }) {
  return (
    <Card padding="sm">
      <Inline gap="xs" wrap={false}>
        <Chip tone="neutral" size="xs">{o.kind}</Chip>
        <T className="min-w-0 truncate text-[12px] font-medium text-text-primary" title={o.title}>{o.title}</T>
      </Inline>
      <T as="div" className="mt-1 text-[11.5px] leading-relaxed text-text-secondary" wrap>{o.body}</T>
      <T as="div" className="mt-1 text-[10.5px] text-text-tertiary">
        {o.repo ?? 'no repo'} · session {o.sessionId}
      </T>
    </Card>
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
    <Stack gap="lg">
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

      <DetailSection first title="Contributing observations">
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

  const [filter, setFilter] = useState('all');
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Last failed promote/dismiss on the OPEN candidate — shown as an
  // InlineAlert in the drawer (DEFECTS.md #1). Reset whenever the drawer
  // opens a (possibly different) candidate so a past failure doesn't bleed
  // into the next one.
  const [actionError, setActionError] = useState<string | null>(null);

  function openCandidate(id: string) {
    setActionError(null);
    setOpenId(id);
  }

  // Fetched unfiltered and narrowed client-side by `filterPromotions` — a
  // pure, tested predicate the Status row can drive directly, rather than a
  // round trip per click that a stale/aborted fetch could silently swallow.
  const { data, isLoading, error, refresh } = useFetch<{ candidates: PromotionCandidate[] }>('/api/promotions', 30_000);
  const candidates = useMemo(() => filterPromotions(data?.candidates ?? [], filter), [data, filter]);

  const { data: openData, refresh: refreshOpen } = useFetch<PromotionCandidate>(
    openId ? `/api/promotions/${encodeURIComponent(openId)}` : null, 0);

  async function promote(id: string, dryRunPassed?: boolean) {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    const tid = toastPending('Promoting', 'recording approval');
    try {
      const res = await post(`/api/promotions/${encodeURIComponent(id)}/promote`, { dryRunPassed });
      const body = await res.json() as PromotionCandidate & { error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      toastSuccess(tid, body.status === 'promoted' ? 'Promoted' : 'Approval recorded', nextStep(body));
    } catch (err) {
      const message = (err as Error).message;
      toastError(tid, 'Could not promote', message);
      setActionError(message);
    } finally {
      setBusy(false);
      // Re-read regardless of outcome: the mock provider can record a
      // partial state change (e.g. approvedBy) even on a call that ends in
      // an error, so a failed request can still leave the drawer stale.
      refresh();
      refreshOpen();
    }
  }

  async function dismiss(id: string, reason: string) {
    if (busy || !reason) return;
    setBusy(true);
    setActionError(null);
    const tid = toastPending('Dismissing');
    try {
      const res = await post(`/api/promotions/${encodeURIComponent(id)}/dismiss`, { reason });
      if (!res.ok) throw new Error((await res.json() as { error?: string }).error ?? `HTTP ${res.status}`);
      toastSuccess(tid, 'Dismissed');
    } catch (err) {
      const message = (err as Error).message;
      toastError(tid, 'Could not dismiss', message);
      setActionError(message);
    } finally {
      setBusy(false);
      refresh();
      refreshOpen();
    }
  }

  const columns: DataTableColumn<PromotionCandidate>[] = [
    {
      key: 'title', header: 'Candidate', sortable: true,
      render: (c) => (
        <Stack gap="none" className="min-w-0">
          {/* A real Button, not just the row's onClick: DataTable's row-click
              is a bare <tr onClick> with no keyboard access, so this is the
              one focusable, Enter/Space-activatable control in the row —
              same pattern as `work/QueuePage.tsx`'s suggestion rows. */}
          {/* Button's own root is a native button element, whose UA default
              is centred text; the Stack around it stretches the button to
              the column's full width (flex-col with no `align`, so
              cross-axis stretch applies), so a centred label and a
              left-edge sub-line zig-zagged under it. `justify-start` is a
              flex property and does nothing here — Button isn't a flex
              container — `text-left` is what actually overrides the
              centring. */}
          <Button
            variant="ghost"
            size="sm"
            className="justify-start text-left px-0 py-0 border-0 h-fit min-w-0 truncate text-[13px] font-semibold text-text-primary"
            title={c.title}
            onClick={(e) => { e.stopPropagation(); openCandidate(c.id); }}
          >
            {c.title}
          </Button>
          <T as="div" className="text-[11px] text-text-tertiary truncate">{supportLine(c)}</T>
        </Stack>
      ),
    },
    {
      key: 'proposedKind', header: 'Proposed', sortable: true,
      render: (c) => <Chip tone={KIND_TONE[c.proposedKind]} size="xs">{PROPOSED_LABEL[c.proposedKind]}</Chip>,
    },
    {
      key: 'status', header: 'Status', sortable: true,
      render: (c) => (
        <Inline gap="xs" wrap={false}>
          <Chip tone={STATUS_TONE[c.status]} size="xs" dot="static">{STATUS_LABEL[c.status]}</Chip>
          {c.driftedFrom && (
            <Tooltip content={`Drift detection sent this back from the skill ${c.driftedFrom} — its recorded steps no longer matched observed behavior.`}>
              <Chip tone="warning" size="xs">drifted</Chip>
            </Tooltip>
          )}
        </Inline>
      ),
    },
    {
      key: 'supportCount', header: 'Support', align: 'right', sortable: true,
      compare: (a, b) => a.supportCount - b.supportCount,
      render: (c) => <T className="text-[11px] text-text-tertiary whitespace-nowrap">{c.supportCount} obs · {c.sessionCount} sess</T>,
    },
  ];

  return (
    <PageSection
      title="Promotions"
      description="Where an agent session's observations earn their way into the library: three sightings across two sessions make a pattern, a pattern with a repeatable trigger and outcome is a runbook, and only an approved runbook with a passing dry run ships as a skill the fleet runs unattended."
    >
      <Toolbar size="md" aria-label="Promotion filters">
        <ToolbarGroup aria-label="Status">
          <ToolbarLabel>Status</ToolbarLabel>
          {FILTERS.map((f) => (
            <FilterChip key={f.value} active={filter === f.value} onClick={() => setFilter(f.value)} size="sm">
              {f.label}
            </FilterChip>
          ))}
        </ToolbarGroup>
      </Toolbar>

      {error ? (
        <EmptyState title="Could not load the promotions inbox" description={error} />
      ) : isLoading && !data ? (
        <LoadingState label="Loading candidates…" />
      ) : candidates.length === 0 ? (
        <EmptyState
          title="Nothing here"
          description={filter === 'all'
            ? 'No cluster has crossed the pattern floor yet — three observations across two sessions.'
            : `Nothing ${STATUS_LABEL[filter as keyof typeof STATUS_LABEL]?.toLowerCase() ?? filter} right now.`}
        />
      ) : (
        <DataTable<PromotionCandidate>
          data={candidates}
          columns={columns}
          keyField={(c) => c.id}
          onRowClick={(c) => openCandidate(c.id)}
          pageSize={25}
          emptyMessage="No candidates"
        />
      )}

      <Drawer
        open={openId != null}
        onClose={() => setOpenId(null)}
        aria-label="Promotion candidate detail"
        width={720}
      >
        {!openData ? (
          <LoadingState label="Loading…" />
        ) : (
          <CandidateDrawer
            candidate={openData}
            busy={busy}
            canManage={canManage}
            actionError={actionError}
            onPromote={(dryRunPassed) => openId && void promote(openId, dryRunPassed)}
            onDismiss={(reason) => openId && void dismiss(openId, reason)}
          />
        )}
      </Drawer>
    </PageSection>
  );
}
