// The session brief (design §3, R8): what a box is told about ITS run — the
// task, the project, the decisions that bind it, the skills the box carries —
// under a token budget, plus ONE line pointing at the org's established
// skills. Assembled once at claim/dispatch and frozen; the portal shows the
// same bytes (same sha256). Pure: the clock, the framing text and every row
// arrive as input; same input → same markdown → same sha.
//
// Decision (user, 2026-10-15): procedures reach a box ONLY as skills. Every
// published runbook is a Claude Code skill in one org-wide library
// (library.ts) that the box syncs into ~/.claude/skills at boot; Claude Code
// keeps names and descriptions in context and loads a body when it fits. So
// the brief carries no procedure text and no per-runbook selection — one path
// for every box. The library's identity (sha, count, each skill's version) is
// recorded on the brief as metadata, which is what `lab applied` and
// `lab runbook` are checked against.
//
// Budget rules: default 6,000 tokens (BRIEF_BUDGET_TOKENS), estimated by
// estimateTokens, now spent on project context. An over-long task description
// is cut at a word boundary and says so; decisions go newest first and are
// dropped whole; the "N of 6,000 tokens" header counts the whole document,
// itself included. The skills a session bundle installs are listed in
// "Skills on this box" and never dropped.
import type { BriefSection, SessionBrief } from './types.js';
import { estimateTokens, groupThousands, sha256Hex } from './tokens.js';
import { LAB_REPORT_ASK } from '../run-reports/self-report.js';

export const ASSEMBLER_VERSION = '2';
export const DEFAULT_BRIEF_BUDGET = 6_000;

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

