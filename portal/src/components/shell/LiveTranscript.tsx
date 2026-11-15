// The live transcript in the call's pane (HuddleChatBody draws it in place of the thread while it is on): what Milo is
// hearing, as it hears it. Opened from Milo's menu in the footer ("Show transcript"); "Back to chat" returns to the thread.
// The rows are the library's TranscriptPanel, following the newest line while the reader is at the bottom.
import { Button, InlineAlert, Stack, T } from '@connorhoehn/ui-components/shared';
import { TranscriptPanel } from '@connorhoehn/ui-components/video';
import { useMemo } from 'react';
import { useMeetingAssistant } from '../../lib/meetingAssistant';
import { setLiveTranscript, useLiveTranscript } from '../../lib/liveTranscript';
import { LIVE_EMPTY, LIVE_NOT_ACKED, liveSegments, liveStateWords } from '../../lib/liveTranscriptModel';
import { ASSISTANT_NAME } from '../../lib/meetingAssistantModel';

export function LiveTranscript({ callId }: { callId: string }) {
  const assistant = useMeetingAssistant(callId);
  const phase = assistant.view.phase;
  const live = useLiveTranscript(callId, true, phase);
  const segments = useMemo(() => liveSegments(live.lines, live.speakers, live.since), [live.lines, live.speakers, live.since]);
  const back = <Button variant="ghost" size="sm" onClick={() => setLiveTranscript(callId, false)} data-testid="live-transcript-back">Back to chat</Button>;
  const earlier = (live.earlier || live.error) ? <Stack gap="xs">
    {live.earlier && <Button variant="link" size="sm" className="self-center" disabled={live.loadingEarlier} onClick={live.loadEarlier} data-testid="live-transcript-earlier">
      {live.loadingEarlier ? 'Loading earlier lines…' : 'Load earlier lines'}
    </Button>}
    {live.error && <InlineAlert tone="error" data-testid="live-transcript-error">{live.error}</InlineAlert>}
  </Stack> : undefined;
  return <Stack gap="none" className="min-h-0 flex-1" data-testid="live-transcript" data-phase={phase} data-lines={live.lines.length}>
    <TranscriptPanel status="ready" frame="fill" follow title="Live transcript" segments={segments}
      headerMeta={<T size="xs" tone="tertiary" truncate data-testid="live-transcript-state">{liveStateWords(phase)}</T>}
      headerActions={back} beforeSegments={earlier} emptyMessage={live.loaded ? LIVE_EMPTY : `Reading what ${ASSISTANT_NAME} has heard…`}
      data-testid="live-transcript-panel" />
    {assistant.view.youMustAck && <T size="xs" tone="tertiary" wrap className="shrink-0 border-t border-border px-3 py-2" data-testid="live-transcript-not-acked">{LIVE_NOT_ACKED}</T>}
  </Stack>;
}
