// The open work item (mockup variant 2, W8–W15): its epic, type and key above
// a large title, the divided meta row (status · flags · owner · points ·
// priority, each a PATCH for a role that may edit), then three tabs:
//
//   Brief       Why this matters, the amber Next step, "Complete the brief"
//               (a ruled three-row table built by `briefModel`: criteria,
//               dependencies and decisions, planning notes — each with its
//               action), the full section for whatever is already written,
//               and the collapsed Run setup holding the run draft.
//   Discussion  the whole comment thread.
//   Activity    the item's history (itemActivity) — status changes, runs,
//               estimates, comments — from data already recorded.
//
// The composer is not here: it docks under the whole pane (the page's
// InitiativeComposer), so the Overview and the item share one slot.

import { useMemo, useState, type ReactNode } from 'react';
import {
  ChecklistSection,
  CommentList,
  DetailSection,
  Disclosure,
  KeyValue,
  LinkedItemsSection,
  OutcomeSection,
  WorkActivityList,
  WorkItemMetaBar,
  type CommentListItem,
  type KeyValueItem,
  type LinkedItem,
  type WorkMetaOption,
  type WorkPerson,
} from '@connorhoehnslalom/ui-components';
import { EditorShell } from '@connorhoehnslalom/ui-components/doc-editor';
import { ArrowRightIcon, Banner, Button, Inline, Stack } from '@connorhoehnslalom/ui-components/shared';
import { DEVBOX_MODELS } from '../../lib/devboxModels';
import type { BotRun } from '../bots/BotsPage';
import {
  BRIEF_BODY,
  BRIEF_TITLE,
  RUN_SETUP_TITLE,
  WHY_TITLE,
  buildBrief,
  itemFlags,
  nextStepCallout,
  type BriefRow,
  type Read,
} from './briefModel';
import { itemActivity } from './itemActivity';
import type { FlatWorkItem } from './projectFormat';
import type { ProjectContributor, ProjectDecision, WorkItem } from './types';
import type { WorkItemThread } from './useWorkItemThread';

export type WorkItemPatch = Partial<Pick<WorkItem, 'status' | 'priority' | 'storyPoints' | 'assigneeId' | 'description'>>
  & { assigneeName?: string | null };

const STATUS_OPTIONS: WorkMetaOption[] = [
  { value: 'open', label: 'Open', tone: 'neutral' },
  { value: 'in_progress', label: 'In progress', tone: 'info' },
  { value: 'in_review', label: 'In review', tone: 'purple' },
  { value: 'done', label: 'Done', tone: 'success' },
  { value: 'cancelled', label: 'Cancelled', tone: 'danger' },
];

const PRIORITY_OPTIONS: WorkMetaOption[] = [
  { value: 'critical', label: 'Critical', tone: 'danger' },
  { value: 'high', label: 'High', tone: 'danger' },
  { value: 'medium', label: 'Medium', tone: 'warning' },
  { value: 'low', label: 'Low', tone: 'neutral' },
];

const DECISION_STATUS: Record<string, { label: string; tone: 'danger' | 'warning' | 'success' | 'neutral' }> = {
  escalated: { label: 'Escalated', tone: 'danger' },
  open: { label: 'Open', tone: 'warning' },
  resolved: { label: 'Resolved', tone: 'success' },
  rejected: { label: 'Rejected', tone: 'neutral' },
};

const PR_STATUS: Record<string, { label: string; tone: 'info' | 'neutral' | 'success' }> = {
  open: { label: 'Open', tone: 'info' },
  draft: { label: 'Draft', tone: 'neutral' },
  merged: { label: 'Merged', tone: 'success' },
  closed: { label: 'Closed', tone: 'neutral' },
};

const modelLabel = (id: string) => DEVBOX_MODELS.find((m) => m.id === id)?.label ?? id;

export type DetailTab = 'brief' | 'comments' | 'history';

/** How a thread read reads when it has nothing to show. */
function threadEmpty(loading: boolean, error: string | null, what: string, empty: string): string {
  if (loading) return `Loading ${what}…`;
  if (error) return `The ${what} could not be read: ${error}`;
  return empty;
}

/** One brief row's action: a link-styled button, disabled with its reason. */
function RowAction({ label, disabledReason, onClick, testId }: {
  label: string;
  disabledReason: string | null;
  onClick: () => void;
  testId: string;
}) {
  return (
    <Button
      variant="link"
      size="sm"
      onClick={onClick}
      disabled={disabledReason != null}
      title={disabledReason ?? undefined}
      aria-label={disabledReason ? `${label} — ${disabledReason}` : undefined}
      data-testid={testId}
    >
      {label}
    </Button>
  );
}

