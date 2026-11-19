// The interview's shared whiteboard (WHITEBOARD-PLAN steps 1 and 2): a system design round's canvas, where the code
// pad would be. One Yjs document per interview, `ivboard:<interviewId>`, on the socket already mounted (the shell's
// for the panel, GuestCallHost's for the candidate), drawn by the library's Excalidraw canvas
// (`@connorhoehn/ui-components/diagram` CollaborativeExcalidraw, hosted mode) with the provider's awareness, so each
// person's pointer carries their name ("Candidate" for the candidate).
//
// Above it one compact row: the lead's "Start from a board" menu (the round's questions that carry a starting board;
// a pick adds the board as one write and never clears anything) and the connection chip. The lead's room also
// checkpoints the board (lib/interviewsBoard.ts BOARD_SNAPSHOT_MS) for the record.
import { lazy, Suspense, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { GatewayContext, useYjsDoc, type GatewayContextValue } from '@connorhoehn/realtime-modules/client';
import { Chip, DropdownMenu, InlineAlert, LoadingState, Stack, Toolbar } from '@connorhoehn/ui-components/shared';
import { offlineGateway } from '../../../components/OptionalGatewayProvider';
import {
  BOARD_SNAPSHOT_MS, boardChannel, boardDocumentId, insertBoard, postBoardSnapshot, readBoardElements, sceneKey, type KitBoard,
} from '../../../lib/interviewsBoard';
import { caretColor, caretName, isPadRefusal, isPadSnapshot, padConnection, type PadConnection } from '../../../lib/interviewsPad';
import { useBoardFit } from './useBoardFit';

const ExcalidrawCanvas = lazy(() => import('@connorhoehn/ui-components/diagram').then((m) => ({ default: m.CollaborativeExcalidraw })));

export type BoardSeat = 'lead' | 'panel' | 'candidate';
export interface BoardQuestion { id: string; prompt: string; board?: KitBoard }
export interface InterviewBoardProps {
  interviewId: string;
  self: { userId: string; displayName: string };
  seat: BoardSeat;
  /** The lead's "Start from a board" menu: the round's questions; only those with a board are offered. */
  questions?: readonly BoardQuestion[];
  /** Post checkpoints while the round is live (the lead's room). */
  checkpoint?: boolean;
}

const NOTICES: Readonly<Partial<Record<PadConnection, { tone: 'info' | 'warning' | 'error'; text: string }>>> = {
  offline: { tone: 'info', text: 'The shared whiteboard needs the live connection, and it is not set up here.' },
  refused: { tone: 'error', text: 'This whiteboard is not open to you.' },
  down: { tone: 'warning', text: 'The connection dropped. The board stays here and catches up when it is back.' },
};

export function InterviewBoard(props: InterviewBoardProps) {
  const gateway = useContext(GatewayContext);
  const documentId = boardDocumentId(props.interviewId);
  if (!gateway || gateway === offlineGateway || !documentId) return <BoardFrame connection={documentId ? 'offline' : 'refused'} />;
  return <SharedBoard {...props} gateway={gateway} documentId={documentId} channel={boardChannel(props.interviewId)!} />;
}

function SharedBoard({ interviewId, self, seat, questions, checkpoint, gateway, documentId, channel }:
  InterviewBoardProps & { gateway: GatewayContextValue; documentId: string; channel: string }) {
  const { ydoc, provider, synced } = useYjsDoc({ documentId, ws: gateway, onMessage: gateway.onMessage });
  const [refused, setRefused] = useState(false);
  useEffect(() => gateway.onMessage((msg) => {
    if (isPadRefusal(msg, channel)) setRefused(true);
    else if (isPadSnapshot(msg, channel)) setRefused(false);
  }), [gateway, channel]);
  const connection = padConnection({ configured: true, connectionState: String(gateway.connectionState), synced, refused });
  const editable = connection === 'synced';
  const user = useMemo(() => ({ userId: self.userId, displayName: caretName(seat, self.displayName), color: caretColor(self.userId) }), [seat, self.displayName, self.userId]);
  // Opened, the board zooms to its content (and again when an empty board first gets some), until the person moves it.
  useBoardFit(ydoc, `[data-board="${documentId}"]`);

  // The lead's checkpoints: a changed board every BOARD_SNAPSHOT_MS, and once more when the room closes.
  const posted = useRef('');
  const flush = useCallback(() => {
    if (!ydoc || !checkpoint) return;
    const elements = readBoardElements(ydoc);
    const key = sceneKey(elements);
    if (!elements.length || key === posted.current) return;
    posted.current = key;
    void postBoardSnapshot(interviewId, elements);
  }, [ydoc, checkpoint, interviewId]);
  useEffect(() => {
    if (!checkpoint || connection !== 'synced') return undefined;
    const tick = setInterval(flush, BOARD_SNAPSHOT_MS);
    return () => { clearInterval(tick); flush(); };
  }, [checkpoint, connection, flush]);

  const boards = (questions ?? []).filter((q) => q.board);
  const [inserted, setInserted] = useState<string | null>(null);
  const start = useCallback((q: BoardQuestion) => {
    if (!ydoc || !q.board) return;
    const n = insertBoard(ydoc, q.board);
    setInserted(n ? `${q.board.name} added to the board.` : `${q.board.name} is already on the board.`);
    flush();
  }, [ydoc, flush]);

  const toolbar = <Toolbar size="sm" aria-label="Whiteboard" data-testid="interview-board-toolbar">
    {seat === 'lead' && boards.length > 0 && <DropdownMenu trigger="Start from a board" triggerLabel="Start from a board" triggerVariant="secondary"
      triggerClassName="whitespace-nowrap" disabled={!editable} triggerTestId="interview-board-insert"
      sections={[{ items: boards.map((q) => ({ id: q.id, label: q.board!.name, description: q.prompt, onSelect: () => start(q) })) }]} />}
    {connection === 'connecting' && <Chip size="sm" tone="neutral" data-testid="interview-board-status">Connecting…</Chip>}
    {connection === 'synced' && <Chip size="sm" tone="success" data-testid="interview-board-status">In sync</Chip>}
  </Toolbar>;

  return <BoardFrame boardId={documentId} connection={connection} toolbar={toolbar} note={inserted}
    canvas={ydoc && connection !== 'refused'
      ? <ExcalidrawCanvas key={documentId} ydoc={ydoc} awareness={provider?.awareness ?? null} user={user} editable={editable} className="h-full min-h-0 flex-1" />
      : null} />;
}

/** The board's column: the row, a notice when there is one, the canvas taking the rest. */
function BoardFrame({ boardId, connection, toolbar, canvas, note }: { boardId?: string; connection: PadConnection; toolbar?: React.ReactNode; canvas?: React.ReactNode; note?: string | null }) {
  const notice = NOTICES[connection];
  return <Stack gap="none" className="h-full min-h-0 min-w-0 flex-1" data-testid="interview-board" data-connection={connection}>
    {toolbar}
    {notice && <InlineAlert tone={notice.tone} data-testid="interview-board-notice">{notice.text}</InlineAlert>}
    {note && <InlineAlert tone="info" data-testid="interview-board-inserted">{note}</InlineAlert>}
    {canvas && <Stack gap="none" className="min-h-[480px] flex-1 overflow-hidden" data-testid="interview-board-canvas" data-board={boardId}>
      <Suspense fallback={<LoadingState label="Loading the whiteboard…" />}>{canvas}</Suspense>
    </Stack>}
  </Stack>;
}
