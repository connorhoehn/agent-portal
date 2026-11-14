/**
 * A decision trace for the scenario simulator, off by default. Only when INSECURE_DEV_MODE is on (never in production) AND
 * MEETING_ASSISTANT_TRACE_FILE names a file does each call append one JSON line per event or decision to it.
 *
 * What a line may carry: an event or decision name, times, ids, speaker ids, booleans and short reason codes. Never transcript or
 * reply text, tool arguments, results, audio or secrets: the caller passes only those kinds of fields, and anything else (a
 * string longer than a short code) is dropped here as well.
 */
import { appendFileSync } from 'node:fs';
import { insecureDevMode } from '../insecure-dev-mode.js';

export const TRACE_FILE_SETTING = 'MEETING_ASSISTANT_TRACE_FILE';

type Field = number | boolean | null | string | undefined;

function traceFile(): string | null {
  const file = (process.env[TRACE_FILE_SETTING] ?? '').trim();
  return file && insecureDevMode() ? file : null;
}

/** A short id or code only: letters, digits and a few separators, at most 80 characters. */
const SHORT = /^[\w.:|@-]{0,80}$/;

export function trace(event: string, fields: Record<string, Field> = {}): void {
  const file = traceFile();
  if (!file) return;
  const line: Record<string, number | boolean | null | string> = { ev: event, wall: Date.now() };
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    if (typeof v === 'string' && !SHORT.test(v)) continue;
    if (typeof v === 'number' && !Number.isFinite(v)) continue;
    line[k] = v;
  }
  try { appendFileSync(file, `${JSON.stringify(line)}\n`); } catch { /* a trace never breaks the call */ }
}
