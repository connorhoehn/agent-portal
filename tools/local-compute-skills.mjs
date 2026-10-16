// local-compute-skills — the org's skill library, installed as PROJECT skills for one local run.
//
// R8 (docs/distillation-runbooks-goal.md): every published runbook is a Claude Code skill in one
// org-wide, content-addressed library. A devbox syncs it into ~/.claude/skills (`lab skills`). A
// local-compute worker runs on the operator's OWN machine, where ~/.claude/skills is their
// personal skills folder, so it never writes there. It installs the library into the run's
// checkout instead:
//
//   <workdir>/.claude/skills/<rb-id>/SKILL.md        (+ scripts/, data/)
//   <workdir>/.claude/skills/.orgiq-library.json     what this module installed: set sha, skill
//                                                    names, every file's sha
//
// Claude Code discovers project skills from `.claude/skills/` under the directory it starts in,
// and `claude -p` skips the workspace-trust dialog, so the worker's plain `claude -p` in that
// cwd loads them with no extra flag (checked against claude 2.1.299: "Skills come from the repo's
// .claude/skills"; `--setting-sources` is left at its default, which includes `project`).
//
// The rules, the same as the box's plus the ones a shared machine needs:
//   - every file's sha, every path, the per-file and library caps, and the set sha (body and
//     X-Skill-Library-Sha256 header) are verified before anything is written; a mismatch writes
//     nothing and leaves what is there;
//   - names keep the `rb-` prefix the library is namespaced by, so they never meet the
//     operator's own skills;
//   - a skill directory this module did not install is never overwritten or removed, and
//     neither is one it installed whose files someone has since changed or added to;
//   - `.claude` or `.claude/skills` being a symlink is refused (a repo could point it at
//     ~/.claude/skills);
//   - in a git checkout the installed paths go in .git/info/exclude (never the repo's
//     .gitignore), so they cannot be committed, and `git clean -fd` between runs keeps them,
//     which is what makes the next run's "unchanged" skip possible.
//
// Pure Node, no dependencies; tested offline by middleware/src/lib/__tests__/local-skills-install.test.ts.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync,
  realpathSync, renameSync, rmSync, writeFileSync, writeSync, constants as FS,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

export const LIBRARY_FORMAT = 'orgiq-skill-library/1';
export const PROJECT_SKILLS_REL = '.claude/skills';
export const STATE_FILE = '.orgiq-library.json';
const STAGE_PREFIX = '.orgiq-stage-';
const NAME = /^rb-[a-z0-9][a-z0-9-]{1,60}$/;
const SEG = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
export const FILE_MAX = 32 * 1024;
export const LIB_MAX = 8 * 1024 * 1024;
export const BODY_MAX = 4 * LIB_MAX;
const EXCLUDE_BEGIN = '# >>> orgiq skill library (tools/local-compute-skills.mjs): managed block, do not edit';
const EXCLUDE_END = '# <<< orgiq skill library';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/**
 * The library as served → its files grouped per skill, or why it is refused. The same checks,
 * in the same order, as `lab skills` (agents/devbox/lab).
 */
