// The interview room's call in its three states (lib/roomCallMode.ts), each switchable from the widget itself:
//
//   - docked: the Call side pane beside the page (larger tiles); "Float the call" and "Minimise" beside the tiles, and
//     the pane's × minimises too.
//   - floating: the library's draggable `FloatingPanel` flush in the bottom-right corner, just above the footer (the
//     standard 1rem margin); "Dock the call" and "Minimise" beside the tiles, and the panel's × minimises.
//   - minimised: a small pill in the same corner ("2 in the call") restores the floating gallery.
//
// The call's media has one holder in every state: the pane's or the gallery's `CallBlock` claims the call's one sink;
// minimised, nothing claims it and the shell's mounted, hidden outlet holds it, so the voices keep playing.
//
// Library gaps (docs/ui-components-queue.md): FloatingPanel has no header actions slot and its × is always "Close";
// SidePane's header takes extra actions only beside tabs. Until then the switches sit in a narrow column beside the
// tiles (no extra band above or below them) and the ×s are wired to minimise.
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { SidePane, useSidePaneHost } from '@connorhoehn/ui-components';
import { Button, FloatingCard, FloatingPanel, IconButton, Inline, MinimizeIcon, PopOutIcon, SplitViewIcon, Stack, Tooltip } from '@connorhoehn/ui-components/shared';
import { CallBlock } from '../../lib/conversationCall';
import { readRoomCallMode, roomCallActions, writeRoomCallMode, type RoomCallMode } from '../../lib/roomCallMode';
import { aboveFooterEnd, useFooterAnchorKey } from '../shell/footerPanel';

/** The gallery's size: two small tiles side by side under a compact header. */
const WIDTH_REM = 22;
const HEIGHT_REM = 8.5;
const NOTE_REM = 1.75;

/** The viewer's remembered state for this room kind (storage wrapped: a blocked store just uses the default). */
export function useRoomCallMode(key: string, fallback: RoomCallMode): [RoomCallMode, (next: RoomCallMode) => void] {
  const [mode, setMode] = useState<RoomCallMode>(() => readRoomCallMode(key, fallback));
  useEffect(() => { setMode(readRoomCallMode(key, fallback)); }, [key, fallback]);
  const set = useCallback((next: RoomCallMode) => { setMode(next); writeRoomCallMode(key, next); }, [key]);
  return [mode, set];
}

const ICONS: Record<RoomCallMode, ReactNode> = {
  docked: <SplitViewIcon size={14} />,
  floating: <PopOutIcon size={14} />,
  minimised: <MinimizeIcon size={14} />,
};

/** A state's switches, as icon buttons named by their action ("Dock the call", "Float the call", "Minimise"). */
function CallSwitches({ mode, onMode, tone, testId }: { mode: RoomCallMode; onMode(next: RoomCallMode): void; tone: 'surface' | 'code'; testId: string }) {
  return <Stack gap="xs" align="center" className="shrink-0" data-testid={`${testId}-actions`}>
    {roomCallActions(mode).map((a) => <Tooltip key={a.to} content={a.label} placement="left">
      <IconButton aria-label={a.label} size="sm" tone={tone} icon={ICONS[a.to]} onClick={() => onMode(a.to)} data-testid={`${testId}-to-${a.to}`} />
    </Tooltip>)}
  </Stack>;
}

/** Floating gallery or minimised pill (the docked pane is `RoomCallDockedPane`, drawn inside the page's SidePane split). */
export function RoomCallGallery({ mode, onMode, positionKey, count, recordingNote, testId }: {
  mode: 'floating' | 'minimised';
  /** Per-viewer storage for a dragged position (the panel's own `persistKey`). */
  positionKey: string;
  onMode(next: RoomCallMode): void;
  /** People in the call, for the title and the pill. */
  count: number;
  recordingNote: ReactNode | null;
  testId: string;
}) {
  const anchorKey = useFooterAnchorKey();
  const people = count === 1 ? '1 in the call' : `${count} in the call`;
  if (mode === 'minimised') {
    return <FloatingCard corner="bottom-right" width={176} className={`z-[60] ${PILL_LIFT}`} data-testid={`${testId}-pill`}>
      <Inline gap="sm" align="center" justify="center">
        <Button variant="secondary" size="sm" onClick={() => onMode('floating')} aria-label={`Show the call (${people})`} data-testid={`${testId}-restore`}>{people}</Button>
      </Inline>
    </FloatingCard>;
  }
  const height = HEIGHT_REM + (recordingNote ? NOTE_REM : 0);
  const start = aboveFooterEnd(height, WIDTH_REM);
  return <FloatingPanel key={`${anchorKey}:${recordingNote ? 'note' : 'plain'}`} open onClose={() => onMode('minimised')} title={`Call · ${people}`} tone="dark"
    defaultPosition={start} persistKey={positionKey} snapAnchors={['bottom-right', 'bottom-left', 'top-right', 'top-left']}
    widthClassName="w-[min(22rem,calc(100vw-2rem))]" heightClassName={recordingNote ? 'h-[10.25rem]' : 'h-[8.5rem]'} data-testid={testId}>
    <Stack gap="xs" className="min-h-0 min-w-0 flex-1 p-2">
      {recordingNote && <Inline gap="none" data-testid={`${testId}-recording-note`}>{recordingNote}</Inline>}
      <Inline gap="sm" align="stretch" wrap={false} className="min-h-0 min-w-0 flex-1">
        <CallBlock placement="pane" fit="contain" className="min-h-0 min-w-0 flex-1 justify-center" />
        <CallSwitches mode="floating" onMode={onMode} tone="code" testId={testId} />
      </Inline>
    </Stack>
  </FloatingPanel>;
}

/** The docked Call pane: the larger tiles beside the page, with the way back to floating. */
export function RoomCallDockedPane({ onMode, recordingNote, paneId, testId }: {
  onMode(next: RoomCallMode): void;
  recordingNote: ReactNode | null;
  paneId: string;
  testId: string;
}) {
  const { reveal } = useSidePaneHost();
  useEffect(() => { reveal(); }, [reveal]);
  return <SidePane title="Call" closeLabel="Minimise the call" onClose={() => onMode('minimised')} paneId={paneId} widthPx={DOCKED_PANE} data-testid={testId}>
    <Stack gap="sm" className="h-full min-h-0 min-w-0 flex-1 bg-surface px-3 pt-2">
      <Inline gap="sm" align="start" justify="between" wrap={false}>
        {recordingNote ? <Inline gap="none" className="min-w-0" data-testid={`${testId}-recording-note`}>{recordingNote}</Inline> : <span />}
        <Inline gap="xs" wrap={false} data-testid={`${testId}-actions`}>
          {roomCallActions('docked').map((a) => <Tooltip key={a.to} content={a.label} placement="bottom">
            <IconButton aria-label={a.label} size="sm" icon={ICONS[a.to]} onClick={() => onMode(a.to)} data-testid={`${testId}-to-${a.to}`} />
          </Tooltip>)}
        </Inline>
      </Inline>
      <CallBlock placement="pane" fit="contain" className="min-h-0 min-w-0 flex-1 [&_[data-testid=shell-call-media]]:flex-none" />
    </Stack>
  </SidePane>;
}
/** The docked pane's floor and ceiling: room for two tiles one above the other, never the board's width. */
const DOCKED_PANE = { min: 320, max: 440 } as const;

/** The pill's lift: the standard 1rem above the footer's published floor (the shell's bar, or the guest room's footer). */
const PILL_LIFT = 'bottom-[calc(var(--shell-collaboration-floor,0px)+1rem)]';
