// RunbookDoc → canonical markdown (design §2.2). The markdown is the product:
// it is what a person reads, what a reviewer diffs and — verbatim — what a box
// receives inside its session brief. parse.ts reads exactly this back.
//
// Canonical layout (a section whose list is empty is omitted):
//
//   # <title>
//
//   > Runbook <id> · v<n> · <scope> · owner <name>      (optional header, not part of the doc)
//
//   <summary>
//
//   ## Use when / ## Not for            "- item"
//   ## Before you start                 "- [ ] item"
//   ## Steps                            "1. **do**", then indented command fence, "Expect …", "*Why: …*"
//   ## Verify                           "- check", then an indented command fence
//   ## If it goes wrong                 | Symptom | Likely cause | Do this |
//   ## Roll back                        "1. do", then an indented command fence
//   ## Selection hints                  "- Labels: a, b" / Repos / Tools / Keywords
//   ## Notes                            free markdown
//   ## Where this came from             (optional header provenance, not part of the doc)
import type { RunbookCommand, RunbookDoc } from './types.js';
import { COMMAND_LANGS } from './types.js';

export const HEADINGS = {
  use_when: 'Use when',
  not_for: 'Not for',
  preconditions: 'Before you start',
  steps: 'Steps',
  verify: 'Verify',
  failure_modes: 'If it goes wrong',
  rollback: 'Roll back',
  triggers: 'Selection hints',
  notes: 'Notes',
  provenance: 'Where this came from',
} as const;

export const TRIGGER_LABELS = {
  work_item_labels: 'Labels',
  repos: 'Repos',
  tools: 'Tools',
  keywords: 'Keywords',
} as const;

export const FAILURE_TABLE_HEAD = '| Symptom | Likely cause | Do this |';
export const FAILURE_TABLE_RULE = '|---|---|---|';

/** Presentation around the doc — stable per version, so the stored markdown's sha is too. Never parsed back into the doc. */
export interface RunbookHeader {
  id: string;
  version: number;
  /** "Auth Migration", "repo orgiq-auth-service", "org-wide". */
  scope_label?: string;
  owner_name?: string;
  /** One paragraph rendered under "## Where this came from". */
  provenance?: string;
}

export class RunbookFormatError extends Error {
  constructor(readonly problems: string[]) {
    super(`runbook cannot be rendered canonically: ${problems.join('; ')}`);
    this.name = 'RunbookFormatError';
  }
}

/**
 * Why a doc cannot round-trip, or [] when it can. A doc produced by
 * parseRunbook() always returns []; a hand-built doc (a seed, a fixture, a
 * store row) is checked here before it is rendered.
 */
