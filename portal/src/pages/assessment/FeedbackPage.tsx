// Feedback — the question queue. Every question exists because a dimension's
// claimed level reaches further than verification does, or the evidence left
// something unclear (docs/assessment-tenant.md). One row per question, the
// dimension by name, and a drawer that puts the question next to what it is
// about: the two tracks, the evidence on file, and the answer.
//
// It used to be one ~200px card per question — the same boilerplate sentence
// twenty-five times under "Dim 4" — with the answer form pushing everything
// below it down the page (docs/assessment-ux-goal.md, slice 2).
import { useEffect, useMemo, useState } from 'react';
import {
  Button,
  Chip,
  DataTable,
  DetailSection,
  Drawer,
  EmptyState,
  ErrorState,
  Inline,
  Input,
  MetaLine,
  PageHeader,
  Select,
  Stack,
  StatStrip,
  Textarea,
  StatusPill,
  type StatusPillState,
} from '@connorhoehnslalom/ui-components/shared';
import { Link } from 'react-router';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { useCapabilities } from '../../lib/capabilities';
import { useFetch } from '../../hooks/useFetch';
import { useDebouncedSearch } from '../../hooks/useDebouncedSearch';
import { useUrlState } from '../../lib/useUrlState';
import { toastError, toastSuccess } from '../../lib/toastStore';
import { sendJson } from '../../lib/writeJson';
import { feedbackActionPath, formatRelativeTime } from './secondaryFormat';
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

function QuestionDrawer({
  task, dim, teamName, onClose, onChanged,
}: { task: FeedbackTask | null; dim: Dimension | undefined; teamName: string; onClose: () => void; onChanged: () => void }) {
  const { can, ready } = useCapabilities();
  const canScore = ready && can('ScoreAssessment');
  const [response, setResponse] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { setResponse(''); }, [task?.task_id]);

  async function act(action: 'resolve' | 'dismiss') {
    if (!task) return;
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
    <Drawer
      open={task !== null}
      onClose={onClose}
      title={task ? dimensionLabel(task, dim) : ''}
      subtitle={task ? `${teamName}${task.team_id ? ` · ${task.team_id}` : ''}` : undefined}
      width={560}
      footer={task && task.status === 'OPEN' && canScore ? (
        <Inline justify="between" gap="sm" align="center">
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void act('dismiss')}>Dismiss</Button>
          <Button size="sm" disabled={busy || !response.trim()} onClick={() => void act('resolve')}>
            {busy ? 'Recording…' : 'Record answer'}
          </Button>
        </Inline>
      ) : undefined}
    >
      {task && (
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
        </Stack>
      )}
    </Drawer>
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
  const [selectedId, setSelectedId] = useState<string | null>(null);

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

  const openCount = tasks.filter((t) => t.status === 'OPEN').length;
  const teamsWithOpen = new Set(tasks.filter((t) => t.status === 'OPEN').map((t) => t.team_id)).size;
  const selected = rows.find((t) => t.task_id === selectedId) ?? tasks.find((t) => t.task_id === selectedId) ?? null;
  const teamOptions = [{ value: 'all', label: 'All teams' }, ...teamIds.map((id) => ({ value: id, label: nameById.get(id) ?? id }))];

  return (
    <Stack gap="md">
      <PageHeader
        title="Question queue"
        description="Every question a team still owes the assessment. Answering closes the question; the evidence behind the answer is what moves verification."
      />
      <StatStrip
        aria-label="Queue summary"
        items={[
          { label: 'Open questions', value: openCount, tone: openCount > 0 ? 'danger' : 'default', hint: `across ${teamsWithOpen} team${teamsWithOpen === 1 ? '' : 's'}` },
          { label: 'Showing', value: rows.length, hint: status === 'ALL' ? 'all statuses' : STATUS_OPTIONS.find((o) => o.value === status)?.label.toLowerCase() ?? '' },
        ]}
      />
      <Inline align="center" gap="sm" wrap>
        <Select
          size="sm"
          className="w-40"
          aria-label="Status"
          value={status}
          onChange={(e) => setStatus(e.target.value as HitlStatus | 'ALL')}
          options={STATUS_OPTIONS}
        />
        <Select
          size="sm"
          className="w-56"
          aria-label="Team"
          value={team}
          onChange={(e) => setTeam(e.target.value)}
          options={teamOptions}
        />
        <Input
          type="text"
          value={searchText}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search questions, dimensions or teams…"
          className="w-[320px]"
        />
        {(team !== 'all' || search) && (
          <Button variant="ghost" size="sm" onClick={() => { setTeam('all'); cancelSearchPending(); setSearch(''); }}>Clear filters</Button>
        )}
        <MetaLine size="xs" tone="tertiary" className="ml-auto" items={['click a row to answer it']} />
      </Inline>

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
          onRowClick={(t) => setSelectedId(t.task_id)}
          striped
          loading={loading && !data}
          // The full question queue across every team — 20 is a full-page
          // screenful.
          pageSize={20}
          emptyMessage={tasks.length === 0 ? (status === 'OPEN' ? 'No open questions.' : 'No questions with this status.') : 'No questions match the current filters.'}
          columns={[
            {
              key: 'team_id', header: 'Team', sortable: true,
              render: (t) => (
                <Stack gap="none" align="start">
                  <Button variant="ghost" size="sm" className="px-0 font-semibold text-text-primary" onClick={(e) => { e.stopPropagation(); setSelectedId(t.task_id); }}>
                    {teamNameOf(t)}
                  </Button>
                  {t.team_id && <MetaLine size="xs" tone="tertiary" items={[t.team_id]} />}
                </Stack>
              ),
            },
            { key: 'dimension_id', header: 'Dimension', sortable: true, render: (t) => dimensionLabel(t, dimOf(t)) },
            {
              key: 'question', header: 'Question',
              render: (t) => <MetaLine size="xs" tone="secondary" items={[t.question.length > 96 ? `${t.question.slice(0, 96)}…` : t.question]} />,
            },
            { key: 'created_at', header: 'Raised', sortable: true, render: (t) => <MetaLine size="xs" tone="tertiary" items={[formatRelativeTime(t.created_at), t.source ?? null].filter((x): x is string => !!x)} /> },
            // Status earns its width only when the rows can disagree. Under
            // the default OPEN filter every row is open and the column just
            // restated the filter, so it was removed — but under "All
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

      <QuestionDrawer
        task={selected}
        dim={selected ? dimOf(selected) : undefined}
        teamName={selected ? teamNameOf(selected) : ''}
        onClose={() => setSelectedId(null)}
        onChanged={load}
      />
    </Stack>
  );
}
