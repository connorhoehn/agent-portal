// The Voice log view's data (docs/voice-navigator-gaps.md G20): the shapes
// GET /api/voice/sessions and GET /api/voice/sessions/:id answer
// (middleware routes/voice-log.ts), and the pure formatting the view uses, so
// `node --test` checks it without a browser.
//
// The server holds structured events only (no audio, transcript or tool
// arguments). A transcript kept on this device (lib/voice/transcriptKeep.ts)
// is merged in here for display and for "Copy as JSON", and never sent.

import type { KeptTranscript } from '../../lib/voice/transcriptKeep.ts';

export const VOICE_LOG_PATH = '/voice/log';
export const VOICE_SESSIONS_API = '/api/voice/sessions';

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

/** `/voice/log?session=<id>`: the view's own link to one session. */
export const sessionHref = (id: string): string => `${VOICE_LOG_PATH}?session=${encodeURIComponent(id)}`;
export const sessionApi = (id: string): string => `${VOICE_SESSIONS_API}/${encodeURIComponent(id)}`;
export const exportApi = (id: string): string => `${sessionApi(id)}/export`;

/** "8 Nov, 17:49" in the reader's locale and zone; the raw string when it does not parse. */
export function when(iso: string | null | undefined, locale?: string): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(t));
}

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
