// Following on the interview's whiteboard: the lead's canvas keeps the candidate's view in sight while the candidate
// draws (pages/interviews/board/useBoardFollow.ts is the hook). The pure parts live here.
//
// What already travels: the library canvas (`CollaborativeExcalidraw`) publishes each person's pointer and camera
// (scroll and zoom) in the board's awareness under the `diagram` key, throttled by the adapter (50 ms), and its
// `followUserId` prop mirrors a peer's camera onto this canvas. What this module adds: who is on the board (the
// candidate is the peer whose caret says "Candidate"), the follow state (the lead follows from the start; a press,
// wheel or key of the person's own inside the canvas pauses it; the control resumes it), the control's words, and
// each canvas's size beside its camera (BOARD_CANVAS_KEY), so a follower on a smaller canvas can be fitted to the
// followed area once the library can be given a camera (cameraToContain; docs/ui-components-queue.md).
import { caretName } from './interviewsPad.ts';

/** The adapter's awareness key for a person's diagram record (realtime-modules DIAGRAM_AWARENESS_KEY). */
const DIAGRAM_KEY = 'diagram';
/** The portal's own awareness field beside it: this canvas's size in CSS pixels. */
export const BOARD_CANVAS_KEY = 'ivboardCanvas';
/** How often a canvas's size may go out (10 a second at most). */
export const BOARD_CANVAS_PUBLISH_MS = 100;
/** How long "… added to the board." stays before it clears itself. */
export const BOARD_NOTICE_MS = 4000;

export interface BoardCamera { scrollX: number; scrollY: number; zoom: number }
export interface BoardSize { width: number; height: number }
export interface SceneRect { x: number; y: number; width: number; height: number }

/** The scene rectangle a camera shows on a canvas. Excalidraw draws a scene point at (point + scroll) * zoom. */
export function visibleArea(camera: BoardCamera, canvas: BoardSize): SceneRect {
  return { x: 0 - camera.scrollX, y: 0 - camera.scrollY, width: canvas.width / camera.zoom, height: canvas.height / camera.zoom };
}

/** Zoom bounds, Excalidraw's own (MIN_ZOOM 0.1, MAX_ZOOM 30). */
const ZOOM_FLOOR = 0.1;
const ZOOM_CEILING = 30;

/**
 * The camera that keeps `rect` in view on `canvas`, centred: at the preferred zoom when the rectangle fits there,
 * else zoomed out until it fits with `margin` (a share of the canvas on each side) to spare, never past the floor.
 * For a follower, `rect` is the followed person's visible area (visibleArea of their camera and canvas).
 */
export function cameraToContain(rect: SceneRect, canvas: BoardSize, opts: { zoom: number; margin?: number }): BoardCamera {
  const margin = opts.margin ?? 0.05;
  const room = { width: canvas.width * (1 - 2 * margin), height: canvas.height * (1 - 2 * margin) };
  const fits = Math.min(rect.width > 0 ? room.width / rect.width : Infinity, rect.height > 0 ? room.height / rect.height : Infinity);
  const zoom = Math.min(ZOOM_CEILING, Math.max(ZOOM_FLOOR, Math.min(opts.zoom, fits)));
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  return { scrollX: canvas.width / (2 * zoom) - cx, scrollY: canvas.height / (2 * zoom) - cy, zoom };
}

// ── the follow state ──────────────────────────────────────────────────────────

/** `following`: the canvas mirrors the candidate. `paused`: the person took the view by hand. `off`: not following. */
export type FollowMode = 'following' | 'paused' | 'off';
export type FollowEvent = 'own-input' | 'toggle';

/** The lead follows the candidate from the start; the panel may (the control); the candidate follows nobody. */
export const initialFollow = (seat: 'lead' | 'panel' | 'candidate'): FollowMode => (seat === 'lead' ? 'following' : 'off');

export function followStep(mode: FollowMode, event: FollowEvent): FollowMode {
  if (event === 'own-input') return mode === 'following' ? 'paused' : mode;
  return mode === 'following' ? 'off' : 'following';
}

export interface BoardPeer {
  clientId: string;
  userId?: string;
  displayName: string;
  viewport?: BoardCamera;
  canvas?: BoardSize;
}

/** Whom the canvas follows (the library's `followUserId`, matched on userId then clientId), or nobody. */
export const followTarget = (mode: FollowMode, candidate: Pick<BoardPeer, 'clientId' | 'userId'> | null): string | null =>
  (mode === 'following' && candidate ? candidate.userId || candidate.clientId : null);

