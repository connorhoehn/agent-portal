// One paired machine's working area on the Computers page: what is queued for it, handing it
// work, its history and its connection. Moved out of the old Local compute page with its
// behaviour unchanged; the page above it owns the machine list and the selection.

import { useMemo, useState } from 'react';
import { Link as RouterLink } from 'react-router';
import {
  Banner, Button, Card, DataTable, EntityCell, IconButton, InlinePlaceholder, MetaLine,
  PlayCircleIcon, SegmentedControl, SendIcon, Stack, Switch, T, Tabs, Toolbar, ToolbarLabel,
  ToolbarSeparator, useToastOptional,
} from '@connorhoehn/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { useCapabilities } from '../../lib/capabilities';
import { writeJson } from '../../lib/writeJson';
import { usd } from '../../lib/format';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { CapabilityBrief } from './ModelCapability';
import { NoSuggestions } from './SuggestedWork';
import { LiveJobCell } from './LiveJobCell';
import { MachineConnection } from './MachineConnection';
import { runColumns } from './runColumns';
import { when } from './localComputeFormat';
import type { BotRow, ComputeNode, RunRow, WorkSuggestion } from './localComputeTypes';

type MachineTab = 'lane' | 'hand' | 'activity' | 'connection';

/** How many rows the pick list shows — a hand, not a backlog. */
const PICK_LIMIT = 8;

export interface LocalMachineDetailProps {
  node: ComputeNode;
  runs: RunRow[];
  runsFailure: string | null;
  refreshRuns: () => void;
  now: number;
  streamLive: boolean;
  onOpenRun: (id: string) => void;
}

