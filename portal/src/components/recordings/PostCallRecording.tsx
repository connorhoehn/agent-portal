import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { RecordingActivityCard } from '@connorhoehnslalom/ui-components/social';
import { Button, Inline, InlineAlert, Spinner, Stack, T } from '@connorhoehnslalom/ui-components/shared';
import { useSession } from '../../lib/auth';
import { useCallHost } from '../../lib/conversationCall';
import { callScopeKey } from '../shell/callShellModel';
import { createInitiativeRecordingsClient, recordingForCall, type InitiativeRecording } from '../../pages/projects/initiativeRecordingApi';
import { recordingHref, recordingIsProcessing, recordingProcessingLabel, recordingStage } from './recordingState';
import { useRecordingRead } from './useRecordingRead';
import { useRecordingStatus } from './useRecordingStatus';
import { RECORDING_CHANGED_EVENT, notifyRecordingRead } from './recordingEvents';
import { documentRecordingNavigation, type DocumentRecordingNavigation } from './documentRecordingContext';

interface EndedCall { callId: string; lobby: string; title: string; bindingUnavailable?: boolean; document?: DocumentRecordingNavigation }
export function PostCallRecordingMonitor() {
  const { session } = useSession();
  if (!session || session.sub === 'unknown') return null;
  return <Monitor key={callScopeKey(session)} actorId={session.sub} tenant={session.tenant} />;
}
function Monitor({ actorId, tenant }: { actorId: string; tenant: string }) {
  const host = useCallHost();
  const [ended, setEnded] = useState<EndedCall | null>(null);
  const joined = useRef<EndedCall | null>(null);
  const phase = host?.call.phase ?? 'idle';
  const callId = host?.call.call?.callId;
  const lobby = host?.lobby?.lobbyName;
  const title = host?.lobby?.title;
  const channel = host?.lobby?.channel;
  const binding = host?.call.recordingBinding;
  useEffect(() => {
    // The native host may clear self/lobby on leave before its terminal phase.
    // The signed-session keyed boundary remains authoritative for this saved call.
    if ((host?.self?.userId && host.self.userId !== actorId) || (host?.tenant && host.tenant !== tenant)) { joined.current = null; setEnded(null); return; }
    const document = lobby ? documentRecordingNavigation(lobby, channel) : null;
    if (host?.self?.userId === actorId && host.tenant === tenant && ['live', 'reconnecting'].includes(phase) && callId && lobby && (recordingHref(lobby) || document)) {
      joined.current = { callId, lobby, title: title ?? 'Huddle', ...(document ? { document } : {}), bindingUnavailable: binding?.callId === callId && binding.status === 'unavailable' };
      setEnded(previous => previous?.callId === callId ? null : previous);
    }
    // Native media errors can report "failed" while the gateway still owns
    // the active call. Wait for the call to clear before claiming it ended.
    if (!callId && ['ended', 'idle', 'failed'].includes(phase) && joined.current) { setEnded(joined.current); joined.current = null; }
  }, [phase, callId, lobby, title, channel, actorId, tenant, host?.self?.userId, host?.tenant, binding?.callId, binding?.status]);
  return ended ? <PostCallRecording key={`${ended.callId}:${ended.lobby}`} ended={ended} onDismiss={() => setEnded(null)} /> : null;
}
export function PostCallRecording({ ended, onDismiss }: { ended: EndedCall; onDismiss(): void }) {
  const navigate = useNavigate();
  const client = useMemo(() => createInitiativeRecordingsClient({ scopeLabel: 'call', documentSourceId: ended.document?.documentSourceId }), [ended.document?.documentSourceId]);
  const exact = useRef<InitiativeRecording | null>(null);
  const [expanded, setExpanded] = useState(false);
  const observed = useRecordingRead(`${ended.callId}:${ended.lobby}`, async signal => {
    const found = exact.current ?? await recordingForCall(client, ended.callId, ended.lobby, signal);
    if (!found) return null;
    const row = await client.detail(found.recordingId, ended.lobby, signal);
    if (row.callId !== ended.callId) throw new Error('The recording could not be associated with this exact call.');
    exact.current = row; return row;
  }, row => !row || recordingIsProcessing(row) ? 5000 : null);
  const row = observed.error ? null : observed.value;
  useRecordingStatus(!observed.error && !observed.timedOut && (!row || recordingIsProcessing(row)) ? exact.current?.recordingId ?? null : null, ended.lobby, client, observed.recheck);
  const statusKey = row ? JSON.stringify([row.recordingId, row.composeStatus, row.transcriptStatus, row.summaryStatus]) : null;
  useEffect(() => {
    if (statusKey) notifyRecordingRead(ended.lobby, 'postcall');
  }, [statusKey, ended.lobby]);
  useEffect(() => {
    const changed = (event: Event) => { const detail = (event as CustomEvent<{ lobby?: string; source?: string }>).detail; if (detail?.lobby === ended.lobby && detail.source === 'detail') observed.refresh(); };
    window.addEventListener(RECORDING_CHANGED_EVENT, changed);
    return () => window.removeEventListener(RECORDING_CHANGED_EVENT, changed);
  }, [ended.lobby, observed.refresh]);
  const pending = !observed.error && !observed.timedOut && (!row || recordingIsProcessing(row));
  const partial = row?.transcriptStatus === 'failed' || row?.summaryStatus === 'failed' || row?.composeStatus === 'failed';
  const label = observed.error ? 'Recording access could not be confirmed' : observed.timedOut ? 'Recording is not ready yet'
    : row ? recordingProcessingLabel(row) : 'Waiting for the recording from this call';
  const href = recordingHref(ended.lobby, row?.recordingId, ended.document);
  return <Stack gap="xs" className="border-b border-border bg-surface px-4 py-2" data-testid="postcall-recording" data-call-id={ended.callId}>
    <Inline gap="sm" align="center" justify="between" wrap>
      <Inline gap="sm" align="center" wrap>{pending && <Spinner size="sm" />}<T size="xs" weight="semibold">{ended.title}</T><T size="xs" tone="secondary" role="status">{label}</T></Inline>
      <Inline gap="xs" wrap>{(row || ended.bindingUnavailable) && <Button size="sm" variant="ghost" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>Details</Button>}
        {href && <Button size="sm" variant="link" className="text-xs" onClick={() => navigate(href)}>{row ? 'View recording' : 'Open recorded huddles'}</Button>}
        {(observed.error || observed.timedOut) && <Button size="sm" variant="secondary" onClick={observed.refresh}>Retry</Button>}
        <Button size="sm" variant="ghost" onClick={onDismiss} aria-label="Dismiss recording status">Dismiss</Button>
      </Inline>
    </Inline>
    {expanded && row && <RecordingActivityCard recordingId={row.recordingId} title={ended.title} startedAt={row.startedAt} durationMs={row.durationMs}
      participants={(row.participants ?? []).map(person => ({ id: person.userId, name: person.displayName ?? person.userId }))}
      stage={recordingStage(row)} transcriptReady={row.transcriptStatus === 'ready'} summaryReady={row.summaryStatus === 'ready'}
      onOpen={() => { if (href) navigate(href); }} onOpenTranscript={() => { if (href) navigate(href); }} />}
    {(observed.error || observed.timedOut || partial || (expanded && !row && ended.bindingUnavailable)) && <InlineAlert tone="warning">{observed.error ?? (observed.timedOut ? 'No exact recording association is ready. Retry or open recorded huddles; another call has not been substituted.' : partial ? 'One processing step failed. Available saved artifacts can still be opened.' : 'The native call could not confirm its recording association. No other call has been substituted. Retry or check recorded huddles.')}</InlineAlert>}
  </Stack>;
}
