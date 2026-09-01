// The small affordances a work item carries, shared by the tree rows and the
// board cards so the two views can never drift apart.

import { Link } from 'react-router';
import { Button, Chip, StatusDot } from '@connorhoehnslalom/ui-components/shared';
import { useCapabilities } from '../../lib/capabilities';
import type { BotRun } from '../bots/BotsPage';
import { PR_ICONS, PR_TONE, STATUS_DOT_COLOR, STATUS_TONE } from './projectFormat';
import type { PrStatus, WorkItemStatus, WorkItemTree } from './types';

/** Status as a dot plus a toned chip — the dot survives at glance distance,
 *  the chip carries the word. */
export function StatusChip({ status }: { status: WorkItemStatus }) {
  return (
    <span className="inline-flex items-center gap-1 shrink-0">
      <StatusDot color={STATUS_DOT_COLOR[status]} size="xs" />
      <Chip tone={STATUS_TONE[status] ?? 'neutral'} size="xs">
        {status.replace('_', ' ')}
      </Chip>
    </span>
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
    <a
      href={prUrl}
      target="_blank"
      rel="noreferrer"
      className="no-underline shrink-0"
      onClick={(e) => e.stopPropagation()}
    >
      {chip}
    </a>
  );
}

/** The Estimate control — opens the estimate → authorize drawer. Only on open,
 *  pointed stories and bugs, and only for sessions holding DispatchAgentRun. */
export function EstimateChip({
  item, onEstimate,
}: {
  item: WorkItemTree;
  onEstimate: (item: WorkItemTree) => void;
}) {
  const { can, ready } = useCapabilities();
  if (item.status !== 'open' || item.storyPoints == null) return null;
  if (!ready || !can('DispatchAgentRun')) return null;
  return (
    <Button
      size="sm"
      variant="secondary"
      className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold tracking-wide text-primary"
      title="Estimate cost & duration, then authorize an agent run"
      onClick={(e) => { e.stopPropagation(); onEstimate(item); }}
    >
      ⚡ Estimate
    </Button>
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
