// The run console, made readable.
//
// WHAT WAS WRONG. `tools/local-compute-worker.mjs` runs `claude -p` with
// `--output-format stream-json` and ships the child's stdout to
// `POST /api/local-compute/jobs/:id/log` in whatever chunks the pipe hands it.
// The middleware stores those bytes verbatim and the browser rendered them
// verbatim, so the panel labelled as this machine's console was a wall of
// `{"type":"assistant","message":{"id":"msg_01…` — one enormous line per
// poll. It WAS updating live. You could not tell, because nothing in it
// changed in a way a person reads, and a reader watching JSON scroll past
// reasonably concludes nothing is happening.
//
// The page already has a renderer for this exact stream:
// `components/runs/RunTimeline.tsx` turns the same frames into a timeline for
// the devbox and bot pages. It owns an EventSource and a box tail, though, and
// this log is polled text — so what is shared here is the transform's
// vocabulary (`components/runs/toolSummary.ts`, which that component and this
// module both import) and not the component.
//
// Everything here is defensive. The chunks arrive split at arbitrary byte
// offsets, stderr is interleaved with stdout, and a killed child leaves a
// half-written final line. A frame that does not parse is shown as itself
// rather than dropped: raw output is worth more than a swallowed line.

import { toolSummary } from '../../components/runs/toolSummary.ts';

export interface LogEntry { seq: number; text: string }

export type LogLineKind = 'meta' | 'text' | 'tool' | 'result' | 'raw' | 'error';

export interface RunLogLine {
  id: string;
  kind: LogLineKind;
  /** What the reader sees. Never empty. */
  text: string;
}

/** `{"type":"result",...}` carries the run's own verdict; format it as one line. */
function resultLine(ev: Record<string, unknown>): string {
  const bits: string[] = [];
  const subtype = typeof ev['subtype'] === 'string' ? ev['subtype'] : '';
  bits.push(ev['is_error'] === true ? 'failed' : subtype === 'success' || !subtype ? 'done' : subtype);
  const ms = Number(ev['duration_ms']);
  if (Number.isFinite(ms) && ms > 0) bits.push(`${(ms / 1000).toFixed(1)}s`);
  const turns = Number(ev['num_turns']);
  if (Number.isFinite(turns) && turns > 0) bits.push(`${turns} turn${turns === 1 ? '' : 's'}`);
  const cost = Number(ev['total_cost_usd']);
  // A local model costs nothing, and "$0.00" alongside "done" reads as a
  // missing number rather than a fact. Only a real charge is worth a column.
  if (Number.isFinite(cost) && cost > 0) bits.push(`$${cost.toFixed(4)}`);
  return bits.join(' · ');
}

/** One parsed stream-json frame → zero or more reader-visible lines. */
function framesFor(ev: Record<string, unknown>, id: string): RunLogLine[] {
  const type = String(ev['type'] ?? '');

  if (type === 'system') {
    // The init frame names the model and the working directory — the two
    // facts a reader wants before deciding whether the run is even pointed at
    // the right thing.
    const bits: string[] = [];
    if (ev['model']) bits.push(`model ${String(ev['model'])}`);
    if (ev['cwd']) bits.push(`cwd ${String(ev['cwd'])}`);
    const sub = String(ev['subtype'] ?? 'system');
    return [{ id, kind: 'meta', text: bits.length ? `${sub} · ${bits.join(' · ')}` : sub }];
  }

  if (type === 'assistant' || type === 'user') {
    const content = ((ev['message'] as { content?: unknown } | undefined)?.content ?? []) as unknown;
    if (!Array.isArray(content)) return [];
    const out: RunLogLine[] = [];
    content.forEach((raw, i) => {
      if (!raw || typeof raw !== 'object') return;
      const block = raw as Record<string, unknown>;
      const blockId = `${id}.${i}`;
      if (block['type'] === 'text') {
        const text = String(block['text'] ?? '').trim();
        if (text) out.push({ id: blockId, kind: 'text', text });
        return;
      }
      if (block['type'] === 'tool_use') {
        const name = String(block['name'] ?? 'tool');
        const input = (block['input'] ?? {}) as Record<string, unknown>;
        const { summary } = toolSummary(name, input);
        out.push({ id: blockId, kind: 'tool', text: summary ? `${name}  ${summary}` : name });
        return;
      }
      if (block['type'] === 'tool_result') {
        // The output itself is usually long and is already visible in the
        // tool's own page; what belongs in a tail is that it came back, and
        // whether it came back angry.
        const failed = block['is_error'] === true;
        out.push({
          id: blockId,
          kind: failed ? 'error' : 'meta',
          text: failed ? 'tool failed' : 'tool returned',
        });
      }
    });
    return out;
  }

  if (type === 'result') return [{ id, kind: 'result', text: resultLine(ev) }];

  // A frame we have no vocabulary for is still evidence. Show its type rather
  // than its bytes, so an unknown frame is one short line instead of a wall.
  return [{ id, kind: 'meta', text: type || 'frame' }];
}

/**
 * The whole log, as lines a person can read.
 *
 * Chunks are joined before splitting because the worker ships whatever the
 * pipe gives it: a single JSON object is routinely cut across two POSTs, and
 * splitting per-chunk would turn every one of those into two unparseable
 * halves.
 */
export function runLogLines(entries: LogEntry[] | undefined): RunLogLine[] {
  if (!entries || entries.length === 0) return [];
  const joined = [...entries]
    .sort((a, b) => a.seq - b.seq)
    .map((e) => e.text)
    .join('');

  const out: RunLogLine[] = [];
  joined.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const id = `l${i}`;
    if (!line.startsWith('{')) {
      // stderr, or the worker's own `[worker] …` header lines.
      out.push({ id, kind: 'raw', text: line });
      return;
    }
    let ev: unknown;
    try {
      ev = JSON.parse(line);
    } catch {
      // A partial final line while the run is still writing. Showing the
      // fragment is noise; showing nothing loses nothing, because the next
      // poll carries the completed line.
      return;
    }
    if (!ev || typeof ev !== 'object') return;
    out.push(...framesFor(ev as Record<string, unknown>, id));
  });
  return out;
}
