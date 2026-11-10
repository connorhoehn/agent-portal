// The worker's self-report (docs/learning-loop-design.md §1): a fenced
// `lab-report` JSON block at the end of a run's final message, carrying the
// three things only the run knows — what it did, how it checked, what got in
// the way. The run framing asks for it in three lines (LAB_REPORT_ASK); this
// module reads it back.
//
// The reader is tolerant by contract: whatever a model (or anything that got
// into its context) wrote, the answer is a report with those fields filled or
// empty and a state, never an exception. Missing → 'missing'. Unparseable,
// over-long, not an object, or nothing usable in it → 'malformed'. Every
// string is cleaned (control and direction-override characters dropped) and
// capped (RUN_REPORT_LIMITS) before it is returned. The text is data: it is
// stored and shown, and this lane never puts it into a prompt.
import { RUN_REPORT_LIMITS as L, type RunReportVerification, type SelfReportState } from './types.js';

/** The three lines the run framing and the brief's "How to report back" carry. */
export const LAB_REPORT_ASK: readonly string[] = [
  'When you finish, end your final message with a fenced block tagged `lab-report` holding one JSON object, and put nothing after it.',
  'Its fields: `summary` (what you did, under 1,200 characters), `verification` (each command you ran to check the work, as `{"command": "npm test", "passed": true}`), `obstacles` (up to 8 short lines: what went wrong and how you got round it).',
  'Send the block even when nothing went wrong (`"obstacles": []`); a run without one reports nothing back.',
];

export interface ParsedSelfReport {
  state: SelfReportState;
  summary: string;
  verification: RunReportVerification[];
  obstacles: string[];
}

const EMPTY = (state: SelfReportState): ParsedSelfReport => ({ state, summary: '', verification: [], obstacles: [] });

// C0 controls except \t \n, DEL, C1 controls, and the bidi embedding/override/isolate marks
// (a reader must see the text in the order it was written).
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F‪-‮⁦-⁩‎‏]/g;

/** Untrusted text → shown-as-text safe: unsafe characters dropped, trimmed, capped (on a code point boundary). */
export function cleanText(v: unknown, max: number, opts: { singleLine?: boolean } = {}): string {
  if (typeof v !== 'string') return '';
  let s = v.replace(UNSAFE, '');
  s = opts.singleLine ? s.replace(/\s+/g, ' ') : s.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n');
  s = s.trim();
  if (s.length <= max) return s;
  // Cap by UTF-16 length (what `length` limits mean everywhere else) without splitting a surrogate pair.
  let cut = s.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut.trimEnd();
}

const FENCE_OPEN = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*lab-report[ \t]*$/;

/**
 * The text inside the LAST ```lab-report fence of a final message, or null.
 * An unterminated fence runs to the end of the message (a run cut off mid-block
 * still gets read, and fails as malformed if what is there does not parse).
 * A message with no fence that is itself one JSON object is taken as the block
 * (what a worker sends when it has already extracted it).
 */
export function extractLabReportBlock(message: unknown): string | null {
  if (typeof message !== 'string' || !message.trim()) return null;
  // Read only the tail: the block is asked for at the end, and a multi-megabyte message is not scanned whole.
  const text = message.length > 4 * L.block ? message.slice(-4 * L.block) : message;
  const lines = text.split(/\r?\n/);
  let open = -1;
  let fence = '';
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const m = FENCE_OPEN.exec(lines[i]!);
    if (m) { open = i; fence = m[1]!; break; }
  }
  if (open < 0) {
    const t = text.trim();
    return t.startsWith('{') && t.endsWith('}') ? t : null;
  }
  const body: string[] = [];
  for (let i = open + 1; i < lines.length; i += 1) {
    const l = lines[i]!;
    // A closing fence: the same character, at least as long, nothing else on the line.
    if (new RegExp(`^[ \\t]{0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}[ \\t]*$`).test(l)) break;
    body.push(l);
  }
  return body.join('\n');
}

const PASS = new Set(['pass', 'passed', 'ok', 'success', 'succeeded', 'green', 'true', 'yes']);
const FAIL = new Set(['fail', 'failed', 'failure', 'error', 'red', 'false', 'no']);

function passedOf(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const k = v.trim().toLowerCase();
    if (PASS.has(k)) return true;
    if (FAIL.has(k)) return false;
  }
  return null;
}

/**
 * Parse a `lab-report` block (or a whole final message holding one). Never
 * throws. `ok` needs a JSON object with at least one of the three fields usable.
 */
export function parseLabReport(input: unknown): ParsedSelfReport {
  const raw = typeof input === 'string' ? extractLabReportBlock(input) : null;
  if (raw === null || !raw.trim()) return EMPTY('missing');
  if (raw.length > L.block) return EMPTY('malformed');
  let doc: unknown;
  try { doc = JSON.parse(raw); } catch { return EMPTY('malformed'); }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return EMPTY('malformed');
  const o = doc as Record<string, unknown>;

  const summary = cleanText(o['summary'], L.summary);

  const verification: RunReportVerification[] = [];
  if (Array.isArray(o['verification'])) {
    for (const v of o['verification']) {
      if (verification.length >= L.verification) break;
      if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
      const e = v as Record<string, unknown>;
      const command = cleanText(e['command'], L.command, { singleLine: true });
      const passed = passedOf(e['passed'] ?? e['result'] ?? e['status']);
      if (command && passed !== null) verification.push({ command, passed });
    }
  }

  const obstacles: string[] = [];
  if (Array.isArray(o['obstacles'])) {
    for (const v of o['obstacles']) {
      if (obstacles.length >= L.obstacles) break;
      const text = cleanText(v, L.obstacle, { singleLine: true });
      if (text) obstacles.push(text);
    }
  }

  const usable = summary !== '' || verification.length > 0 || obstacles.length > 0
    // An honest "nothing to say": the fields are there with the right shapes, just empty.
    || (typeof o['summary'] === 'string' && Array.isArray(o['verification']) && Array.isArray(o['obstacles']));
  return usable ? { state: 'ok', summary, verification, obstacles } : EMPTY('malformed');
}