/** The org-wide skill library the run's box syncs (library.ts), as the brief records it. */
export interface BriefSkillLibrary {
  sha256: string;
  /** Where the box installs it ("~/.claude/skills"); null on a machine that does not sync it (a local worker). */
  dir: string | null;
  /** Every skill in it at freeze time, by name and version — what `lab applied` is checked against. */
  skills: Array<{ name: string; version: number }>;
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
  /** Skills a session bundle installs on the box (devbox runs); omitted or [] renders no section. */
  skills?: BriefSkill[];
  /** The org's skill library at freeze time; null/omitted when there is none (an empty library). */
  skill_library?: BriefSkillLibrary | null;
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

/** The one line about procedures: where the org's skills are. */
export function skillsPointer(lib: BriefSkillLibrary | null): string {
  if (!lib || lib.skills.length === 0) return '## The org\'s skills\nThe org has no established skills yet.';
  const n = lib.skills.length;
  const what = `The org's ${n} established skill${n === 1 ? ' is' : 's are'}`;
  return lib.dir
    ? `## The org's skills\n${what} installed in \`${lib.dir}\` (library ${lib.sha256.slice(0, 12)}); Claude Code loads one when its description fits the task.`
    : `## The org's skills\n${what} in the org's library (${lib.sha256.slice(0, 12)}) but not installed on this machine.`;
}

function reportSection(): string {
  return [
    '## How to report back',
    '- When you finish, say which skills you followed: `lab applied <skill> followed` (or `lab applied <skill> failed --step 2 "why"`).',
    '- If a skill was wrong or missing a step, write the corrected runbook markdown to a file and run `lab propose <skill> ./runbook.md` (or `lab propose new ./runbook.md`). A person reviews it.',
    '- If you built a tool worth keeping (a script, a client, a harness), put it in `.lab/keep/<rb-name>/` as SKILL.md + scripts/ + data/ with an offline Verify step. It is proposed when the session ends, and a person reviews it before any box gets it.',
    '- Record anything else you learned with `lab remember`.',
    // The run report's self-report (docs/learning-loop-design.md §1), in the same three lines the local framing uses.
    ...LAB_REPORT_ASK.map((l) => `- ${l}`),
  ].join('\n');
}

export function assembleBrief(input: AssembleBriefInput): SessionBrief {
  const budget = input.budget_tokens ?? DEFAULT_BRIEF_BUDGET;
  const briefId = input.brief_id ?? `brief-${input.run_ref}`;
  const w = input.work_item;
  const repo = input.repo ?? input.initiative?.repo ?? null;
  const lib = input.skill_library ?? null;
  const title = `# Session brief — ${w?.id ?? input.run_ref}`;
  const pointer = skillsPointer(lib);
  const report = reportSection();
  const headFor = (used: number) => `> Assembled ${input.assembled_at.slice(0, 10)} for run ${input.run_ref} · ${groupThousands(used)} of ${groupThousands(budget)} tokens · ${briefId}`;
  // What every brief spends before context: title, header (at its widest), pointer, report.
  const fixed = estimateTokens([title, headFor(budget), pointer, report].join('\n\n')) + 8;
  const cap = Math.max(0, budget - fixed);

  // ── Context: framing, task, project, decisions, box skills — within the budget. ──
  const framing = input.framing.trim();
  const ctx: Array<{ kind: BriefSection['kind']; ref: string | null; text: string; reason: string }> = [];
  if (framing) ctx.push({ kind: 'framing', ref: null, text: framing, reason: 'how this run is framed' });
  const skills = [...(input.skills ?? [])].sort((a, b) => cmp(a.id, b.id));
  const skillsText = skills.length > 0 ? skillsSection(skills) : '';
  if (w) {
    let desc = w.description;
    const projectText = input.initiative ? initiativeSection(input.initiative, repo, w.parent_epic) : '';
    const used0 = () => estimateTokens([framing, workItemSection(w, input.initiative, desc), projectText, skillsText].filter(Boolean).join('\n\n'));
    if (used0() > cap) {
      const over = (used0() - cap) * 4;
      desc = truncateWords(desc, Math.max(0, desc.length - over - 80));
    }
    ctx.push({ kind: 'work_item', ref: w.id, text: workItemSection(w, input.initiative, desc), reason: 'the task' });
  }
  if (input.initiative) ctx.push({ kind: 'initiative', ref: input.initiative.id, text: initiativeSection(input.initiative, repo, w?.parent_epic ?? null), reason: "the work item's initiative" });

  const decisions = [...input.decisions].sort((a, b) => cmp(b.at, a.at) || cmp(a.id, b.id));
  const used = estimateTokens([...ctx.map((c) => c.text), ...(skillsText ? [skillsText] : [])].join('\n\n'));
  const kept: BriefDecision[] = [];
  for (const d of decisions) {
    const trial = decisionsSection([...kept, d], decisions.length - kept.length - 1);
    if (used + estimateTokens('\n\n' + trial) <= cap) kept.push(d); else break;
  }
  if (kept.length > 0 || decisions.length > 0) {
    ctx.push({
      kind: 'decisions', ref: kept.map((d) => d.id).join(',') || null,
      text: decisionsSection(kept, decisions.length - kept.length),
      reason: `${kept.length} binding decision${kept.length === 1 ? '' : 's'}, newest first`,
    });
  }
  if (skillsText) ctx.push({ kind: 'skills', ref: skills.map((k) => k.id).join(','), text: skillsText, reason: `${skills.length} skill${skills.length === 1 ? '' : 's'} a session bundle installs on the box` });

  const render = (usedTokens: number): string =>
    [title, headFor(usedTokens), ...ctx.map((c) => c.text), pointer, report].join('\n\n') + '\n';
  // The header names the document's own size; settle it to a fixed point.
  let n = estimateTokens(render(0));
  for (let k = 0; k < 5; k += 1) {
    const next = estimateTokens(render(n));
    if (next === n) break;
    n = next;
  }
  const markdown = render(n);

  const sections: BriefSection[] = ctx.map((c) => ({ kind: c.kind, ref: c.ref, tokens: estimateTokens(c.text), reason: c.reason }));
  sections.push({ kind: 'skill_library', ref: lib?.sha256 ?? null, tokens: estimateTokens(pointer), reason: lib?.skills.length ? `${lib.skills.length} org skills${lib.dir ? ` in ${lib.dir}` : ', not installed here'}` : 'no org skills yet' });
  sections.push({ kind: 'how_to_report', ref: null, tokens: estimateTokens(report), reason: 'how to report back' });

  return {
    id: briefId,
    run_ref: input.run_ref,
    work_item_id: w?.id ?? null,
    initiative_id: input.initiative?.id ?? null,
    repo,
    assembled_at: input.assembled_at,
    assembler_version: ASSEMBLER_VERSION,
    budget_tokens: budget,
    used_tokens: n,
    sections,
    omitted: [],
    markdown,
    sha256: sha256Hex(markdown),
    ...(lib ? { skill_library: { sha256: lib.sha256, dir: lib.dir, skills: lib.skills.map((x) => ({ ...x })) } } : {}),
  };
}
