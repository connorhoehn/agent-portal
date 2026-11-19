// The interview room's call, floating (the owner's ask: the right Call pane took too much of the board's width). While
// a technical round's call is drawn, the call's tiles sit in the library's draggable `FloatingPanel` in the bottom-right
// corner, above the footer and clear of the board's own bottom-right controls; the page under it keeps the full width.
//
//   - expanded: the panel holds the recording note (the host's one-line note, dismissible as it always was) and the
//     call's tiles (`CallBlock placement="pane" fit="contain"`: each person's tile with their name and mic state). It is
//     the call's one media sink while drawn. Its position is the panel's own (`persistKey`, per viewer).
//   - minimised (the panel's ×): the panel is not drawn, so the call's media falls back to the shell's mounted, hidden
//     outlet and keeps playing (the close fix's sink approach); a small pill in the same corner ("2 in the call")
//     brings it back. The minimised state is remembered per viewer (storage wrapped, so a blocked store just forgets).
//
// The library has no minimise-to-pill on FloatingPanel yet (queued in docs/ui-components-queue.md); the pill is the
// library's `FloatingCard` holding a `Button`, lifted to the same corner.
import { useCallback, useState } from 'react';
import { Button, FloatingCard, FloatingPanel, Inline, Stack } from '@connorhoehn/ui-components/shared';
import { CallBlock } from '../../lib/conversationCall';
import { aboveFooterEnd, useFooterAnchorKey } from '../shell/footerPanel';

/** The panel's size: two tiles side by side, with the header and the recording note. */
const WIDTH_REM = 22;
const HEIGHT_REM = 12;
/** Room left under the panel for the board's own bottom-right controls (Excalidraw's help button). */
const BOARD_CLEARANCE_REM = 4;

export function RoomCallGallery({ storageKey, count, recordingNote, liftRem = 0, testId }: {
  /** Per-viewer storage for the position and the minimised state. */
  storageKey: string;
  /** People in the call, for the title and the pill. */
  count: number;
  recordingNote: React.ReactNode | null;
  /** Extra lift above the viewport's bottom edge for a page whose footer does not publish `--shell-collaboration-floor`. */
  liftRem?: number;
  testId: string;
}) {
  const [minimised, setMinimised] = useMinimised(`${storageKey}.minimised`);
  const anchorKey = useFooterAnchorKey();
  const people = count === 1 ? '1 in the call' : `${count} in the call`;
  if (minimised) {
    return <FloatingCard corner="bottom-right" width={176} className={`z-[60] ${PILL_LIFT[liftRem > 0 ? 'guest' : 'shell']}`} data-testid={`${testId}-pill`}>
      <Inline gap="sm" align="center" justify="center">
        <Button variant="secondary" size="sm" onClick={() => setMinimised(false)} aria-label={`Show the call (${people})`} data-testid={`${testId}-restore`}>{people}</Button>
      </Inline>
    </FloatingCard>;
  }
  const start = aboveFooterEnd(HEIGHT_REM + BOARD_CLEARANCE_REM + liftRem, WIDTH_REM);
  return <FloatingPanel key={anchorKey} open onClose={() => setMinimised(true)} title={`Call · ${people}`} tone="dark"
    defaultPosition={start} persistKey={`${storageKey}.position`} snapAnchors={['bottom-right', 'bottom-left', 'top-right', 'top-left']}
    widthClassName="w-[min(22rem,calc(100vw-2rem))]" heightClassName="h-[12rem]" data-testid={testId}>
    <Stack gap="none" className="min-h-0 min-w-0 flex-1">
      {recordingNote && <Inline gap="none" className="px-2 pt-1" data-testid={`${testId}-recording-note`}>{recordingNote}</Inline>}
      <CallBlock placement="pane" fit="contain" className="min-h-0 min-w-0 flex-1 justify-center" />
    </Stack>
  </FloatingPanel>;
}

/** The pill's lift: above the shell's footer (its published floor) plus the board's clearance, or a guest page's footer. */
const PILL_LIFT = {
  shell: 'bottom-[calc(var(--shell-collaboration-floor,0px)+4rem)]',
  guest: 'bottom-[7rem]',
} as const;

function useMinimised(key: string): [boolean, (next: boolean) => void] {
  const [value, setValue] = useState<boolean>(() => {
    try { return window.localStorage.getItem(key) === '1'; } catch { return false; }
  });
  const set = useCallback((next: boolean) => {
    setValue(next);
    try { window.localStorage.setItem(key, next ? '1' : '0'); } catch { /* a blocked store forgets */ }
  }, [key]);
  return [value, set];
}
