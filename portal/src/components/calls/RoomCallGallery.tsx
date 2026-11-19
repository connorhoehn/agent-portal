// The interview room's call in its three states (lib/roomCallMode.ts), each switchable from the widget itself:
//
//   - docked: the Call side pane beside the page (larger tiles); "Float the call" in the pane's title row (SidePane
//     `actions`), and the pane's × minimises.
//   - floating: the library's draggable `FloatingPanel` flush in the bottom-right corner, just above the footer (the
//     standard 1rem margin); "Dock the call" in its title bar (`headerActions`), and its × is "Minimise".
//   - minimised: the panel's own pill in the same corner ("Call · 2 in the call") restores the floating gallery.
//
// The call's media has one holder in every state: the pane's or the gallery's `CallBlock` claims the call's one sink;
// minimised, the panel stays mounted (its position kept) but its body is left out, so nothing claims the sink and the
// shell's mounted, hidden outlet holds it, and the voices keep playing.
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { SidePane, useSidePaneHost } from '@connorhoehn/ui-components';
import { FloatingPanel, IconButton, Inline, MinimizeIcon, PopOutIcon, SplitViewIcon, Stack, Tooltip } from '@connorhoehn/ui-components/shared';
import { CallBlock } from '../../lib/conversationCall';
import { readRoomCallMode, roomCallActions, writeRoomCallMode, type RoomCallMode } from '../../lib/roomCallMode';
import { aboveFooterEnd, useFooterAnchorKey } from '../shell/footerPanel';

/** The gallery's size: two small tiles side by side under a compact header. */
const WIDTH_REM = 22;
const HEIGHT_REM = 10;
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

/**
 * A state's switches for a header, as icon buttons named by their action ("Dock the call", "Float the call"). Minimise
 * is the header's own × in both states, so it is left out here.
 */
function CallSwitches({ mode, onMode, tone, testId }: { mode: RoomCallMode; onMode(next: RoomCallMode): void; tone: 'surface' | 'code'; testId: string }) {
  return <Inline gap="xs" align="center" wrap={false} className="shrink-0" data-testid={`${testId}-actions`}>
    {roomCallActions(mode).filter((a) => a.to !== 'minimised').map((a) => <Tooltip key={a.to} content={a.label} placement="bottom">
      <IconButton aria-label={a.label} size="sm" tone={tone} icon={ICONS[a.to]} onClick={() => onMode(a.to)} data-testid={`${testId}-to-${a.to}`} />
    </Tooltip>)}
  </Inline>;
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
  const minimised = mode === 'minimised';
  const height = HEIGHT_REM + (recordingNote ? NOTE_REM : 0);
  const start = aboveFooterEnd(height, WIDTH_REM);
  return <FloatingPanel key={`${anchorKey}:${recordingNote ? 'note' : 'plain'}`} open title={`Call · ${people}`} tone="dark"
    onClose={() => onMode('minimised')} closeIcon="minimize" closeLabel="Minimise"
    minimized={minimised} onMinimizedChange={(next) => onMode(next ? 'minimised' : 'floating')}
    headerActions={<CallSwitches mode="floating" onMode={onMode} tone="code" testId={testId} />}
    defaultPosition={start} persistKey={positionKey} snapAnchors={['bottom-right', 'bottom-left', 'top-right', 'top-left']}
    widthClassName="w-[min(22rem,calc(100vw-2rem))]" heightClassName={recordingNote ? 'h-[11.75rem]' : 'h-[10rem]'} data-testid={testId}>
    {!minimised && <Stack gap="xs" className="min-h-0 min-w-0 flex-1 p-2">
      {recordingNote && <Inline gap="none" data-testid={`${testId}-recording-note`}>{recordingNote}</Inline>}
      <CallBlock placement="pane" fit="contain" className="min-h-0 min-w-0 flex-1 justify-center" />
    </Stack>}
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
  return <SidePane title="Call" closeLabel="Minimise the call" onClose={() => onMode('minimised')} paneId={paneId} widthPx={DOCKED_PANE} data-testid={testId}
    actions={<CallSwitches mode="docked" onMode={onMode} tone="surface" testId={testId} />}>
    <Stack gap="sm" className="h-full min-h-0 min-w-0 flex-1 bg-surface px-3 pt-2">
      {recordingNote && <Inline gap="none" className="min-w-0" data-testid={`${testId}-recording-note`}>{recordingNote}</Inline>}
      <CallBlock placement="pane" fit="contain" className="min-h-0 min-w-0 flex-1 [&_[data-testid=shell-call-media]]:flex-none" />
    </Stack>
  </SidePane>;
}
/** The docked pane's floor and ceiling: room for two tiles one above the other, never the board's width. */
const DOCKED_PANE = { min: 320, max: 440 } as const;

