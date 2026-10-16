// Runs / Activity — the run ledger. A DataTable of every recorded run; a row opens the
// run as a page (`/assessment/runs/:runId`, the ledger as the list rail beside it) with
// the progress/result envelope and a Stop action, a "Pipeline runs" section (the
// same runs in the pipelines ledger, via /api/assessment/pipeline-runs), and a "Run a command" panel that
// lists the deployed Strands tools and collects each command
// source before reserving a run (docs/assessment-tenant.md "Agentic support"). Launch responses are mapped per docs/agent-runs.md §1: 202 toasts
// and adds the row, 400/403/409/429 each get their own explanation.

import { useEffect, useRef, useState } from 'react';
import {
  Button,
  Chip,
  ConnectionPill,
  DataTable,
  DetailHeader,
  EmptyState,
  ErrorState,
  Inline,
  IconButton,
  InlineAlert,
  Modal,
  FormField,
  Textarea,
  PageHeader,
  Stack,
  PageSection,
  PlayCircleIcon,
  Select,
  StatusPill,
  T,
} from '@connorhoehnslalom/ui-components/shared';
import { useNavigate, useParams } from 'react-router';
import { KeyValue } from '../../components/KeyValue';
import { RecordLink } from '../decisions/RecordLink';
import { CollectionRecordFrame } from '../../components/collections/CollectionRecordFrame';
import { RecordNotFound } from '../../components/UnavailableNotice';
import { useCrumbLabel } from '../../lib/crumbLabels';
import { RunsLedger } from '../../components/runs/RunsLedger';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { useFetch } from '../../hooks/useFetch';
import { useCapabilities } from '../../lib/capabilities';
import { toastError, toastSuccess } from '../../lib/toastStore';
import { commandTitle, runTitle } from './assessmentFormat';
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
        toastSuccess(null, 'Run started', `${commandTitle(command)} for ${teams.find((t) => t.id === teamId)?.name ?? 'the team'}.`);
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
    <PageSection size="sm" title="Run a command" description="Choose a command and its source. Draft results stay in the run ledger for review; publishing is a separate action.">
      <Inline align="center" gap="sm" className="mb-3">
        <Select
          aria-label="Assessment team"
          size="sm"
          placeholder="Choose a team…"
          value={teamId}
          onChange={(e) => setTeamId(e.target.value)}
          options={teams.map((t) => ({ value: t.id, label: t.name }))}
        />
      </Inline>
      {commands.length === 0 ? (
        <EmptyState title="No commands available" body="The agent command registry hasn't reported any commands yet." />
      ) : (
        <DataTable<AgentCommand>
          data={commands}
          keyField={(cmd) => cmd.name}
          staticRows="A command is a verb, not a record: its row's Run action prepares it for the chosen team."

          // The command registry is small today but not bounded by contract
          // — 15 keeps a growing registry a scan, not a scroll.
          pageSize={15}
          columns={[
            { key: 'name', header: 'Command', render: (cmd) => <T size="sm" weight="medium">{cmd.name}</T> },
            { key: 'summary', header: 'What it does', render: (cmd) => (cmd.summary ? <T size="sm" title={cmd.summary}>{cmd.summary.length > 90 ? `${cmd.summary.slice(0, 90)}…` : cmd.summary}</T> : '—') },
            {
              key: 'tools',
              header: 'Tools',
              render: (cmd) => (
                <Chip tone="neutral" size="xs" mono title={cmd.allowed_tools.join(', ') || 'no tools'}>
                  {cmd.allowed_tools.length} {cmd.allowed_tools.length === 1 ? 'tool' : 'tools'}
                </Chip>
              ),
            },
          ]}
          rowActions={canRun ? (cmd) => (
            <IconButton
              size="sm"
              icon={<PlayCircleIcon />}
              aria-label={`Prepare ${cmd.name}`}
              title={launching === cmd.name ? 'Starting…' : 'Run'}
              disabled={!teamId || launching === cmd.name}
              onClick={() => { setPreparing(cmd.name); setSourceText(''); setSubmissionId(''); setRecommendationId(''); }}
            />
          ) : undefined}
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
  const { teams } = useTeams();
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
  // The open run is the URL (`/assessment/runs/:runId`).
  const { runId } = useParams<{ runId?: string }>();
  const navigate = useNavigate();
  const detailId = runId ?? null;
  const openRun = (id: string) => navigate(`/assessment/runs/${encodeURIComponent(id)}`);
  const [stopping, setStopping] = useState(false);
  const detail = runs.find((r) => r.id === detailId) ?? null;
  // The command box under the page narrows the pipeline-runs ledger; the run list above follows its status filter.
  const [statusFilter, setStatusFilter] = useState('');
  const shown = statusFilter ? runs.filter((r) => r.status === statusFilter) : runs;

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

  useCrumbLabel(detailId ?? undefined, detail ? runTitle(detail, teams) : null);
  if (detailId) {
    const statuses = [...new Set(runs.map((r) => r.status))];
    return (
      <CollectionRecordFrame
        title="Activity"
        listTitle="Runs"
        listLabel="runs"
        {...(runsResp ? { count: runs.length } : {})}
        groups={statuses.map((st) => ({ id: st, title: st, count: runs.filter((r) => r.status === st).length }))}
        rows={runs.map((r) => ({ id: r.id, groupId: r.status, title: commandTitle(r.command), subline: `${r.team_id ? teams.find((t) => t.id === r.team_id)?.name ?? 'Unknown team' : 'No team'} · ${formatRelativeTime(r.started_at)}` }))}
        currentId={detail?.id ?? null}
        onOpen={openRun}
        loading={loading && !runsResp}
        error={error}
        onRetry={load}
        data-testid="assessment-run-explorer"
      >
        {detail ? (
          <Stack gap="md" data-testid="assessment-run-record">
            <DetailHeader
              title={runTitle(detail, teams)}
              badge={<StatusPill state={RUN_STATUS_PILL_STATE[detail.status]} label={detail.status} size="sm" />}
              description={`Started ${formatRelativeTime(detail.started_at)}`}
              {...(canStop && detail.status === 'running' ? {
                aside: <Button variant="danger" size="sm" disabled={stopping} onClick={() => void stop(detail)}>{stopping ? 'Stopping…' : 'Stop'}</Button>,
                asideWidth: 120,
              } : {})}
            />
            <Stack gap="sm">
              <KeyValue layout="row" label="Team" value={detail.team_id ? teams.find((t) => t.id === detail.team_id)?.name ?? 'Unknown team' : '—'} />
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
              {detail.error && <KeyValue layout="row" label="Error" value={detail.error} className="text-danger" />}
            </Stack>
          </Stack>
        ) : loading || !runsResp ? (
          <EmptyState title="Loading run…" />
        ) : (
          <RecordNotFound heading="Run" title="Run not found" body="This run is no longer in the ledger."
            backLabel="Activity" onBack={() => navigate('/assessment/runs')} />
        )}
      </CollectionRecordFrame>
    );
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
        <>
        {statusFilter && <T size="xs" tone="secondary">{`Showing ${shown.length} of ${runs.length} runs with status ${statusFilter}. Clear the status in the pipeline runs command box to see them all.`}</T>}
        <DataTable<RunRecord>
          data={shown}
          keyField={(r) => r.id}
          striped
          onRowClick={(r) => openRun(r.id)}
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
              render: (r) => <RecordLink to={`/assessment/runs/${encodeURIComponent(r.id)}`}><T size="sm" title={r.id}>{runTitle(r, teams)}</T></RecordLink>,
            },
            { key: 'team', header: 'Team', render: (r) => (r.team_id ? teams.find((t) => t.id === r.team_id)?.name ?? 'Unknown team' : '—') },
            {
              key: 'status',
              header: 'Status',
              render: (r) => <StatusPill state={RUN_STATUS_PILL_STATE[r.status]} label={r.status} size="sm" />,
            },
            { key: 'started', header: 'Started', numeric: true, render: (r) => formatRelativeTime(r.started_at) },
            { key: 'duration', header: 'Duration', numeric: true, render: (r) => formatDuration(r.started_at, r.finished_at) },
          ]}
          emptyMessage={statusFilter ? `No run has status ${statusFilter}.` : 'No runs recorded yet.'}
        />
        </>
      )}

      <RunACommandPanel onLaunched={load} />

      {/* Pipeline runs (docs/social-tenant-design.md §5.1, lane E): the same
          commands as runs of the pipelines ledger — steps, status crosswalk,
          cost — read through this tenant's own façade (context.tenant =
          assessment), never the pipelines tenant's door. The same RunsLedger
          composition as /pipelines/runs and /iq/runs; rows do not open here
          (the run detail lives in the ledger's own tenant). */}
      <PageSection
        size="sm"
        title="Pipeline runs"
        description="Each command above, as a run of the pipelines ledger — its status, kind and cost."
      >
        <RunsLedger endpoint="/api/assessment/pipeline-runs" detailBase={null} pageSize={10} onStatusChange={setStatusFilter} data-testid="assessment-pipeline-runs" />
      </PageSection>

    </Stack>
  );
}
