// The Voice log (docs/voice-navigator-gaps.md G20), System › Voice log: the
// caller's own voice sessions, newest first, and the one picked: its row, its
// tool calls and its event timeline from GET /api/voice/sessions/:id
// (routes/voice-log.ts), with the transcript merged in when this device kept it
// (lib/voice/transcriptKeep.ts). "Copy as JSON" copies what the view shows;
// "Download export" is the route's own attachment. Registered at /iq/voice-log
// and /iq/voice-log/:sessionId under the dev server with the voiceNavigator
// flag on (App.tsx), on the shell rail under System and opened from the voice
// dock's log control.
//
// The house cascade (docs/layout-cascade.md): the sessions are the flush list
// rail (`CollectionRecordFrame`, the library `ListRailLayout` the Initiatives
// list draws) with one compact filter row; the content column opens with the
// shell's trail (System › Voice log › the session), the one title with the keep
// and short-answers switches and the two actions in its action slot, then the record as KeyValue
// facts and two DataTables in DetailSections, and the kept turns through the
// library's VoiceTurnStrip.

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import {
  Button, DataTable, DetailSection, EmptyState, ErrorState, FormField, Inline, KeyValue, LoadingState, SegmentedControl, Stack, Switch, T,
} from '@connorhoehn/ui-components/shared';
import { VoiceTurnStrip, type VoiceTurn } from '@connorhoehn/ui-components/voice';
import { CollectionRecordFrame } from '../../components/collections/CollectionRecordFrame';
import { useFetch } from '../../hooks/useFetch';
import { useCrumbLabel } from '../../lib/crumbLabels';
import { keepTranscripts, setKeepTranscripts, subscribeKeepTranscripts, transcriptStore, type KeptTranscript } from '../../lib/voice/transcriptKeep';
import { setVoiceVerbosity, subscribeVoiceVerbosity, voiceVerbosity } from '../../lib/voice/contextWindow';
import {
  VOICE_LOG_RANGES, clock, dayGroups, eventData, exportApi, logJson, parseRange, sessionApi, sessionFacts, sessionHref, sessionSubline, sessionsApi, when,
  type VoiceLogRange, type VoiceSessionDetail, type VoiceSessionListItem,
} from './voiceLogModel';

export interface VoiceLogViewProps {
  sessions: VoiceSessionListItem[] | null;
  sessionsError?: string | null;
  selectedId: string | null;
  detail: VoiceSessionDetail | null;
  detailError?: string | null;
  transcript: KeptTranscript | null;
  keep: boolean;
  onKeepChange(on: boolean): void;
  /** G33: this device's spoken length; the switch shows only when both are given. */
  terse?: boolean;
  onTerseChange?(on: boolean): void;
  onSelect(id: string): void;
  onCopy(): void;
  onDownload(): void;
  copied?: boolean;
  /** The list rail's filter row; `all` when omitted. */
  range?: VoiceLogRange;
  onRangeChange?(range: VoiceLogRange): void;
}

/** The view, with no fetching: what the page renders and what the test renders from a fixture. */
export function VoiceLogView(p: VoiceLogViewProps) {
  const rows = p.sessions ?? [];
  const { groups, groupOf } = dayGroups(rows);
  const d = p.detail;
  const actions = <Inline gap="sm" align="center" wrap>
    <FormField label="Keep transcripts on this device" layout="inline"
      hint={p.keep ? 'Turning this off deletes the kept transcripts.' : 'Off: no words are kept anywhere.'}>
      {(f) => <Switch checked={p.keep} onChange={p.onKeepChange} aria-labelledby={f.id} size="sm" data-testid="voice-log-keep" />}
    </FormField>
    {p.onTerseChange && <FormField label="Short answers" layout="inline"
      hint={p.terse ? 'The voice gives the count and at most three names.' : 'The voice may answer in a few sentences.'}>
      {(f) => <Switch checked={!!p.terse} onChange={p.onTerseChange!} aria-labelledby={f.id} size="sm" data-testid="voice-log-terse" />}
    </FormField>}
    {d && <Button variant="secondary" size="sm" onClick={p.onCopy} data-testid="voice-log-copy">{p.copied ? 'Copied' : 'Copy as JSON'}</Button>}
    {d && <Button variant="secondary" size="sm" onClick={p.onDownload} data-testid="voice-log-export">Download export</Button>}
  </Inline>;
  const filter = <SegmentedControl fullWidth aria-label="Sessions started" options={VOICE_LOG_RANGES.map((r) => ({ ...r }))}
    value={p.range ?? 'all'} onChange={(v) => p.onRangeChange?.(v as VoiceLogRange)} />;
  return <CollectionRecordFrame
    title="Voice log"
    description="Your own voice sessions: what ran, what was refused, and every event in order. The server keeps no audio, words or tool arguments."
    listTitle="Sessions" listLabel="voice sessions" {...(p.sessions ? { count: rows.length } : {})}
    filter={filter}
    empty={(p.range ?? 'all') === 'all'
      ? { title: 'No voice sessions yet', description: 'Start one from the Voice control in the footer; it shows here once it begins.' }
      : { title: 'No sessions in this range', description: 'Pick All to see every session you have run.' }}
    actions={actions}
    groups={groups}
    rows={rows.map((s) => ({ id: s.id, groupId: groupOf(s), title: clock(s.startedAt), subline: sessionSubline(s) }))}
    currentId={p.selectedId} onOpen={p.onSelect}
    loading={p.sessions == null && !p.sessionsError}
    error={p.sessions == null ? (p.sessionsError ?? null) : null}
    data-testid="voice-log">
    {!p.selectedId ? (rows.length ? <EmptyState title="Pick a session" description="Its tool calls and event timeline show here." /> : null)
      : !d ? (p.detailError ? <ErrorState title="That session did not load" description={p.detailError} /> : <LoadingState label="Loading the session" />)
      : <Stack gap="md" className="min-w-0" data-testid="voice-log-detail">
        <DetailSection title="Session" first>
          <KeyValue items={sessionFacts(d)} aria-label="Session" />
        </DetailSection>
        <DetailSection title="Tool calls" hint={String(d.toolCalls.length)}>
          <DataTable data={d.toolCalls} keyField={(c) => c.id} emptyMessage="No tool calls." rowHeight="fixed" data-testid="voice-log-tools"
            columns={[
              { key: 'at', header: 'At', render: (c) => when(c.at) },
              { key: 'tool', header: 'Tool' },
              { key: 'outcome', header: 'Outcome' },
              { key: 'confirmedBy', header: 'Confirmed', render: (c) => c.confirmedBy ?? '' },
              { key: 'durationMs', header: 'Took', numeric: true, render: (c) => (c.durationMs == null ? '' : `${c.durationMs} ms`) },
            ]} />
        </DetailSection>
        <DetailSection title="Events" hint={String(d.events.length)}>
          <DataTable data={d.events} keyField={(e) => String(e.seq)} emptyMessage="No events." rowHeight="content" pageSize={100} data-testid="voice-log-events"
            columns={[
              { key: 'seq', header: '#', numeric: true },
              { key: 'at', header: 'At', render: (e) => when(e.at) },
              { key: 'kind', header: 'Kind' },
              { key: 'data', header: 'Data', className: 'whitespace-normal min-w-0', render: (e) => <T size="xs" tone="secondary" className="font-mono break-all">{eventData(e.data)}</T> },
            ]} />
        </DetailSection>
        <DetailSection title="Transcript" hint="this device only">
          {p.transcript?.turns.length
            ? <VoiceTurnStrip turns={p.transcript.turns as VoiceTurn[]} maxVisible={p.transcript.turns.length} data-testid="voice-log-transcript" />
            : <T size="sm" tone="tertiary" as="p">{p.keep ? 'This device kept no transcript of this session.' : 'Not kept. Turn on "Keep transcripts on this device" to keep the words of later sessions here.'}</T>}
        </DetailSection>
      </Stack>}
  </CollectionRecordFrame>;
}

