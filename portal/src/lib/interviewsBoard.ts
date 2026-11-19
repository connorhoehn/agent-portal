// The interview's shared whiteboard on the portal side (WHITEBOARD-PLAN steps 1 and 2): the board's names on the
// wire, inserting a question's starting board, reading the board for a checkpoint, and the checkpoint routes. The
// component is pages/interviews/board/InterviewBoard.tsx.
//
// The names mirror middleware/src/lib/interviews/board/channel.ts and a unit test pins them by value: document
// `ivboard:<interviewId>` on channel `doc:ivboard:<interviewId>`; inside, the scene is the library binding's root map.
import { ExcalidrawYjsBinding, type DiagramElement } from '@connorhoehn/realtime-modules/adapters/excalidraw';
import type * as Y from 'yjs';
import { INTERVIEWS_API } from './interviews.ts';
import { writeJson } from './writeJson.ts';

export const BOARD_DOCUMENT_PREFIX = 'ivboard:';
const INTERVIEW_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,37}$/;

/** What a technical round works on; null for a behavioural round. Mirrors the server's kit.ts roundSurface. */
export type RoundSurface = 'pad' | 'board';

/** A question's starting board as the kit carries it. */
export interface KitBoard { name: string; elements: Array<Record<string, unknown>> }

/**
 * The starting boards the kit editor offers beside an empty one (the server builds them: GET /board-templates, from
 * middleware board/templates.ts). "Architecture kit" is the notes column, the component palette and a Design frame;
 * "Master template" the owner's format (board/templates.ts): the prompt with user stories, then "Your design" in five sections.
 */
export const BOARD_TEMPLATE_NAMES = ['Frames with starter notes', 'Prompt and empty frames', 'Architecture kit', 'Master template'] as const;

/** The prompt card's text for a question: its prompt up to the first colon or full stop ("Design Twitter: …" → "Design Twitter"). */
export function boardTitleOf(prompt: string): string {
  const head = prompt.trim().split(/[:.\n]/, 1)[0]!.trim();
  return (head.length > 80 ? `${head.slice(0, 79).trimEnd()}…` : head) || 'The prompt';
}

/** The template named `name`, built around `title`; null when the server could not be reached or does not have it. */
export async function readBoardTemplate(name: string, title: string, fetcher: typeof fetch = fetch): Promise<KitBoard | null> {
  try {
    const res = await fetcher(`${INTERVIEWS_API}/board-templates?title=${encodeURIComponent(title)}`, { credentials: 'include' });
    if (!res.ok) return null;
    const body = await res.json() as { items?: KitBoard[] };
    return body.items?.find((b) => b.name === name) ?? null;
  } catch { return null; }
}

export function boardDocumentId(interviewId: string): string | null {
  return INTERVIEW_ID.test(interviewId) ? `${BOARD_DOCUMENT_PREFIX}${interviewId}` : null;
}
export function boardChannel(interviewId: string): string | null {
  const id = boardDocumentId(interviewId);
  return id ? `doc:${id}` : null;
}

/** The round's surface from the room's read; an older server without it reads as the pad. */
export const surfaceOf = (round: { type: string; surface?: RoundSurface | null }): RoundSurface | null =>
  round.type !== 'technical' ? null : round.surface === 'board' ? 'board' : 'pad';

/** The board's live elements now, as the canvas's binding holds them. */
export function readBoardElements(ydoc: Y.Doc): DiagramElement[] {
  const binding = new ExcalidrawYjsBinding({ ydoc });
  try { return binding.readAll().filter((e) => !e.isDeleted); } finally { binding.destroy(); }
}

/**
 * Put a starting board on the room's board as one write. Nothing on the board is cleared: an element already there
 * keeps its place, and an element of the template drawn before (the same id) comes back at a higher version so the
 * canvas takes it. How many elements went in.
 */
export function insertBoard(ydoc: Y.Doc, board: KitBoard): number {
  const binding = new ExcalidrawYjsBinding({ ydoc });
  try {
    const have = new Map(binding.readAll().map((e) => [e.id, e]));
    const next = board.elements.flatMap((raw): DiagramElement[] => {
      if (typeof raw['id'] !== 'string' || typeof raw['type'] !== 'string') return [];
      const prior = have.get(raw['id']);
      if (prior && !prior.isDeleted) return [];
      const version = Math.max(Number(raw['version']) || 1, (prior?.version ?? 0) + 1);
      return [{ ...raw, id: raw['id'], version, versionNonce: Math.floor(Math.random() * 2 ** 31), isDeleted: false, updated: Date.now() } as DiagramElement];
    });
    if (next.length) binding.commitLocal([...binding.readAll(), ...next]);
    return next.length;
  } finally { binding.destroy(); }
}

// ── checkpoints (the server's routes/interviews/board.ts) ─────────────────────

