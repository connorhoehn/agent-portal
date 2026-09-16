// Runs / Activity — the run ledger. A DataTable of every recorded run, a detail Drawer
// with the progress/result envelope and a Stop action, and a "Run a command" panel that
// lists every launchable agent command with its tool allowlist shown in full — that
// allowlist IS the security boundary, so it is never hidden (docs/assessment-tenant.md
// "Agentic support"). Launch responses are mapped per docs/agent-runs.md §1: 202 toasts
// and adds the row, 400/403/409/429 each get their own explanation.

import { useEffect, useRef, useState } from 'react';
import {
  Button,
  Chip,
  ConnectionPill,
  DataTable,
  Drawer,
  EmptyState,
  ErrorState,
  Inline,
  LoadingState,
  MetaLine,
  PageHeader,
  Stack,
  PageSection,
  Select,
  StatusPill,
  T,
} from '@connorhoehnslalom/ui-components/shared';
import { KeyValue } from '../../components/KeyValue';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { useFetch } from '../../hooks/useFetch';
import { useCapabilities } from '../../lib/capabilities';
import { toastError, toastSuccess } from '../../lib/toastStore';
import { useTeams } from './dashboard/useTeams';
import { useAssessmentEvents } from './knowledge/useAssessmentEvents';
import { applyRunEvent, formatDuration, formatRelativeTime, launchResponseMessage, RUN_STATUS_PILL_STATE } from './secondaryFormat';
import type { AgentCommand, AgentCommandsResponse, RunRecord, RunsListResponse } from './secondaryTypes';

function RunACommandPanel({ onLaunched }: { onLaunched: () => void }) {
  const { can, ready } = useCapabilities();
  const canRun = ready && can('RunAssessmentAgent');

  const { data: commandsResp } = useFetch<AgentCommandsResponse>('/api/assessment/agent/commands');
  const commands = commandsResp?.commands ?? [];
  // Reuses the shared roster hook instead of a second `/teams` fetch this
  // panel used to run on its own — same request DashboardPage already makes.
  const { teams } = useTeams();
  const [teamId, setTeamId] = useState('');
  const [launching, setLaunching] = useState<string | null>(null);

  async function launch(command: string) {
    if (!canRun || !teamId) return;
    setLaunching(command);
    try {
      const res = await fetch('/api/assessment/runs', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command, args: { team: teamId }, team_id: teamId }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      const outcome = launchResponseMessage(res.status, body.error);
      if (outcome.ok) {
        toastSuccess(null, 'Run started', `${command} for ${teamId}.`);
        onLaunched();
      } else {
        toastError(null, 'Run not started', outcome.message);
      }
    } catch (err) {
      toastError(null, 'Run not started', (err as Error).message);
    } finally {
      setLaunching(null);
    }
  }

  return (
    <PageSection title="Run a command" description="Every command runs under a read-only tool floor — the allowlist below is the whole security boundary.">
      <Inline align="center" gap="sm" className="mb-3">
        <Select
          size="sm"
          placeholder="Choose a team…"
          value={teamId}
          onChange={(e) => setTeamId(e.target.value)}
          options={teams.map((t) => ({ value: t.id, label: `${t.name} (${t.id})` }))}
        />
      </Inline>
      {commands.length === 0 ? (
        <EmptyState title="No commands available" body="The agent command registry hasn't reported any commands yet." />
      ) : (
        <DataTable<AgentCommand>
          data={commands}
          keyField={(cmd) => cmd.name}
          columns={[
            { key: 'name', header: 'Command', render: (cmd) => <strong className="text-sm font-semibold">{cmd.name}</strong> },
            { key: 'summary', header: 'What it does', render: (cmd) => (cmd.summary ? <MetaLine size="xs" items={[cmd.summary]} /> : '—') },
            {
              key: 'tools',
              header: 'Tools',
              render: (cmd) => (
                <Inline wrap gap="xs">
                  {cmd.allowed_tools.map((tool) => (
                    <Chip key={tool} tone="neutral" size="xs" mono>{tool}</Chip>
                  ))}
                </Inline>
              ),
            },
            {
              key: 'run',
              header: '',
              render: (cmd) => (canRun ? (
                <Button size="sm" disabled={!teamId || launching === cmd.name} onClick={() => void launch(cmd.name)}>
                  {launching === cmd.name ? 'Starting…' : 'Run'}
                </Button>
              ) : null),
            },
          ]}
        />
      )}
    </PageSection>
  );
}

