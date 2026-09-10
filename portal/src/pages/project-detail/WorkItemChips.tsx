// The small affordances a work item carries, shared by the tree rows and the
// board cards so the two views can never drift apart.

import { useState } from 'react';
import { Link } from 'react-router';
import {
  Button,
  Chip,
  Inline,
  Link as ExternalLink,
  StatusDot,
} from '@connorhoehnslalom/ui-components/shared';
import { useCapabilities } from '../../lib/capabilities';
import { relativeTime } from '../../lib/relativeTime';
import { DEFAULT_DEVBOX_MODEL } from '../../lib/devboxModels';
import { toastError, toastPending, toastSuccess } from '../../lib/toastStore';
import type { BotRun } from '../bots/BotsPage';
import { PR_ICONS, PR_TONE, STATUS_DOT_COLOR, STATUS_TONE } from './projectFormat';
import type { PrStatus, WorkItemStatus, WorkItemTree } from './types';

/** Status as a dot plus a toned chip — the dot survives at glance distance,
 *  the chip carries the word. */
export function StatusChip({ status }: { status: WorkItemStatus }) {
  return (
    <Inline gap="xs" align="center" wrap={false} className="shrink-0">
      <StatusDot color={STATUS_DOT_COLOR[status]} size="xs" />
      <Chip tone={STATUS_TONE[status] ?? 'neutral'} size="xs">
        {status.replace('_', ' ')}
      </Chip>
    </Inline>
  );
}

/** The pull request, linked when there is somewhere to go. */
export function PrBadge({ prStatus, prUrl }: { prStatus: PrStatus; prUrl: string | null }) {
  const chip = (
    <Chip tone={PR_TONE[prStatus]} size="xs">
      {PR_ICONS[prStatus]} PR · {prStatus}
    </Chip>
  );
  if (!prUrl) return chip;
  return (
    <ExternalLink external
      href={prUrl}
      className="no-underline shrink-0"
      onClick={(e) => e.stopPropagation()}
    >
      {chip}
    </ExternalLink>
  );
}

/** The Estimate control — opens the estimate → authorize drawer. Only on open,
 *  pointed stories and bugs, and only for sessions holding DispatchAgentRun. */
/**
 * The run controls on a work row.
 *
 * WHY "RUN" AND NOT "ESTIMATE". This used to render a single ⚡ Estimate
 * button, which put an authorize-a-forecast step in front of every dispatch —
 * on a row that was already showing 5 story points. That is asking someone to
 * approve a COMPUTATION: the forecast is derived deterministically from
 * (points, model) through the repo-calibrated curve, so there is no decision in
 * producing it. The decision is whether to SPEND, and that is what ▶ Run is.
 *
 * The cost is still never hidden before money moves. Run on an item with no
 * standing estimate opens the drawer, which computes the forecast and shows it
 * behind Authorize — the same confirmation as before, reached by pressing the
 * button that says what the operator actually wants to do.
 */
