// The Voice log (docs/voice-navigator-gaps.md G20): the caller's own voice
// sessions, newest first, and the one picked: its row, its tool calls and its
// event timeline from GET /api/voice/sessions/:id (routes/voice-log.ts), with
// the transcript merged in when this device kept it (lib/voice/transcriptKeep.ts).
// "Copy as JSON" copies what the view shows; "Download export" is the route's
// own attachment. Registered at /voice/log under the dev server with the
// voiceNavigator flag on (App.tsx), opened from the voice dock's log control.
//
// Built from the library's MasterDetailPage: the sessions as a GroupedList in
// the rail, the record as KeyValue facts and two DataTables in DetailSections,
// the kept turns through the library's own VoiceTurnStrip.

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import {
  Button, DataTable, DetailSection, EmptyState, ErrorState, FormField, GroupedList, Inline, KeyValue, LoadingState, MasterDetailPage, Stack, Switch, T,
} from '@connorhoehn/ui-components/shared';
import { VoiceTurnStrip, type VoiceTurn } from '@connorhoehn/ui-components/voice';
import { useFetch } from '../../hooks/useFetch';
import { keepTranscripts, setKeepTranscripts, subscribeKeepTranscripts, transcriptStore, type KeptTranscript } from '../../lib/voice/transcriptKeep';
import {
  VOICE_SESSIONS_API, eventData, exportApi, logJson, sessionApi, sessionFacts, sessionHref, sessionSubline, when,
  type VoiceSessionDetail, type VoiceSessionListItem,
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
  onSelect(id: string): void;
  onCopy(): void;
  onDownload(): void;
  copied?: boolean;
}

/** The view, with no fetching: what the page renders and what the test renders from a fixture. */
export function VoiceLogView(p: VoiceLogViewProps) {
  const rows = p.sessions ?? [];
  const keepControl = <FormField label="Keep transcripts on this device" layout="inline"
    hint={p.keep ? 'Turning this off deletes the kept transcripts.' : 'Off: no words are kept anywhere.'}>
    {(f) => <Switch checked={p.keep} onChange={p.onKeepChange} aria-labelledby={f.id} size="sm" data-testid="voice-log-keep" />}
  </FormField>;
  const actions = <Inline gap="sm" align="center" wrap>
    {keepControl}
    {p.detail && <Button variant="secondary" size="sm" onClick={p.onCopy} data-testid="voice-log-copy">{p.copied ? 'Copied' : 'Copy as JSON'}</Button>}
    {p.detail && <Button variant="secondary" size="sm" onClick={p.onDownload} data-testid="voice-log-export">Download export</Button>}
  </Inline>;
  const body = p.sessions == null
    ? (p.sessionsError ? <ErrorState title="The voice log did not load" description={p.sessionsError} /> : <LoadingState label="Loading voice sessions" />)
    : rows.length === 0
      ? <EmptyState title="No voice sessions yet" body="Start one from the Voice control in the footer; it shows here once it begins." size="sm" />
      : <GroupedList size="md" rowStyle="ruled" currentStyle="bar" groupHeading="label"
          groups={[{ id: 'recent', title: 'Recent' }]}
          rows={rows.map((s) => ({ id: s.id, groupId: 'recent', title: when(s.startedAt), subline: sessionSubline(s), current: s.id === p.selectedId }))}
          currentId={p.selectedId} onOpenRow={(row) => p.onSelect(row.id)} />;
  const d = p.detail;
  return <MasterDetailPage
    title={d ? `Voice session ${when(d.session.startedAt)}` : 'Voice log'}
    description="Your own voice sessions: what ran, what was refused, and every event in order. The server keeps no audio, words or tool arguments."
    breadcrumbs={[{ label: 'Voice log', ...(d ? { href: '/voice/log' } : {}) }, ...(d ? [{ label: when(d.session.startedAt) }] : [])]}
    actions={actions}
    list={{ title: 'Sessions', count: rows.length, label: 'voice sessions', body }}
    emptyDetail={<EmptyState title="Pick a session" body="Its tool calls and event timeline show here." size="sm" />}
    data-testid="voice-log">
    {p.selectedId ? (d ? <Stack gap="md" className="min-w-0" data-testid="voice-log-detail">
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
            { key: 'data', header: 'Data', render: (e) => <T size="xs" tone="secondary" className="font-mono break-all">{eventData(e.data)}</T> },
          ]} />
      </DetailSection>
      <DetailSection title="Transcript" hint="this device only">
        {p.transcript?.turns.length
          ? <VoiceTurnStrip turns={p.transcript.turns as VoiceTurn[]} maxVisible={p.transcript.turns.length} data-testid="voice-log-transcript" />
          : <T size="sm" tone="tertiary" as="p">{p.keep ? 'This device kept no transcript of this session.' : 'Not kept. Turn on "Keep transcripts on this device" to keep the words of later sessions here.'}</T>}
      </DetailSection>
    </Stack> : p.detailError ? <ErrorState title="That session did not load" description={p.detailError} /> : <LoadingState label="Loading the session" />) : null}
  </MasterDetailPage>;
}

export default function VoiceLogPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const list = useFetch<{ sessions: VoiceSessionListItem[] }>(`${VOICE_SESSIONS_API}?limit=50`, 15_000);
  const selectedId = params.get('session');
  const detail = useFetch<VoiceSessionDetail>(selectedId ? sessionApi(selectedId) : null, 10_000);
  const keep = useSyncExternalStore(subscribeKeepTranscripts, keepTranscripts, () => false);
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
    if (!detail.data) return;
    void navigator.clipboard?.writeText(logJson(detail.data, transcript)).then(() => setCopied(true)).catch(() => undefined);
  }, [detail.data, transcript]);
  const onDownload = useCallback(() => {
    if (!selectedId) return;
    // The route answers an attachment (Content-Disposition), so following it downloads and stays on this page.
    window.location.assign(exportApi(selectedId));
  }, [selectedId]);
  return <VoiceLogView
    sessions={list.data?.sessions ?? null} sessionsError={list.error}
    selectedId={selectedId} detail={detail.data && detail.data.session.id === selectedId ? detail.data : null} detailError={detail.error}
    transcript={transcript} keep={keep} onKeepChange={(on) => { void setKeepTranscripts(on, store); }}
    onSelect={(id) => navigate(sessionHref(id))} onCopy={onCopy} onDownload={onDownload} copied={copied} />;
}
