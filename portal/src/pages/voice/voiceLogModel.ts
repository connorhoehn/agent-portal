// The Voice log view's data (docs/voice-navigator-gaps.md G20): the shapes
// GET /api/voice/sessions and GET /api/voice/sessions/:id answer
// (middleware routes/voice-log.ts), and the pure formatting the view uses, so
// `node --test` checks it without a browser.
//
// The server holds structured events only (no audio, transcript or tool
// arguments). A transcript kept on this device (lib/voice/transcriptKeep.ts)
// is merged in here for display and for "Copy as JSON", and never sent.

import type { KeptTranscript } from '../../lib/voice/transcriptKeep.ts';
import { plural } from '../../lib/plural.ts';
import { readDiagnostic, type HeardOutcome, type SpokeAfter } from '../../lib/voice/sessionEvents.ts';
import { dayGroupsBy, took, when, type ConversationRow, type LogRecord, type LogRow } from '../logging/loggingModel.ts';

export { when };

/** System › Logging's Voice source (orgiq, G37): the list rail of sessions, a session at `/iq/logging/voice/<id>`. */
export const VOICE_LOG_PATH = '/iq/logging/voice';
export const VOICE_SESSIONS_API = '/api/voice/sessions';
/** The list read's page size; the route caps it at 100. */
export const VOICE_SESSIONS_LIMIT = 50;

export interface VoiceSessionListItem {
  id: string;
  tenant: string;
  mock: boolean;
  startedAt: string;
  endedAt: string | null;
  seconds: number | null;
  maxSeconds: number;
  costUsd: number | null;
  costBasis: string | null;
  toolCallCount: number;
  lastOutcome: string | null;
  stopReason: string | null;
  /** The dropped session this one resumed (G35), when the server linked it. */
  resumeOf?: string | null;
}

export interface VoiceSessionDetail {
  session: VoiceSessionListItem & {
    model: string | null;
    voice: string | null;
    usdPerMinute: number | null;
    holdId: string | null;
    provider: { seconds: number | null; inputTokens: number | null; outputTokens: number | null; cachedTokens: number | null };
  };
  toolCalls: Array<{ id: string; at: string; tool: string; outcome: string; argsSha256: string | null; confirmedBy: string | null; durationMs: number | null }>;
  events: Array<{ seq: number; at: string; kind: string; data: Record<string, unknown> }>;
}

/** `/iq/logging/voice/<id>`: one session, opened beside the list rail. */
export const sessionHref = (id: string): string => `${VOICE_LOG_PATH}/${encodeURIComponent(id)}`;

/** The list rail's filter row: sessions started today, in the last seven days, or all of them. */
export type VoiceLogRange = 'today' | 'week' | 'all';
export const VOICE_LOG_RANGES: ReadonlyArray<{ value: VoiceLogRange; label: string }> = [
  { value: 'today', label: 'Today' },
  { value: 'week', label: '7 days' },
  { value: 'all', label: 'All' },
];
export const parseRange = (raw: string | null | undefined): VoiceLogRange => (raw === 'today' || raw === 'week' ? raw : 'all');

/** The `since` the list read sends: local midnight today, or seven midnights back; none for all. Stable within a day, so the read's URL does not change per render. */
export function sinceFor(range: VoiceLogRange, now: Date = new Date()): string | null {
  if (range === 'all') return null;
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (range === 'week' ? 6 : 0));
  return d.toISOString();
}

export function sessionsApi(range: VoiceLogRange, now: Date = new Date()): string {
  const since = sinceFor(range, now);
  return `${VOICE_SESSIONS_API}?limit=${VOICE_SESSIONS_LIMIT}${since ? `&since=${encodeURIComponent(since)}` : ''}`;
}

/** "17:49:02": a rail row's title under its day group. */
export function clock(iso: string, locale?: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(t));
}

/** The rail's day groups, newest first, in the order the rows came (the route answers newest first). */
export function dayGroups(rows: readonly VoiceSessionListItem[], now: Date = new Date(), locale?: string): {
  groups: Array<{ id: string; title: string; count: number }>;
  groupOf: (s: VoiceSessionListItem) => string;
} {
  return dayGroupsBy(rows, (s) => s.startedAt, now, locale);
}
export const sessionApi = (id: string): string => `${VOICE_SESSIONS_API}/${encodeURIComponent(id)}`;
export const exportApi = (id: string): string => `${sessionApi(id)}/export`;