export function formatProblems(doc: RunbookDoc): string[] {
  const out: string[] = [];
  const line = (path: string, v: unknown) => {
    if (typeof v !== 'string') { out.push(`${path} is not a string`); return; }
    if (v.length === 0) out.push(`${path} is empty`);
    else if (/[\r\n]/.test(v)) out.push(`${path} spans lines`);
    else if (v !== v.trim()) out.push(`${path} has leading or trailing whitespace`);
  };
  const command = (path: string, c: RunbookCommand | undefined) => {
    if (c === undefined) return;
    if (!COMMAND_LANGS.includes(c.lang)) out.push(`${path}.lang ${String(c.lang)} is not one of ${COMMAND_LANGS.join('/')}`);
    if (typeof c.text !== 'string' || c.text.trim() === '') out.push(`${path}.text is empty`);
    else if (/\r/.test(c.text)) out.push(`${path}.text has a carriage return`);
    else if (c.text.endsWith('\n') || c.text.startsWith('\n')) out.push(`${path}.text starts or ends with a newline`);
  };
  line('title', doc.title);
  line('summary', doc.summary);
  if (typeof doc.summary === 'string' && /^(#|>|- |\d+\. )/.test(doc.summary)) out.push('summary starts like a heading, quote or list item');
  doc.use_when.forEach((v, i) => line(`use_when[${i}]`, v));
  doc.not_for.forEach((v, i) => line(`not_for[${i}]`, v));
  doc.preconditions.forEach((v, i) => line(`preconditions[${i}]`, v));
  for (const k of Object.keys(TRIGGER_LABELS) as Array<keyof typeof TRIGGER_LABELS>) {
    doc.triggers[k].forEach((v, i) => {
      line(`triggers.${k}[${i}]`, v);
      if (v.includes(',')) out.push(`triggers.${k}[${i}] contains a comma`);
    });
  }
  doc.steps.forEach((s, i) => {
    line(`steps[${i}].do`, s.do);
    command(`steps[${i}].command`, s.command);
    if (s.expect !== undefined) line(`steps[${i}].expect`, s.expect);
    if (s.why !== undefined) line(`steps[${i}].why`, s.why);
  });
  doc.verify.forEach((v, i) => { line(`verify[${i}].check`, v.check); command(`verify[${i}].command`, v.command); });
  doc.failure_modes.forEach((f, i) => {
    line(`failure_modes[${i}].symptom`, f.symptom); line(`failure_modes[${i}].cause`, f.cause); line(`failure_modes[${i}].response`, f.response);
    const cells = [f.symptom, f.cause, f.response];
    if (cells.every((c) => /^:?-{3,}:?$/.test(c))) out.push(`failure_modes[${i}] reads as a table rule`);
    if (i === 0 && cells.map((c) => c.toLowerCase()).join('|') === 'symptom|likely cause|do this') out.push('failure_modes[0] repeats the table header');
  });
  doc.rollback.forEach((r, i) => { line(`rollback[${i}].do`, r.do); command(`rollback[${i}].command`, r.command); });
  if (doc.notes !== undefined) {
    if (doc.notes.trim() === '') out.push('notes is empty (omit it instead)');
    else if (doc.notes !== doc.notes.replace(/^\s*\n/, '').trimEnd()) out.push('notes has leading blank lines or trailing whitespace');
    else if (/\r/.test(doc.notes)) out.push('notes has a carriage return');
    else if (new RegExp(`^## ${HEADINGS.provenance}$`, 'm').test(doc.notes)) out.push(`notes contains a "## ${HEADINGS.provenance}" heading`);
  }
  return out;
}

/** The fence for a command: three backticks, or one longer than any backtick run inside it. */
export function fenceFor(text: string): string {
  let longest = 0;
  for (const m of text.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  return '`'.repeat(Math.max(3, longest + 1));
}

function renderCommand(c: RunbookCommand, indent: string): string[] {
  const fence = fenceFor(c.text);
  return [
    `${indent}${fence}${c.lang}`,
    ...c.text.split('\n').map((l) => (l === '' ? '' : indent + l)),
    `${indent}${fence}`,
  ];
}

/** Table cells: backslash and pipe escaped, so a command-ish cell survives the round trip. */
export function escapeCell(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
}

export function renderRunbook(doc: RunbookDoc, header?: RunbookHeader): string {
  const problems = formatProblems(doc);
  if (problems.length > 0) throw new RunbookFormatError(problems);

  const blocks: string[][] = [];
  blocks.push([`# ${doc.title}`]);
  if (header) {
    const bits = [`Runbook ${header.id}`, `v${header.version}`];
    if (header.scope_label) bits.push(header.scope_label);
    if (header.owner_name) bits.push(`owner ${header.owner_name}`);
    blocks.push([`> ${bits.join(' · ')}`]);
  }
  blocks.push([doc.summary]);

  const bullets = (heading: string, items: string[], prefix = '- ') => {
    if (items.length > 0) blocks.push([`## ${heading}`, '', ...items.map((i) => prefix + i)]);
  };
  bullets(HEADINGS.use_when, doc.use_when);
  bullets(HEADINGS.not_for, doc.not_for);
  bullets(HEADINGS.preconditions, doc.preconditions, '- [ ] ');

  if (doc.steps.length > 0) {
    const lines = [`## ${HEADINGS.steps}`, ''];
    doc.steps.forEach((s, i) => {
      const marker = `${i + 1}. `;
      const indent = ' '.repeat(marker.length);
      lines.push(`${marker}**${s.do}**`);
      if (s.command) lines.push(...renderCommand(s.command, indent));
      if (s.expect !== undefined) lines.push(`${indent}Expect ${s.expect}`);
      if (s.why !== undefined) lines.push(`${indent}*Why: ${s.why}*`);
    });
    blocks.push(lines);
  }

  if (doc.verify.length > 0) {
    const lines = [`## ${HEADINGS.verify}`, ''];
    for (const v of doc.verify) {
      lines.push(`- ${v.check}`);
      if (v.command) lines.push(...renderCommand(v.command, '  '));
    }
    blocks.push(lines);
  }

  if (doc.failure_modes.length > 0) {
    blocks.push([
      `## ${HEADINGS.failure_modes}`, '', FAILURE_TABLE_HEAD, FAILURE_TABLE_RULE,
      ...doc.failure_modes.map((f) => `| ${escapeCell(f.symptom)} | ${escapeCell(f.cause)} | ${escapeCell(f.response)} |`),
    ]);
  }

  if (doc.rollback.length > 0) {
    const lines = [`## ${HEADINGS.rollback}`, ''];
    doc.rollback.forEach((r, i) => {
      const marker = `${i + 1}. `;
      lines.push(`${marker}${r.do}`);
      if (r.command) lines.push(...renderCommand(r.command, ' '.repeat(marker.length)));
    });
    blocks.push(lines);
  }

  const hints = (Object.keys(TRIGGER_LABELS) as Array<keyof typeof TRIGGER_LABELS>)
    .filter((k) => doc.triggers[k].length > 0)
    .map((k) => `- ${TRIGGER_LABELS[k]}: ${doc.triggers[k].join(', ')}`);
  if (hints.length > 0) blocks.push([`## ${HEADINGS.triggers}`, '', ...hints]);

  if (doc.notes !== undefined) blocks.push([`## ${HEADINGS.notes}`, '', doc.notes]);
  if (header?.provenance) blocks.push([`## ${HEADINGS.provenance}`, '', header.provenance]);

  return blocks.map((b) => b.join('\n')).join('\n\n') + '\n';
}
