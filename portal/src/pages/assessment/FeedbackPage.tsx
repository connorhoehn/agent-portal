// Feedback — open follow-ups across every team, grouped by team. Every question here
// exists because a dimension's claimed level reaches further than verification does, or
// because the evidence left something unclear (docs/assessment-tenant.md). Answering
// records the answer; the evidence behind it is what actually moves verification, which
// is why every group links straight to that team's Evidence tab.

import { useEffect, useMemo, useState } from 'react';
import {
  Button,
  Card,
  Chip,
  EmptyState,
  Inline,
  LoadingState,
  MetaLine,
  PageHeader,
  SectionLabel,
  Stack,
  Select,
  Textarea,
} from '@connorhoehnslalom/ui-components/shared';
import { Link } from 'react-router';
import { useCapabilities } from '../../lib/capabilities';
import { toastError, toastSuccess } from '../../lib/toastStore';
import { feedbackActionPath, formatRelativeTime } from './secondaryFormat';
import type { FeedbackListResponse, FeedbackTask, HitlStatus } from './secondaryTypes';
import { useTeams } from './dashboard/useTeams';

const STATUS_OPTIONS: { value: HitlStatus | 'ALL'; label: string }[] = [
  { value: 'OPEN', label: 'Open' },
  { value: 'RESOLVED', label: 'Answered' },
  { value: 'DISMISSED', label: 'Dismissed' },
  { value: 'ALL', label: 'All statuses' },
];