export interface WorkItemDetailProps {
  item: FlatWorkItem;
  /** Criteria and comments for this item (useWorkItemThread). */
  thread: WorkItemThread;
  /** The initiative's decisions as read; this item's are those whose `workItemId` matches. */
  decisions: Read<ProjectDecision[]>;
  /** Who the owner picker offers — the initiative's contributors. */
  contributors: ProjectContributor[];
  /** Marketplace runs on this initiative; the ones on this item feed Activity. */
  runs: BotRun[];
  /** The board's write gate (DispatchAgentRun). */
  canEdit: boolean;
  tab: DetailTab;
  onTabChange: (tab: DetailTab) => void;
  onPatch: (fields: WorkItemPatch) => void;
  onOpenEpic: () => void;
  onOpenDecisions: () => void;
  /** "Draft with agent": put the criteria workflow in the composer. */
  onDraftCriteria: () => void;
  /** "Add context": link a decision to this item. */
  onAddContext: () => void;
  /** "Add a note": write a planning note. */
  onAddNote: () => void;
  /** The collapsed Run setup: its hint and the run draft inside it. */
  runSetup: { hint: string; body: ReactNode };
}

export function WorkItemDetail({
  item,
  thread,
  decisions,
  contributors,
  runs,
  canEdit,
  tab,
  onTabChange,
  onPatch,
  onOpenEpic,
  onOpenDecisions,
  onDraftCriteria,
  onAddContext,
  onAddNote,
  runSetup,
}: WorkItemDetailProps) {
  const readOnly = canEdit ? undefined : 'Your role cannot edit work items';
  // An editor with no criteria yet can also write them by hand; the list
  // opens under the table once asked for. Keyed by item so it never carries.
  const [writingCriteriaFor, setWritingCriteriaFor] = useState<string | null>(null);
  const people = useMemo<WorkPerson[]>(
    () => contributors.map((c) => ({ id: c.personId, name: c.name })),
    [contributors],
  );

  const itemDecisions = (decisions.data ?? []).filter((d) => d.workItemId === item.id);
  const itemRuns = runs.filter((r) => r.workItemId === item.id);
  const latestRun = itemRuns.reduce<BotRun | undefined>(
    (a, r) => (!a || Date.parse(r.startedAt) > Date.parse(a.startedAt) ? r : a), undefined);

  const links: LinkedItem[] = [
    ...itemDecisions.map((d) => ({
      id: d.id,
      title: d.topic,
      kind: 'page' as const,
      relation: 'Decided by',
      status: DECISION_STATUS[d.status] ?? { label: d.status, tone: 'neutral' as const },
      onOpen: onOpenDecisions,
    })),
    ...(item.prUrl
      ? [{
          id: 'pr',
          title: item.prUrl.replace(/^https:\/\/github\.com\//, ''),
          relation: 'Pull request',
          status: item.prStatus ? PR_STATUS[item.prStatus] ?? null : null,
          href: item.prUrl,
        }]
      : []),
    ...(latestRun?.outcome?.prUrl && latestRun.outcome.prUrl !== item.prUrl
      ? [{
          id: 'run-pr',
          title: latestRun.outcome.prUrl.replace(/^https:\/\/github\.com\//, ''),
          relation: 'Agent pull request',
          href: latestRun.outcome.prUrl,
        }]
      : []),
  ];

  const notes: CommentListItem[] = thread.comments
    .filter((c) => !c.isSystem)
    .map((c) => ({
      id: c.id,
      author: { id: c.authorId ?? c.id, name: c.authorName ?? 'Unknown' },
      role: c.authorTitle,
      createdAt: c.createdAt,
      text: c.body,
    }));

  const activity = useMemo(
    () => itemActivity(item, thread.comments, runs, modelLabel),
    [item, thread.comments, runs],
  );

  const brief = buildBrief({
    itemId: item.id,
    criteria: { data: thread.criteriaLoading ? null : thread.criteria, error: thread.criteriaError },
    decisions,
    comments: { data: thread.commentsLoading ? null : thread.comments, error: thread.commentsError },
    canEdit,
  });
  const filled = (id: BriefRow['id']) => brief.rows.find((r) => r.id === id)?.filled ?? false;
  const showCriteria = filled('criteria') || writingCriteriaFor === item.id;
  const nextStep = nextStepCallout(item);

  const onRowAction = (row: BriefRow) => {
    if (row.id === 'criteria') {
      if (row.filled) {
        document.querySelector('[data-testid="brief-criteria"]')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } else {
        onDraftCriteria();
      }
    } else if (row.id === 'decisions') {
      onAddContext();
    } else {
      onAddNote();
    }
  };

  const briefItems: KeyValueItem[] = brief.rows.map((row) => ({
    label: row.label,
    value: row.value,
    muted: row.muted,
    ...(row.action
      ? {
          action: (
            <Inline gap="md" align="center">
              {row.id === 'criteria' && !row.filled && canEdit && writingCriteriaFor !== item.id && (
                <RowAction label="Write" disabledReason={null} onClick={() => setWritingCriteriaFor(item.id)} testId="brief-action-criteria-write" />
              )}
              <RowAction
                label={row.action.label}
                disabledReason={row.action.disabledReason}
                onClick={() => onRowAction(row)}
                testId={`brief-action-${row.id}`}
              />
            </Inline>
          ),
        }
      : {}),
  }));

  return (
    <EditorShell
      variant="work-item"
      titleSize="lg"
      itemType={item.type === 'bug' ? 'Bug' : 'Story'}
      itemKey={item.id}
      title={item.title}
      breadcrumbs={[{ label: item.epicTitle, onClick: onOpenEpic }]}
      metaBar={(
        <WorkItemMetaBar
          layout="divided"
          priorityStyle="tag"
          flags={itemFlags(item)}
          status={{ value: item.status, options: STATUS_OPTIONS, readOnlyReason: readOnly, onChange: (v) => onPatch({ status: v as WorkItem['status'] }) }}
          points={{ value: item.storyPoints, max: 21, readOnlyReason: readOnly, onChange: (v) => onPatch({ storyPoints: v }) }}
          owner={{
            value: item.assigneeId && item.assigneeName ? { id: item.assigneeId, name: item.assigneeName } : null,
            readOnlyReason: readOnly,
            onSearchPeople: (q) => people.filter((p) => p.name.toLowerCase().includes(q.trim().toLowerCase())),
            onChange: (p) => onPatch({ assigneeId: p?.id ?? null, assigneeName: p?.name ?? null }),
          }}
          priority={{ value: item.priority, options: PRIORITY_OPTIONS, readOnlyReason: readOnly, onChange: (v) => onPatch({ priority: v as WorkItem['priority'] }) }}
        />
      )}
      tabs={[
        { id: 'brief', label: 'Brief' },
        // A count only when there is one — "Discussion 0" reads as noise.
        { id: 'comments', label: 'Discussion', ...(thread.commentCount > 0 ? { count: thread.commentCount } : {}) },
        { id: 'history', label: 'Activity' },
      ]}
      activeTab={tab}
      onTabChange={(id) => onTabChange(id as DetailTab)}
      surface="plain"
      label="Work item"
      data-testid="work-item-detail"
    >
      <Stack gap="lg" className="px-4 pb-6 pt-2">
        {tab === 'brief' && (
          <>
            <OutcomeSection
              first
              size="lg"
              title={WHY_TITLE}
              value={item.description}
              placeholder="Why does this work matter?"
              readOnlyReason={readOnly}
              onChange={(v) => onPatch({ description: v })}
            />
            {nextStep && (
              <Banner
                layout="callout"
                variant="warning"
                accent="bar"
                size="lg"
                title={nextStep.title}
                {...(nextStep.detail ? { meta: nextStep.detail } : {})}
                action={(
                  <Button variant="link" onClick={() => onTabChange('comments')} data-testid="next-step-open-discussion">
                    <Inline gap="xs" align="center">
                      {nextStep.actionLabel}
                      <ArrowRightIcon size={16} />
                    </Inline>
                  </Button>
                )}
                data-testid="work-item-next-step"
              >
                {nextStep.step}
              </Banner>
            )}
            {showCriteria && (
              <ChecklistSection
                title="Acceptance criteria"
                items={thread.criteria.map((c) => ({ id: c.id, text: c.text, done: c.done }))}
                readOnlyReason={readOnly}
                emptyLabel={threadEmpty(thread.criteriaLoading, thread.criteriaError, 'criteria', 'No acceptance criteria yet')}
                addPlaceholder="Add a criterion"
                onToggle={thread.toggle}
                onAdd={thread.add}
                onEdit={thread.edit}
                onRemove={thread.remove}
                onMove={thread.move}
                data-testid="brief-criteria"
              />
            )}
            {filled('decisions') && (
              <LinkedItemsSection
                title="Dependencies and decisions"
                items={links}
                emptyLabel="No decisions or pull requests linked yet"
              />
            )}
            {filled('notes') && (
              <CommentList
                title="Planning notes"
                comments={[...notes].reverse()}
                total={notes.length}
                max={2}
                onViewAll={() => onTabChange('comments')}
                emptyLabel="No planning notes yet"
              />
            )}
            {brief.showTable && (
              <DetailSection variant="heading" size="lg" title={BRIEF_TITLE} description={BRIEF_BODY} data-testid="brief-table">
                <KeyValue layout="row" divided labelWidth="w-72" items={briefItems} aria-label={BRIEF_TITLE} />
              </DetailSection>
            )}
            <Disclosure
              variant="plain"
              size="lg"
              summary={RUN_SETUP_TITLE}
              hint={runSetup.hint}
              data-testid="run-setup"
            >
              {runSetup.body}
            </Disclosure>
          </>
        )}
        {tab === 'comments' && (
          <CommentList
            first
            title="Discussion"
            comments={notes}
            emptyLabel={threadEmpty(thread.commentsLoading, thread.commentsError, 'discussion',
              canEdit ? 'No comments yet — switch the composer to Chat to start one' : 'No comments yet')}
          />
        )}
        {tab === 'history' && (
          <WorkActivityList
            first
            events={activity}
            loading={thread.commentsLoading}
            error={thread.commentsError ? `The item's history could not be read: ${thread.commentsError}` : null}
          />
        )}
      </Stack>
    </EditorShell>
  );
}