export default function VoiceLogPage() {
  const navigate = useNavigate();
  const { search } = useLocation();
  const [params, setParams] = useSearchParams();
  const { sessionId } = useParams<{ sessionId: string }>();
  const range = parseRange(params.get('range'));
  // Keyed on the range only: `since` is a midnight, stable through the day, so the read's URL holds still.
  const listUrl = useMemo(() => sessionsApi(range), [range]);
  const list = useFetch<{ sessions: VoiceSessionListItem[] }>(listUrl, 15_000);
  const selectedId = sessionId ?? null;
  const newest = list.data?.sessions[0]?.id ?? null;
  // The bare route opens the newest session, so the trail and the URL always name the record on screen.
  useEffect(() => {
    if (!selectedId && newest) void navigate(`${sessionHref(newest)}${search}`, { replace: true });
  }, [selectedId, newest, search, navigate]);
  const detail = useFetch<VoiceSessionDetail>(selectedId ? sessionApi(selectedId) : null, 10_000);
  const record = detail.data && detail.data.session.id === selectedId ? detail.data : null;
  useCrumbLabel(selectedId ?? undefined, record ? `Session ${when(record.session.startedAt)}` : null);
  const keep = useSyncExternalStore(subscribeKeepTranscripts, keepTranscripts, () => false);
  const terse = useSyncExternalStore(subscribeVoiceVerbosity, () => voiceVerbosity() === 'terse', () => true);
  const store = useMemo(() => transcriptStore(), []);
  const [transcript, setTranscript] = useState<KeptTranscript | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let live = true;
    setTranscript(null);
    if (selectedId && store) store.get(selectedId).then((t) => { if (live) setTranscript(t); }).catch(() => undefined);
    return () => { live = false; };
  }, [selectedId, store, keep, detail.data]);
  useEffect(() => { setCopied(false); }, [selectedId]);
  const onCopy = useCallback(() => {
    if (!record) return;
    void navigator.clipboard?.writeText(logJson(record, transcript)).then(() => setCopied(true)).catch(() => undefined);
  }, [record, transcript]);
  const onDownload = useCallback(() => {
    if (!selectedId) return;
    // The route answers an attachment (Content-Disposition), so following it downloads and stays on this page.
    window.location.assign(exportApi(selectedId));
  }, [selectedId]);
  const onRangeChange = useCallback((next: VoiceLogRange) => {
    setParams((prev) => {
      const out = new URLSearchParams(prev);
      if (next === 'all') out.delete('range'); else out.set('range', next);
      return out;
    }, { replace: true });
  }, [setParams]);
  return <VoiceLogView
    sessions={list.data?.sessions ?? null} sessionsError={list.error}
    selectedId={selectedId} detail={record} detailError={detail.error}
    transcript={transcript} keep={keep} onKeepChange={(on) => { void setKeepTranscripts(on, store); }}
    terse={terse} onTerseChange={(on) => { setVoiceVerbosity(on ? 'terse' : 'normal'); }}
    onSelect={(id) => navigate(`${sessionHref(id)}${search}`)} onCopy={onCopy} onDownload={onDownload} copied={copied}
    range={range} onRangeChange={onRangeChange} />;
}
