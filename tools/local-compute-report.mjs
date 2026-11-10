// local-compute-report — the worker's half of the run report (docs/learning-loop-design.md §1).
//
// When a local run ends, the worker sends, with its completion call:
//   block         the run's final message (its tail), which ends in a fenced `lab-report` block;
//                 the middleware parses it tolerantly (lib/run-reports/self-report.ts)
//   skillsLoaded  every skill the session LOADED, observed in Claude Code's own
//                 `--output-format stream-json --verbose` stream: a `tool_use` block named `Skill`
//                 (its input's `skill`, or `name` / `command`), or a `Read` of a skill's SKILL.md
//                 under `.claude/skills/`. Never self-reported, and the transcript file is not read.
//   kept          the checkout's `.lab/keep/<rb-name>/` folders, in exactly the shape `lab keep`
//                 posts (agents/devbox/lab, middleware lib/runbooks/keep.ts); they enter the
//                 proposals queue as untrusted drafts a person reviews.
//
// Everything here is decided by what the run wrote, so it is all untrusted: links are never
// followed, only regular UTF-8 text files under scripts/ and data/ are read, names and sizes are
// checked before anything is read whole, and the server re-checks it all.
//
// Pure Node, no dependencies; the parity suite (middleware
// src/lib/run-reports/__tests__/run-report-worker-parity.test.ts) holds it to the TypeScript.

import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SKILL_FILE = /(?:^|\/)\.claude\/skills\/([a-z0-9][a-z0-9-]{0,63})\/SKILL\.md$/;
const KEEP_NAME = /^rb-[a-z0-9][a-z0-9-]{1,60}$/;
const SEG = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
// lib/runbooks/files.ts FILE_LIMITS, and `lab keep`'s.
const FILE_MAX = 32 * 1024, BUNDLE_MAX = 80 * 1024, MAX_FILES = 24, SKILL_MD_MAX = 200_000;
/** What the worker sends of the final message: its tail (the block is asked for at the end). */
export const BLOCK_TAIL = 4 * 16_384;
export const MAX_SKILLS = 50;
export const MAX_KEPT = 10;

/** The skills one stream-json event shows being loaded. */
export function skillsLoadedByEvent(ev) {
  if (!ev || typeof ev !== 'object' || ev.type !== 'assistant') return [];
  const content = ev.message?.content;
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const b of content) {
    if (!b || typeof b !== 'object' || b.type !== 'tool_use') continue;
    const input = b.input && typeof b.input === 'object' ? b.input : {};
    if (b.name === 'Skill') {
      const raw = input.skill ?? input.name ?? input.command;
      const name = typeof raw === 'string' ? raw.trim().replace(/^\//, '').split(':').pop().toLowerCase() : '';
      if (SKILL_NAME.test(name)) out.push(name);
    } else if (b.name === 'Read') {
      const m = typeof input.file_path === 'string' ? SKILL_FILE.exec(input.file_path) : null;
      if (m) out.push(m[1]);
    }
  }
  return out;
}

/** Every distinct skill a stream-json stdout loaded, first-load order, capped. Unparseable lines are skipped. */
export function skillsLoadedFromStream(stdout) {
  const seen = new Set();
  for (const line of String(stdout ?? '').split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    let ev;
    try { ev = JSON.parse(t); } catch { continue; }
    for (const s of skillsLoadedByEvent(ev)) {
      if (seen.size >= MAX_SKILLS) return [...seen];
      seen.add(s);
    }
  }
  return [...seen];
}

