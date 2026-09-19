// Runs / Activity — the run ledger. A DataTable of every recorded run, a detail Drawer
// with the progress/result envelope and a Stop action, and a "Run a command" panel that
// lists the deployed Strands tools and collects each command
// source before reserving a run (docs/assessment-tenant.md "Agentic support"). Launch responses are mapped per docs/agent-runs.md §1: 202 toasts
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
  InlineAlert,
  MetaLine,
  Modal,
  FormField,
  Textarea,
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
import type { AgentCommand, AgentCommandsResponse, RunRecord, RunsListResponse, SubmissionsListResponse } from './secondaryTypes';

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
  const [preparing, setPreparing] = useState<string | null>(null);
  const [sourceText, setSourceText] = useState('');
  const [submissionId, setSubmissionId] = useState('');
  const [recommendationId, setRecommendationId] = useState('');
  type Recommendation = { dimension_id: string; kind: string; title: string; rationale: string };
  const recommendations = useFetch<{ recommendations: Recommendation[] }>(
    preparing === 'develop-jira-story' && teamId ? `/api/assessment/teams/${encodeURIComponent(teamId)}/recommendations` : null);
  const submissions = useFetch<SubmissionsListResponse>(preparing === 'process-self-assessment' ? '/api/assessment/submissions' : null);
  const needsSource = preparing !== null && !['score-dimensions', 'process-self-assessment', 'develop-jira-story'].includes(preparing);
  const recommendation = recommendations.data?.recommendations.find(r => r.dimension_id === recommendationId);
  const validInput = needsSource ? sourceText.trim().length > 0
    : preparing === 'process-self-assessment' ? !!submissionId
    : preparing === 'develop-jira-story' ? !!recommendation : true;


  async function launch(command: string) {
    if (!canRun || !teamId || !validInput) return;
    setLaunching(command);
    try {
      const res = await fetch('/api/assessment/runs', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command, args: { team: teamId,
          ...(needsSource ? { document: { text: sourceText } } : {}),
          ...(command === 'process-self-assessment' ? { submission: submissionId } : {}),
          ...(command === 'develop-jira-story' ? { recommendation } : {}),
        }, team_id: teamId }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      const outcome = launchResponseMessage(res.status, body.error);
      if (outcome.ok) {
        toastSuccess(null, 'Run started', `${command} for ${teamId}.`);
        setPreparing(null);
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
    <PageSection title="Run a command" description="Choose a command and its source. Draft results stay in the run ledger for review; publishing is a separate action.">
      <Inline align="center" gap="sm" className="mb-3">
        <Select
          aria-label="Assessment team"
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
          // The command registry is small today but not bounded by contract
          // — 15 keeps a growing registry a scan, not a scroll.
          pageSize={15}
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
                <Button size="sm" aria-label={`Prepare ${cmd.name}`} disabled={!teamId || launching === cmd.name} onClick={() => { setPreparing(cmd.name); setSourceText(''); setSubmissionId(''); setRecommendationId(''); }}>
                  {launching === cmd.name ? 'Starting…' : 'Run'}
                </Button>
              ) : null),
            },
          ]}
        />
      )}
      <Modal open={preparing !== null} onClose={() => setPreparing(null)} title={preparing ?? 'Prepare command'}
        footer={<Inline gap="sm" justify="end">
          <Button variant="ghost" onClick={() => setPreparing(null)} disabled={launching !== null}>Cancel</Button>
          <Button variant="primary" disabled={!validInput || launching !== null} onClick={() => preparing && void launch(preparing)}>
            {launching ? 'Starting…' : 'Start run'}
          </Button>
        </Inline>}>
        <Stack gap="md">
          {needsSource && <FormField label="Source material" hint="Paste the document, transcript, or existing draft this command should use.">
            {({ id }) => <Textarea id={id} rows={10} value={sourceText} onChange={e => setSourceText(e.target.value)} />}
          </FormField>}
          {preparing === 'score-dimensions' && <T>Scores the team's saved evidence against the assessment rubric.</T>}
          {preparing === 'process-self-assessment' && <FormField label="Submission">
            {({ id }) => <Select id={id} value={submissionId} placeholder="Choose a committed submission…"
              onChange={e => setSubmissionId(e.target.value)} options={(submissions.data?.envelopes ?? [])
                .filter(e => e.team_id === teamId && e.status === 'committed')
                .map(e => ({ value: e.envelope_id, label: `${e.submitted_at} · ${e.envelope_id}` }))} />}
          </FormField>}
          {preparing === 'develop-jira-story' && <FormField label="Recommendation">
            {({ id }) => <Select id={id} value={recommendationId} placeholder="Choose an improvement…"
              onChange={e => setRecommendationId(e.target.value)} options={(recommendations.data?.recommendations ?? [])
                .map(r => ({ value: r.dimension_id, label: r.title }))} />}
          </FormField>}
          {(recommendations.error || submissions.error) && <InlineAlert tone="error">{recommendations.error ?? submissions.error}</InlineAlert>}
        </Stack>
      </Modal>
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
  const { events, connected, gapped } = useAssessmentEvents();
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

      {/* A gap matters more here than anywhere else in the tenant. This page
          does not re-read the ledger per event — it FOLDS run.started /
          progress / completed / failed onto it with applyRunEvent — so an
          event the replay ring could not reach is a transition that never
          arrives, and a run that finished ten minutes ago goes on rendering
          as "running" with nothing to say otherwise. Unlike the Workspace's
          notice, this one can actually fix it: `load()` re-reads the ledger
          from the server, which is the state the missed events were
          describing. applyRunEvent is idempotent, so the events already
          folded in do no harm on top of a fresh read. */}
      {gapped && (
        <InlineAlert tone="warning">
          <Inline gap="sm" align="center" wrap>
            <T>
              This tab was disconnected for longer than the live feed keeps its
              history, so some run updates were missed and cannot be replayed —
              a run shown as still going may already have finished.
            </T>
            <Button variant="secondary" size="sm" onClick={load}>Refresh the ledger</Button>
          </Inline>
        </InlineAlert>
      )}

      {/* See the shared list-page loading pattern comment in QueuePage.tsx:
          `load()` re-fires on every live run event (above), which set
          `loading` true on every event and blanked the whole table to a
          bare LoadingState on a healthy, fast-moving ledger. Gate on
          `loading && !data` — first load only — and hand that to
          DataTable's own `loading` prop instead. */}
      {error ? (
        <ErrorState title="Couldn't load activity" description={error} actionLabel="Retry" onAction={load} />
      ) : degraded ? (
        <UnavailableNotice
          error={degraded}
          what="the run ledger"
          source="Runs are read from the assessment database"
          onRetry={load}
        />
      ) : !(loading && !runsResp) && runs.length === 0 ? (
        <EmptyState title="No activity yet" />
      ) : (
        <DataTable<RunRecord>
          data={runs}
          keyField={(r) => r.id}
          striped
          onRowClick={(r) => setDetailId(r.id)}
          loading={loading && !runsResp}
          // The full run ledger accumulates for the life of the program —
          // 20 is a full-page ledger's screenful.
          pageSize={20}
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