export function duration(seconds: number | null | undefined): string {
  if (seconds == null) return 'open';
  const m = Math.floor(seconds / 60), s = Math.round(seconds % 60);
  return m ? `${m}m ${s}s` : `${s}s`;
}


/** The rail row's second line: workspace, length, tool calls, how it ended. */
export function sessionSubline(s: VoiceSessionListItem): string {
  return [s.tenant, duration(s.seconds), plural(s.toolCallCount, 'tool call'), s.stopReason ?? (s.endedAt ? 'closed' : 'open'), s.mock ? 'scripted' : null]
    .filter(Boolean).join(' · ');
}

/** The session row's facts, as the detail's KeyValue shows them. */
export function sessionFacts(d: VoiceSessionDetail): Array<{ label: string; value: string; mono?: boolean }> {
  const s = d.session;
  const usd = (v: number | null) => (v == null ? 'unknown' : `$${v.toFixed(4)}`);
  return [
    // 'Id', not 'Session': the section heading over these facts already says Session.
    { label: 'Id', value: s.id, mono: true },
    { label: 'Workspace', value: s.tenant },
    { label: 'Started', value: when(s.startedAt) },
    { label: 'Ended', value: s.endedAt ? when(s.endedAt) : 'still open' },
    { label: 'Length', value: `${duration(s.seconds)} of ${duration(s.maxSeconds)}` },
    { label: 'Stopped by', value: s.stopReason ?? 'not yet' },
    ...(s.resumeOf ? [{ label: 'Resumes', value: s.resumeOf, mono: true }] : []),
    ...(confirmationsLine(d.events) ? [{ label: 'Confirmations', value: confirmationsLine(d.events)! }] : []),
    { label: 'Model', value: [s.model, s.voice].filter(Boolean).join(' · ') || 'unknown', mono: true },
    { label: 'Cost', value: `${usd(s.costUsd)}${s.costBasis ? ` (${s.costBasis})` : ''}` },
    { label: 'Tool calls', value: `${s.toolCallCount}${s.lastOutcome ? `, last ${s.lastOutcome}` : ''}` },
    { label: 'Mode', value: s.mock ? 'scripted (MOCK_VOICE)' : 'live' },
  ];
}

/** One event's fields as one line of compact JSON (the rows were sanitized when written). */
export function eventData(data: Record<string, unknown>): string {
  const text = JSON.stringify(data ?? {});
  return text === '{}' ? '' : text;
}

/** What "Copy as JSON" puts on the clipboard: the server's log, plus the on-device transcript when one is kept. */
export function logJson(detail: VoiceSessionDetail, transcript: KeptTranscript | null): string {
  return JSON.stringify({
    ...detail,
    ...(transcript ? { transcript: { keptOn: 'this device', savedAt: transcript.savedAt, turns: transcript.turns } } : {}),
  }, null, 2);
}

/**
 * G40: every card the session answered, in order: the tool, who answered (voice or click), the matched word of a
 * spoken answer (the closed vocabulary, never the utterance) and how long the card waited. Null when none was.
 */
export function confirmationsLine(events: ReadonlyArray<{ kind: string; data: Record<string, unknown> }>): string | null {
  const rows = events.filter((e) => e.kind === 'confirmed' || e.kind === 'cancelled').map((e) => {
    const d = e.data ?? {};
    const tool = typeof d['tool'] === 'string' ? d['tool'] : 'card';
    const by = typeof d['by'] === 'string' ? d['by'] : 'click';
    const phrase = typeof d['phrase'] === 'string' ? ` "${d['phrase']}"` : '';
    const after = typeof d['afterMs'] === 'number' ? `, ${(d['afterMs'] / 1000).toFixed(1)} s` : '';
    return `${tool} ${e.kind === 'confirmed' ? 'confirmed' : 'cancelled'} by ${by}${phrase}${after}`;
  });
  return rows.length ? rows.join('; ') : null;
}

// ── Logging's Voice source (G37): the session as the page's one record shape ──

export function voiceRows(sessions: readonly VoiceSessionListItem[]): LogRow[] {
  return sessions.map((s) => ({ source: 'voice', kind: 'session', id: s.id, at: s.startedAt, subline: sessionSubline(s) }));
}

