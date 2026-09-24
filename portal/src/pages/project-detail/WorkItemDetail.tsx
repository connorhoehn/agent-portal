// The open work item: its epic, type and key above the title, the meta bar
// (status, points, owner, priority — each a PATCH), then three tabs:
//
//   Brief       outcome, acceptance criteria, dependencies & decisions, and
//               the latest planning notes.
//   Discussion  the whole comment thread.
//   Activity    the item's history (itemActivity) — status changes, runs,
//               estimates, comments — from data already recorded.
//
// The composer docked underneath has two modes: Chat posts a comment to the
// thread, Agent prepares the run draft's instruction. The library's
// EditorShell and work sections draw all of it; this file maps one work item
// onto them.

import { useMemo, useState } from 'react';
import {
  ChecklistSection,
  CommentList,
  LinkedItemsSection,
  OutcomeSection,
  WorkActivityList,
  WorkItemMetaBar,
  type CommentListItem,
  type LinkedItem,
  type WorkMetaOption,
  type WorkPerson,
} from '@connorhoehnslalom/ui-components';
import { EditorShell } from '@connorhoehnslalom/ui-components/doc-editor';
import { RichChatComposer, type ComposerMode } from '@connorhoehnslalom/ui-components/social/rich-composer';
import { Stack } from '@connorhoehnslalom/ui-components/shared';
import { DEVBOX_MODELS } from '../../lib/devboxModels';
import type { BotRun } from '../bots/BotsPage';
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

export function WorkItemDetail({
  item,
  thread,
  decisions,
  contributors,
  runs,
  canEdit,
  canDispatch,
  tab,
  onTabChange,
  onPatch,
  onOpenEpic,
  onOpenDecisions,
  onPrepare,
}: {
  item: FlatWorkItem;
  /** Criteria and comments for this item (useWorkItemThread). */
  thread: WorkItemThread;
  /** Decisions whose `workItemId` is this item. */
  decisions: ProjectDecision[];
  /** Who the owner picker offers — the initiative's contributors. */
  contributors: ProjectContributor[];
  /** Marketplace runs on this initiative; the ones on this item feed Activity. */
  runs: BotRun[];
  canEdit: boolean;
  canDispatch: boolean;
  tab: DetailTab;
  onTabChange: (tab: DetailTab) => void;
  onPatch: (fields: WorkItemPatch) => void;
  onOpenEpic: () => void;
  onOpenDecisions: () => void;
  /** The composer's Agent-mode text becomes the run draft's instruction. */
  onPrepare: (instruction: string) => void;
}) {
  const readOnly = canEdit ? undefined : 'Your role cannot edit work items';
  const [mode, setMode] = useState<ComposerMode>('agent');
  const people = useMemo<WorkPerson[]>(
    () => contributors.map((c) => ({ id: c.personId, name: c.name })),
    [contributors],
  );

  const itemRuns = runs.filter((r) => r.workItemId === item.id);
  const latestRun = itemRuns.reduce<BotRun | undefined>(
    (a, r) => (!a || Date.parse(r.startedAt) > Date.parse(a.startedAt) ? r : a), undefined);

  const links: LinkedItem[] = [
    ...decisions.map((d) => ({
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

  return (
    <EditorShell
      variant="work-item"
      itemType={item.type === 'bug' ? 'Bug' : 'Story'}
      itemKey={item.id}
      title={item.title}
      breadcrumbs={[{ label: item.epicTitle, onClick: onOpenEpic }]}
      subtitle={item.labels.length > 0 ? item.labels.join(' · ') : undefined}
      metaBar={(
        <WorkItemMetaBar
          appearance="boxed"
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
        { id: 'comments', label: 'Discussion', count: thread.commentCount },
        { id: 'history', label: 'Activity' },
      ]}
      activeTab={tab}
      onTabChange={(id) => onTabChange(id as DetailTab)}
      surface="plain"
      label="Work item"
      data-testid="work-item-detail"
      footer={canDispatch ? (
        <Stack gap="none" className="px-4 pb-3">
          <RichChatComposer
            key={item.id}
            mode={mode}
            onModeChange={setMode}
            modeControl="menu"
            modeShortcuts
            disabledModes={['terminal']}
            modeUnavailableReasons={{ terminal: 'A work item has no terminal — dispatch a run first' }}
            layout="wide"
            toolbar="compact"
            submitLabel={{ chat: 'Comment', agent: 'Prepare run' }}
            modePlaceholders={{
              chat: 'Add to the discussion…',
              agent: 'Tell the agent what done looks like…',
            }}
            references={[{ id: item.id, label: 'This work item' }]}
            onSend={(msg) => {
              if (mode === 'chat') return thread.postComment(msg.text);
              // Agent mode sends `/agent <text>` for hosts with an /agent
              // command path; the run's instruction is only what was typed.
              onPrepare(msg.text.replace(/^\/agent\s+/, ''));
              return true;
            }}
          />
        </Stack>
      ) : undefined}
    >
      <Stack gap="xs" className="px-4 py-2">
        {tab === 'brief' && (
          <>
            <OutcomeSection
              first
              value={item.description}
              placeholder="What does done look like?"
              readOnlyReason={readOnly}
              onChange={(v) => onPatch({ description: v })}
            />
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
            />
            <LinkedItemsSection
              title="Dependencies & decisions"
              items={links}
              emptyLabel="No decisions or pull requests linked yet"
            />
            <CommentList
              title="Planning notes"
              comments={[...notes].reverse()}
              total={notes.length}
              max={2}
              onViewAll={() => onTabChange('comments')}
              emptyLabel={threadEmpty(thread.commentsLoading, thread.commentsError, 'notes', 'No planning notes yet')}
            />
          </>
        )}
        {tab === 'comments' && (
          <CommentList
            first
            title="Discussion"
            comments={notes}
            emptyLabel={threadEmpty(thread.commentsLoading, thread.commentsError, 'discussion',
              canDispatch ? 'No comments yet — switch the composer to Chat to start one' : 'No comments yet')}
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
