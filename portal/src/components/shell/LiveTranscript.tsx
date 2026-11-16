// The live transcript in the call's pane (HuddleChatBody draws it in place of the thread while it is on): what Milo is
// hearing, as it hears it. Opened from Milo's menu in the footer ("Show transcript"); "Back to chat" returns to the thread.
// The rows are the library's TranscriptPanel, following the newest line while the reader is at the bottom.
import { Button, Inline, Stack, T } from '@connorhoehn/ui-components/shared';
import { TranscriptPanel } from '@connorhoehn/ui-components/video';
import { useMemo } from 'react';
import { useMeetingAssistant } from '../../lib/meetingAssistant';
import { setLiveTranscript, useLiveTranscript } from '../../lib/liveTranscript';
import { LIVE_ACK_LABEL, LIVE_EMPTY, LIVE_NOT_ACKED, liveSegments, liveStateWords } from '../../lib/liveTranscriptModel';
import { ASSISTANT_NAME } from '../../lib/meetingAssistantModel';

export function LiveTranscript({ callId }: { callId: string }) {
  const assistant = useMeetingAssistant(callId);
  const phase = assistant.view.phase;
  const live = useLiveTranscript(callId, true, phase);
  const segments = useMemo(() => liveSegments(live.lines, live.speakers, live.since), [live.lines, live.speakers, live.since]);
  const back = <Button variant="ghost" size="sm" onClick={() => setLiveTranscript(callId, false)} data-testid="live-transcript-back">Back to chat</Button>;
  // "Load earlier lines" sits above the oldest line; a read that failed is said in the header, where the reader is looking.
  const earlier = live.earlier ? <Button variant="link" size="sm" className="self-center" disabled={live.loadingEarlier} onClick={live.loadEarlier} data-testid="live-transcript-earlier">
    {live.loadingEarlier ? 'Loading earlier lines…' : 'Load earlier lines'}
  </Button> : undefined;
  const meta = live.error
    ? <T size="xs" tone="danger" truncate role="alert" title={live.error} data-testid="live-transcript-error">{live.error}</T>
    : <T size="xs" tone="tertiary" truncate data-testid="live-transcript-state">{liveStateWords(assistant.view)}</T>;
  return <Stack gap="none" className="min-h-0 flex-1" data-testid="live-transcript" data-phase={phase} data-lines={live.lines.length}>
    <TranscriptPanel status="ready" frame="fill" follow title="Live transcript" segments={segments}
      headerMeta={meta}
      headerActions={back} beforeSegments={earlier} emptyMessage={live.loaded ? LIVE_EMPTY : `Reading what ${ASSISTANT_NAME} has heard…`}
      data-testid="live-transcript-panel" />
    {/* One quiet sentence, no ruled row, and the acknowledgement itself beside it (the notice may have been closed). */}
    {assistant.view.youMustAck && <Inline gap="xs" align="center" className="shrink-0 px-3 py-1.5" data-testid="live-transcript-not-acked">
      <T size="xs" tone="tertiary" wrap>{LIVE_NOT_ACKED}</T>
      <Button variant="link" size="sm" disabled={assistant.busy} onClick={() => void assistant.acknowledge()} data-testid="live-transcript-acknowledge">{LIVE_ACK_LABEL}</Button>
    </Inline>}
  </Stack>;
}