/** How often the lead's room posts a changed board, and the check for "changed". */
export const BOARD_SNAPSHOT_MS = 60_000;
export const boardSnapshotsPath = (interviewId: string): string => `${INTERVIEWS_API}/interviews/${encodeURIComponent(interviewId)}/board/snapshots`;

/** A stable fingerprint of a scene: the elements' ids and versions. */
export const sceneKey = (elements: readonly DiagramElement[]): string => elements.map((e) => `${e.id}:${e.version}`).sort().join('|');

/** Post one checkpoint; true when the server took it (stored, or the same board as its last one). */
export async function postBoardSnapshot(interviewId: string, elements: readonly DiagramElement[]): Promise<boolean> {
  const res = await writeJson<{ stored: boolean }>(boardSnapshotsPath(interviewId), 'POST', { elements });
  return res.ok;
}

export interface BoardCheckpoints {
  /** Post the board when it changed since the last post the server took; true when nothing is left unposted. */
  flush(): Promise<boolean>;
}

/**
 * The lead's checkpoints of one board. A board counts as posted only once the server took it, so a failed post (the
 * network, a refusal) is tried again on the next flush; one post at a time, a flush during a post waiting for it.
 */
export function boardCheckpoints(read: () => readonly DiagramElement[] | null, post: (elements: readonly DiagramElement[]) => Promise<boolean>): BoardCheckpoints {
  let posted = '';
  let last: Promise<boolean> = Promise.resolve(true);
  const once = async (): Promise<boolean> => {
    const elements = read();
    if (!elements?.length) return true;
    const key = sceneKey(elements);
    if (key === posted) return true;
    const ok = await post(elements).catch(() => false);
    if (ok) posted = key;
    return ok;
  };
  return {
    flush() {
      last = last.then(once, once);
      return last;
    },
  };
}

/** How long ending the round waits for the board's closing checkpoint. */
export const BOARD_END_FLUSH_MS = 3000;

/**
 * The board's closing checkpoint, before the round ends (the server takes the lead's post for a short grace after the
 * end too). Bounded: a slow or hung post never holds up the end. True when nothing was left unposted.
 */
export async function flushBoardWithin(checkpoints: BoardCheckpoints | null, ms = BOARD_END_FLUSH_MS): Promise<boolean> {
  if (!checkpoints) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), ms); });
  try { return await Promise.race([checkpoints.flush(), late]); } finally { clearTimeout(timer); }
}

export interface BoardSnapshot { seq: number; at: string; who: { id: string; name: string }; elements: Array<Record<string, unknown>> }

export async function readBoardSnapshots(interviewId: string, fetcher: typeof fetch = fetch): Promise<BoardSnapshot[] | null> {
  try {
    const res = await fetcher(boardSnapshotsPath(interviewId), { credentials: 'include' });
    if (!res.ok) return null;
    const body = (await res.json()) as { snapshots?: BoardSnapshot[] };
    return Array.isArray(body.snapshots) ? body.snapshots : null;
  } catch { return null; }
}

// ── fit to the content ────────────────────────────────────────────────────────

/**
 * Zoom a mounted board so its content fills the pane: Excalidraw's own "Zoom to fit" (its Shift+1 shortcut, which it
 * allows in view mode too), sent to the canvas's container. The library's canvas takes no fit option yet
 * (docs/ui-components-queue.md); once it does, this goes. Whether a canvas was there to fit.
 *
 * Excalidraw 0.18 keeps clear of its toolbar using the toolbar's bottom in WINDOW coordinates, so a canvas that sits
 * lower on the page fits into a sliver at its bottom. For the one synchronous keystroke no toolbar is found (their
 * class is lifted and put straight back, with no render between), and the fit takes the whole canvas, between the
 * floating toolbar above and the menu bar below.
 */
export function fitBoardView(root: ParentNode | null | undefined): boolean {
  const container = root?.querySelector('.excalidraw');
  if (!container) return false;
  // Every one: a narrow canvas draws a second toolbar along its bottom, which would be found instead.
  const toolbars = [...container.querySelectorAll('.App-toolbar')];
  for (const t of toolbars) t.classList.remove('App-toolbar');
  try {
    container.dispatchEvent(new KeyboardEvent('keydown', { key: '!', code: 'Digit1', shiftKey: true, bubbles: true, cancelable: true }));
  } finally {
    for (const t of toolbars) t.classList.add('App-toolbar');
  }
  return true;
}

// ── opening on the prompt (the master template) ──────────────────────────────

