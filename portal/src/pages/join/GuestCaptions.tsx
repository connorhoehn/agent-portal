// The candidate's own live captions (gap audit 2026-11-20 §11), under the call in the candidate's room.
//
// Shown only where the deployment offers them (the room's `captions`). A candidate who declined the transcript reads one plain
// sentence saying why there are none, and nothing asks them to change it. Otherwise: the library's TranscriptPanel following
// the newest line, a switch the candidate turns them off and on with (it stays where it is, so a keyboard user keeps their
// place), and a polite live region (the library's LiveRegion) that reads each new line to a screen reader. Nothing here takes
// focus. Lines are React text, never markup. The read is bounded (guestCaptionLines.ts) and stops when the room unmounts.
import { useEffect, useState } from 'react';
import { Inline, LiveRegion, Stack, Switch, T } from '@connorhoehn/ui-components/shared';
import { TranscriptPanel, type TranscriptSegment } from '@connorhoehn/ui-components/video';
import { readCaptions } from './guestApi.ts';
import {
  CAPTIONS_DECLINED, CAPTIONS_EMPTY, CAPTIONS_NOT_RUNNING, CAPTIONS_POLL_MS, captionAnnouncement, captionSpeakerLabel, captionsMaxReads, captionsMode,
  mergeCaptions, type CaptionLine,
} from './guestCaptionLines.ts';
import type { GuestRoom } from './steps.ts';

function useGuestCaptions(on: boolean, minutes: number) {
  const [lines, setLines] = useState<CaptionLine[]>([]);
  const [running, setRunning] = useState(false);
  useEffect(() => {
    if (!on) return;
    let live = true;
    let after = 0;
    let reads = 0;
    let timer: number | undefined;
    const max = captionsMaxReads(minutes);
    const read = async () => {
      if (!live || reads++ >= max) return;
      const got = await readCaptions(after);
      if (!live) return;
      if (got) {
        setRunning(got.running);
        if (got.lines.length) setLines((held) => mergeCaptions(held, got.lines));
        after = Math.max(after, got.lastSeq);
      }
      timer = window.setTimeout(() => { void read(); }, CAPTIONS_POLL_MS);
    };
    void read();
    return () => { live = false; window.clearTimeout(timer); };
  }, [on, minutes]);
  return { lines, running };
}

export function GuestCaptions({ room, transcriptAccepted }: { room: GuestRoom; transcriptAccepted: boolean | null }) {
  const mode = captionsMode(room.captions, transcriptAccepted);
  const [shown, setShown] = useState(true);
  const { lines, running } = useGuestCaptions(mode === 'captions' && shown && room.state === 'open', room.round.minutes);
  if (mode === 'none') return null;
  if (mode === 'declined') {
    return <Inline gap="sm" align="center" className="shrink-0 px-4 py-2" data-testid="join-captions-declined">
      <T size="xs" tone="secondary" as="p">{CAPTIONS_DECLINED}</T>
    </Inline>;
  }
  const segments: TranscriptSegment[] = lines.map((l) => ({ id: String(l.seq), startMs: 0, endMs: 0, speakerId: l.speaker, speakerLabel: captionSpeakerLabel(l.speaker), text: l.text }));
  return <Stack gap="xs" className="shrink-0 px-4 py-2" data-testid="join-captions">
    <Inline gap="sm" align="center">
      <T size="sm" weight="medium" as="p">Captions</T>
      <Switch size="sm" checked={shown} onChange={setShown} aria-label="Captions" data-testid="join-captions-switch" />
    </Inline>
    {shown && <Stack gap="none" className="h-40 min-h-0" data-testid="join-captions-list">
      <TranscriptPanel status="ready" follow frame="fill" title="Live captions" segments={segments}
        emptyMessage={running ? CAPTIONS_EMPTY : CAPTIONS_NOT_RUNNING} data-testid="join-captions-panel" />
    </Stack>}
    {shown && <LiveRegion politeness="polite" message={captionAnnouncement(lines.at(-1))} data-testid="join-captions-live" />}
  </Stack>;
}
