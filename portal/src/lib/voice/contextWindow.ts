// The delegation's context, bounded (docs/voice-navigator-gaps.md G31).
//
// The 23:03 session reached 17 k input tokens per delegation by its end: every
// tool result and every page note stays in the session, and each delegation
// reads them all again. Two things change what the dock sends, and one thing
// keeps count:
//
// 1. modelOutput: what the model is sent of a result. No links (the model
//    never passes a path; the dock keeps every href in its kept results and
//    the choice card reads the result itself, not the wire), every list cut
//    to its first rows until the whole output fits OUTPUT_MAX_CHARS, with
//    `more` saying how many were left out. The strip, the log and the kept
//    rows still see the full result.
// 2. Page context is one current note, replaced rather than appended: the
//    controller sends it only when the page in view changes (its text), and
//    says that it replaces every earlier one.
// 3. DelegationContext: the dock's model of what a delegation reads. Tool
//    results of the last CONTEXT_FULL_TURNS turns count in full, older ones as
//    their one-line summary; the latest page note only; every spoken and
//    heard line. `sentChars` counts everything the dock ever sent, so the two
//    figures say how far the provider's own retention can sit from the window.
//
// What this cannot do: the Live API's data channel has no client event that
// deletes or rewrites an item already in the session (the mint's allowlist
// is close, mute, unmute, response.item.create, response.create and the two
// appends), so an aged-out result is not removed from the provider's copy;
// the window holds because every result is compact and nothing is re-sent.
// The real per-delegation figure is the session's delegated tokens (G11).

/** Turns whose tool results count in full; older results count as one line each. */
export const CONTEXT_FULL_TURNS = 6;
/** The most characters one tool output sends the model. */
export const OUTPUT_MAX_CHARS = 1600;
/** The usual characters-per-token rule for English text and JSON. */
export const CHARS_PER_TOKEN = 4;
/** A summary line's cap. */
const LINE_MAX = 120;
/** The sentence the controller appends to a page note (G31: replaced, not appended). */
export const PAGE_NOTE_REPLACES = 'This replaces every earlier page context note.';

function stripLinks(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripLinks);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (k === 'href' || k === 'url') continue;
      out[k] = stripLinks(x);
    }
    return out;
  }
  return v;
}

/** The longest top-level list of an output (rows, candidates, results…), by key. */
function longestList(o: Record<string, unknown>): string | null {
  let best: string | null = null;
  for (const [k, v] of Object.entries(o)) if (Array.isArray(v) && v.length > 1 && (!best || v.length > (o[best] as unknown[]).length)) best = k;
  return best;
}

/**
 * What the model is sent of a tool result: no links, and at most
 * OUTPUT_MAX_CHARS of JSON, its longest list cut from the end with `more`
 * (the count left out) when it does not fit.
 */
export function modelOutput(output: Record<string, unknown>): Record<string, unknown> {
  let o = stripLinks(output) as Record<string, unknown>;
  let left = 0;
  for (let guard = 0; JSON.stringify(o).length > OUTPUT_MAX_CHARS && guard < 40; guard++) {
    const key = longestList(o);
    if (!key) break;
    const list = o[key] as unknown[];
    o = { ...o, [key]: list.slice(0, -1) };
    left += 1;
  }
  return left ? { ...o, more: (typeof o['more'] === 'number' ? o['more'] : 0) + left } : o;
}

/** A result in one line: the tool and the strip's summary (the dock's own words, capped). */
export function summaryLine(tool: string, summary: string): string {
  const s = `${tool}: ${summary}`.replace(/\s+/g, ' ').trim();
  return s.length > LINE_MAX ? `${s.slice(0, LINE_MAX - 1)}…` : s;
}

interface Turn { results: Array<{ chars: number; line: string }> }

/** The dock's model of what one delegation reads (see the module header). */
export class DelegationContext {
  private turns: Turn[] = [];
  private page: string | null = null;
  private sent = 0;
  /** Every line spoken or heard and every other append: the window keeps them all (the provider keeps the transcript). */
  private lines = 0;

