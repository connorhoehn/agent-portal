// System › Logging (docs/voice-navigator-gaps.md G37; the Voice log of G20
// is its Voice source). The filter row's first control picks the source:
// Voice (the caller's own voice sessions), Agents (bot runs and the agent
// runtime's invocation traces), Pipelines (the run projection where the tenant
// has it) or Jobs and sweeps (the work queue's agent jobs and the org sweeps'
// runs). Every source reads the routes its own page reads, so the server's
// gates are the gates; a source whose reads are refused, or that the tenant
// lacks, is not offered (loggingModel.ts offeredSources). Nothing is stored.
// Registered at /iq/logging/* under the dev server with the voice navigator
// flag on (App.tsx), on the shell rail under System and opened from the voice
// dock's history control on the current session.
//
// The house cascade (docs/layout-cascade.md): the records are the flush list
// rail (`CollectionRecordFrame`, the library `ListRailLayout`) with one filter
// row (the source, then the range), newest first in day groups; the content
// column opens with the shell's trail (System › Logging › the record), the one
// title with the record's actions, then the record in one shape for every
// source: KeyValue facts, the calls or steps DataTable and the events
// DataTable in DetailSections; the Voice source adds the kept transcript
// through the library's VoiceTurnStrip and its server export.

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import {
  Button, DataTable, DetailSection, EmptyState, ErrorState, FormField, Inline, KeyValue, LoadingState, SegmentedControl, Select, Stack, Switch, T,
} from '@connorhoehn/ui-components/shared';
import { VoiceTurnStrip, type VoiceTurn } from '@connorhoehn/ui-components/voice';
import { CollectionRecordFrame } from '../../components/collections/CollectionRecordFrame';
import { usePipelineRun } from '../../components/runs/PipelineRunParts';
import { deckDownloadName } from '../../components/decks/downloadDeckFile';
import { useFetch } from '../../hooks/useFetch';
import { useSession } from '../../lib/auth';
import { useCrumbLabel } from '../../lib/crumbLabels';
import type { RunListResponse } from '../../lib/pipelineRuns';
import { keepTranscripts, setKeepTranscripts, subscribeKeepTranscripts, transcriptStore, type KeptTranscript } from '../../lib/voice/transcriptKeep';
import { setVoiceVerbosity, subscribeVoiceVerbosity, voiceVerbosity } from '../../lib/voice/contextWindow';
import {
  VOICE_LOG_RANGES, clock, exportApi, logJson, parseRange, sessionApi, sessionsApi, voiceRecord, voiceRows,
  type VoiceLogRange, type VoiceSessionDetail, type VoiceSessionListItem,
} from '../voice/voiceLogModel';
import {
  LOG_SOURCES, dayGroupsBy, inRange, loggingBase, loggingHref, offeredSources, parseLoggingPath, pipelineRunsBase, readOutcome, rowKey,
  sourceInTenant, sourceMeta, sourceOptions, took, when, type LogRecord, type LogRow, type LogSource,
} from './loggingModel';
import {
  BOTS_API, BOT_RUN, INVOCATION, INVOCATIONS_API, agentRows, botRunRecord, botRunsApi, invocationApi, invocationRecord,
  type BotRow, type BotRunRow, type InvocationDetail, type InvocationRow, type RunJob,
} from './agentsLogModel';
import { PIPELINE_RUN, pipelineRecord, pipelineRows, pipelineRunsApi } from './pipelinesLogModel';
import {
  AGENT_JOB, SWEEP_JOB, SWEEP_JOBS_API, SWEEP_RUNS_API, SWEEP_RUN, WORK_JOBS_API, agentJobRecord, jobRows, sweepJobApi, sweepJobRecord, sweepRunRecord, workJobApi,
  type SweepJob, type SweepRun, type WorkJob,
} from './jobsLogModel';
import { useEventFrames } from './useEventFrames';

const RECORD_HEADING: Record<string, string> = {
  session: 'Session', [BOT_RUN]: 'Bot run', [INVOCATION]: 'Invocation', [PIPELINE_RUN]: 'Run',
  [AGENT_JOB]: 'Job', [SWEEP_RUN]: 'Sweep run', [SWEEP_JOB]: 'Sweep job',
};