export function EstimateChip({
  item, onEstimate,
}: {
  item: WorkItemTree;
  onEstimate: (item: WorkItemTree) => void;
}) {
  const { can, ready } = useCapabilities();
  const [dispatching, setDispatching] = useState(false);
  if (item.status !== 'open' || item.storyPoints == null) return null;
  if (!ready || !can('DispatchAgentRun')) return null;

  // A stored estimate is only "standing" if somebody authorized it AND it was
  // computed for the model this run will actually use. Haiku and Opus were
  // measured 20x apart on identical points, so re-running against a forecast
  // from the other model would be a number nobody agreed to.
  const standing = item.estimatedAt != null
    && item.estimateModel === DEFAULT_DEVBOX_MODEL
    && item.estimateForecast != null;

  // Who signed off, and when. Shown only once an estimate has actually been
  // authorized — a derived forecast carries no name, and labelling one would
  // invent an author.
  const reviewed = item.estimateReviewedBy != null;
  const estBy = item.estimatedByName ?? item.estimatedBy ?? 'unknown';
  const revBy = item.estimateReviewedByName ?? item.estimateReviewedBy;

  // Re-run against the estimate already on the record.
  //
  // This still spends money and still faces every gate — grant-scoped 403,
  // per-run cap, allocation, envelope. It does not bypass them; it skips the
  // DRAWER, which exists to produce and authorize a forecast this item already
  // has. Any refusal hands off to that drawer, because it is the surface that
  // knows how to explain all four and to collect the right confirm flag.
  async function dispatchStanding(e: React.MouseEvent) {
    e.stopPropagation();
    if (dispatching) return;
    setDispatching(true);
    const tid = toastPending('Dispatching', item.title);
    try {
      const res = await fetch('/api/bots/dispatch-work', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workItemId: item.id,
          model: DEFAULT_DEVBOX_MODEL,
          estimate: item.estimateForecast,
        }),
      });
      if (res.ok) {
        toastSuccess(tid, 'Agent dispatched', `${item.title} — on the standing estimate.`);
        return;
      }
      toastError(tid, 'Needs authorizing', 'Opening the estimate drawer.');
      onEstimate(item);
    } catch (err) {
      toastError(tid, 'Could not dispatch', (err as Error).message);
    } finally {
      setDispatching(false);
    }
  }

  return (
    <Inline gap="xs" wrap={false} className="shrink-0">
      {standing && (
        <Chip
          size="sm"
          // Truncate rather than wrap: this sits in a fixed-width table column,
          // and a wrapped chip changes the row height for one row only.
          className="min-w-0 max-w-[112px] truncate"
          tone={reviewed ? 'success' : 'neutral'}
          title={reviewed
            ? `Estimate by ${estBy} ${relativeTime(item.estimatedAt)}; reviewed by ${revBy} ${relativeTime(item.estimateReviewedAt)}`
            : `Estimate by ${estBy} ${relativeTime(item.estimatedAt)} — not yet reviewed`}
        >
          {/* Name inline, timing in the tooltip and in full in the drawer. The
              whole sentence does not fit a dense table column without either
              overflowing the panel or truncating the name away — and WHO is the
              half that cannot be recovered from anywhere else on this row. */}
          {reviewed ? '✓ ' : ''}{estBy}
        </Chip>
      )}
      <Button
        size="sm"
        variant="primary"
        disabled={dispatching}
        className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold tracking-wide"
        title={standing
          ? `Run on the standing estimate — by ${estBy}`
          : `Run an agent on this ${item.storyPoints}-point item — you will see the forecast before it spends`}
        // No standing estimate → the drawer, which computes the forecast and
        // shows it behind Authorize. Same confirmation, reached by pressing the
        // button that names the intent instead of one that names a prerequisite.
        onClick={(e) => {
          if (standing) { void dispatchStanding(e); return; }
          e.stopPropagation();
          onEstimate(item);
        }}
        // A stable, re-queryable handle for the Estimate drawer to refocus on
        // close — see the comment on EstimateDrawer's handleClose. A re-query
        // by id survives whatever opened this row unmounting.
        {...(standing ? {} : { 'data-estimate-trigger': item.id })}
      >
        {dispatching ? '…' : '▶ Run'}
      </Button>
      {standing && (
        <Button
          size="sm"
          variant="secondary"
          className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold tracking-wide text-primary"
          title="Review, re-estimate, cap or add an instruction before running"
          data-estimate-trigger={item.id}
          onClick={(e) => { e.stopPropagation(); onEstimate(item); }}
        >
          ⚡
        </Button>
      )}
    </Inline>
  );
}

/** Live marketplace state for a work item: a pulsing chip while an agent is on
 *  it (linking to its Computers box), and a review link once a change landed. */
export function RunStateChips({ item, run }: { item: WorkItemTree; run: BotRun | undefined }) {
  return (
    <>
      {run?.status === 'running' && (
        run.outcome?.boxId ? (
          <Link
            to={`/admin/devbox?box=${encodeURIComponent(run.outcome.boxId)}`}
            className="no-underline shrink-0"
            onClick={(e) => e.stopPropagation()}
            title="An agent is working this item — open its computer"
          >
            <Chip tone="info" size="xs" dot="pulse">agent working</Chip>
          </Link>
        ) : (
          <Chip tone="info" size="xs" dot="pulse">agent working</Chip>
        )
      )}
      {item.status === 'in_review' && run?.outcome?.changeId && (
        <Link
          to="/admin/changes"
          onClick={(e) => e.stopPropagation()}
          title="The agent's change is waiting in the review queue"
          className="shrink-0 whitespace-nowrap text-[11px] font-semibold text-primary no-underline"
        >
          → review
        </Link>
      )}
    </>
  );
}