  /** A delegation began: a new turn. */
  newTurn(): void {
    this.turns.push({ results: [] });
  }

  private current(): Turn {
    if (!this.turns.length) this.newTurn();
    return this.turns[this.turns.length - 1]!;
  }

  /** A tool output went to the model: its JSON length, and its one-line summary for when it ages out. */
  result(sentChars: number, line: string): void {
    this.current().results.push({ chars: sentChars, line });
    this.sent += sentChars;
  }

  /** The page note now in force (it replaces the last one). */
  pageNote(text: string): void {
    this.page = text;
    this.sent += text.length;
  }

  /** Another silent or spoken append (a choice made, a job's outcome, a refusal line). */
  note(chars: number): void {
    this.lines += chars;
    this.sent += chars;
  }

  /** A line the user said or the voice spoke (the provider keeps the transcript). */
  speech(chars: number): void {
    this.lines += chars;
  }

  /** The window's characters: recent results in full, older ones as lines, the page note, every line spoken. */
  windowChars(): number {
    const cut = this.turns.length - CONTEXT_FULL_TURNS;
    let n = (this.page?.length ?? 0) + this.lines;
    this.turns.forEach((t, i) => {
      for (const r of t.results) n += i >= cut ? r.chars : r.line.length + 1;
    });
    return n;
  }

  /** Everything the dock has sent into the session (outputs and appends), whatever the window says. */
  sentChars(): number { return this.sent; }

  /** The one-line summaries of the results that have left the window, oldest first. */
  agedLines(): string[] {
    const cut = this.turns.length - CONTEXT_FULL_TURNS;
    return this.turns.slice(0, Math.max(0, cut)).flatMap((t) => t.results.map((r) => r.line));
  }

  get turnCount(): number { return this.turns.length; }

  reset(): void {
    this.turns = [];
    this.page = null;
    this.sent = 0;
    this.lines = 0;
  }
}

/** Characters to estimated tokens. */
export const estimateTokens = (chars: number): number => Math.ceil(chars / CHARS_PER_TOKEN);

// ── G33: terse by default ───────────────────────────────────────────────────

/** The rows list, search and get hand the model unless the call asked for `detail`. */
export const BRIEF_ROWS = 3;
/** Words per name in the `say` line. */
const SAY_NAME_WORDS = 5;
const BRIEF_TOOLS: ReadonlySet<string> = new Set(['list', 'search', 'get']);

function shortName(t: unknown): string {
  const words = String(t ?? '').replace(/\s+/g, ' ').trim().split(' ');
  return words.length > SAY_NAME_WORDS ? `${words.slice(0, SAY_NAME_WORDS).join(' ')}…` : words.join(' ');
}

function labelOf(output: Record<string, unknown>, n: number): string {
  const of = typeof output['of'] === 'string' ? output['of'] : typeof output['part'] === 'string' ? output['part'] : null;
  if (!of) return n === 1 ? 'result' : 'results';
  const words = of.replace(/-/g, ' ');
  return n === 1 ? words : words.endsWith('s') ? words : `${words}s`;
}

/**
 * G65: a search's line is the count and the top hit, and "read them" for the rest ("12 decisions, top: Adopt
 * OpenTelemetry. Say "read them" for more."). Three names read out a 29-word, 9-second answer in the owner's session
 * (10 November 2026); a search answers "where is X", so the first hit is the answer. A one-fact answer is its own line.
 */
/** Search types whose spoken word is not the type plus "s". */
const SEARCH_TYPE_WORDS: Readonly<Record<string, readonly [string, string]>> = {
  person: ['person', 'people'], work: ['work item', 'work items'], knowledge: ['document', 'documents'],
  calllog: ['call', 'calls'], dm: ['direct message', 'direct messages'],
};

