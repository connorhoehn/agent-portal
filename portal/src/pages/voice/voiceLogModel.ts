// The Voice log view's data (docs/voice-navigator-gaps.md G20): the shapes
// GET /api/voice/sessions and GET /api/voice/sessions/:id answer
// (middleware routes/voice-log.ts), and the pure formatting the view uses, so
// `node --test` checks it without a browser.
//
// The server holds structured events only (no audio, transcript or tool
// arguments). A transcript kept on this device (lib/voice/transcriptKeep.ts)
// is merged in here for display and for "Copy as JSON", and never sent.

import type { KeptTranscript } from '../../lib/voice/transcriptKeep.ts';
import { dayGroupsBy, when, type LogRecord, type LogRow } from '../logging/loggingModel.ts';

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

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

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
    { label: 'Session', value: s.id, mono: true },
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

export function voiceRecord(d: VoiceSessionDetail): LogRecord {
  return {
    source: 'voice', kind: 'session', id: d.session.id, label: `Session ${when(d.session.startedAt)}`,
    facts: sessionFacts(d),
    callsTitle: 'Tool calls',
    calls: d.toolCalls.map((c) => ({ id: c.id, at: c.at, name: c.tool, outcome: c.outcome, detail: c.confirmedBy ? `confirmed by ${c.confirmedBy}` : '', tookMs: c.durationMs })),
    events: d.events.map((e) => ({ seq: e.seq, at: e.at, kind: e.kind, data: eventData(e.data) })),
    raw: d,
  };
}
