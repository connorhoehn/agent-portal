// The interview's shared whiteboard (WHITEBOARD-PLAN steps 1 and 2): a system design round's canvas, where the code
// pad would be. One Yjs document per interview, `ivboard:<interviewId>`, on the socket already mounted (the shell's
// for the panel, GuestCallHost's for the candidate), drawn by the library's Excalidraw canvas
// (`@connorhoehn/ui-components/diagram` CollaborativeExcalidraw, hosted mode) with the provider's awareness, so each
// person's pointer carries their name ("Candidate" for the candidate).
//
// Follow (useBoardFollow): the lead's canvas follows the candidate's camera from the start, so what the candidate draws
// is in the lead's view with their named pointer; the lead's own press, wheel or key inside the canvas pauses it, and
// the row's "Follow <name>" resumes it. The panel has the same control, off at first; the candidate follows nobody.
//
// Above it one compact row, laid out as the code pad's: on the left the lead's "Start from a board" menu (the round's
// questions that carry a starting board; a pick adds the board as one write and never clears anything) and the follow
// toggle, a pressed/unpressed button of the same family; on the right the pick's short confirmation (it clears itself)
// and the connection chip. Nothing else sits between the row and the canvas but a connection notice. The lead's room also
// checkpoints the board (lib/interviewsBoard.ts BOARD_SNAPSHOT_MS) for the record.
import { Children, lazy, Suspense, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { GatewayContext, useYjsDoc, type GatewayContextValue } from '@connorhoehn/realtime-modules/client';
import { Button, Chip, DropdownMenu, Inline, InlineAlert, LoadingState, Stack, T, Toolbar, ToolbarGroup } from '@connorhoehn/ui-components/shared';
import { offlineGateway } from '../../../components/OptionalGatewayProvider';
import {
  BOARD_SNAPSHOT_MS, boardChannel, boardCheckpoints, boardDocumentId, insertBoard, postBoardSnapshot, readBoardElements, type BoardCheckpoints,
  type KitBoard,
} from '../../../lib/interviewsBoard';
import { caretColor, caretName, isPadRefusal, isPadSnapshot, padConnection, questionLabel, type PadConnection } from '../../../lib/interviewsPad';
import { BOARD_NOTICE_MS } from '../../../lib/interviewsBoardFollow';
import { onBoardReveal, placeBeside, takeBoardReveal } from '../../../lib/interviewsAnswerKey';
import { useBoardFit } from './useBoardFit';
import { useBoardFollow } from './useBoardFollow';

const ExcalidrawCanvas = lazy(() => import('@connorhoehn/ui-components/diagram').then((m) => ({ default: m.CollaborativeExcalidraw })));

export type BoardSeat = 'lead' | 'panel' | 'candidate';
type BoardNote = ReturnType<typeof boardAddedNote>;
export interface BoardQuestion { id: string; prompt: string; board?: KitBoard }
export interface InterviewBoardProps {
  interviewId: string;
  self: { userId: string; displayName: string };
  seat: BoardSeat;
  /** The lead's "Start from a board" menu: the round's questions; only those with a board are offered. */
  questions?: readonly BoardQuestion[];
  /** Post checkpoints while the round is live (the lead's room). */
  checkpoint?: boolean;
  /** The candidate's name, for the follow control ("Following Mateo"); the candidate's own pointer says "Candidate". */
  candidateName?: string;
  /** The lead's room: the board's checkpoints while it is open (null once closed), so ending the round flushes them first. */
  onCheckpoints?: (checkpoints: BoardCheckpoints | null) => void;
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

function SharedBoard({ interviewId, self, seat, questions, checkpoint, onCheckpoints, candidateName, gateway, documentId, channel }:
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
  const canvasSelector = `[data-board="${documentId}"]`;
  const awareness = provider?.awareness ?? null;
  const follow = useBoardFollow(awareness, seat, canvasSelector, candidateName ?? '');
  // Opened, the board zooms to its content (and again when an empty board first gets some), until the person moves
  // it; while it follows the candidate, their camera is the view instead.
  useBoardFit(ydoc, canvasSelector, follow.target !== null);

  // The lead's checkpoints: a changed board every BOARD_SNAPSHOT_MS, and once more when the room closes. A post the
  // server did not take is tried again on the next tick (boardCheckpoints).
  const checkpoints = useMemo(() => (ydoc && checkpoint
    ? boardCheckpoints(() => readBoardElements(ydoc), (elements) => postBoardSnapshot(interviewId, elements))
    : null), [ydoc, checkpoint, interviewId]);
  const flush = useCallback(() => { void checkpoints?.flush(); }, [checkpoints]);
  useEffect(() => {
    if (!onCheckpoints) return undefined;
    onCheckpoints(checkpoints);
    return () => onCheckpoints(null);
  }, [checkpoints, onCheckpoints]);
  useEffect(() => {
    if (!checkpoints || connection !== 'synced') return undefined;
    const tick = setInterval(flush, BOARD_SNAPSHOT_MS);
    return () => { clearInterval(tick); flush(); };
  }, [checkpoints, connection, flush]);

  const boards = (questions ?? []).filter((q) => q.board);
  const [inserted, setInserted] = useState<BoardNote | null>(null);
  const start = useCallback((q: BoardQuestion) => {
    if (!ydoc || !q.board) return;
    const n = insertBoard(ydoc, q.board);
    setInserted(boardAddedNote(q, n > 0));
    flush();
  }, [ydoc, flush]);
  // The lead's reveal (the Provided design tab, lib/interviewsAnswerKey.ts): the server's copy of the provided design,
  // put right of what is drawn as one write once the board is in sync.
  const takeReveal = useCallback(() => {
    if (!ydoc || seat !== 'lead' || !editable) return;
    const board = takeBoardReveal(interviewId);
    if (!board) return;
    const n = insertBoard(ydoc, placeBeside(readBoardElements(ydoc) as unknown as Array<Record<string, unknown>>, board));
    setInserted(n > 0
      ? { text: 'Provided design shown.', detail: 'The provided design is on the shared board, right of what was drawn.' }
      : { text: 'Already on the board.', detail: 'The provided design is already on the shared board.' });
    flush();
  }, [ydoc, seat, editable, interviewId, flush]);
  useEffect(() => { takeReveal(); return onBoardReveal(takeReveal); }, [takeReveal]);
  // The notice says what the pick did, then clears itself.
  useEffect(() => {
    if (!inserted) return undefined;
    const t = setTimeout(() => setInserted(null), BOARD_NOTICE_MS);
    return () => clearTimeout(t);
  }, [inserted]);

  const toolbar = <BoardToolbar connection={connection} note={inserted}>
    {seat === 'lead' && boards.length > 0 && <DropdownMenu trigger="Start from a board" triggerLabel="Start from a board" triggerVariant="default"
      triggerClassName="whitespace-nowrap" disabled={!editable} triggerTestId="interview-board-insert"
      sections={[{ items: boards.map((q) => ({ id: q.id, label: q.board!.name, description: questionLabel(q), onSelect: () => start(q) })) }]} />}
    {seat !== 'candidate' && follow.present && <Button size="sm" variant="secondary"
      aria-pressed={follow.mode === 'following'} onClick={follow.toggle} className="whitespace-nowrap"
      data-testid="interview-board-follow" data-follow={follow.mode}>{follow.label}</Button>}
  </BoardToolbar>;

  return <BoardFrame boardId={documentId} connection={connection} toolbar={toolbar}
    canvas={ydoc && connection !== 'refused'
      ? <ExcalidrawCanvas key={documentId} ydoc={ydoc} awareness={awareness} user={user} editable={editable} followUserId={follow.target} className="h-full min-h-0 flex-1" />
      : null} />;
}

/**
 * What a pick from "Start from a board" did, for the row's status slot: a short line that fits beside the controls
 * in the room pane, and the long form (which question's starting board) for its tooltip.
 */
export function boardAddedNote(q: Pick<BoardQuestion, 'prompt'>, added: boolean): { text: string; detail: string } {
  const title = questionTitle(q);
  const text = added ? 'Starting board added.' : 'Already on the board.';
  if (!title) return { text, detail: added ? 'Added the starting board.' : 'That starting board is already on the board.' };
  return { text, detail: added ? `Added the starting board for ${title}.` : `The starting board for ${title} is already on the board.` };
}

/** A question's title: its first line up to a colon ("Design Twitter: people post…" is "Design Twitter"), shortened. */
export function questionTitle(q: Pick<BoardQuestion, 'prompt'>): string {
  const first = questionLabel(q, 200);
  const head = first.split(':')[0]!.trim();
  return questionLabel({ prompt: head || first }, 48);
}

/**
 * The board's one row, the pad's pattern: the actions on the left (sm, one family), the pick's confirmation and the
 * connection chip on the right. `px-4` is the pane's content inset, so the first control lines up with the first tab's label.
 */
function BoardToolbar({ connection, note, children }: { connection: PadConnection; note?: BoardNote | null; children?: React.ReactNode }) {
  const end = <Inline gap="sm" align="center" wrap={false}>
    {note && <T size="xs" tone="secondary" title={note.detail} role="status" data-testid="interview-board-inserted">{note.text}</T>}
    {connection === 'connecting' && <Chip size="sm" tone="neutral" data-testid="interview-board-status">Connecting…</Chip>}
    {connection === 'synced' && <Chip size="sm" tone="success" data-testid="interview-board-status">In sync</Chip>}
  </Inline>;
  return <Toolbar size="sm" aria-label="Whiteboard" end={end} className="px-4" data-testid="interview-board-toolbar">
    {Children.toArray(children).length > 0 && <ToolbarGroup aria-label="Board actions">{children}</ToolbarGroup>}
  </Toolbar>;
}

/** The board's column: the row, a connection notice when there is one, the canvas taking the rest. */
function BoardFrame({ boardId, connection, toolbar, canvas }: { boardId?: string; connection: PadConnection; toolbar?: React.ReactNode; canvas?: React.ReactNode }) {
  const notice = NOTICES[connection];
  return <Stack gap="none" className="h-full min-h-0 min-w-0 flex-1" data-testid="interview-board" data-connection={connection}>
    {toolbar}
    {notice && <InlineAlert tone={notice.tone} data-testid="interview-board-notice">{notice.text}</InlineAlert>}
    {canvas && <Stack gap="none" className="min-h-[480px] flex-1 overflow-hidden" data-testid="interview-board-canvas" data-board={boardId}>
      <Suspense fallback={<LoadingState label="Loading the whiteboard…" />}>{canvas}</Suspense>
    </Stack>}
  </Stack>;
}