export interface SceneBounds { x1: number; y1: number; x2: number; y2: number }
/** The box around a scene's live elements (their x, y, width and height), or null for an empty one. */
export function sceneBounds(elements: ReadonlyArray<Record<string, unknown>>): SceneBounds | null {
  let b: SceneBounds | null = null;
  for (const e of elements) {
    if (e['isDeleted'] === true) continue;
    const x = Number(e['x']), y = Number(e['y']), w = Math.abs(Number(e['width']) || 0), h = Math.abs(Number(e['height']) || 0);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    b = b ? { x1: Math.min(b.x1, x), y1: Math.min(b.y1, y), x2: Math.max(b.x2, x + w), y2: Math.max(b.y2, y + h) } : { x1: x, y1: y, x2: x + w, y2: y + h };
  }
  return b;
}

/**
 * The parts a board opens on, first found wins (middleware board/templates.ts names them): the master template's
 * part A, the prompt (`mt-a-*`), and a provided design's High-level design frame (`pd-hld`).
 */
const OPENING_PARTS: ReadonlyArray<(id: string) => boolean> = [(id) => id.startsWith('mt-a-'), (id) => id === 'pd-hld'];
/** The part of a board it opens on, or null when the board has none (it is fitted whole). */
export function openingRegion(elements: ReadonlyArray<Record<string, unknown>>): SceneBounds | null {
  for (const part of OPENING_PARTS) {
    const region = sceneBounds(elements.filter((e) => typeof e['id'] === 'string' && part(e['id'] as string)));
    if (region) return region;
  }
  return null;
}

/** Below this the prompt's 24 px body text stops reading (about 14 px on screen). */
export const OPENING_MIN_ZOOM = 0.6;
const OPENING_MARGIN = 32;
/** Room above the prompt's title for Excalidraw's floating toolbar, which sits over the canvas's top. */
const OPENING_TOP = 80;
const ZOOM_STEP = 0.1;
export interface OpeningView { zoom: number; zoomOutSteps: number; deltaX: number; deltaY: number }

/**
 * How a board opens on its prompt, as Excalidraw's own controls do it: after its "Zoom to fit" the view is centred on
 * the whole board; "Reset zoom" (zoom 1, about that centre), `zoomOutSteps` of "Zoom out" (0.1 each) to the widest zoom
 * at which the prompt's column fits the canvas (never below OPENING_MIN_ZOOM), then one wheel scroll of
 * (`deltaX`, `deltaY`) puts the prompt's top-left corner inside the canvas (OPENING_MARGIN from the left, OPENING_TOP
 * from the top, clear of Excalidraw's floating toolbar). The rest of the board
 * (Your design) is reached by scrolling. Null when the board has no prompt part.
 */
export function openingView(elements: ReadonlyArray<Record<string, unknown>>, canvas: { width: number; height: number }): OpeningView | null {
  const region = openingRegion(elements);
  const all = sceneBounds(elements);
  if (!region || !all || canvas.width <= 0 || canvas.height <= 0) return null;
  const fits = Math.floor(((canvas.width - 2 * OPENING_MARGIN) / Math.max(1, region.x2 - region.x1)) * 10 + 1e-9) / 10;
  const zoom = Math.min(1, Math.max(OPENING_MIN_ZOOM, fits));
  const zoomOutSteps = Math.round((1 - zoom) / ZOOM_STEP);
  const cx = (all.x1 + all.x2) / 2, cy = (all.y1 + all.y2) / 2;
  // Excalidraw's wheel scroll: the visible left edge moves by deltaX / zoom scene units.
  const deltaX = ((region.x1 - OPENING_MARGIN / zoom) - (cx - canvas.width / (2 * zoom))) * zoom;
  const deltaY = ((region.y1 - OPENING_TOP / zoom) - (cy - canvas.height / (2 * zoom))) * zoom;
  return { zoom: Math.round(zoom * 10) / 10, zoomOutSteps, deltaX, deltaY };
}

const nextTask = (): Promise<void> => new Promise((r) => { setTimeout(r, 40); });
const key = (target: Element, k: string, code: string): void => {
  target.dispatchEvent(new KeyboardEvent('keydown', { key: k, code, shiftKey: true, bubbles: true, cancelable: true }));
};

/**
 * Open a mounted board: a board with a prompt part opens on it at a readable zoom (openingView), any other is fitted
 * whole (fitBoardView). Each step waits a task, since Excalidraw's next action reads the state the last one set.
 * Whether a canvas was there.
 */
export async function openBoardView(root: ParentNode | null | undefined, elements: ReadonlyArray<Record<string, unknown>>): Promise<boolean> {
  if (!fitBoardView(root)) return false;
  const container = root!.querySelector('.excalidraw');
  const canvas = container?.querySelector('canvas.interactive') ?? container?.querySelector('canvas');
  const view = container && canvas ? openingView(elements, { width: container.clientWidth, height: container.clientHeight }) : null;
  if (!view) return true;
  await nextTask();
  key(container!, ')', 'Digit0');
  for (let i = 0; i < view.zoomOutSteps; i += 1) { await nextTask(); key(container!, '_', 'Minus'); }
  await nextTask();
  canvas!.dispatchEvent(new WheelEvent('wheel', { deltaX: view.deltaX, deltaY: view.deltaY, deltaMode: 0, bubbles: true, cancelable: true }));
  return true;
}