const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The checkout's kept folders, as `lab keep` reads them. `installed` names the library skills in the checkout (an edit, not a new one). */
export function readKeptFolders(keepDir, { runRef, sessionId = '', installed = new Set() } = {}) {
  if (!existsSync(keepDir)) return [];
  const top = lstatSync(keepDir);
  if (top.isSymbolicLink() || !top.isDirectory()) return [];
  const out = [];
  for (const name of readdirSync(keepDir).sort(byName)) {
    if (out.length >= MAX_KEPT) break;
    const base = join(keepDir, name);
    const st = lstatSync(base);
    if (st.isSymbolicLink() || !st.isDirectory()) continue;
    const problems = [];
    if (!KEEP_NAME.test(name)) problems.push("the folder name must look like rb-some-name (it becomes the skill's name)");
    const skillPath = join(base, 'SKILL.md');
    const skillSt = existsSync(skillPath) ? lstatSync(skillPath) : null;
    if (!skillSt || !skillSt.isFile()) problems.push('no SKILL.md');
    else if (skillSt.size > SKILL_MD_MAX) problems.push(`SKILL.md is ${skillSt.size} bytes (max ${SKILL_MD_MAX})`);
    const files = [];
    let total = 0;
    const walk = (dir, rel) => {
      for (const n of readdirSync(dir).sort(byName)) {
        const full = join(dir, n);
        const r = `${rel}/${n}`;
        const s = lstatSync(full);
        if (s.isSymbolicLink()) { problems.push(`${r} is not a regular file (links are not carried)`); continue; }
        if (s.isDirectory()) { walk(full, r); continue; }
        if (!s.isFile()) { problems.push(`${r} is not a regular file (links are not carried)`); continue; }
        if (!r.split('/').slice(1).every((p) => SEG.test(p))) { problems.push(`${r}: a name outside [A-Za-z0-9._-] or starting with . or -`); continue; }
        if (s.size > FILE_MAX) { problems.push(`${r} is ${s.size} bytes (max ${FILE_MAX})`); continue; }
        const raw = readFileSync(full);
        if (raw.includes(0)) { problems.push(`${r} is binary (only text is carried)`); continue; }
        let text;
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(raw); } catch { problems.push(`${r} is not UTF-8 text`); continue; }
        total += raw.length;
        files.push({ path: r, content: text, mode: (s.mode & 0o111) ? '755' : '644' });
      }
    };
    for (const root of ['scripts', 'data']) {
      const t = join(base, root);
      if (!existsSync(t)) continue;
      const s = lstatSync(t);
      if (s.isSymbolicLink() || !s.isDirectory()) continue;
      walk(t, root);
    }
    if (files.length > MAX_FILES) problems.push(`${files.length} files (max ${MAX_FILES})`);
    if (total > BUNDLE_MAX) problems.push(`the files total ${total} bytes (max ${BUNDLE_MAX})`);
    if (problems.length) { out.push({ name, problems }); continue; }
    const edit = installed.has(name);
    out.push({
      name,
      body: {
        kind: edit ? 'edit' : 'new',
        skill_md: readFileSync(skillPath, 'utf8'),
        files,
        rationale: `Kept by run ${runRef || '(no run)'} in .lab/keep/${name}: a tool this run built and wants every box to have.`,
        source: { run_ref: runRef, session_id: sessionId, lab_experience_ids: [] },
        ...(edit ? { runbook_id: name } : {}),
      },
    });
  }
  return out;
}

/** The library skills a checkout holds (tools/local-compute-skills.mjs writes the state file). */
export function installedSkills(workdir) {
  try {
    const s = JSON.parse(readFileSync(join(workdir, '.claude', 'skills', '.orgiq-library.json'), 'utf8'));
    return new Set((Array.isArray(s.skills) ? s.skills : []).filter((n) => typeof n === 'string' && KEEP_NAME.test(n)));
  } catch { return new Set(); }
}

/**
 * The `report` field of the completion body. `finalMessage` is the result event's text;
 * `stdout` the run's stream-json output; `workdir` the checkout (null: a job with no repo keeps nothing).
 */
export function buildReport({ finalMessage, stdout, workdir, runRef, sessionId }) {
  const msg = typeof finalMessage === 'string' ? finalMessage : '';
  return {
    block: msg ? msg.slice(-BLOCK_TAIL) : null,
    skillsLoaded: skillsLoadedFromStream(stdout),
    kept: workdir ? readKeptFolders(join(workdir, '.lab', 'keep'), { runRef, sessionId, installed: installedSkills(workdir) }) : [],
  };
}