/**
 * G53: the delegated model's input tokens per response, from the sideband's cumulative `usage` rows (one at most
 * every 30 s): each row's input and response counts less the previous row's. Keyed by the row's seq; "11,661 per
 * response (7)". The delegation re-reads the whole conversation each response, so this figure climbs through a session.
 */
export function tokensPerResponse(events: VoiceSessionDetail['events']): Map<number, { perResponse: number; responses: number }> {
  const out = new Map<number, { perResponse: number; responses: number }>();
  let prev = { input: 0, responses: 0 };
  for (const e of events) {
    if (e.kind !== 'usage' || e.data?.['source'] !== 'sideband') continue;
    const input = e.data['inputTokens'];
    const responses = e.data['responses'];
    if (typeof input !== 'number' || typeof responses !== 'number') continue;
    const dr = responses - prev.responses;
    if (dr > 0 && input >= prev.input) out.set(e.seq, { perResponse: Math.round((input - prev.input) / dr), responses: dr });
    prev = { input, responses };
  }
  return out;
}

const thousands = (n: number) => n.toLocaleString('en-US');

/** The record's fact: the first and the last interval's input per response, and the session's responses. Null when none. */
export function tokensFact(events: VoiceSessionDetail['events']): string | null {
  const per = [...tokensPerResponse(events).values()];
  if (!per.length) return null;
  const total = per.reduce((n, p) => n + p.responses, 0);
  const first = per[0]!.perResponse, last = per[per.length - 1]!.perResponse;
  return per.length === 1 ? `${thousands(first)} per response (${total} responses)` : `${thousands(first)} → ${thousands(last)} per response (${total} responses)`;
}

/**
 * G47: a call's Detail: who confirmed it, and for a failed call (or a route's brake) why, from its `tool-result`
 * event's summary: the code (`http-409`, `receipt-timeout`…) and the gate (`gate:run-budget`), or the refusal's code.
 */
export function callDetail(call: { id: string; outcome: string; confirmedBy: string | null }, events: VoiceSessionDetail['events']): string {
  const result = events.find((e) => e.kind === 'tool-result' && e.data?.['toolCallId'] === call.id);
  const summary = (result?.data?.['summary'] ?? {}) as Record<string, unknown>;
  const parts: string[] = [];
  if (call.confirmedBy) parts.push(`confirmed by ${call.confirmedBy}`);
  const word = (v: unknown) => (typeof v === 'string' && /^[a-z][a-z0-9:_-]{0,60}$/i.test(v) ? v : null);
  const code = word(summary['code']);
  const gate = word(summary['gate']);
  const reason = word(summary['reason']);
  if (code) parts.push(`code: ${code}`);
  if (gate) parts.push(`gate:${gate}`);
  if (!code && call.outcome === 'refused' && reason) parts.push(`refused: ${reason}`);
  return parts.join(' · ');
}

// ── G63: the conversation, as the session's heard and spoke rows ───────────

const HEARD_LABEL: Record<HeardOutcome, string> = { answered: 'answered', delegated: 'delegated', card: 'card', ignored: 'ignored' };
const SPOKE_LABEL: Record<SpokeAfter, string> = { result: 'after a result', commentary: 'after the dock', user: 'after you', unprompted: 'unprompted' };

/** The heard and spoke rows in the order they began (their `atMs`, then the log's order), as the Conversation table shows them. */
export function conversationRows(events: VoiceSessionDetail['events']): ConversationRow[] {
  const rows: Array<ConversationRow & { order: number }> = [];
  for (const e of events) {
    const g = readDiagnostic(e.kind, e.data);
    if (g?.event === 'heard') {
      rows.push({ id: `h${e.seq}`, seq: e.seq, atMs: g.atMs, who: 'you', wordCount: g.wordCount, ms: g.ms, outcome: g.outcome, label: HEARD_LABEL[g.outcome],
        detail: [g.afterMs != null ? `${took(g.afterMs)} after` : null, g.delegations > 1 || (g.delegations === 1 && g.outcome !== 'delegated') ? `${g.delegations} delegations` : null].filter(Boolean).join(' · '),
        order: g.atMs || Date.parse(e.at) || 0 });
    } else if (g?.event === 'spoke') {
      rows.push({ id: `s${e.seq}`, seq: e.seq, atMs: g.atMs, who: 'voice', wordCount: g.wordCount, ms: g.ms, outcome: g.after, label: SPOKE_LABEL[g.after], detail: '',
        order: g.atMs || Date.parse(e.at) || 0 });
    }
  }
  return rows.sort((a, b) => a.order - b.order || a.seq - b.seq).map(({ order: _o, ...r }) => r);
}