/** When the board fits itself after it opens, in ms: the canvas loads the scene over its first seconds. */
export const BOARD_FIT_DELAYS_MS: readonly number[] = [400, 1200, 2500, 4500];

type TouchEventLike = { isTrusted: boolean; target: unknown };
export interface BoardFitEnv {
  /** Where the person's presses land: the document (the board's wrapper may be drawn, or drawn again, after this starts). */
  page: {
    addEventListener(type: string, fn: (e: TouchEventLike) => void, opts?: AddEventListenerOptions): void;
    removeEventListener(type: string, fn: (e: TouchEventLike) => void, opts?: EventListenerOptions): void;
  };
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(t: unknown): void;
  /** Fit the board now (fitBoardView on its wrapper). */
  fit(): void;
  /** True while the canvas follows someone (useBoardFollow): their camera is the view, so no fit moves it. */
  held?: () => boolean;
}

/** The events by which the person takes the view: a press, a wheel, a key, their own (trusted) and inside the board. */
const TOUCHES = ['pointerdown', 'wheel', 'keydown'] as const;

/**
 * Fit the board to its content while it opens (BOARD_FIT_DELAYS_MS, while it has content), and once more when an empty
 * board first gets some, until the person touches it: their first trusted press, wheel or key inside `selector` hands
 * the view to them. The listeners are on the page and match with `closest`, so a wrapper drawn later still counts. The
 * cleanup to call when the board goes.
 */
export function watchBoardFit(ydoc: Y.Doc, selector: string, env: BoardFitEnv): () => void {
  let touched = false;
  const timers: unknown[] = [];
  const fit = () => { if (!touched && !env.held?.() && readBoardElements(ydoc).length > 0) env.fit(); };
  const schedule = (delays: readonly number[]) => { for (const ms of delays) timers.push(env.setTimer(fit, ms)); };
  schedule(BOARD_FIT_DELAYS_MS);
  let empty = readBoardElements(ydoc).length === 0;
  const onUpdate = () => {
    if (!empty || readBoardElements(ydoc).length === 0) return;
    empty = false;
    schedule([300, 1200]);
  };
  ydoc.on('update', onUpdate);
  const hand = (e: TouchEventLike) => {
    const target = e.target as { closest?: (q: string) => unknown } | null;
    if (e.isTrusted && typeof target?.closest === 'function' && target.closest(selector)) touched = true;
  };
  for (const type of TOUCHES) env.page.addEventListener(type, hand, { capture: true, passive: true });
  return () => {
    timers.forEach((t) => env.clearTimer(t));
    ydoc.off('update', onUpdate);
    for (const type of TOUCHES) env.page.removeEventListener(type, hand, { capture: true });
  };
}

// ── the record page's board ───────────────────────────────────────────────────

/** One checkpoint the record page offers: when it was taken (ms from the interview's start), its label, its scene. */
export interface BoardMoment { seq: number; atMs: number; label: string; final: boolean; elements: Array<Record<string, unknown>> }

const clock = (ms: number): string => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/**
 * The checkpoints the record page shows, oldest first: the last one (the final board) always, and up to `max - 1`
 * earlier ones spread evenly over the round. Times count from the interview's start (the page's one clock).
 */
export function boardMoments(snapshots: readonly BoardSnapshot[], startedAt: string | null, max = 5): BoardMoment[] {
  if (!snapshots.length || max < 1) return [];
  const start = startedAt ? Date.parse(startedAt) : NaN;
  const last = snapshots.length - 1;
  const earlier = Math.min(max - 1, last);
  const picked = new Set<number>([last]);
  for (let k = 0; k < earlier; k++) picked.add(Math.round((k * (last - 1)) / Math.max(1, earlier - 1)));
  return [...picked].sort((a, b) => a - b).map((i) => {
    const s = snapshots[i]!;
    const atMs = Number.isFinite(start) ? Math.max(0, Date.parse(s.at) - start) : 0;
    const final = i === last;
    return { seq: s.seq, atMs, final, label: final ? `Final, ${clock(atMs)}` : clock(atMs), elements: s.elements };
  });
}

/** sceneKey for a kit's stored board (plain objects): the editor writes the question only when this moved. */
export const boardSceneKey = (elements: ReadonlyArray<Record<string, unknown>>): string =>
  elements.filter((e) => !e['isDeleted']).map((e) => `${String(e['id'])}:${Number(e['version']) || 0}`).sort().join('|');