export function verifyLibrary(lib, headerSha = '') {
  if (!lib || typeof lib !== 'object' || lib.format !== LIBRARY_FORMAT) return { ok: false, why: 'unknown format' };
  if (!Array.isArray(lib.files)) return { ok: false, why: 'no file list' };
  let total = 0;
  const lines = [];
  const bySkill = new Map();
  for (const f of lib.files) {
    const p = typeof f?.path === 'string' ? f.path : '';
    const parts = p.split('/');
    const ok = parts.length >= 2 && NAME.test(parts[0])
      && ((parts.length === 2 && parts[1] === 'SKILL.md')
        || (parts.length >= 3 && (parts[1] === 'scripts' || parts[1] === 'data') && parts.slice(2).every((s) => SEG.test(s))));
    if (!ok) return { ok: false, why: `unsafe path ${JSON.stringify(p)}` };
    if (f.mode !== '644' && f.mode !== '755') return { ok: false, why: `bad mode on ${p}` };
    if (typeof f.content !== 'string') return { ok: false, why: `${p} has no content` };
    const data = Buffer.from(f.content, 'utf8');
    if (data.length > FILE_MAX) return { ok: false, why: `${p} is over ${FILE_MAX} bytes` };
    if (sha256(data) !== f.sha256) return { ok: false, why: `${p} does not match its sha256` };
    total += data.length;
    lines.push(`${p} ${f.mode} ${f.sha256}`);
    if (!bySkill.has(parts[0])) bySkill.set(parts[0], []);
    bySkill.get(parts[0]).push({ rel: parts.slice(1), data, mode: f.mode, sha: f.sha256 });
  }
  if (total > LIB_MAX) return { ok: false, why: 'library over its size cap' };
  // Python's sorted() on str and JS's default sort agree for these ASCII lines.
  const got = sha256(Buffer.from([LIBRARY_FORMAT, ...lines.sort()].join('\n') + '\n', 'utf8'));
  if (got !== lib.sha256 || (headerSha && got !== headerSha)) return { ok: false, why: 'the set does not match its sha256' };
  return { ok: true, sha: got, bySkill };
}

/** `<workdir>/.claude/skills`, created if missing; refused when either level is a link or not a directory. */
export function projectSkillsDir(workdir) {
  const root = realpathSync(workdir);
  let at = root;
  for (const seg of PROJECT_SKILLS_REL.split('/')) {
    at = join(at, seg);
    if (existsSync(at) || isLink(at)) {
      const st = lstatSync(at);
      if (st.isSymbolicLink()) return { ok: false, why: `${relative(root, at)} is a symlink; skills are installed only into a real directory of the checkout` };
      if (!st.isDirectory()) return { ok: false, why: `${relative(root, at)} is not a directory` };
    } else {
      mkdirSync(at);
    }
  }
  return { ok: true, root, dir: at };
}

function isLink(p) {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
}

/** Every regular file under `dir`, as "<name>/<rel>" → sha; null when it holds a link or anything else odd. */
function filesUnder(skillsDir, name) {
  const out = {};
  const walk = (abs, rel) => {
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const a = join(abs, e.name);
      const r = `${rel}/${e.name}`;
      if (e.isSymbolicLink()) return false;
      if (e.isDirectory()) { if (!walk(a, r)) return false; continue; }
      if (!e.isFile()) return false;
      out[r] = sha256(readFileSync(a));
    }
    return true;
  };
  return walk(join(skillsDir, name), name) ? out : null;
}