function searchSay(output: Record<string, unknown>, total: number, top: string): string {
  if (typeof output['answer'] === 'string' && output['answer'].trim()) return output['answer'].trim();
  const type = typeof output['type'] === 'string' && output['type'] !== 'all' ? output['type'] : null;
  const named = type ? SEARCH_TYPE_WORDS[type] : undefined;
  const label = named ? named[total === 1 ? 0 : 1] : type ? labelOf({ of: type }, total) : total === 1 ? 'result' : 'results';
  return total > 1 ? `${total} ${label}, top: ${top}. Say "read them" for more.` : `1 ${label}: ${top}.`;
}

/**
 * What list, search and get hand the model by default (G33): the count, the
 * first BRIEF_ROWS rows, `more` (how many the model was not given) and `say`,
 * a ready line of the count and the top names ("11 work items, 3 high
 * priority: A, B and C, and 8 more."). `detail: true` in the call's arguments
 * hands over every row the runner returned. The kept rows are the runner's,
 * untouched, so "open the fifth one" still works.
 */
export function briefOutput(tool: string, args: unknown, output: Record<string, unknown>): Record<string, unknown> {
  if (!BRIEF_TOOLS.has(tool) || !Array.isArray(output['rows'])) return output;
  let a: Record<string, unknown> = {};
  if (typeof args === 'string') { try { a = JSON.parse(args) as Record<string, unknown>; } catch { a = {}; } } else if (args && typeof args === 'object') a = args as Record<string, unknown>;
  const rows = output['rows'] as Array<Record<string, unknown>>;
  const total = typeof output['count'] === 'number' ? output['count'] : typeof output['total'] === 'number' ? output['total'] : rows.length;
  if (a['detail'] === true || !rows.length) return output;
  const top = rows.slice(0, BRIEF_ROWS);
  const more = Math.max(0, total - top.length);
  const high = rows.filter((r) => /^(high|urgent|critical|p0|p1)$/i.test(String(r['priority'] ?? ''))).length;
  const names = top.map((r) => shortName(r['title'] ?? r['ref']));
  const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0];
  const say = tool === 'search'
    ? searchSay(output, total, names[0]!)
    : `${total} ${labelOf(output, total)}${high ? `, ${high} high priority` : ''}: ${list}${more ? `, and ${more} more` : ''}.`;
  return { ...output, rows: top, count: total, more, say, detail: 'Pass detail true to get every row; only when the user asks for all of them.' };
}

/** The spoken length the user chose on this device (G33): terse by default. */
export type Verbosity = 'terse' | 'normal';
export const VERBOSITY_KEY = 'voiceVerbosity';
const verbosityListeners = new Set<() => void>();

function prefs(): Storage | null {
  try { return (globalThis as { localStorage?: Storage }).localStorage ?? null; } catch { return null; }
}

export function voiceVerbosity(): Verbosity {
  try { return prefs()?.getItem(VERBOSITY_KEY) === 'normal' ? 'normal' : 'terse'; } catch { return 'terse'; }
}

export function setVoiceVerbosity(v: Verbosity): void {
  try { prefs()?.setItem(VERBOSITY_KEY, v); } catch { /* a private window keeps the default */ }
  for (const l of verbosityListeners) l();
}

export function subscribeVoiceVerbosity(listener: () => void): () => void {
  verbosityListeners.add(listener);
  return () => { verbosityListeners.delete(listener); };
}

/**
 * The note the controller appends when a session starts (session.thinking.append: the data channel's allowlist
 * leaves session.instructions.append to the server, so the browser can only add context, never instructions).
 */
export function verbosityNote(v: Verbosity): string {
  return v === 'normal'
    ? 'Speaking preference (from the user\'s settings): normal length. Answer in a few sentences when the result warrants it; still give counts before lists and name at most three items unless asked for all.'
    : 'Speaking preference (from the user\'s settings): terse. One short sentence per turn: the count, then at most three names. No summaries, no restating the request, nothing about a page the user is looking at. Say more only when the user asks.';
}
