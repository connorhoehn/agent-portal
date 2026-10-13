// Feedback — the question queue. Every question exists because a dimension's
// claimed level reaches further than verification does, or the evidence left
// something unclear (docs/assessment-tenant.md). One row per question, the
// dimension by name, and a row opens the question as a page
// (`/assessment/feedback/:taskId`, the queue as the list rail beside it) that
// puts the question next to what it is about: the two tracks, the evidence on
// file, and the answer. Never a drawer (docs/layout-cascade.md rule 5).
//
// It used to be one ~200px card per question — the same boilerplate sentence
// twenty-five times under "Dim 4" — with the answer form pushing everything
// below it down the page (docs/assessment-ux-goal.md, slice 2).
import { useEffect, useMemo, useState } from 'react';
import {
  Button,
  Chip,
  CollectionToolbar,
  DataTable,
  DetailHeader,
  DetailSection,
  EmptyState,
  ErrorState,
  Inline,
  LoadingState,
  MetaLine,
  Stack,
  StatStrip,
  T,
  Textarea,
  StatusPill,
  type StatusPillState,
} from '@connorhoehnslalom/ui-components/shared';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { CollectionRecordFrame } from '../../components/collections/CollectionRecordFrame';
import { RecordNotFound } from '../../components/UnavailableNotice';
import { useCrumbLabel } from '../../lib/crumbLabels';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { CollectionCommandHost } from '../../components/collections/CollectionCommandHost';
import { CollectionCommandPage } from '../../components/collections/CollectionCommandPage';
import { feedbackCommandAdapter } from './assessmentCollectionCommands';
import { useCapabilities } from '../../lib/capabilities';
import { useFetch } from '../../hooks/useFetch';
import { useDebouncedSearch } from '../../hooks/useDebouncedSearch';
import { useUrlState } from '../../lib/useUrlState';
import { toastError, toastSuccess } from '../../lib/toastStore';
import { sendJson } from '../../lib/writeJson';
import { feedbackActionPath, formatRelativeTime, splitOpenFeedback } from './secondaryFormat';
import type { FeedbackListResponse, FeedbackTask, HitlStatus } from './secondaryTypes';
import { useTeams } from './dashboard/useTeams';
import { useDimensionIndex } from './useDimensionIndex';
import { levelBadgeLabel, type Dimension } from './types';

// Only rendered under the "All statuses" filter — see the column below.
const STATUS_PILL: Record<HitlStatus, { state: StatusPillState; label: string }> = {
  OPEN: { state: 'warning', label: 'Open' },
  RESOLVED: { state: 'success', label: 'Answered' },
  DISMISSED: { state: 'neutral', label: 'Dismissed' },
};

const STATUS_OPTIONS: { value: HitlStatus | 'ALL'; label: string }[] = [
  { value: 'OPEN', label: 'Open' },
  { value: 'RESOLVED', label: 'Answered' },
  { value: 'DISMISSED', label: 'Dismissed' },
  { value: 'ALL', label: 'All statuses' },
];

function dimensionLabel(task: FeedbackTask, dim: Dimension | undefined): string {
  if (dim) return dim.title;
  if (task.dimension_title) return task.dimension_title;
  return task.dimension_id ? `Dimension ${task.dimension_id}` : 'General';
}

/** "Claimed L5 · verified L3" as two chips — the gap is the whole point. */
function TwoTrack({ dim }: { dim: Dimension }) {
  const cert = dim.certification;
  const claimed = cert?.claimed_level ?? null;
  const verified = cert?.verified_level ?? dim.current_level;
  return (
    <Inline gap="xs" align="center" wrap>
      <Chip size="xs" tone="neutral" title="What the team says">claimed {claimed === null ? '—' : levelBadgeLabel(claimed, dim.is_na)}</Chip>
      <Chip size="xs" tone={verified !== null && claimed !== null && verified < claimed ? 'warning' : 'success'} title="How far the evidence reaches">
        verified {verified === null ? '—' : levelBadgeLabel(verified, dim.is_na)}
      </Chip>
      {cert?.to_verify_higher && <MetaLine size="xs" tone="tertiary" items={[`to go higher: ${cert.to_verify_higher}`]} />}
    </Inline>
  );
}

