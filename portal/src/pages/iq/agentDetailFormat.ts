// Pure formatting/parsing logic for AgentDetailPage, split out so it can be
// unit-tested without mounting the page.
import type { ChipTone, LogLevel } from '@connorhoehn/ui-components/shared';
import { STATUS_TONE } from '../agentFleetRows.ts';
import { relativeTime } from '../../lib/relativeTime.ts';

export function ms(n: number | null | undefined): string {
  if (n == null || n === 0) return '—';
  return n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(1)} s`;
}

export function when(iso: string | null | undefined): string {
  // Delegates to lib/relativeTime rather than laddering here. Every copy of
  // this ladder in the portal had drifted differently — round vs floor at the
  // minute boundary, "just now" under 1 minute vs under 2, and past a week
  // some counted to "100d ago" forever while the shared one switches to a
  // date — so one instant read differently depending which page you were on.
  // The null sentinel below stays because callers here depend on it.
  if (!iso) return '—';
  return relativeTime(iso);
}

/**
 * Agent logs arrive as OpenTelemetry envelopes — one line is a whole JSON
 * document with the actual message buried in it. Rendered raw the pane is
 * unreadable, so the body and severity are lifted out when the shape matches
 * and the raw line is kept otherwise.
 */
export function readable(message: string): { level: string | null; text: string } {
  const trimmed = message.trim();
  if (!trimmed.startsWith('{')) return { level: null, text: message };
  try {
    const o = JSON.parse(trimmed) as Record<string, unknown>;
    const body = o['body'];
    const sev = o['severityText'] ?? o['severity_text'] ?? o['level'];
    if (typeof body === 'string') {
      return { level: typeof sev === 'string' ? sev : null, text: body };
    }
    // A span export, not a log line — say what it is instead of dumping it.
    if (o['resource'] || o['scopeSpans'] || o['resourceSpans']) {
      return { level: 'TRACE', text: '(telemetry span export)' };
    }
    return { level: typeof sev === 'string' ? sev : null, text: trimmed };
  } catch {
    return { level: null, text: message };
  }
}

export interface RawLogEvent { at: string; message: string }
export interface ParsedLogLine { at: string; level: string | null; text: string }

/**
 * The runtime emits each line twice — once as raw stdout and once wrapped in
 * an OpenTelemetry envelope — so every message appeared in the pane twice,
 * the second copy padded with trace_id/span_id noise. Keep the parsed one (it
 * carries a level) and drop the raw line that contains it. `hideTelemetry`
 * additionally drops span-export lines.
 */
export function visibleLogLines(events: RawLogEvent[], hideTelemetry: boolean): ParsedLogLine[] {
  const parsed = events.map((e) => ({ at: e.at, ...readable(e.message) }));
  const visible = hideTelemetry ? parsed.filter((l) => l.level !== 'TRACE') : parsed;

  const bodies = new Set(
    visible.filter((l) => l.level && l.text.length > 12).map((l) => l.text),
  );
  return visible.filter((l) => {
    if (l.level) return true;
    for (const b of bodies) if (l.text.includes(b)) return false;
    return true;
  });
}

export function countTelemetryLines(events: RawLogEvent[]): number {
  return events.filter((e) => readable(e.message).level === 'TRACE').length;
}

const LOG_LEVEL_MAP: Record<string, LogLevel> = {
  ERROR: 'error', WARN: 'warn', WARNING: 'warn', INFO: 'info', DEBUG: 'debug', TRACE: 'debug',
};

/** Maps the level lifted out of an envelope to the LogStream composite's level. */
export function toLogLevel(level: string | null): LogLevel | undefined {
  return level ? LOG_LEVEL_MAP[level] : undefined;
}

// Same canonical map the fleet list uses (agentFleetRows.ts) — the control
// plane only ever emits healthy/deploying/degraded/offline/unknown
// (`mapRuntimeStatus` in middleware/src/providers/agentcore.ts). This used to
// be a locally-invented map with dead `READY`/`unhealthy` keys the server
// never sends, and no entry for `deploying`/`offline`, which it does: an
// offline agent fell through to the `?? 'neutral'` default here while the
// fleet list correctly showed it red.
export const STATUS_CHIP_TONE: Record<string, ChipTone> = STATUS_TONE;