function gitTracked(root, rel) {
  try {
    execFileSync('git', ['-C', root, 'ls-files', '--error-unmatch', '--', rel], { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

/** The repo this workdir is in: { top, exclude, prefix } or null when it is not a git checkout. */
export function gitInfo(root) {
  try {
    const top = execFileSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const ex = execFileSync('git', ['-C', root, 'rev-parse', '--git-path', 'info/exclude'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const rel = relative(realpathSync(top), root).split(sep).join('/');
    return { top, exclude: resolve(root, ex), prefix: rel ? `/${rel}/` : '/' };
  } catch { return null; }
}

/** Rewrite this module's block in .git/info/exclude; every other line stays as it was. */
export function writeExclude(git, names) {
  let text = '';
  try { text = readFileSync(git.exclude, 'utf8'); } catch { /* none yet */ }
  const lines = text.split('\n');
  const kept = [];
  let inBlock = false;
  for (const l of lines) {
    if (l === EXCLUDE_BEGIN) { inBlock = true; continue; }
    if (l === EXCLUDE_END) { inBlock = false; continue; }
    if (!inBlock) kept.push(l);
  }
  while (kept.length && kept[kept.length - 1] === '') kept.pop();
  const base = `${git.prefix}${PROJECT_SKILLS_REL}/`;
  const block = [
    EXCLUDE_BEGIN,
    `${base}${STATE_FILE}`,
    `${base}${STATE_FILE}.tmp`,
    `${base}${STAGE_PREFIX}*/`,
    ...[...names].sort().map((n) => `${base}${n}/`),
    EXCLUDE_END,
  ];
  mkdirSync(dirname(git.exclude), { recursive: true });
  writeFileSync(git.exclude, [...kept, ...(kept.length ? [''] : []), ...block, ''].join('\n'));
}

/** What a previous install left: { sha, skills, files } — or null when absent, unreadable or not to be trusted. */
export function readState(skillsDir, root, git) {
  const p = join(skillsDir, STATE_FILE);
  if (!existsSync(p) || isLink(p)) return null;
  // A state file the repo carries was not written by this module, so it says nothing about what is ours.
  if (git && gitTracked(root, relative(root, p))) return null;
  try {
    const s = JSON.parse(readFileSync(p, 'utf8'));
    if (typeof s.sha256 !== 'string' || !Array.isArray(s.skills) || typeof s.files !== 'object' || !s.files) return null;
    return { sha: s.sha256, skills: s.skills.filter((n) => typeof n === 'string' && NAME.test(n)), files: s.files };
  } catch { return null; }
}

/** Is `name` still exactly what this module installed (no file added, changed or turned into a link)? */
function untouched(skillsDir, name, state) {
  const p = join(skillsDir, name);
  if (isLink(p) || !lstatSync(p).isDirectory()) return false;
  const now = filesUnder(skillsDir, name);
  if (!now) return false;
  return Object.entries(now).every(([rel, sha]) => state.files[rel] === sha);
}

function writeExclusive(dest, data, mode) {
  mkdirSync(dirname(dest), { recursive: true });
  const fd = openSync(dest, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | (FS.O_NOFOLLOW ?? 0), parseInt(mode, 8));
  try { writeSync(fd, data); } finally { closeSync(fd); }
}

/**
 * Install a verified library into `skillsDir`. Never overwrites or removes a directory it did
 * not install, or one it installed that has since been changed.
 */
export function installLibrary(skillsDir, verified, prev, git) {
  const prevNames = new Set(prev?.skills ?? []);
  const ours = (name) => prev && prevNames.has(name) && untouched(skillsDir, name, prev);
  const target = (name) => join(skillsDir, name);
  const exists = (p) => existsSync(p) || isLink(p);

  const installed = [];
  const skipped = [];   // a skill of that name is there and is not ours
  const kept = [];      // ours, but someone changed it since: left alone
  const removed = [];
  const files = {};

  // Exclude first: a crash mid-install must not leave anything committable.
  const willWrite = [...verified.bySkill.keys()].filter((n) => !exists(target(n)) || ours(n));
  if (git) writeExclude(git, new Set([...willWrite, ...prevNames]));

  const stage = mkdtempSync(join(skillsDir, STAGE_PREFIX));
  try {
    for (const name of [...verified.bySkill.keys()].sort()) {
      const t = target(name);
      if (exists(t) && !ours(name)) {
        (prevNames.has(name) ? kept : skipped).push(name);
        continue;
      }
      const root = join(stage, name);
      for (const f of verified.bySkill.get(name)) {
        writeExclusive(join(root, ...f.rel), f.data, f.mode);
        files[`${name}/${f.rel.join('/')}`] = f.sha;
      }
      if (exists(t)) rmSync(t, { recursive: true, force: true });
      renameSync(root, t);
      installed.push(name);
    }
    for (const name of [...prevNames].sort()) {
      if (verified.bySkill.has(name)) continue;
      const t = target(name);
      if (!exists(t)) continue;
      if (ours(name)) { rmSync(t, { recursive: true, force: true }); removed.push(name); } else kept.push(name);
    }
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }

  const statePath = join(skillsDir, STATE_FILE);
  writeFileSync(`${statePath}.tmp`, JSON.stringify({ sha256: verified.sha, skills: installed, files }, null, 1));
  renameSync(`${statePath}.tmp`, statePath);
  if (git) writeExclude(git, new Set(installed));
  return { installed, skipped, kept, removed };
}

/**
 * One run's sync. `fetchLibrary(have)` asks the BFF for the library (have = the sha already
 * installed, '' for none) and returns { status, body, sha } — body the raw JSON text, sha the
 * X-Skill-Library-Sha256 header. Never throws; the result says what happened:
 *
 *   installed | unchanged       the skills are in `dir`
 *   refused | unavailable       nothing was written; what was there stays (`why`)
 */
export async function syncProjectSkills({ workdir, fetchLibrary }) {
  let prep;
  try { prep = projectSkillsDir(workdir); } catch (err) { return { status: 'refused', why: err.message, dir: null }; }
  if (!prep.ok) return { status: 'refused', why: prep.why, dir: null };
  const { root, dir } = prep;
  const git = gitInfo(root);
  const prev = readState(dir, root, git);
  // Skip only when every skill the last install put there is still there, as installed.
  const intact = prev && prev.skills.every((n) => existsSync(join(dir, n)) && untouched(dir, n, prev));
  const have = intact ? prev.sha : '';
  let r;
  try { r = await fetchLibrary(have); } catch (err) { return { status: 'unavailable', why: err.message, dir }; }
  if (r.status === 304 && have) {
    if (git) writeExclude(git, new Set(prev.skills));
    return { status: 'unchanged', sha: have, dir, installed: prev.skills, skipped: [], kept: [], removed: [] };
  }
  if (r.status !== 200) return { status: 'unavailable', why: `HTTP ${r.status}`, dir };
  if (typeof r.body !== 'string' || Buffer.byteLength(r.body) > BODY_MAX) return { status: 'refused', why: 'response too large', dir };
  let lib;
  try { lib = JSON.parse(r.body); } catch { return { status: 'refused', why: 'response is not JSON', dir }; }
  const v = verifyLibrary(lib, r.sha ?? '');
  if (!v.ok) return { status: 'refused', why: v.why, dir };
  try {
    const out = installLibrary(dir, v, prev, git);
    return { status: 'installed', sha: v.sha, dir, ...out };
  } catch (err) {
    return { status: 'refused', why: `install failed: ${err.message}`, dir };
  }
}

/** One line for the worker's log. */
export function describeSync(r) {
  if (r.status === 'refused') return `skills: REFUSED the org's library (${r.why}); nothing written`;
  if (r.status === 'unavailable') return `skills: could not fetch the org's library (${r.why}); nothing written`;
  const head = r.status === 'unchanged'
    ? `skills: library ${r.sha.slice(0, 12)} unchanged, ${r.installed.length} skill(s) in ${r.dir}`
    : `skills: installed the org's library ${r.sha.slice(0, 12)}: ${r.installed.length} skill(s) in ${r.dir}`;
  const tail = [
    r.removed?.length ? `${r.removed.length} retired removed` : '',
    r.skipped?.length ? `skipped ${r.skipped.join(', ')} (a skill of that name is already there and is not the library's)` : '',
    r.kept?.length ? `left ${r.kept.join(', ')} alone (changed since it was installed)` : '',
  ].filter(Boolean);
  return tail.length ? `${head}; ${tail.join('; ')}` : head;
}

/**
 * What the run is told when the install and the frozen brief disagree, or null when they agree.
 * `briefDir` is the brief's skill_library.dir (null: the brief said "not installed here").
 */
export function skillsNote(r, briefDir) {
  const ok = r && (r.status === 'installed' || r.status === 'unchanged');
  if (briefDir && !ok) {
    return `Correction from the worker: the session brief says the org's skills are installed in ${briefDir}, but they could not be installed for this run (${r?.why ?? 'no checkout to install into'}). No org skills are available; do not look for them.`;
  }
  if (!briefDir && ok && r.installed.length > 0) {
    return `Note from the worker: the org's skills (library ${r.sha.slice(0, 12)}, ${r.installed.length} skill${r.installed.length === 1 ? '' : 's'}) are installed as project skills in ./${PROJECT_SKILLS_REL} for this run; Claude Code loads one when its description fits the task.`;
  }
  return null;
}