export function LocalMachineDetail({ node: selectedNode, runs, runsFailure, refreshRuns, now, streamLive, onOpenRun: setSelectedRunId }: LocalMachineDetailProps) {
  const { can, ready } = useCapabilities();
  const canDispatch = ready && can('ConnectLocalCompute');
  const canRunBots = ready && can('ManageBots');
  const { data: suggestData } = useFetch<{ suggestions: WorkSuggestion[] }>(canDispatch ? '/api/work/suggestions' : null, 60_000);
  const { data: botsData } = useFetch<{ bots: BotRow[] }>(canDispatch && canRunBots ? '/api/bots' : null, 60_000);
  const [pick, setPick] = useState<'work' | 'bots'>('work');
  // Whether a finished run waits for a person. True by default: a run that
  // touched a repo should be looked at unless someone says otherwise.
  const [requiresReview, setRequiresReview] = useState(true);
  const [sending, setSending] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [tab, setTab] = useState<MachineTab>('lane');
  const toast = useToastOptional();

  const upNext = useMemo(
    () => runs.filter((r) => (r.status === 'queued' || r.status === 'claimed' || r.status === 'running')
      && (r.nodeId === selectedNode.id || (r.nodeId === null && selectedNode.jobKinds.includes(r.kind)))),
    [runs, selectedNode],
  );
  const machineJobs = useMemo(() => {
    const mine = runs.filter((r) => r.nodeId === selectedNode.id);
    const current = mine.find((r) => r.status === 'running') ?? mine.find((r) => r.status === 'claimed');
    return {
      running: mine.filter((r) => r.status === 'running').length,
      queued: mine.filter((r) => r.status === 'queued').length,
      failedRecently: mine.filter((r) => r.status === 'failed' || r.status === 'cancelled').length,
      currentTitle: current?.title ?? null,
      currentStatus: current?.status ?? null,
      currentSince: current?.startedAt ?? current?.claimedAt ?? current?.createdAt ?? null,
    };
  }, [runs, selectedNode]);

  const pickWork = (suggestData?.suggestions ?? []).slice(0, PICK_LIMIT);
  const pickBots = (botsData?.bots ?? []).filter((b) => b.enabled && !b.pausedReason).slice(0, PICK_LIMIT);

  // Hand the machine a work item or a bot's mission. Same route the fleet uses for a targeted
  // local job; the server keeps the governed checks and the review rule.
  const send = async (origin: { workItemId: string } | { botId: string }, label: string) => {
    const key = 'workItemId' in origin ? origin.workItemId : origin.botId;
    setSendError(null);
    setSending(key);
    const res = await writeJson<{ id: string }>(
      `/api/local-compute/nodes/${selectedNode.id}/work`,
      'POST',
      { ...origin, requiresReview },
    );
    setSending(null);
    if (res.ok) {
      toast?.toast(
        requiresReview
          ? `${label} queued for ${selectedNode.label} — it will wait for your review`
          : `${label} queued for ${selectedNode.label} — it will finish without asking`,
        { type: 'success' },
      );
      refreshRuns();
    } else {
      setSendError(res.error ?? `Could not hand ${label} to ${selectedNode.label}`);
    }
  };

  return (
      <Card>
      <Stack gap="none" className="border-b border-border px-4 pt-3">
      <Tabs
        idPrefix="machine"
        aria-label={`${selectedNode.label} detail`}
        value={tab}
        onValueChange={(id) => setTab(id as MachineTab)}
        items={[
          { id: 'lane', label: upNext.length > 0 ? `Queue · ${upNext.length}` : 'Queue' },
          ...(canDispatch ? [{ id: 'hand', label: 'Assign work' }] : []),
          { id: 'activity', label: 'History' },
          { id: 'connection', label: 'Details' },
        ]}
      />
      </Stack>
      <Stack gap="none" className="p-4">

      <Stack hidden={tab !== 'lane'} gap="sm">
{/* The offline / paused / never-announced banners that used to
            sit here are gone: MachineConnection above says the same
            thing in its status line and carries the worker command
            with it, so the page no longer explains the same state
            twice in two different voices. */}
        {upNext.length === 0 ? (
          // The one action that fills it, where this viewer may dispatch (UX walk, 9 November 2026).
          <InlinePlaceholder data-testid="machine-queue-empty"
            {...(canDispatch ? { action: <Button size="sm" variant="secondary" onClick={() => setTab('hand')}>Assign work</Button> } : {})}>
            Nothing queued for this machine. Work reaches it from a bot's schedule or an initiative's work item, in the kinds it registered
            {selectedNode.jobKinds.length > 0 ? ` (${selectedNode.jobKinds.join(', ')})` : ''}.
          </InlinePlaceholder>
        ) : (
          <DataTable<RunRow>
            columns={[
              { key: 'title', header: 'Work', render: (r) => <EntityCell label={r.title} id={r.kind} /> },
              { key: 'status', header: 'Status', render: (r) => (
                <LiveJobCell job={r} now={now} lanePosition={upNext.findIndex((u) => u.id === r.id) + 1} />
              ) },
              { key: 'target', header: 'Targeted', render: (r) => (r.nodeId ? 'this machine' : 'any machine in the kind') },
              { key: 'queued', header: 'Queued', render: (r) => when(r.createdAt) },
            ]}
            data={upNext}
            keyField={(r) => r.id}
            onRowClick={(r) => setSelectedRunId(r.id)}
            striped
          />
        )}
      </Stack>

      {canDispatch && (
        <Stack hidden={tab !== 'hand'} gap="sm">
          {/* A labelled switch between the two places work comes
              from, not two counted chips with a link floating beside
              them — the counts read as filters over one list, which
              is not what they are: these are different sources. */}
          <Toolbar wrap>
            <ToolbarLabel>Source</ToolbarLabel>
            <SegmentedControl
              aria-label="Where the work comes from"
              value={pick}
              onChange={(v) => setPick(v as 'work' | 'bots')}
              options={[
                { label: 'Initiative work', value: 'work' },
                ...(canRunBots ? [{ label: 'Bots', value: 'bots' }] : []),
              ]}
            />
            <ToolbarSeparator />
            <MetaLine
              size="xs"
              tone="tertiary"
              items={[pick === 'work'
                ? `${pickWork.length} open on your initiatives`
                : `${pickBots.length} enabled bot${pickBots.length === 1 ? '' : 's'}`]}
            />
            <ToolbarSeparator />
            {/* The other half of the review lane. Every repo-backed run
                parked itself in `awaiting_review` with no way to opt
                out, so a machine that finished its work still sat
                waiting on a person who had not asked to be asked. */}
            <ToolbarLabel>Wait for my review</ToolbarLabel>
            <Switch
              size="sm"
              checked={requiresReview}
              onChange={setRequiresReview}
              aria-label="Wait for my review before the run is finished"
            />
            <MetaLine
              size="xs"
              tone="tertiary"
              items={[requiresReview
                ? 'It parks in review when it finishes'
                : 'It finishes on its own — nothing waits for you']}
            />
          </Toolbar>

            {sendError && <Banner variant="error">{sendError}</Banner>}
            {pick === 'work' && pickWork.length === 0 ? (
              <NoSuggestions
                machineLabel={selectedNode.label}
                models={selectedNode.localModels}
                accepting={selectedNode.acceptJobs}
                onTryBots={() => setPick('bots')}
              />
            ) : pick === 'work' ? (
              <DataTable<WorkSuggestion>
                columns={[
                  { key: 'title', header: 'Work item', render: (r) => (
                    <EntityCell label={r.title} id={r.workItemId} href={`/iq/projects/${r.initiativeId}?item=${encodeURIComponent(r.workItemId)}`} />
                  ) },
                  { key: 'initiative', header: 'Initiative', render: (r) => (
                    <RouterLink to={`/iq/projects/${r.initiativeId}`} className="text-primary hover:underline">{r.initiativeName}</RouterLink>
                  ) },
                  { key: 'why', header: 'Why now', render: (r) => <MetaLine items={[r.reason]} /> },
                  { key: 'size', header: 'Size', render: (r) => [r.storyPoints != null ? `${r.storyPoints} pts` : null, r.estimatedCostUsd != null ? usd(r.estimatedCostUsd) : null].filter(Boolean).join(' · ') || '—' },
                  { key: 'send', header: '', render: (r) => (
                    <IconButton size="sm" icon={<SendIcon />} disabled={!selectedNode.acceptJobs || sending === r.workItemId} onClick={(e) => { e.stopPropagation(); void send({ workItemId: r.workItemId }, r.title); }} aria-label={`Send ${r.title} to ${selectedNode.label}`} title={sending === r.workItemId ? 'Sending…' : `Send to ${selectedNode.label}`} />
                  ) },
                ]}
                data={pickWork}
                keyField={(r) => r.workItemId}
                striped
                emptyMessage="Nothing suggested right now — open work on your initiatives shows up here."
              />
            ) : (
              <DataTable<BotRow>
                columns={[
                  { key: 'name', header: 'Bot', render: (b) => (
                    <EntityCell label={b.name} id={b.repoFullName ?? undefined} href={`/admin/bots/${b.id}`} />
                  ) },
                  { key: 'schedule', header: 'Schedule', render: (b) => b.cronExpr ?? 'manual' },
                  { key: 'model', header: 'Model', render: (b) => b.model },
                  { key: 'last', header: 'Last ran', render: (b) => (b.lastRunAt ? when(b.lastRunAt) : 'never') },
                  { key: 'send', header: '', render: (b) => (
                    <IconButton size="sm" icon={<PlayCircleIcon />} disabled={!selectedNode.acceptJobs || sending === b.id} onClick={(e) => { e.stopPropagation(); void send({ botId: b.id }, b.name); }} aria-label={`Run ${b.name} on ${selectedNode.label}`} title={sending === b.id ? 'Sending…' : `Run on ${selectedNode.label}`} />
                  ) },
                ]}
                data={pickBots}
                keyField={(b) => b.id}
                striped
                emptyMessage="No enabled bots to run."
              />
            )}
        </Stack>
      )}

      <Stack hidden={tab !== 'activity'} gap="sm">

    {runsFailure ? (
      <UnavailableNotice
        error={runsFailure}
        what="run history"
        source="Runs are read from Aurora"
        onRetry={refreshRuns}
      />
    ) : (
      <DataTable
        data={runs}
        keyField={(r) => r.id}
        columns={runColumns(now)}
        striped
        // The console, from here too. Only the Queue table opened it,
        // so the output of a run became unreachable the moment the run
        // ended: it left the queue for this table, and this table had
        // no way in. The transcript is worth most AFTER the run, which
        // is exactly when it could not be opened.
        onRowClick={(r) => setSelectedRunId(r.id)}
        // Full run history for this machine, across every session
        // it has ever worked — 20 keeps a long-lived machine ledger
        // a screenful instead of an ever-growing scroll.
        pageSize={20}
        emptyMessage="No runs yet."
      />
    )}
      </Stack>

      <Stack hidden={tab !== 'connection'} gap="md">
        {/* First, because it is the question this tab is usually open
            to answer: what size of job can go to this machine. The
            Models column says WHICH models; this says what they are
            for. */}
        <Card padding="sm">
          <Stack gap="sm">
            <T size="xs" className="font-semibold uppercase tracking-wide text-text-tertiary">
              What this machine can take on
            </T>
            <CapabilityBrief models={selectedNode.localModels} />
          </Stack>
        </Card>
        <MachineConnection
          machine={selectedNode}
          jobs={machineJobs}
          now={now}
          streamLive={streamLive}
        />
      </Stack>
      </Stack>
      </Card>
  );
}