export default function RunsPage() {
  const { can, ready } = useCapabilities();
  const canStop = ready && can('RunAssessmentAgent');

  // The ledger read is `useFetch` (so a `degraded` envelope surfaces), but the
  // rows themselves live in local state: the SSE reducer below folds
  // run.started/progress/completed/failed onto them between fetches, and a
  // fresh GET has to be able to replace that local state wholesale on the
  // next `load()` — same contract the old hand-rolled fetch had.
  const { data: runsResp, isLoading: loading, error, degraded, refresh: load } = useFetch<RunsListResponse>('/api/assessment/runs');
  const [runs, setRuns] = useState<RunRecord[]>([]);
  useEffect(() => { if (runsResp) setRuns(runsResp.runs ?? []); }, [runsResp]);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const detail = runs.find((r) => r.id === detailId) ?? null;

  // Reactive to its own launches: the same GET /events stream the Workspace
  // explorer subscribes to (./knowledge/useAssessmentEvents.ts) carries
  // run.started/progress/completed/failed — folded onto the ledger via the
  // pure applyRunEvent reducer as they arrive, so a launch adds its row, a
  // progress tick updates it, and completion finalizes it with no manual
  // refresh (docs/assessment-goal.md §6 "Runs page reactivity"). Only the
  // events since the last render are applied — replaying the whole buffer
  // every render would be idempotent but wasteful.
  const { events, connected } = useAssessmentEvents();
  const appliedCountRef = useRef(0);
  useEffect(() => {
    if (events.length <= appliedCountRef.current) return;
    const newEvents = events.slice(appliedCountRef.current);
    appliedCountRef.current = events.length;
    setRuns((prev) => newEvents.reduce(applyRunEvent, prev));
  }, [events]);

  async function stop(run: RunRecord) {
    setStopping(true);
    try {
      const res = await fetch(`/api/assessment/runs/${encodeURIComponent(run.id)}/stop`, { method: 'POST', credentials: 'include' });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      toastSuccess(null, 'Run stopped');
      load();
    } catch (err) {
      toastError(null, 'Could not stop', (err as Error).message);
    } finally {
      setStopping(false);
    }
  }

  return (
    <Stack gap="lg">
      <PageHeader
        title="Activity"
        description="Every command run recorded in the assessment ledger, across every team and cohort."
        badge={<ConnectionPill state={connected ? 'connected' : 'connecting'} compact />}
      />

      {loading ? (
        <LoadingState label="Loading activity…" />
      ) : error ? (
        <ErrorState title="Couldn't load activity" description={error} actionLabel="Retry" onAction={load} />
      ) : degraded ? (
        <UnavailableNotice
          error={degraded}
          what="the run ledger"
          source="Runs are read from the assessment database"
          onRetry={load}
        />
      ) : runs.length === 0 ? (
        <EmptyState title="No activity yet" />
      ) : (
        <DataTable<RunRecord>
          data={runs}
          keyField={(r) => r.id}
          striped
          onRowClick={(r) => setDetailId(r.id)}
          columns={[
            {
              key: 'id',
              header: 'Run',
              // DataTable rows with onRowClick are keyboard-reachable on
              // their own now, so this is plain text, not a Button.
              render: (r) => <T className="font-mono text-xs">{r.id}</T>,
            },
            { key: 'command', header: 'Command', render: (r) => r.command },
            { key: 'team', header: 'Team', render: (r) => r.team_id ?? '—' },
            {
              key: 'status',
              header: 'Status',
              render: (r) => <StatusPill state={RUN_STATUS_PILL_STATE[r.status]} label={r.status} size="sm" />,
            },
            { key: 'started', header: 'Started', render: (r) => formatRelativeTime(r.started_at) },
            { key: 'duration', header: 'Duration', render: (r) => formatDuration(r.started_at, r.finished_at) },
          ]}
        />
      )}

      <RunACommandPanel onLaunched={load} />

      <Drawer open={detail !== null} onClose={() => setDetailId(null)} title={detail?.command} subtitle={detail?.id}>
        {detail && (
          <Stack gap="sm" className="text-sm">
            <StatusPill state={RUN_STATUS_PILL_STATE[detail.status]} label={detail.status} size="sm" />
            <KeyValue layout="row" label="Team" value={detail.team_id ?? '—'} mono />
            <KeyValue layout="row" label="Started" value={formatRelativeTime(detail.started_at)} />
            <KeyValue layout="row" label="Duration" value={formatDuration(detail.started_at, detail.finished_at)} mono />
            {detail.progress?.phase && (
              <KeyValue
                layout="row"
                label="Progress"
                value={`${detail.progress.phase}${detail.progress.detail ? ` — ${detail.progress.detail}` : ''}`}
              />
            )}
            {detail.summary && <KeyValue layout="row" label="Summary" value={detail.summary} />}
            {detail.error && (
              <KeyValue layout="row" label="Error" value={detail.error} className="text-danger" />
            )}
            {canStop && detail.status === 'running' && (
              <Button variant="danger" disabled={stopping} onClick={() => void stop(detail)}>
                {stopping ? 'Stopping…' : 'Stop'}
              </Button>
            )}
          </Stack>
        )}
      </Drawer>
    </Stack>
  );
}