export interface LoggingViewProps {
  source: LogSource;
  /** The sources this persona is offered, in the control's order. */
  sources: readonly LogSource[];
  onSourceChange(source: LogSource): void;
  range?: VoiceLogRange;
  onRangeChange?(range: VoiceLogRange): void;
  rows: LogRow[] | null;
  rowsError?: string | null;
  /** `kind/id` of the record open beside the rail. */
  selectedKey: string | null;
  onOpen(row: LogRow): void;
  /** Narrow width: the record's back control, back to the source's list. */
  onShowList?: () => void;
  record: LogRecord | null;
  recordError?: string | null;
  onCopy(): void;
  copied?: boolean;
  /** The source's own export (Voice's attachment); omitted where the source has none. */
  onDownload?: () => void;
  /** The Voice source's device switches and kept transcript. */
  voice?: {
    keep: boolean;
    onKeepChange(on: boolean): void;
    terse?: boolean;
    onTerseChange?(on: boolean): void;
    transcript: KeptTranscript | null;
  };
}

/** The view, with no fetching: what the page renders and what the tests render from fixtures. */
export function LoggingView(p: LoggingViewProps) {
  const meta = sourceMeta(p.source);
  const rows = p.rows ?? [];
  const { groups, groupOf } = dayGroupsBy(rows, (r) => r.at);
  const r = p.record;
  const range = p.range ?? 'all';
  // Switches, then the record's buttons as one row of their own: on a narrow
  // column the group wraps under the title and the buttons stay a row.
  const buttons = r ? <Inline gap="sm" align="center" wrap={false}>
    <Button variant="secondary" size="sm" onClick={p.onCopy} data-testid="logging-copy">{p.copied ? 'Copied' : 'Copy as JSON'}</Button>
    {p.onDownload && <Button variant="secondary" size="sm" onClick={p.onDownload} data-testid="logging-export">Download export</Button>}
  </Inline> : null;
  const actions = <Inline gap="sm" align="center" wrap>
    {p.voice && <FormField label="Keep transcripts on this device" layout="inline"
      hint={p.voice.keep ? 'Turning this off deletes the kept transcripts.' : 'Off: no words are kept anywhere.'}>
      {(f) => <Switch checked={p.voice!.keep} onChange={p.voice!.onKeepChange} aria-labelledby={f.labelId} size="sm" data-testid="logging-keep" />}
    </FormField>}
    {p.voice?.onTerseChange && <FormField label="Short answers" layout="inline"
      hint={p.voice.terse ? 'The voice gives the count and at most three names.' : 'The voice may answer in a few sentences.'}>
      {(f) => <Switch checked={!!p.voice!.terse} onChange={p.voice!.onTerseChange!} aria-labelledby={f.labelId} size="sm" data-testid="logging-terse" />}
    </FormField>}
    {buttons}
  </Inline>;
  const options = sourceOptions(p.source, p.sources);
  const filter = <Stack gap="sm">
    <Select aria-label="Source" size="sm" value={p.source} options={options} onChange={(e) => p.onSourceChange(e.target.value as LogSource)} data-testid="logging-source" />
    <SegmentedControl fullWidth aria-label="Started" options={VOICE_LOG_RANGES.map((x) => ({ ...x }))}
      value={range} onChange={(v) => p.onRangeChange?.(v as VoiceLogRange)} />
  </Stack>;
  const byKey = new Map(rows.map((x) => [rowKey(x), x]));
  const empty = range === 'all'
    ? { title: `No ${meta.listLabel} yet`, description: p.source === 'voice' ? 'Start one from the Voice control in the footer; it shows here once it begins.' : 'They show here once one runs.' }
    : { title: 'Nothing in this range', description: 'Pick All to see everything this source holds.' };
  let body: ReactNode;
  // Nothing held: the content column says so too (the rail's own state is its list's; the column is never blank).
  if (!p.selectedKey) body = rows.length ? <EmptyState title="Pick a record" description="Its facts, its calls and its events show here." />
    : p.rows ? <EmptyState title={empty.title} description={empty.description} testId="logging-empty" /> : null;
  else if (!r) body = p.recordError ? <ErrorState title="That record did not load" description={p.recordError} /> : <LoadingState label="Loading the record" />;
  else body = <Stack gap="md" className="min-w-0" data-testid="logging-detail">
    <DetailSection as="h2" title={RECORD_HEADING[r.kind] ?? 'Record'} first>
      <KeyValue items={r.facts} aria-label={RECORD_HEADING[r.kind] ?? 'Record'} />
    </DetailSection>
    <DetailSection as="h2" title={r.callsTitle} hint={String(r.calls.length)}>
      <DataTable data={r.calls} keyField={(c) => c.id} emptyMessage={`No ${r.callsTitle.toLowerCase()}.`} rowHeight="fixed" data-testid="logging-calls"
        staticRows="A call or step is read in place, in the record it belongs to; it has no page of its own."
        columns={[
          { key: 'at', header: 'At', render: (c) => when(c.at) },
          { key: 'name', header: r.callsTitle === 'Steps' ? 'Step' : 'Tool' },
          { key: 'outcome', header: 'Outcome' },
          { key: 'detail', header: 'Detail', className: 'whitespace-normal min-w-0' },
          { key: 'tookMs', header: 'Took', numeric: true, render: (c) => took(c.tookMs) },
        ]} />
    </DetailSection>
    <DetailSection as="h2" title="Events" hint={String(r.events.length)}>
      <DataTable data={r.events} keyField={(e) => String(e.seq)} emptyMessage="No events." rowHeight="content" pageSize={100} data-testid="logging-events"
        staticRows="An event is one line of the record's own log, read in place; it has no page of its own."
        columns={[
          { key: 'seq', header: '#', numeric: true },
          { key: 'at', header: 'At', render: (e) => when(e.at) },
          { key: 'kind', header: 'Kind' },
          { key: 'data', header: 'Data', className: 'whitespace-normal min-w-0', render: (e) => <T size="xs" tone="secondary" className="font-mono break-all">{e.data}</T> },
        ]} />
    </DetailSection>
    {p.voice && <DetailSection as="h2" title="Transcript" hint="this device only">
      {p.voice.transcript?.turns.length
        ? <VoiceTurnStrip size="panel" turns={p.voice.transcript.turns as VoiceTurn[]} maxVisible={p.voice.transcript.turns.length} data-testid="logging-transcript" />
        : <T size="sm" tone="tertiary" as="p">{p.voice.keep ? 'This device kept no transcript of this session.' : 'Not kept. Turn on "Keep transcripts on this device" to keep the words of later sessions here.'}</T>}
    </DetailSection>}
  </Stack>;
  return <CollectionRecordFrame
    title="Logging"
    description={meta.description}
    listTitle={meta.listTitle} listLabel={meta.listLabel} {...(p.rows ? { count: rows.length } : {})}
    filter={filter}
    empty={empty}
    actions={actions}
    countStyle="plain"
    {...(p.onShowList ? { narrow: { onBack: p.onShowList } } : {})}
    groups={groups}
    rows={rows.map((x) => ({ id: rowKey(x), groupId: groupOf(x), title: clock(x.at), subline: x.subline }))}
    currentId={p.selectedKey} onOpen={(key) => { const row = byKey.get(key); if (row) p.onOpen(row); }}
    loading={p.rows == null && !p.rowsError}
    error={p.rows == null ? (p.rowsError ?? null) : null}
    data-testid="logging">
    {body}
  </CollectionRecordFrame>;
}