function QuestionCard({ task, onChanged }: { task: FeedbackTask; onChanged: () => void }) {
  const { can, ready } = useCapabilities();
  const canScore = ready && can('ScoreAssessment');
  const [responding, setResponding] = useState(false);
  const [response, setResponse] = useState('');
  const [busy, setBusy] = useState(false);

  async function act(action: 'resolve' | 'dismiss') {
    setBusy(true);
    try {
      const res = await fetch(feedbackActionPath(task, action), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: action === 'resolve' ? JSON.stringify({ response }) : undefined,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      toastSuccess(null, action === 'resolve' ? 'Answer recorded' : 'Dismissed');
      setResponding(false);
      onChanged();
    } catch (err) {
      toastError(null, `Couldn't ${action}`, (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card padding="md">
      {task.title && <strong className="block text-sm font-bold">{task.title}</strong>}
      <Stack gap="none" className="text-sm">{task.question}</Stack>
      <Inline gap="sm" wrap align="center" className="mt-2 text-xs text-text-tertiary">
        {/* "Raised by unknown" is a sentence that says nothing. Name the
            source when there is one; otherwise just say when. */}
        <span>
          {task.source && (
            <>Raised by <strong className="font-semibold text-text-secondary">{task.source}</strong> · </>
          )}
          {formatRelativeTime(task.created_at)}
        </span>
        {task.dimension_id && <Chip tone="neutral" size="xs">Dim {task.dimension_id}</Chip>}
      </Inline>

      {task.status !== 'OPEN' && (
        <Card padding="sm" className="mt-2 bg-surface-secondary">
          <SectionLabel>{task.status === 'RESOLVED' ? 'Answer on file' : 'Dismissed'}</SectionLabel>
          {task.response && <Stack gap="none" className="mt-1 text-sm">{task.response}</Stack>}
          <Stack gap="none" className="mt-1 text-xs text-text-tertiary">
            {task.resolved_by ? `${task.resolved_by} · ` : ''}
            {formatRelativeTime(task.resolved_at)}
          </Stack>
        </Card>
      )}

      {canScore && task.status === 'OPEN' && !responding && (
        <Inline gap="sm" className="mt-3">
          <Button size="sm" onClick={() => setResponding(true)}>Record answer</Button>
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void act('dismiss')}>Dismiss</Button>
        </Inline>
      )}

      {canScore && task.status === 'OPEN' && responding && (
        <Stack gap="sm" className="mt-3">
          <Textarea
            value={response}
            onChange={(e) => setResponse(e.target.value)}
            placeholder="What the team said…"
            rows={3}
          />
          <Inline justify="end" gap="sm">
            <Button size="sm" variant="secondary" onClick={() => setResponding(false)} disabled={busy}>Cancel</Button>
            <Button size="sm" disabled={busy || !response.trim()} onClick={() => void act('resolve')}>
              {busy ? 'Recording…' : 'Record answer'}
            </Button>
          </Inline>
        </Stack>
      )}

      {task.team_id && (
        <Inline className="mt-3">
          <Link
            to={`/assessment/teams/${encodeURIComponent(task.team_id)}?tab=evidence`}
            className="text-xs font-semibold text-accent hover:underline"
          >
            Add the evidence →
          </Link>
        </Inline>
      )}
    </Card>
  );
}

export default function FeedbackPage() {
  const [status, setStatus] = useState<HitlStatus | 'ALL'>('OPEN');
  const [data, setData] = useState<FeedbackListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  function load() {
    setLoading(true);
    const params = new URLSearchParams();
    if (status !== 'ALL') params.set('status', status);
    fetch(`/api/assessment/feedback?${params.toString()}`, { credentials: 'include' })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((body: FeedbackListResponse) => { setData(body); setError(null); })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }

  useEffect(load, [status]);

  const tasks = data?.tasks ?? [];

  // Feedback rows carry only a team id; the heading wants the team's NAME,
  // which the roster already has — otherwise the group reads "TEAM-002" twice.
  const { teams } = useTeams();
  const nameById = useMemo(() => new Map(teams.map((t) => [t.id, t.name])), [teams]);

  const byTeam = useMemo(() => {
    const groups = new Map<string, { teamId: string | null; teamName: string; tasks: FeedbackTask[] }>();
    tasks.forEach((task) => {
      const key = task.team_id ?? '__none__';
      const existing = groups.get(key);
      if (existing) existing.tasks.push(task);
      else {
        const teamName = task.team_name ?? (task.team_id ? nameById.get(task.team_id) : undefined) ?? task.team_id ?? 'No team';
        groups.set(key, { teamId: task.team_id, teamName, tasks: [task] });
      }
    });
    return Array.from(groups.values()).sort((a, b) => b.tasks.length - a.tasks.length);
  }, [tasks, nameById]);

  return (
    <Stack gap="lg">
      <PageHeader
        title="Needs Feedback"
        description="Every question exists because a claim reaches further than verification does, or the evidence left something unclear. Answering closes the question; the evidence behind the answer is what moves verification."
      />

      <Inline align="center" gap="sm" justify="between">
        <Select
          size="sm"
          className="w-48"
          value={status}
          onChange={(e) => setStatus(e.target.value as HitlStatus | 'ALL')}
          options={STATUS_OPTIONS}
        />
        <MetaLine
          size="xs"
          items={[`${tasks.filter((t) => t.status === 'OPEN').length} open across ${byTeam.length} team${byTeam.length === 1 ? '' : 's'}`]}
        />
      </Inline>

      {loading ? (
        <LoadingState label="Loading feedback…" />
      ) : error ? (
        <EmptyState title="Couldn't load the feedback queue" body={error} actionLabel="Retry" onAction={load} />
      ) : byTeam.length === 0 ? (
        <EmptyState title="No matching questions" body={status === 'OPEN' ? 'No open questions.' : undefined} />
      ) : (
        <Stack gap="lg">
          {byTeam.map((group) => (
            <Stack as="section" key={group.teamId ?? '__none__'} gap="sm">
              <Inline as="header" align="center" gap="sm">
                <strong className="text-base font-bold">{group.teamName}</strong>
                {group.teamId && <Chip tone="neutral" size="xs">{group.teamId}</Chip>}
                <MetaLine size="xs" items={[`${group.tasks.length} question${group.tasks.length === 1 ? '' : 's'}`]} />
              </Inline>
              <Stack gap="sm">
                {group.tasks.map((task) => (
                  <QuestionCard key={task.task_id} task={task} onChanged={load} />
                ))}
              </Stack>
            </Stack>
          ))}
        </Stack>
      )}
    </Stack>
  );
}