/** "12 heard: 7 delegated, 3 answered, 2 ignored · the voice spoke 9 times (2 unprompted)"; null when the log has no heard or spoke rows. */
export function conversationHealth(rows: readonly ConversationRow[]): string | null {
  const heard = rows.filter((r) => r.who === 'you');
  const spoke = rows.filter((r) => r.who === 'voice');
  if (!heard.length && !spoke.length) return null;
  const order: HeardOutcome[] = ['delegated', 'answered', 'card', 'ignored'];
  const parts = order.map((o) => [o, heard.filter((r) => r.outcome === o).length] as const).filter(([, n]) => n > 0).map(([o, n]) => `${n} ${o}`);
  const unprompted = spoke.filter((r) => r.outcome === 'unprompted').length;
  const head = `${heard.length} heard${parts.length ? `: ${parts.join(', ')}` : ''}`;
  const tail = spoke.length ? ` · the voice spoke ${spoke.length} time${spoke.length === 1 ? '' : 's'}${unprompted ? ` (${unprompted} unprompted)` : ''}` : '';
  return head + tail;
}

/**
 * G63 item 6: the words this device kept (transcriptKeep, owner-only, never sent) beside the rows: each kept turn goes
 * to the row of its side (you → heard, assistant → spoke) that began nearest to it, within KEPT_MATCH_MS. Nothing
 * changes server-side; with no kept transcript every row's words are empty.
 */
export const KEPT_MATCH_MS = 3000;
export function keptWordsFor(rows: readonly ConversationRow[], transcript: KeptTranscript | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!transcript) return out;
  for (const t of transcript.turns) {
    const text = t.text.trim();
    if (!text) continue;
    const who = t.role === 'you' ? 'you' : 'voice';
    let best: ConversationRow | null = null;
    for (const r of rows) {
      if (r.who !== who || !r.atMs) continue;
      const gap = Math.abs(r.atMs - t.at);
      if (gap <= KEPT_MATCH_MS && (!best || gap < Math.abs(best.atMs - t.at))) best = r;
    }
    if (best) out.set(best.id, out.has(best.id) ? `${out.get(best.id)} ${text}` : text);
  }
  return out;
}

/** The voice's own context use (G63): the highest usage ratio the log saw, from the dock's `context` rows or the sideband's usage rows. */
export function contextFact(events: VoiceSessionDetail['events']): string | null {
  let max: number | null = null;
  for (const e of events) {
    const g = readDiagnostic(e.kind, e.data);
    const r = g?.event === 'context' ? g.ratio : e.kind === 'usage' && typeof e.data?.['contextRatio'] === 'number' ? e.data['contextRatio'] as number : null;
    if (r != null && Number.isFinite(r) && (max == null || r > max)) max = r;
  }
  return max == null ? null : `${(max * 100).toFixed(1)}% of its window at most`;
}

export function voiceRecord(d: VoiceSessionDetail): LogRecord {
  const perResponse = tokensPerResponse(d.events);
  const fact = tokensFact(d.events);
  const rows = conversationRows(d.events);
  const health = conversationHealth(rows);
  const context = contextFact(d.events);
  return {
    source: 'voice', kind: 'session', id: d.session.id, label: `Session ${when(d.session.startedAt)}`,
    facts: [
      ...sessionFacts(d),
      ...(fact ? [{ label: 'Input per response', value: fact }] : []),
      ...(health ? [{ label: 'Conversation', value: health }] : []),
      ...(context ? [{ label: 'Voice context', value: context }] : []),
    ],
    ...(rows.length ? { conversation: { rows, health: health ?? '' } } : {}),
    callsTitle: 'Tool calls',
    calls: d.toolCalls.map((c) => ({ id: c.id, at: c.at, name: c.tool, outcome: c.outcome, detail: callDetail(c, d.events), tookMs: c.durationMs })),
    events: d.events.map((e) => {
      const t = perResponse.get(e.seq);
      return { seq: e.seq, at: e.at, kind: e.kind, data: eventData(e.data), ...(t ? { tokens: `${thousands(t.perResponse)} (${t.responses})` } : {}) };
    }),
    raw: d,
  };
}
