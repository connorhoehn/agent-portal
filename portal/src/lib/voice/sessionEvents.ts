// The dock's half of the voice session log (docs/voice-navigator-gaps.md G20):
// every phase change, refusal, confirm and choice shown or decided, tool call,
// cutoff and error goes to POST /api/voice/sessions/:id/events with the
// server's own `kind` (middleware lib/voice/session-log.ts CLIENT_EVENT_KINDS).
//
// Batched: events queue here and leave as `{ events: [...] }` (at most
// MAX_EVENT_BATCH per request), never more than one request per
// EVENT_FLUSH_MS. The tool-call row (the legacy form: one voice_tool_calls row
// and its `tool-result` event, with the structured result summary) goes
// through the same queue on its own, so the dock's requests to /events, of
// either form, keep that pace together.
//
// Never words: an event carries a tool name, a phase, a count, an outcome, an
// id the dock minted; never what anyone said or typed, never a tool's
// arguments (the row keeps their sha256) and never a ToolResult's spoken
// summary, which can repeat the user's query. `eventData` drops the keys the
// server would drop anyway, so nothing of the kind is even sent.
//
// Best effort: a lost batch never breaks the session.

import { VOICE_API, type ToolCallReport } from './client.ts';

export const EVENT_FLUSH_MS = 500;
/** The middleware's MAX_EVENT_BATCH. */
export const MAX_EVENT_BATCH = 20;

/** The kinds the dock may post (the middleware's CLIENT_EVENT_KINDS). */
export const DOCK_EVENT_KINDS = [
  'started', 'delegation', 'tool-call', 'tool-result', 'refused', 'confirm-shown', 'confirmed', 'cancelled', 'usage', 'error', 'client',
] as const;
export type DockEventKind = typeof DOCK_EVENT_KINDS[number];

/** Keys never sent, at any depth (the server's FORBIDDEN_KEYS, the words and arguments half). */
const NEVER_KEYS: ReadonlySet<string> = new Set([
  'delta', 'transcript', 'text', 'said', 'utterance', 'words', 'content', 'body', 'message_text', 'instructions', 'prompt',
  'args', 'arguments', 'input', 'output', 'query', 'q', 'sdp', 'summary_text', 'title', 'detail',
]);

export type EventScalar = string | number | boolean | null;
export type EventData = Record<string, EventScalar | EventScalar[] | Record<string, EventScalar>>;

export interface DockEvent {
  kind: DockEventKind;
  tool?: string;
  argsSha256?: string;
  /** Counts, statuses, ids: never words. */
  summary?: Record<string, EventScalar>;
  data?: EventData;
}

/** The refusal codes a `refused` event carries as `data.reason` (never the spoken sentence, which can repeat the user's words). */
export const REFUSAL_CODES = [
  'ambiguous', 'not-found', 'role', 'no-grant', 'budget', 'allowlist', 'not-on-this-page', 'other-workspace',
  'card-open', 'unavailable', 'invalid-arguments', 'unknown-tool', 'not-in-workspace', 'read-failed', 'other',
] as const;
export type RefusalCode = typeof REFUSAL_CODES[number];

const REFUSAL_PATTERNS: ReadonlyArray<[RegExp, RefusalCode]> = [
  [/waiting for the user to confirm/i, 'card-open'],
  [/^There is no ".*" tool\./i, 'unknown-tool'],
  [/is not available in this workspace/i, 'not-in-workspace'],
  [/^I could not use those details/i, 'invalid-arguments'],
  [/not on (this|the) page|on this page/i, 'not-on-this-page'],
  [/another workspace|switching to it ends/i, 'other-workspace'],
  [/allowlist|not allowed to run|phrase table/i, 'allowlist'],
  [/budget|allocation|envelope|over the (run )?cap|spend hold|hold/i, 'budget'],
  [/grant|request access|which this session cannot reach|Social is not connected/i, 'no-grant'],
  [/your role|role cannot|with your role/i, 'role'],
  [/could not be reached|offline|not connected|try again in a moment|did not open in time/i, 'unavailable'],
  [/could not read|did not answer|failed to read/i, 'read-failed'],
  [/found no|there is no|no .* matches|nothing (matches|called)|no row \d/i, 'not-found'],
];

/**
 * The code of a refused result: the runner's own `code` when it set one,
 * `ambiguous` for several matches, else read from the refusal's wording (the
 * runners' fixed sentences), `other` when nothing fits.
 */
export function refusalCode(output: Record<string, unknown>): RefusalCode {
  const given = output['code'];
  if (typeof given === 'string' && (REFUSAL_CODES as readonly string[]).includes(given)) return given as RefusalCode;
  if (output['kind'] === 'ambiguous') return 'ambiguous';
  if (output['gate'] != null || output['budget'] != null) return 'budget';
  const reason = typeof output['reason'] === 'string' ? output['reason'] : '';
  for (const [re, code] of REFUSAL_PATTERNS) if (re.test(reason)) return code;
  return 'other';
}