/** The control's words: "Following Mateo" while following, "Follow Mateo" otherwise. */
export function followLabel(mode: FollowMode, candidateName: string): string {
  const first = candidateName.trim().split(/\s+/)[0];
  const who = first || 'the candidate';
  return mode === 'following' ? `Following ${who}` : `Follow ${who}`;
}

type InputLike = { type: string; isTrusted: boolean; target: unknown };
/** The events by which the person takes the view; a pointer move is not one of them. */
export const OWN_INPUTS = ['pointerdown', 'wheel', 'keydown'] as const;

/** The person's own (trusted) press, wheel or key inside the canvas: the fit's own synthetic keystroke never counts. */
export function isOwnBoardInput(e: InputLike, selector: string): boolean {
  if (!e.isTrusted || !(OWN_INPUTS as readonly string[]).includes(e.type)) return false;
  const target = e.target as { closest?: (q: string) => unknown } | null;
  return typeof target?.closest === 'function' && Boolean(target.closest(selector));
}

// ── who is on the board ───────────────────────────────────────────────────────

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
function asCamera(v: unknown): BoardCamera | undefined {
  const c = v as Partial<BoardCamera> | null | undefined;
  return c && isNum(c.scrollX) && isNum(c.scrollY) && isNum(c.zoom) && c.zoom > 0 ? { scrollX: c.scrollX, scrollY: c.scrollY, zoom: c.zoom } : undefined;
}
function asSize(v: unknown): BoardSize | undefined {
  const s = v as Partial<BoardSize> | null | undefined;
  return s && isNum(s.width) && isNum(s.height) && s.width > 0 && s.height > 0 ? { width: s.width, height: s.height } : undefined;
}

/** The other people on the board, from the awareness states: everyone with a diagram record but this client. */
export function boardPeers(states: ReadonlyMap<number, unknown>, selfClientId: number): BoardPeer[] {
  const peers: BoardPeer[] = [];
  for (const [clientId, raw] of states) {
    if (clientId === selfClientId) continue;
    const state = raw as Record<string, unknown> | null;
    const record = state?.[DIAGRAM_KEY] as { user?: { userId?: unknown; displayName?: unknown }; viewport?: unknown } | undefined;
    if (!record) continue;
    const user = (state?.user ?? record.user ?? {}) as { userId?: unknown; displayName?: unknown };
    const viewport = asCamera(record.viewport);
    const canvas = asSize(state?.[BOARD_CANVAS_KEY]);
    peers.push({
      clientId: String(clientId),
      ...(typeof user.userId === 'string' && user.userId ? { userId: user.userId } : {}),
      displayName: typeof user.displayName === 'string' ? user.displayName : '',
      ...(viewport ? { viewport } : {}),
      ...(canvas ? { canvas } : {}),
    });
  }
  return peers;
}

/** The candidate among them: their caret always says "Candidate" (interviewsPad caretName). */
export const candidatePeer = (peers: readonly BoardPeer[]): BoardPeer | null =>
  peers.find((p) => p.displayName === caretName('candidate', '')) ?? null;

// ── publishing this canvas's size ─────────────────────────────────────────────

export interface TickerClock { now(): number; setTimer(fn: () => void, ms: number): unknown; clearTimer(t: unknown): void }

/**
 * A size publisher: at most one send per `ms`, the latest size sent last (a trailing send), and an unchanged size not
 * sent again. Returns the function to hand each measured size; `.cancel()` drops a pending send.
 */
export function canvasSizeTicker(send: (size: BoardSize) => void, ms: number, clock: TickerClock): ((size: BoardSize) => void) & { cancel(): void } {
  let lastAt = -Infinity;
  let sent: BoardSize | null = null;
  let pending: BoardSize | null = null;
  let timer: unknown = null;
  const flush = () => {
    timer = null;
    if (!pending) return;
    const next = pending;
    pending = null;
    if (sent && sent.width === next.width && sent.height === next.height) return;
    sent = next;
    lastAt = clock.now();
    send(next);
  };
  const tick = (size: BoardSize) => {
    pending = { width: Math.round(size.width), height: Math.round(size.height) };
    if (timer !== null) return;
    const wait = lastAt + ms - clock.now();
    if (wait <= 0) flush();
    else timer = clock.setTimer(flush, wait);
  };
  return Object.assign(tick, { cancel: () => { if (timer !== null) clock.clearTimer(timer); timer = null; pending = null; } });
}