const POLL_MS = 15_000;

export default function LoggingPage() {
  const navigate = useNavigate();
  const { pathname, search, state } = useLocation();
  const [params, setParams] = useSearchParams();
  const { session } = useSession();
  const tenant = session?.tenant ?? null;
  const range = parseRange(params.get('range'));
  const at = useMemo(() => parseLoggingPath(pathname), [pathname]);
  const base = loggingBase(pathname);
  const poll = (s: LogSource) => (at.source === s ? POLL_MS : undefined);

  // Every source's list read, once each (the open source polls): what the rail shows, and what decides the control's options.
  const voiceUrl = useMemo(() => sessionsApi(range), [range]);
  const voiceList = useFetch<{ sessions: VoiceSessionListItem[] }>(voiceUrl, poll('voice'));
  const orgiqReads = sourceInTenant('agents', tenant);
  const bots = useFetch<{ bots: BotRow[] }>(orgiqReads ? BOTS_API : null);
  const botIds = useMemo(() => (bots.data?.bots ?? []).slice(0, 50).map((b) => b.id), [bots.data]);
  const botRuns = useFetch<{ runs: BotRunRow[] }>(botIds.length ? botRunsApi(botIds) : null, poll('agents'));
  const invocations = useFetch<{ invocations: InvocationRow[] }>(orgiqReads ? INVOCATIONS_API : null, poll('agents'));
  const runsBase = pipelineRunsBase(tenant);
  const pipelineList = useFetch<RunListResponse>(runsBase ? pipelineRunsApi(runsBase) : null, poll('pipelines'));
  const jobsReads = sourceInTenant('jobs', tenant);
  const workJobs = useFetch<{ jobs: WorkJob[] }>(jobsReads ? WORK_JOBS_API : null, poll('jobs'));
  const sweepRuns = useFetch<{ runs: SweepRun[] }>(jobsReads ? SWEEP_RUNS_API : null, poll('jobs'));
  // The caller's own background sweep jobs: an extra rail row kind, so a refusal here never takes the source away.
  const sweepJobs = useFetch<{ jobs: SweepJob[] }>(jobsReads ? SWEEP_JOBS_API : null, poll('jobs'));

  const outcome = (f: { data: unknown; error: string | null; failure: { status: number | null; kind: string } | null }, skipped: boolean) =>
    readOutcome({ ...f, skipped });
  const reads = {
    voice: [outcome(voiceList, false)],
    agents: [outcome(bots, !orgiqReads), outcome(invocations, !orgiqReads)],
    pipelines: [outcome(pipelineList, !runsBase)],
    jobs: [outcome(workJobs, !jobsReads), outcome(sweepRuns, !jobsReads)],
  } as const;
  const offered = offeredSources(tenant, reads);
  const offeredKey = offered.join(',');
  const settled = (s: LogSource) => reads[s].every((o) => o !== 'pending');

  // The bare route opens the first offered source; a source the persona is not offered falls back to it.
  useEffect(() => {
    if (!at.source) { if (offered[0]) void navigate(`${loggingHref(offered[0], null, null, base)}${search}`, { replace: true }); return; }
    if (session && !offered.includes(at.source) && settled(at.source)) {
      void navigate(`${base}${search}`, { replace: true });
    }
  }, [at.source, offeredKey, search, navigate, session, base]);

  const source: LogSource = at.source ?? offered[0] ?? 'voice';
  const now = new Date();
  const listOf = (): { rows: LogRow[] | null; error: string | null } => {
    const pick = <T,>(f: { data: T | null; error: string | null }, map: (d: T) => LogRow[]) => ({ rows: f.data ? map(f.data) : null, error: f.data ? null : f.error });
    switch (source) {
      case 'voice': return pick(voiceList, (d) => voiceRows(d.sessions));
      case 'pipelines': return pick(pipelineList, (d) => pipelineRows(d.runs).filter((x) => inRange(x.at, range, now)));
      // A two-read source draws once both have answered, so the newest row it opens is the newest of both.
      case 'agents': {
        const any = bots.data || invocations.data;
        if (!any) return { rows: null, error: invocations.error && (bots.error || !orgiqReads) ? invocations.error : null };
        if (reads.agents.includes('pending') || (botIds.length > 0 && !botRuns.data && !botRuns.error)) return { rows: null, error: null };
        return { rows: agentRows(bots.data?.bots ?? [], botRuns.data?.runs ?? [], invocations.data?.invocations ?? []).filter((x) => inRange(x.at, range, now)), error: null };
      }
      case 'jobs': {
        if (!workJobs.data && !sweepRuns.data) return { rows: null, error: workJobs.error && sweepRuns.error ? workJobs.error : null };
        if (reads.jobs.includes('pending')) return { rows: null, error: null };
        return { rows: jobRows(workJobs.data?.jobs ?? [], sweepRuns.data?.runs ?? [], sweepJobs.data?.jobs ?? []).filter((x) => inRange(x.at, range, now)), error: null };
      }
    }
  };
  const nothingReadable = !!session && offered.length === 0 && LOG_SOURCES.every((s) => settled(s.value));
  const list = nothingReadable ? { rows: null, error: 'None of the logging sources is readable for this role.' } : listOf();
  const kindOf = (s: LogSource) => (s === 'voice' ? 'session' : s === 'pipelines' ? PIPELINE_RUN : at.kind);
  const kind = at.source ? kindOf(at.source) : null;
  const selectedKey = at.id && kind ? `${kind}/${at.id}` : null;
  const newest = list.rows?.[0] ?? null;
  const newestHref = at.source && newest ? loggingHref(at.source, newest.kind, newest.id, base) : null;

  // The bare source opens its newest record, so the trail and the URL always name the record on screen,
  // unless the reader asked for the list (the narrow layout's back control).
  const listAsked = (state as { loggingList?: boolean } | null)?.loggingList === true;
  useEffect(() => {
    if (!at.id && newestHref && !listAsked) void navigate(`${newestHref}${search}`, { replace: true });
  }, [at.id, newestHref, search, navigate, listAsked]);

  // The record's own reads.
  const id = at.id;
  const voiceDetail = useFetch<VoiceSessionDetail>(source === 'voice' && id ? sessionApi(id) : null, 10_000);
  const invocation = useFetch<InvocationDetail>(source === 'agents' && kind === INVOCATION && id ? invocationApi(id) : null);
  const botRun = source === 'agents' && kind === BOT_RUN && id ? botRuns.data?.runs.find((x) => x.id === id) ?? null : null;
  const botJob = useFetch<RunJob>(botRun?.jobId && jobsReads ? workJobApi(botRun.jobId) : null);
  const pipeline = usePipelineRun(runsBase ?? '/api/runs', source === 'pipelines' && runsBase ? id : null);
  const frames = useEventFrames(source === 'pipelines' ? pipeline.eventsUrl : null);
  const agentJob = useFetch<WorkJob>(source === 'jobs' && kind === AGENT_JOB && id ? workJobApi(id) : null, 10_000);
  const sweepJob = useFetch<SweepJob>(source === 'jobs' && kind === SWEEP_JOB && id ? sweepJobApi(id) : null, 5_000);
  const sweepRun = source === 'jobs' && kind === SWEEP_RUN && id ? sweepRuns.data?.runs.find((x) => x.id === id) ?? null : null;

  const { record, recordError } = ((): { record: LogRecord | null; recordError: string | null } => {
    if (!id) return { record: null, recordError: null };
    const notFound = 'Not in this source, or not yours to read.';
    switch (source) {
      case 'voice': return { record: voiceDetail.data && voiceDetail.data.session.id === id ? voiceRecord(voiceDetail.data) : null, recordError: voiceDetail.error };
      case 'agents':
        if (kind === INVOCATION) return { record: invocation.data && invocation.data.invocation.invocationId === id ? invocationRecord(invocation.data) : null, recordError: invocation.error };
        if (kind === BOT_RUN) {
          if (!botRun) return { record: null, recordError: botRuns.data ? notFound : botRuns.error };
          const name = bots.data?.bots.find((b) => b.id === botRun.botId)?.name ?? null;
          return { record: botRunRecord(botRun, name, botJob.data ?? null), recordError: null };
        }
        return { record: null, recordError: notFound };
      case 'pipelines':
        return { record: pipeline.run && pipeline.run.id === id ? pipelineRecord(pipeline.run, pipeline.steps, frames) : null, recordError: pipeline.error };
      case 'jobs':
        if (kind === AGENT_JOB) return { record: agentJob.data && agentJob.data.id === id ? agentJobRecord(agentJob.data) : null, recordError: agentJob.error };
        if (kind === SWEEP_JOB) return { record: sweepJob.data && sweepJob.data.jobId === id ? sweepJobRecord(sweepJob.data) : null, recordError: sweepJob.error };
        if (kind === SWEEP_RUN) return { record: sweepRun ? sweepRunRecord(sweepRun) : null, recordError: sweepRun ? null : sweepRuns.data ? notFound : sweepRuns.error };
        return { record: null, recordError: notFound };
    }
  })();
  // The trail's record crumb is the path's last segment, as the shell reads it.
  const lastSeg = pathname.split('/').filter(Boolean)[at.source === 'voice' || at.source === 'pipelines' ? 3 : 4];
  useCrumbLabel(id ? lastSeg : undefined, record?.label ?? null);

  // The Voice source's device state: the kept transcript and the spoken length.
  const keep = useSyncExternalStore(subscribeKeepTranscripts, keepTranscripts, () => false);
  const terse = useSyncExternalStore(subscribeVoiceVerbosity, () => voiceVerbosity() === 'terse', () => true);
  const store = useMemo(() => transcriptStore(), []);
  const [transcript, setTranscript] = useState<KeptTranscript | null>(null);
  const [copied, setCopied] = useState(false);
  const voiceId = source === 'voice' ? id : null;
  useEffect(() => {
    let live = true;
    setTranscript(null);
    if (voiceId && store) store.get(voiceId).then((t) => { if (live) setTranscript(t); }).catch(() => undefined);
    return () => { live = false; };
  }, [voiceId, store, keep, voiceDetail.data]);
  useEffect(() => { setCopied(false); }, [pathname]);
  const onCopy = useCallback(() => {
    if (!record) return;
    const text = record.source === 'voice' ? logJson(record.raw as VoiceSessionDetail, transcript) : JSON.stringify(record.raw, null, 2);
    void navigator.clipboard?.writeText(text).then(() => setCopied(true)).catch(() => undefined);
  }, [record, transcript]);
  const onDownload = useCallback(() => {
    if (!voiceId) return;
    // Fetched, never followed (G35): navigating to an attachment fires beforeunload, which ends a live voice session.
    void downloadAttachment(exportApi(voiceId), `voice-session-${voiceId}.json`).catch(() => undefined);
  }, [voiceId]);
  const onRangeChange = useCallback((next: VoiceLogRange) => {
    setParams((prev) => {
      const out = new URLSearchParams(prev);
      if (next === 'all') out.delete('range'); else out.set('range', next);
      return out;
    }, { replace: true });
  }, [setParams]);

  return <LoggingView
    source={source} sources={offered} onSourceChange={(s) => navigate(`${loggingHref(s, null, null, base)}${search}`)}
    range={range} onRangeChange={onRangeChange}
    rows={list.rows} rowsError={list.error}
    selectedKey={selectedKey} onOpen={(row) => navigate(`${loggingHref(row.source, row.kind, row.id, base)}${search}`)}
    onShowList={() => navigate(`${loggingHref(source, null, null, base)}${search}`, { state: { loggingList: true } })}
    record={record} recordError={recordError}
    onCopy={onCopy} copied={copied}
    {...(source === 'voice' ? {
      onDownload,
      voice: {
        keep, onKeepChange: (on: boolean) => { void setKeepTranscripts(on, store); },
        terse, onTerseChange: (on: boolean) => { setVoiceVerbosity(on ? 'terse' : 'normal'); },
        transcript,
      },
    } : {})} />;
}

/** Download a same-origin attachment without leaving the page: fetch it and save the blob (the deck download's pattern). */
async function downloadAttachment(path: string, fallbackName: string): Promise<void> {
  const res = await fetch(path, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`export failed (${res.status})`);
  const objectUrl = URL.createObjectURL(await res.blob());
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = deckDownloadName(res.headers.get('content-disposition'), fallbackName);
  anchor.hidden = true;
  try {
    document.body.append(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
  }
}
