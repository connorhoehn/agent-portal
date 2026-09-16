// Runs / Activity — the run ledger. A DataTable of every recorded run, a detail Drawer
// with the progress/result envelope and a Stop action, and a "Run a command" panel that
// lists every launchable agent command with its tool allowlist shown in full — that
// allowlist IS the security boundary, so it is never hidden (docs/assessment-tenant.md
// "Agentic support"). Launch responses are mapped per docs/agent-runs.md §1: 202 toasts
// and adds the row, 400/403/409/429 each get their own explanation.

import { useEffect, useRef, useState } from 'react';
import {
  Button,
  Card,
  Chip,
  ConnectionPill,
  DataTable,
  Drawer,
  EmptyState,
  Inline,
  LoadingState,
  MetaLine,
  PageHeader,
  Stack,
  PageSection,
  Select,
  StatusPill,
} from '@connorhoehnslalom/ui-components/shared';
import { KeyValue } from '../../components/KeyValue';
import { useCapabilities } from '../../lib/capabilities';
import { toastError, toastSuccess } from '../../lib/toastStore';
import { useAssessmentEvents } from './knowledge/useAssessmentEvents';
import { applyRunEvent, formatDuration, formatRelativeTime, launchResponseMessage } from './secondaryFormat';
import type { AgentCommand, AgentCommandsResponse, RunRecord, RunStatus, RunsListResponse, TeamOption } from './secondaryTypes';

const STATUS_STATE: Record<RunStatus, 'info' | 'success' | 'error'> = {
  running: 'info',
  completed: 'success',
  failed: 'error',
};

function RunACommandPanel({ onLaunched }: { onLaunched: () => void }) {
  const { can, ready } = useCapabilities();
  const canRun = ready && can('RunAssessmentAgent');

  const [commands, setCommands] = useState<AgentCommand[]>([]);
  const [teams, setTeams] = useState<TeamOption[]>([]);
  const [teamId, setTeamId] = useState('');
  const [launching, setLaunching] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/assessment/agent/commands', { credentials: 'include' })
      .then((res) => (res.ok ? res.json() : { commands: [] }))
      .then((body: AgentCommandsResponse) => setCommands(body.commands ?? []))
      .catch(() => setCommands([]));
    fetch('/api/assessment/teams', { credentials: 'include' })
      .then((res) => (res.ok ? res.json() : []))
      .then((body: unknown) => {
        const list = Array.isArray(body) ? body : Array.isArray((body as { teams?: unknown })?.teams) ? (body as { teams: unknown[] }).teams : [];
        setTeams(list as TeamOption[]);
      })
      .catch(() => setTeams([]));
  }, []);

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
        <Stack gap="sm">
          {commands.map((cmd) => (
            <Card key={cmd.name} padding="sm">
              <Inline justify="between" align="center" wrap gap="sm">
                <Stack gap="none">
                  <strong className="text-sm font-semibold">{cmd.name}</strong>
                  {cmd.summary && <MetaLine size="xs" items={[cmd.summary]} />}
                </Stack>
                {canRun && (
                  <Button size="sm" disabled={!teamId || launching === cmd.name} onClick={() => void launch(cmd.name)}>
                    {launching === cmd.name ? 'Starting…' : 'Run'}
                  </Button>
                )}
              </Inline>
              <Inline wrap gap="xs" className="mt-2">
                {cmd.allowed_tools.map((tool) => (
                  <Chip key={tool} tone="neutral" size="xs" mono>{tool}</Chip>
                ))}
              </Inline>
            </Card>
          ))}
        </Stack>
      )}
    </PageSection>
  );
}

export default function RunsPage() {
  const { can, ready } = useCapabilities();
  const canStop = ready && can('RunAssessmentAgent');

  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const detail = runs.find((r) => r.id === detailId) ?? null;

  function load() {
    fetch('/api/assessment/runs', { credentials: 'include' })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((body: RunsListResponse) => { setRuns(body.runs ?? []); setError(null); })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }

  useEffect(() => { load(); }, []);

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
        <EmptyState title="Couldn't load activity" body={error} actionLabel="Retry" onAction={load} />
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
              // A real Button, not just the row's onClick — DataTable's
              // row-click is a bare <tr onClick> with no keyboard handling.
              render: (r) => (
                <Button variant="ghost" size="sm" className="font-mono text-xs" onClick={(e) => { e.stopPropagation(); setDetailId(r.id); }}>
                  {r.id}
                </Button>
              ),
            },
            { key: 'command', header: 'Command', render: (r) => r.command },
            { key: 'team', header: 'Team', render: (r) => r.team_id ?? '—' },
            {
              key: 'status',
              header: 'Status',
              render: (r) => <StatusPill state={STATUS_STATE[r.status]} label={r.status} size="sm" />,
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
            <StatusPill state={STATUS_STATE[detail.status]} label={detail.status} size="sm" />
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
