// A runbook as a Claude Code skill (R8). The box runs Claude Code, so the
// established procedures reach it as skills: one directory per published
// runbook, `<runbook-id>/SKILL.md` plus its scripts/ and data/ beside it
// (library.ts lays the set out). Claude Code keeps only each skill's name and
// description in context and loads a body when it is relevant — which is what
// lifts procedures out of the session brief's token budget.
//
// SKILL.md is rendered deterministically from the RunbookDoc, which stays the
// source of truth:
//
//   ---
//   name: rb-ws-cdp-debug
//   description: "<summary> Use when: <use_when…>. Not for: <not_for…>."
//   ---
//
//   <renderRunbook(doc)>            the canonical markdown, byte for byte
//
// parseSkill reads it back: the frontmatter's name, and parseRunbook over the
// body — so parseSkill(renderSkill(id, doc)).doc deep-equals doc. A run's
// captured draft (`.lab/keep/<name>/SKILL.md`) is parsed the same way.
//
// Claude Code's frontmatter rules (Agent Skills): `name` ≤ 64 characters of
// lowercase letters, digits and hyphens, without "anthropic" or "claude";
// `description` non-empty, ≤ 1024 characters, no XML tags. Runbook ids already
// carry the `rb-` prefix, which keeps them clear of every other skill on a box
// (session-bundle skills, the user's own) in the one flat ~/.claude/skills/.
import type { RunbookDoc } from './types.js';
import { renderRunbook } from './render.js';
import { tryParseRunbook, type ParseError } from './parse.js';

export const SKILL_LIMITS = { name: 64, description: 1024 } as const;
export const SKILL_NAME = /^rb-[a-z0-9][a-z0-9-]{1,60}$/;
const RESERVED = /anthropic|claude/;

const sentence = (s: string): string => s.trim().replace(/[.;:,\s]+$/, '');

/** What Claude matches on: the summary, then when to use it and when not to. Single line, no XML. */
export function skillDescription(doc: RunbookDoc): string {
  const parts = [doc.summary.trim()];
  if (doc.use_when.length) parts.push(`Use when: ${doc.use_when.map(sentence).join('; ')}.`);
  if (doc.not_for.length) parts.push(`Not for: ${doc.not_for.map(sentence).join('; ')}.`);
  return parts.join(' ').replace(/\s+/g, ' ').replace(/[<>]/g, (c) => (c === '<' ? '‹' : '›'));
}

/** Why a skill name is unacceptable to Claude Code, or null. */
export function checkSkillName(name: string): string | null {
  if (name.length > SKILL_LIMITS.name) return `skill name is ${name.length} characters (max ${SKILL_LIMITS.name})`;
  if (!SKILL_NAME.test(name)) return `skill name "${name}" must be rb- followed by lowercase letters, digits and hyphens`;
  if (RESERVED.test(name)) return `skill name "${name}" may not contain "anthropic" or "claude"`;
  return null;
}

/** Why a description is unacceptable, or null. */
export function checkSkillDescription(description: string): string | null {
  if (!description.trim()) return 'the skill description is empty';
  if (description.length > SKILL_LIMITS.description) return `the skill description is ${description.length} characters (Claude Code's limit is ${SKILL_LIMITS.description}); shorten the summary, "Use when" or "Not for"`;
  if (/<[A-Za-z/!?]/.test(description)) return 'the skill description contains an XML/HTML tag';
  return null;
}

/** YAML double-quoted scalar (JSON strings are valid YAML). */
const yamlString = (s: string): string => JSON.stringify(s);

export function renderSkill(runbookId: string, doc: RunbookDoc): string {
  return ['---', `name: ${runbookId}`, `description: ${yamlString(skillDescription(doc))}`, '---', '', renderRunbook(doc)].join('\n');
}

export type SkillParse =
  | { ok: true; name: string | null; description: string | null; doc: RunbookDoc; keys: string[] }
  | { ok: false; errors: Array<ParseError | { line: number; message: string }> };

/**
 * The frontmatter keys an Agent Skill may carry and still be portable (Anthropic's skill format).
 * Lane C: anything else in a draft is a lint error (R-frontmatter), and `allowed-tools` has its
 * own (R-allowed-tools): a runbook never widens what a future run may do.
 */
export const PORTABLE_FRONTMATTER_KEYS: readonly string[] = ['name', 'description', 'license', 'compatibility', 'metadata'];

/**
 * SKILL.md (or plain runbook markdown, for `lab propose`) → doc. The frontmatter
 * is optional; when present it must be the first lines and carry plain
 * `key: value` pairs (a key with an empty value may be followed by indented
 * lines: the `metadata` mapping). Only `name` is kept — the description is
 * always derived — and every top-level key is reported in `keys` for lint.
 */
export function parseSkill(text: string): SkillParse {
  const src = text.replace(/\r\n/g, '\n');
  let name: string | null = null;
  let description: string | null = null;
  const keys: string[] = [];
  let body = src;
  if (src.startsWith('---\n')) {
    const end = src.indexOf('\n---\n', 4);
    if (end < 0) return { ok: false, errors: [{ line: 1, message: 'the frontmatter opened with --- is never closed' }] };
    const fm = src.slice(4, end).split('\n');
    let nested = false;
    for (const [i, line] of fm.entries()) {
      if (!line.trim()) continue;
      // An indented line belongs to the mapping a key with an empty value opened (`metadata:`).
      if (/^[ \t]/.test(line)) {
        if (nested) continue;
        return { ok: false, errors: [{ line: i + 2, message: `frontmatter line is indented under a key with a value: ${line.slice(0, 60)}` }] };
      }
      const m = /^([a-z][a-z0-9_-]*):\s*(.*)$/.exec(line);
      if (!m) return { ok: false, errors: [{ line: i + 2, message: `frontmatter line is not "key: value": ${line.slice(0, 60)}` }] };
      let v = m[2]!.trim();
      if (!keys.includes(m[1]!)) keys.push(m[1]!);
      nested = v === '';
      if (v.startsWith('"')) {
        try { v = JSON.parse(v) as string; } catch { return { ok: false, errors: [{ line: i + 2, message: 'frontmatter value is a malformed quoted string' }] }; }
      }
      if (m[1] === 'name') name = v;
      else if (m[1] === 'description') description = v;
    }
    body = src.slice(end + 5).replace(/^\n+/, '');
  }
  const parsed = tryParseRunbook(body);
  if (!parsed.ok) return { ok: false, errors: parsed.errors };
  return { ok: true, name, description, doc: parsed.doc, keys };
}
