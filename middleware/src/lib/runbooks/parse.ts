// Canonical markdown → RunbookDoc (design §2.2). The inverse of render.ts:
// parseRunbook(renderRunbook(doc)) deep-equals doc for every doc that
// formatProblems() accepts, and renderRunbook(parseRunbook(md)) === md for
// every canonical md. It also reads what a person (or a run's `lab propose`)
// writes by hand: CRLF, "*" bullets, "- [x]", "Expect:" and unbolded step
// lines are accepted. Anything it cannot place is an error with a line
// number — never silently dropped, because a dropped line is a dropped step.
import type { CommandLang, RunbookCommand, RunbookDoc, RunbookStep } from './types.js';
import { COMMAND_LANGS } from './types.js';
import { HEADINGS, TRIGGER_LABELS } from './render.js';

export interface ParseError { line: number; message: string }

export class RunbookParseError extends Error {
  constructor(readonly errors: ParseError[]) {
    super(`runbook markdown does not parse: ${errors.map((e) => `line ${e.line}: ${e.message}`).join('; ')}`);
    this.name = 'RunbookParseError';
  }
}

export type ParseResult =
  | { ok: true; doc: RunbookDoc; header: string[]; provenance: string | null }
  | { ok: false; errors: ParseError[] };

const LANG_ALIASES: Record<string, CommandLang> = { sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash', '': 'text' };

type SectionKey = keyof typeof HEADINGS;
const HEADING_TO_KEY = new Map<string, SectionKey>(
  (Object.entries(HEADINGS) as Array<[SectionKey, string]>).map(([k, h]) => [h.toLowerCase(), k]),
);
const TRIGGER_BY_LABEL = new Map<string, keyof typeof TRIGGER_LABELS>(
  (Object.entries(TRIGGER_LABELS) as Array<[keyof typeof TRIGGER_LABELS, string]>).map(([k, l]) => [l.toLowerCase(), k]),
);

interface Line { n: number; text: string }

export function parseRunbook(markdown: string): RunbookDoc {
  const r = tryParseRunbook(markdown);
  if (!r.ok) throw new RunbookParseError(r.errors);
  return r.doc;
}

export function tryParseRunbook(markdown: string): ParseResult {
  const errors: ParseError[] = [];
  const err = (n: number, message: string) => errors.push({ line: n, message });
  const all: Line[] = markdown.replace(/\r\n?/g, '\n').split('\n').map((text, i) => ({ n: i + 1, text }));
  if (all.length > 0 && all[all.length - 1]!.text === '') all.pop();

  let i = 0;
  const skipBlank = () => { while (i < all.length && all[i]!.text.trim() === '') i += 1; };

  skipBlank();
  const titleLine = all[i];
  const tm = titleLine ? /^#\s+(.+?)\s*$/.exec(titleLine.text) : null;
  if (!titleLine || !tm || titleLine.text.startsWith('##')) {
    return { ok: false, errors: [{ line: titleLine?.n ?? 1, message: 'expected "# <title>" as the first line' }] };
  }
  const title = tm[1]!;
  i += 1;

  skipBlank();
  const header: string[] = [];
  while (i < all.length && all[i]!.text.startsWith('>')) { header.push(all[i]!.text); i += 1; }

  skipBlank();
  const summaryParts: string[] = [];
  while (i < all.length && all[i]!.text.trim() !== '' && !/^##\s/.test(all[i]!.text)) { summaryParts.push(all[i]!.text.trim()); i += 1; }
  if (summaryParts.length === 0) err(all[i]?.n ?? all.length, 'expected a one-sentence summary under the title');
  const summary = summaryParts.join(' ');

  // Split the rest into sections. "## Notes" swallows everything up to the
  // provenance heading, so a note may carry its own headings.
  const sections = new Map<SectionKey, { at: number; body: Line[] }>();
  let provenance: string | null = null;
  let current: { key: SectionKey; body: Line[] } | null = null;
  let inUnknown = false; // the unknown heading is the error; its body is not reported line by line
  for (; i < all.length; i += 1) {
    const ln = all[i]!;
    const hm = /^##\s+(.+?)\s*$/.exec(ln.text);
    const inNotes = current?.key === 'notes';
    if (hm && (!inNotes || hm[1]!.toLowerCase() === HEADINGS.provenance.toLowerCase())) {
      const key = HEADING_TO_KEY.get(hm[1]!.toLowerCase());
      inUnknown = false;
      if (!key) { err(ln.n, `unknown section "## ${hm[1]}" (known: ${Object.values(HEADINGS).join(', ')})`); current = null; inUnknown = true; continue; }
      if (key === 'provenance') {
        provenance = all.slice(i + 1).map((l) => l.text).join('\n').trim() || null;
        break;
      }
      if (sections.has(key)) { err(ln.n, `section "## ${hm[1]}" appears twice`); current = null; inUnknown = true; continue; }
      current = { key, body: [] };
      sections.set(key, { at: ln.n, body: current.body });
      continue;
    }
    if (!current) {
      if (ln.text.trim() !== '' && !inUnknown) err(ln.n, 'text outside any section (a second summary paragraph?)');
      continue;
    }
    current.body.push(ln);
  }

  const body = (k: SectionKey) => sections.get(k)?.body ?? [];

  const bulletList = (k: SectionKey, checkbox = false): string[] => {
    const out: string[] = [];
    for (const ln of body(k)) {
      if (ln.text.trim() === '') continue;
      const m = checkbox ? /^[-*]\s+(?:\[[ xX]\]\s+)?(.+?)\s*$/.exec(ln.text) : /^[-*]\s+(.+?)\s*$/.exec(ln.text);
      if (m) out.push(m[1]!);
      else err(ln.n, `expected a "- " list item under "## ${HEADINGS[k]}"`);
    }
    return out;
  };

  // A list of items ("1. …" or "- …") whose continuation lines are indented.
  const items = (k: SectionKey, marker: RegExp): Array<{ head: Line; text: string; indent: number; rest: Line[] }> => {
    const out: Array<{ head: Line; text: string; indent: number; rest: Line[] }> = [];
    for (const ln of body(k)) {
      const m = marker.exec(ln.text);
      if (m) { out.push({ head: ln, text: m[2]!.trimEnd(), indent: m[1]!.length, rest: [] }); continue; }
      if (out.length === 0) { if (ln.text.trim() !== '') err(ln.n, `expected a list item under "## ${HEADINGS[k]}"`); continue; }
      out[out.length - 1]!.rest.push(ln);
    }
    return out;
  };

  const dedent = (text: string, indent: number) => {
    let k = 0;
    while (k < indent && text[k] === ' ') k += 1;
    return text.slice(k);
  };

  // Reads one item's continuation lines: fences become a command, the rest go to `other`.
  const readItemBody = (rest: Line[], indent: number, other: (ln: Line, text: string) => void): RunbookCommand | undefined => {
    let command: RunbookCommand | undefined;
    for (let j = 0; j < rest.length; j += 1) {
      const ln = rest[j]!;
      if (ln.text.trim() === '') continue;
      if (!ln.text.startsWith(' ')) { err(ln.n, 'expected this line to be indented under its list item'); continue; }
      const text = dedent(ln.text, indent);
      const fm = /^(`{3,})([A-Za-z]*)\s*$/.exec(text);
      if (fm) {
        const fence = fm[1]!;
        const rawLang = fm[2]!.toLowerCase();
        const lang = (COMMAND_LANGS as readonly string[]).includes(rawLang) ? (rawLang as CommandLang) : LANG_ALIASES[rawLang];
        if (!lang) err(ln.n, `unknown command language "${fm[2]}" (use ${COMMAND_LANGS.join(', ')})`);
        const cmd: string[] = [];
        let closed = false;
        for (j += 1; j < rest.length; j += 1) {
          const cl = rest[j]!;
          if (dedent(cl.text, indent).trimEnd() === fence) { closed = true; break; }
          cmd.push(dedent(cl.text, indent));
        }
        if (!closed) err(ln.n, 'command fence is never closed');
        if (command) err(ln.n, 'an item carries one command; split it into two steps');
        command = { lang: lang ?? 'text', text: cmd.join('\n') };
        continue;
      }
      other(ln, text.trimEnd());
    }
    return command;
  };

  const steps: RunbookStep[] = items('steps', /^(\d+\.\s+)(.*)$/).map((it) => {
    const bold = /^\*\*(.+)\*\*$/.exec(it.text);
    const step: RunbookStep = { do: bold ? bold[1]! : it.text };
    const command = readItemBody(it.rest, it.indent, (ln, text) => {
      const em = /^Expect:?\s+(.+)$/.exec(text);
      const wm = /^\*Why:\s+(.+)\*$/.exec(text);
      if (em && step.expect === undefined) step.expect = em[1]!;
      else if (wm && step.why === undefined) step.why = wm[1]!;
      else err(ln.n, 'a step line must be a command fence, "Expect …" or "*Why: …*"');
    });
    // Key order matches the renderer's so a deep-equal never trips on it.
    return { do: step.do, ...(command ? { command } : {}), ...(step.expect !== undefined ? { expect: step.expect } : {}), ...(step.why !== undefined ? { why: step.why } : {}) };
  });

  const verify = items('verify', /^([-*]\s+)(.*)$/).map((it) => {
    const command = readItemBody(it.rest, it.indent, (ln) => err(ln.n, 'a verify line must be a command fence'));
    return { check: it.text, ...(command ? { command } : {}) };
  });

  const rollback = items('rollback', /^(\d+\.\s+)(.*)$/).map((it) => {
    const command = readItemBody(it.rest, it.indent, (ln) => err(ln.n, 'a roll-back line must be a command fence'));
    return { do: it.text, ...(command ? { command } : {}) };
  });

  const failure_modes: RunbookDoc['failure_modes'] = [];
  {
    const rows = body('failure_modes').filter((l) => l.text.trim() !== '');
    rows.forEach((ln, idx) => {
      const cells = splitRow(ln.text);
      if (!cells) { err(ln.n, 'expected a table row "| symptom | cause | do this |"'); return; }
      if (idx === 0 && cells.map((c) => c.toLowerCase()).join('|') === 'symptom|likely cause|do this') return;
      if (cells.every((c) => /^:?-{3,}:?$/.test(c))) return;
      if (cells.length !== 3) { err(ln.n, `a failure row has 3 cells, this one has ${cells.length}`); return; }
      failure_modes.push({ symptom: cells[0]!, cause: cells[1]!, response: cells[2]! });
    });
  }

  const triggers: RunbookDoc['triggers'] = { work_item_labels: [], repos: [], tools: [], keywords: [] };
  for (const ln of body('triggers')) {
    if (ln.text.trim() === '') continue;
    const m = /^[-*]\s+([A-Za-z ]+):\s*(.*)$/.exec(ln.text);
    const key = m ? TRIGGER_BY_LABEL.get(m[1]!.trim().toLowerCase()) : undefined;
    if (!m || !key) { err(ln.n, `expected "- Labels|Repos|Tools|Keywords: a, b" under "## ${HEADINGS.triggers}"`); continue; }
    triggers[key] = m[2]!.split(',').map((s) => s.trim()).filter(Boolean);
  }

  let notes: string | undefined;
  if (sections.has('notes')) {
    const text = body('notes').map((l) => l.text).join('\n').replace(/^\s*\n/, '').trimEnd();
    if (text.trim() !== '') notes = text;
  }

  const doc: RunbookDoc = {
    title,
    summary,
    use_when: bulletList('use_when'),
    not_for: bulletList('not_for'),
    triggers,
    preconditions: bulletList('preconditions', true),
    steps,
    verify,
    failure_modes,
    rollback,
    ...(notes !== undefined ? { notes } : {}),
  };
  if (errors.length > 0) return { ok: false, errors: errors.sort((a, b) => a.line - b.line) };
  return { ok: true, doc, header, provenance };
}

/** "| a | b \| c |" → ["a", "b | c"]; null when the line is not a table row. */
export function splitRow(line: string): string[] | null {
  const t = line.trim();
  if (!t.startsWith('|') || !t.endsWith('|') || t.length < 2) return null;
  const cells: string[] = [];
  let cur = '';
  for (let k = 1; k < t.length; k += 1) {
    const c = t[k]!;
    if (c === '\\' && k + 1 < t.length && (t[k + 1] === '|' || t[k + 1] === '\\')) { cur += t[k + 1]; k += 1; continue; }
    if (c === '|') { cells.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  return cells;
}
