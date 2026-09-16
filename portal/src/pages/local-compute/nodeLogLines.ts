// The machine's own operational scrollback, made ready for LogStream.
//
// Unlike runLogLines (which decodes `claude -p --output-format stream-json`
// frames from a job's stdout), a node's log is already what a person reads:
// tools/local-compute-worker.mjs's emit() writes one plain-text line per
// fact — `14:32:01 ✓ registered as connor-macbook` — so there is no frame
// format to parse here, and every line passes through verbatim. What this
// module does is the housekeeping runLogLines also does: order entries by
// seq (a retried batch or two in-flight POSTs can arrive out of order), and
// turn the worker's own level glyph into a LogStream `level` so a failure or
// a warning reads as one instead of blending into the rest of the scroll.

export interface NodeLogEntry { seq: number; text: string }

export type NodeLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface NodeLogLine {
  id: string;
  text: string;
  level: NodeLogLevel;
}

/**
 * The glyph `tools/local-compute-worker.mjs`'s `LEVEL_GLYPH` writes as the
 * second space-separated token of every line — `HH:MM:SS <glyph> message`.
 * A line from before this feature shipped, or one this map does not
 * recognize, reads as plain `info` rather than being hidden or miscoloured —
 * the worker's scrollback is worth showing even when it can't be toned.
 */
const GLYPH_LEVEL: Record<string, NodeLogLevel> = {
  '✗': 'error',
  '!': 'warn',
  '✓': 'info',
  '→': 'info',
  '·': 'info',
};

function levelOf(line: string): NodeLogLevel {
  const glyph = line.trim().split(/\s+/)[1];
  return (glyph && GLYPH_LEVEL[glyph]) || 'info';
}

/**
 * The whole log, ordered and ready to hand to `LogStream`.
 *
 * Entries arrive in ARRIVAL order — the transport can reorder two in-flight
 * POSTs, same as the per-job log this mirrors — so this sorts by `seq`
 * before rendering; otherwise a retried batch could show lines out of the
 * order the worker actually wrote them.
 */
export function nodeLogLines(entries: NodeLogEntry[] | undefined): NodeLogLine[] {
  if (!entries || entries.length === 0) return [];
  return [...entries]
    .sort((a, b) => a.seq - b.seq)
    .map((e) => ({ id: `n${e.seq}`, text: e.text, level: levelOf(e.text) }));
}
