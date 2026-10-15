// The session brief (design §3): the ONE thing a box receives — task,
// project, binding decisions and the selected runbooks, under a token budget.
// Assembled once at claim/dispatch and frozen; the portal shows the same bytes
// (same sha256). Pure: the clock, the framing text and every row arrive as
// input; same input → same markdown → same sha.
//
// Budget rules (§3.2 step 5, decisions 2026-10-14):
//   - default 6,000 tokens (BRIEF_BUDGET_TOKENS), estimated by estimateTokens;
//   - framing + task + project + decisions share at most 1,800, decisions
//     newest first and dropped whole; an over-long task description is cut
//     at a word boundary and says so;
//   - runbooks are included whole or not at all, at most four, in selection
//     order; one that does not fit is listed under "Also available" with
//     `lab runbook <id>`, and a later, smaller one may still fit;
//   - the "N of 6,000 tokens" header counts the whole document, itself included;
//   - the skills a devbox carries (what a session bundle used to deliver on its
//     own, decision 4 of 2026-10-14) are listed in "Skills on this box", inside
//     the context cap and never dropped for a runbook.
import type { BriefOmission, BriefSection, SessionBrief } from './types.js';
import type { SelectedRunbook } from './select.js';
import { estimateTokens, groupThousands, sha256Hex } from './tokens.js';

export const ASSEMBLER_VERSION = '1';
export const DEFAULT_BRIEF_BUDGET = 6_000;
export const CONTEXT_CAP_TOKENS = 1_800;
export const MAX_FULL_RUNBOOKS = 4;

export interface BriefWorkItem {
  id: string;
  title: string;
  /** "story", "bug", "task" … */
  kind?: string | null;
  points?: number | null;
  description: string;
  labels: string[];
  parent_epic?: { title: string; goal?: string | null } | null;
}

export interface BriefInitiative { id: string; name: string; repo?: string | null }

/** A skill installed on the box (the live session bundle's skills), listed so the run knows it has it. */
export interface BriefSkill {
  id: string;
  name: string;
  /** "Use when …" — one line. */
  description: string;
  version: string;
}

export interface BriefDecision {
  id: string;
  title: string;
  /** What binds, in words: "resolved 2026-01-30: migrate remaining services off the v1 auth gateway before Q3 2026." */
  status_line: string;
  /** Ordering key, newest first. */
  at: string;
}

export interface AssembleBriefInput {
  run_ref: string;
  /** Defaults to `brief-<run_ref>`, so the id is as deterministic as the bytes. */
  brief_id?: string;
  /** ISO time from the caller's clock (mock/core/clock.ts in the mock). */
  assembled_at: string;
  /** The non-interactive framing (frameLocalPrompt) or PIPELINE_CONTRACT; '' for none. */
  framing: string;
  work_item: BriefWorkItem | null;
  initiative: BriefInitiative | null;
  repo?: string | null;
  decisions: BriefDecision[];
  /** selectRunbooks(...).selected, in order. */
  runbooks: SelectedRunbook[];
  /** Skills on the box (devbox runs); omitted or [] renders no section. */
  skills?: BriefSkill[];
  budget_tokens?: number;
}