function QuestionRecord({
  task, dim, teamName, onClose, onChanged,
}: { task: FeedbackTask; dim: Dimension | undefined; teamName: string; onClose: () => void; onChanged: () => void }) {
  const { can, ready } = useCapabilities();
  const canScore = ready && can('ScoreAssessment');
  const [response, setResponse] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { setResponse(''); }, [task?.task_id]);

  async function act(action: 'resolve' | 'dismiss') {
    setBusy(true);
    try {
      await sendJson(feedbackActionPath(task, action), 'POST', action === 'resolve' ? { response } : undefined);
      toastSuccess(null, action === 'resolve' ? 'Answer recorded' : 'Dismissed');
      onChanged();
      onClose();
    } catch (err) {
      toastError(null, `Couldn't ${action}`, (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const evidence = dim?.evidence ?? [];
  return (
    <Stack gap="lg" data-testid="assessment-question-record">
      <DetailHeader
        title={dimensionLabel(task, dim)}
        badge={<StatusPill size="sm" state={STATUS_PILL[task.status].state} label={STATUS_PILL[task.status].label} />}
        description={`${teamName}${task.team_id ? ` · ${task.team_id}` : ''}`}
      />
        <Stack gap="md">
          {dim && (
            <DetailSection first title="Where the dimension stands">
              <Stack gap="xs">
                <TwoTrack dim={dim} />
                {dim.certification?.statement && (
                  <MetaLine size="xs" tone="secondary" items={[dim.certification.statement]} />
                )}
              </Stack>
            </DetailSection>
          )}
          <DetailSection first={!dim} title="The question">
            <Stack gap="xs">
              <MetaLine size="sm" tone="secondary" items={[task.question]} />
              <MetaLine
                size="xs"
                tone="tertiary"
                items={[task.source ? `raised by ${task.source}` : 'raised by the assessment', formatRelativeTime(task.created_at)]}
              />
            </Stack>
          </DetailSection>
          {task.status !== 'OPEN' && (
            <DetailSection title={task.status === 'RESOLVED' ? 'Answer on file' : 'Dismissed'}>
              <Stack gap="xs">
                {task.response && <MetaLine size="sm" tone="secondary" items={[task.response]} />}
                <MetaLine size="xs" tone="tertiary" items={[task.resolved_by ?? null, formatRelativeTime(task.resolved_at)].filter((x): x is string => !!x)} />
              </Stack>
            </DetailSection>
          )}
          {task.status === 'OPEN' && canScore && (
            <DetailSection title="Record what the team said">
              <Textarea
                value={response}
                onChange={(e) => setResponse(e.target.value)}
                placeholder="What the team said…"
                rows={4}
              />
            </DetailSection>
          )}
          {dim && (
            <DetailSection title={`Evidence on file · ${evidence.length}`}>
              {evidence.length === 0 ? (
                <MetaLine size="xs" tone="tertiary" items={['Nothing on file for this dimension yet — the answer alone will not move verification.']} />
              ) : (
                <Stack gap="xs">
                  {evidence.slice(0, 4).map((ev) => (
                    <Inline key={ev.evidence_id} gap="xs" align="start" wrap={false}>
                      <Chip size="xs" tone={ev.scored ? 'success' : 'neutral'}>{ev.source_type}</Chip>
                      <MetaLine size="xs" tone="secondary" items={[ev.excerpt.length > 140 ? `${ev.excerpt.slice(0, 140)}…` : ev.excerpt]} />
                    </Inline>
                  ))}
                  {evidence.length > 4 && <MetaLine size="xs" tone="tertiary" items={[`and ${evidence.length - 4} more`]} />}
                </Stack>
              )}
            </DetailSection>
          )}
          {task.team_id && (
            <Link
              to={`/assessment/teams/${encodeURIComponent(task.team_id)}?tab=evidence`}
              className="text-xs font-semibold text-accent hover:underline"
            >
              Add the evidence →
            </Link>
          )}
          {task.status === 'OPEN' && canScore && (
            <Inline justify="between" gap="sm" align="center">
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => void act('dismiss')}>Dismiss</Button>
              <Button size="sm" disabled={busy || !response.trim()} onClick={() => void act('resolve')}>
                {busy ? 'Recording…' : 'Record answer'}
              </Button>
            </Inline>
          )}
        </Stack>
    </Stack>
  );
}

export default function FeedbackPage() {
  // Filters live in the URL — `?status=&team=&q=` — so a filtered feedback
  // queue is a shareable link and survives a reload.
  const [status, setStatus] = useUrlState<HitlStatus | 'ALL'>(
    'status',
    (raw) => (STATUS_OPTIONS.some((o) => o.value === raw) ? (raw as HitlStatus | 'ALL') : 'OPEN'),
    (v) => (v === 'OPEN' ? null : v),
  );
  const [team, setTeam] = useUrlState<string>(
    'team',
    (raw) => raw ?? 'all',
    (v) => (v === 'all' ? null : v),
  );
  const [search, setSearch] = useUrlState<string>(
    'q',
    (raw) => raw ?? '',
    (v) => (v ? v : null),
  );
  const { searchText, onSearchChange, cancelPending: cancelSearchPending } =
    useDebouncedSearch(search, setSearch, 250);
  // The open question is the URL (`/assessment/feedback/:taskId`), the queue's filters ride along.
  const { taskId } = useParams<{ taskId?: string }>();
  const selectedId = taskId ?? null;
  const navigate = useNavigate();
  const location = useLocation();
  const openQuestion = (id: string) => navigate(`/assessment/feedback/${encodeURIComponent(id)}${location.search}`);
  const closeQuestion = () => navigate(`/assessment/feedback${location.search}`);

  const feedbackUrl = useMemo(() => {
    const params = new URLSearchParams();
    if (status !== 'ALL') params.set('status', status);
    return `/api/assessment/feedback?${params.toString()}`;
  }, [status]);
  const { data, isLoading: loading, error, degraded, refresh: load } = useFetch<FeedbackListResponse>(feedbackUrl);

  const tasks = useMemo(() => data?.tasks ?? [], [data]);
  const { teams } = useTeams();
  const nameById = useMemo(() => new Map(teams.map((t) => [t.id, t.name])), [teams]);
  const teamIds = useMemo(() => Array.from(new Set(tasks.map((t) => t.team_id).filter((x): x is string => !!x))), [tasks]);
  const { index } = useDimensionIndex(teamIds);
  const dimOf = (task: FeedbackTask): Dimension | undefined =>
    task.team_id && task.dimension_id ? index.get(task.team_id)?.get(task.dimension_id) : undefined;
  const teamNameOf = (task: FeedbackTask): string =>
    task.team_name ?? (task.team_id ? nameById.get(task.team_id) : undefined) ?? task.team_id ?? 'No team';

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return tasks.filter((t) => {
      if (team !== 'all' && t.team_id !== team) return false;
      if (!q) return true;
      const dim = dimOf(t);
      return t.question.toLowerCase().includes(q) || dimensionLabel(t, dim).toLowerCase().includes(q) || teamNameOf(t).toLowerCase().includes(q);
    });
    // dimOf/teamNameOf close over `index`/`nameById`, listed below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, team, search, index, nameById]);

  // A `follow_up` is a question the TEAM owes the assessment — the thing this
  // page's own title, description and "click a row to answer it" hint all
  // describe. An `exception_review` is the opposite direction: a decision the
  // ASSESSOR owes, approved or denied rather than answered.
  //
  // Counting both as "Open questions" made three things wrong at once. The
  // number disagreed with the dashboard's own Questions-open tile (25 here
  // against 24 there, for what reads as the same queue) because that tile
  // counts follow-ups only; the label called a decision a question; and the
  // kind was rendered nowhere at all, so the odd row was indistinguishable
  // from the other twenty-four.
  const { questions: openQuestions, decisions: openDecisions } =
    splitOpenFeedback(tasks);
  const openCount = openQuestions.length;
  const selected = rows.find((t) => t.task_id === selectedId) ?? tasks.find((t) => t.task_id === selectedId) ?? null;
  const teamOptions = [{ value: 'all', label: 'All teams' }, ...teamIds.map((id) => ({ value: id, label: nameById.get(id) ?? id }))];

  const adapter = feedbackCommandAdapter(rows, {
    setQuery: (value) => { cancelSearchPending(); setSearch(value); },
    setStatus,
    clearTeam: () => setTeam('all'),
    refresh: load,
    openQuestion,
  });

  useCrumbLabel(selectedId ?? undefined, selected ? dimensionLabel(selected, dimOf(selected)) : null);
  if (selectedId) {
    return (
      <CollectionRecordFrame
        title="Question queue"
        listTitle="Questions"
        listLabel="questions"
        {...(data ? { count: rows.length } : {})}
        search={{ value: searchText, onChange: onSearchChange, placeholder: 'Find a question' }}
        groups={[...new Set(rows.map((t) => teamNameOf(t)))].map((name) => ({ id: name, title: name, count: rows.filter((t) => teamNameOf(t) === name).length }))}
        rows={rows.map((t) => ({ id: t.task_id, groupId: teamNameOf(t), title: dimensionLabel(t, dimOf(t)), subline: t.question }))}
        currentId={selected?.task_id ?? null}
        onOpen={openQuestion}
        loading={loading && !data}
        error={error}
        onRetry={load}
        footer={<CollectionCommandHost adapter={adapter} />}
        data-testid="assessment-question-explorer"
      >
        {selected ? (
          <QuestionRecord key={selected.task_id} task={selected} dim={dimOf(selected)} teamName={teamNameOf(selected)} onClose={closeQuestion} onChanged={load} />
        ) : loading || !data ? (
          <LoadingState label="Loading question…" />
        ) : (
          <RecordNotFound heading="Question" title="Question not found"
            body={status === 'ALL' ? `No question has the id "${selectedId}".` : `No ${STATUS_OPTIONS.find((o) => o.value === status)?.label.toLowerCase()} question has the id "${selectedId}" — it may have been answered or dismissed.`}
            backLabel="Question queue" onBack={closeQuestion} />
        )}
      </CollectionRecordFrame>
    );
  }

  return (
    <CollectionCommandPage
      data-testid="assessment-feedback"
      title="Question queue"
      description="Every question a team still owes the assessment. Answering closes the question; the evidence behind the answer is what moves verification."
    >
      <Stack gap="none" className="min-h-0 min-w-0 flex-1">
      <Stack gap="md" className="min-h-0 flex-1 overflow-auto px-[var(--ui-page-gutter)] pb-4">
      <StatStrip
        aria-label="Queue summary"
        variant="line"
        items={[
          { label: openCount === 1 ? 'open question' : 'open questions', value: openCount, ...(openCount > 0 ? { tone: 'danger' as const } : {}) },
          // Not folded into the count above and not hidden either: these are
          // real open work, they are just yours rather than the team.
          ...(openDecisions.length > 0
            ? [{ label: 'waiting on you', value: openDecisions.length, tone: 'accent' as const }]
            : []),
          { label: 'showing', value: rows.length },
        ]}
      />
      <CollectionToolbar
        label="Question filters"
        search={{ value: searchText, onChange: onSearchChange, placeholder: 'Search questions, dimensions or teams…', 'aria-label': 'Search questions' }}
        filters={[
          // OPEN is the queue's default, so it is the filter's "no restriction" value.
          { id: 'status', label: 'Status', value: status, emptyValue: 'OPEN', onChange: (v) => setStatus((v || 'OPEN') as HitlStatus | 'ALL'), options: STATUS_OPTIONS },
          { id: 'team', label: 'Team', value: team, emptyValue: 'all', onChange: (v) => setTeam(v || 'all'), options: teamOptions },
        ]}
        onRefresh={load}
        refreshing={loading}
      />

      {/* See the shared list-page loading pattern comment in QueuePage.tsx —
          the filter toolbar above stays mounted; only the table body needs
          the skeleton. */}
      {error ? (
        <ErrorState title="Couldn't load the queue" description={error} actionLabel="Retry" onAction={load} />
      ) : degraded ? (
        <UnavailableNotice
          error={degraded}
          what="the question queue"
          source="Feedback tasks are read from the assessment database"
          onRetry={load}
        />
      ) : (
        <DataTable<FeedbackTask>
          data={rows}
          keyField={(t) => t.task_id}
          onRowClick={(t) => openQuestion(t.task_id)}
          striped
          loading={loading && !data}
          // The full question queue across every team — 20 is a full-page
          // screenful.
          pageSize={20}
          emptyMessage={tasks.length === 0 ? (status === 'OPEN' ? 'No open questions.' : 'No questions with this status.') : 'No questions match the current filters.'}
          columns={[
            {
              key: 'team_id', header: 'Team', sortable: true,
              render: (t) => <T size="sm" weight="medium">{teamNameOf(t)}</T>,
            },
            { key: 'id', header: 'ID', render: (t) => <T size="xs" tone="tertiary">{t.team_id ?? '—'}</T> },
            { key: 'dimension_id', header: 'Dimension', sortable: true, render: (t) => <T size="sm">{dimensionLabel(t, dimOf(t))}</T> },
            {
              key: 'kind', header: 'Kind', sortable: true,
              render: (t) => (t.kind === 'follow_up'
                ? <Chip size="xs" tone="neutral">question</Chip>
                : <Chip size="xs" tone="warning">{t.kind.replace(/_/g, ' ')}</Chip>),
            },
            {
              key: 'question', header: 'Question',
              render: (t) => <T size="sm" title={t.question}>{t.question.length > 72 ? `${t.question.slice(0, 72)}…` : t.question}</T>,
            },
            { key: 'created_at', header: 'Raised', sortable: true, numeric: true, render: (t) => <T size="sm" className="justify-end" title={t.source ? `source: ${t.source}` : undefined}>{formatRelativeTime(t.created_at)}</T> },
            // Status earns its width only when the rows can disagree. Under
            // the default OPEN filter every row is open and the column just
            // restated the filter, so it was removed — but under All
            // statuses" the rows genuinely differ and dropping it left no way
            // to tell an open question from an answered one. Conditional, not
            // deleted.
            ...(status === 'ALL'
              ? [{
                  key: 'status',
                  header: 'Status',
                  sortable: true,
                  render: (t: FeedbackTask) => <StatusPill size="sm" state={STATUS_PILL[t.status].state} label={STATUS_PILL[t.status].label} />,
                }]
              : []),
          ]}
        />
      )}

      </Stack>
      <CollectionCommandHost adapter={adapter} />
      </Stack>
    </CollectionCommandPage>
  );
}