/** The structured result summary a tool-call row carries: the outcome, the result kind and its counts. */
export function resultSummary(outcome: string, output: Record<string, unknown>): Record<string, EventScalar> {
  const s: Record<string, EventScalar> = { outcome };
  if (outcome === 'refused') s['reason'] = refusalCode(output);
  if (typeof output['kind'] === 'string') s['result'] = output['kind'];
  if (typeof output['count'] === 'number') s['count'] = output['count'];
  if (Array.isArray(output['rows'])) s['rows'] = output['rows'].length;
  if (Array.isArray(output['candidates'])) s['candidates'] = output['candidates'].length;
  if (typeof output['of'] === 'string') s['of'] = output['of'];
  if (typeof output['jobId'] === 'string') s['jobId'] = output['jobId'];
  return s;
}

function clean(v: unknown, depth: number): unknown {
  if (v == null || typeof v === 'boolean') return v ?? null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') return v.slice(0, 120);
  if (depth >= 2) return undefined;
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => clean(x, depth + 1)).filter((x) => x !== undefined);
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (NEVER_KEYS.has(k.toLowerCase())) continue;
      const c = clean(x, depth + 1);
      if (c !== undefined) out[k] = c;
    }
    return out;
  }
  return undefined;
}

/** An event as it goes on the wire: the kind, the tool, the hash, and small structured fields with no words in them. */
export function eventBody(e: DockEvent): Record<string, unknown> {
  return {
    kind: e.kind,
    ...(e.tool ? { tool: e.tool } : {}),
    ...(e.argsSha256 ? { argsSha256: e.argsSha256 } : {}),
    ...(e.summary ? { summary: clean(e.summary, 0) } : {}),
    ...(e.data ? { data: clean(e.data, 0) } : {}),
  };
}

type Timer = unknown;

export interface EventLogOptions {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => Timer;
  clearTimer?: (t: Timer) => void;
  flushMs?: number;
}

type Queued =
  | { sessionId: string; type: 'event'; body: Record<string, unknown> }
  | { sessionId: string; type: 'row'; body: ToolCallReport & { summary?: Record<string, EventScalar> } };

export class VoiceEventLog {
  private queue: Queued[] = [];
  private timer: Timer | null = null;
  private lastSentAt: number | null = null;
  private sending = false;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => Timer;
  private readonly clearTimer: (t: Timer) => void;
  private readonly flushMs: number;
  private readonly opts: EventLogOptions;

  constructor(opts: EventLogOptions) {
    this.opts = opts;
    this.now = opts.now ?? (() => Date.now());
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
    this.flushMs = opts.flushMs ?? EVENT_FLUSH_MS;
  }

  /** Queue one event of session `sessionId`. */
  add(sessionId: string, event: DockEvent): void {
    this.queue.push({ sessionId, type: 'event', body: eventBody(event) });
    this.schedule();
  }

  /** Queue the tool-call row (one voice_tool_calls row; the server writes its `tool-result` event). */
  toolCall(sessionId: string, row: ToolCallReport, summary?: Record<string, EventScalar>): void {
    this.queue.push({ sessionId, type: 'row', body: { ...row, ...(summary ? { summary: clean(summary, 0) as Record<string, EventScalar> } : {}) } });
    this.schedule();
  }

  /** What is still waiting (tests). */
  get pending(): number { return this.queue.length; }

  dispose(): void {
    if (this.timer != null) this.clearTimer(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    if (this.timer != null || this.sending || !this.queue.length) return;
    const wait = this.lastSentAt == null ? 0 : Math.max(0, this.lastSentAt + this.flushMs - this.now());
    this.timer = this.setTimer(() => { this.timer = null; void this.send(); }, wait);
  }

  /** One request: the head row alone, else the head's run of events of one session (at most MAX_EVENT_BATCH). */
  private async send(): Promise<void> {
    const head = this.queue[0];
    if (!head) return;
    let body: unknown;
    if (head.type === 'row') {
      this.queue.shift();
      body = head.body;
    } else {
      let n = 0;
      while (n < this.queue.length && n < MAX_EVENT_BATCH && this.queue[n]!.type === 'event' && this.queue[n]!.sessionId === head.sessionId) n += 1;
      body = { events: this.queue.splice(0, n).map((q) => q.body) };
    }
    this.sending = true;
    this.lastSentAt = this.now();
    try {
      await this.opts.fetch(`${VOICE_API}/${encodeURIComponent(head.sessionId)}/events`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
    } catch { /* telemetry: a lost batch never breaks the session */ }
    this.sending = false;
    this.schedule();
  }
}