/** BRIEF_BUDGET_TOKENS, or the default. The env is an argument so this stays pure. */
export function briefBudget(env: Readonly<Record<string, string | undefined>>): number {
  const n = Number(env['BRIEF_BUDGET_TOKENS']);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_BRIEF_BUDGET;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function truncateWords(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const note = ' … (truncated; the full description is on the work item)';
  const room = Math.max(0, maxChars - note.length);
  const cut = text.slice(0, room);
  const at = cut.lastIndexOf(' ');
  return (at > 0 ? cut.slice(0, at) : cut).trimEnd() + note;
}

function workItemSection(w: BriefWorkItem, initiative: BriefInitiative | null, description: string): string {
  const facts = [w.kind ?? null, w.points != null ? `${w.points} pts` : null, initiative?.name ?? null].filter(Boolean);
  const lines = ['## Your task', `**${w.title}**${facts.length ? ` (${facts.join(', ')})` : ''}`];
  if (description.trim()) lines.push(description.trim());
  if (w.labels.length) lines.push(`Labels: ${w.labels.join(', ')}.`);
  return lines.join('\n');
}

function initiativeSection(i: BriefInitiative, repo: string | null, epic: BriefWorkItem['parent_epic']): string {
  let line = `**${i.name}**`;
  const r = repo ?? i.repo ?? null;
  if (r) line += ` — repo ${r}.`;
  if (epic) line += ` Parent epic: ${epic.title}${epic.goal ? ` ("${epic.goal}")` : ''}.`;
  return ['## The project', line].join('\n');
}

function decisionsSection(ds: BriefDecision[], dropped: number): string {
  const lines = ['## Decisions that bind this work', ...ds.map((d) => `- **${d.title}** — ${d.status_line}`)];
  if (dropped > 0) lines.push(`- (${dropped} older decision${dropped === 1 ? '' : 's'} not shown; see the work item.)`);
  return lines.join('\n');
}

function skillsSection(skills: BriefSkill[]): string {
  return [
    '## Skills on this box',
    ...skills.map((k) => `- **${k.name}** (${k.id} v${k.version}) — ${k.description}`),
  ].join('\n');
}

function runbookBlock(r: SelectedRunbook, n: number): string {
  const lines = [`### ${n}. ${r.title} (${r.runbook_id} v${r.version})`, `Included because: ${r.reasons.join('; ')}.`];
  if (r.health.status !== 'proven' && r.health.warning) lines.push(`⚠ ${r.health.warning}`);
  lines.push('', r.markdown.trimEnd());
  return lines.join('\n');
}

function reportSection(firstId: string | null): string {
  const id = firstId ?? '<runbook-id>';
  return [
    '## How to report back',
    `- When you finish, say which runbooks you followed: \`lab applied ${id} followed\` (or \`lab applied ${id} failed --step 2 "why"\`).`,
    `- If a runbook was wrong or missing a step, write the corrected markdown to a file and run \`lab propose ${id} ./runbook.md\` (or \`lab propose new ./runbook.md\`). A person reviews it.`,
    '- Record anything else you learned with `lab remember`.',
  ].join('\n');
}

export function assembleBrief(input: AssembleBriefInput): SessionBrief {
  const budget = input.budget_tokens ?? DEFAULT_BRIEF_BUDGET;
  const briefId = input.brief_id ?? `brief-${input.run_ref}`;
  const w = input.work_item;
  const repo = input.repo ?? input.initiative?.repo ?? null;

  // ── Context: framing, task, project, decisions — capped together. ─────────
  const framing = input.framing.trim();
  const ctx: Array<{ kind: BriefSection['kind']; ref: string | null; text: string; reason: string }> = [];
  if (framing) ctx.push({ kind: 'framing', ref: null, text: framing, reason: 'how this run is framed' });
  if (w) {
    let desc = w.description;
    const fixed = () => estimateTokens([framing, workItemSection(w, input.initiative, desc), input.initiative ? initiativeSection(input.initiative, repo, w.parent_epic) : ''].join('\n\n'));
    if (fixed() > CONTEXT_CAP_TOKENS) {
      const over = (fixed() - CONTEXT_CAP_TOKENS) * 4;
      desc = truncateWords(desc, Math.max(0, desc.length - over - 80));
    }
    ctx.push({ kind: 'work_item', ref: w.id, text: workItemSection(w, input.initiative, desc), reason: 'the task' });
  }
  if (input.initiative) ctx.push({ kind: 'initiative', ref: input.initiative.id, text: initiativeSection(input.initiative, repo, w?.parent_epic ?? null), reason: "the work item's initiative" });

  const skills = [...(input.skills ?? [])].sort((a, b) => cmp(a.id, b.id));
  const skillsText = skills.length > 0 ? skillsSection(skills) : '';
  const decisions = [...input.decisions].sort((a, b) => cmp(b.at, a.at) || cmp(a.id, b.id));
  const used = estimateTokens([...ctx.map((c) => c.text), ...(skillsText ? [skillsText] : [])].join('\n\n'));
  const kept: BriefDecision[] = [];
  for (const d of decisions) {
    const trial = decisionsSection([...kept, d], decisions.length - kept.length - 1);
    if (used + estimateTokens('\n\n' + trial) <= CONTEXT_CAP_TOKENS) kept.push(d); else break;
  }
  if (kept.length > 0 || decisions.length > 0) {
    ctx.push({
      kind: 'decisions', ref: kept.map((d) => d.id).join(',') || null,
      text: kept.length > 0 ? decisionsSection(kept, decisions.length - kept.length) : decisionsSection([], decisions.length),
      reason: `${kept.length} binding decision${kept.length === 1 ? '' : 's'}, newest first`,
    });
  }
  if (skillsText) ctx.push({ kind: 'skills', ref: skills.map((k) => k.id).join(','), text: skillsText, reason: `${skills.length} skill${skills.length === 1 ? '' : 's'} installed on the box` });

  // ── Runbooks: whole or not at all. ────────────────────────────────────────
  const title = `# Session brief — ${w?.id ?? input.run_ref}`;
  const render = (included: SelectedRunbook[], usedTokens: number): string => {
    const omitted = input.runbooks.filter((r) => !included.includes(r));
    const rb: string[] = ['## Runbooks for this work'];
    if (included.length === 0 && input.runbooks.length === 0) rb.push('No runbooks matched this work.');
    included.forEach((r, k) => rb.push(runbookBlock(r, k + 1)));
    if (omitted.length > 0) {
      rb.push(['Also available (not included, budget):', ...omitted.map((r) => `- ${r.title} — \`lab runbook ${r.runbook_id}\``)].join('\n'));
    }
    const head = `> Assembled ${input.assembled_at.slice(0, 10)} for run ${input.run_ref} · ${groupThousands(usedTokens)} of ${groupThousands(budget)} tokens · ${briefId}`;
    return [title, head, ...ctx.map((c) => c.text), rb.join('\n\n'), reportSection(included[0]?.runbook_id ?? input.runbooks[0]?.runbook_id ?? null)].join('\n\n') + '\n';
  };
  // The header names the document's own size; settle it to a fixed point.
  const finalize = (included: SelectedRunbook[]): { markdown: string; tokens: number } => {
    let n = estimateTokens(render(included, 0));
    for (let k = 0; k < 5; k += 1) {
      const next = estimateTokens(render(included, n));
      if (next === n) break;
      n = next;
    }
    return { markdown: render(included, n), tokens: n };
  };

  const included: SelectedRunbook[] = [];
  for (const r of input.runbooks) {
    if (included.length >= MAX_FULL_RUNBOOKS) break;
    if (finalize([...included, r]).tokens <= budget) included.push(r);
  }
  const { markdown, tokens } = finalize(included);

  const sections: BriefSection[] = ctx.map((c) => ({ kind: c.kind, ref: c.ref, tokens: estimateTokens(c.text), reason: c.reason }));
  included.forEach((r, k) => sections.push({
    kind: 'runbook', ref: r.runbook_id, version: r.version, tokens: estimateTokens(runbookBlock(r, k + 1)), reason: r.reasons.join('; '),
  }));
  const report = reportSection(included[0]?.runbook_id ?? input.runbooks[0]?.runbook_id ?? null);
  sections.push({ kind: 'how_to_report', ref: null, tokens: estimateTokens(report), reason: 'how to report back' });
  const omitted: BriefOmission[] = input.runbooks.filter((r) => !included.includes(r)).map((r) => ({ runbook_id: r.runbook_id, reason: 'budget' }));

  return {
    id: briefId,
    run_ref: input.run_ref,
    work_item_id: w?.id ?? null,
    initiative_id: input.initiative?.id ?? null,
    repo,
    assembled_at: input.assembled_at,
    assembler_version: ASSEMBLER_VERSION,
    budget_tokens: budget,
    used_tokens: tokens,
    sections,
    omitted,
    markdown,
    sha256: sha256Hex(markdown),
  };
}
