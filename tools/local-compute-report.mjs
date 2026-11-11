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
 * `stdout` the run's stream-json output; `workdir` the checkout (null: a job with no repo keeps nothing);
 * `claudeSessionId` the session the work turn ran in (the debrief resumes it).
 */
export function buildReport({ finalMessage, stdout, workdir, runRef, sessionId, claudeSessionId = null }) {
  const msg = typeof finalMessage === 'string' ? finalMessage : '';
  return {
    block: msg ? msg.slice(-BLOCK_TAIL) : null,
    skillsLoaded: skillsLoadedFromStream(stdout),
    kept: workdir ? readKeptFolders(join(workdir, '.lab', 'keep'), { runRef, sessionId, installed: installedSkills(workdir) }) : [],
    ...(typeof claudeSessionId === 'string' && SESSION_UUID.test(claudeSessionId) ? { claudeSessionId } : {}),
  };
}

// ── The debrief (docs/learning-loop-design.md, Stage 2; lane C) ─────────────
//
// The server may answer a completion with a debrief request: resume the SAME session for one
// bounded turn that writes one runbook folder under .lab/keep/, or answers that nothing is worth
// keeping. Everything the worker does with it is here, pure, so the middleware's tests can hold it.

/** A Claude Code session id. */
export const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The session id the work turn ran in, from its own stream-json output: every event of
 * `claude -p --output-format stream-json --verbose` carries `session_id` (the `system`/`init`
 * event first, the `result` event last). The last valid one wins; null when none was seen.
 */
export function sessionIdFromStream(stdout) {
  let found = null;
  for (const line of String(stdout ?? '').split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{') || !t.includes('session_id')) continue;
    let ev;
    try { ev = JSON.parse(t); } catch { continue; }
    if (ev && typeof ev.session_id === 'string' && SESSION_UUID.test(ev.session_id)) found = ev.session_id;
  }
  return found;
}

/** What a debrief turn may ever be given, whatever a request says: the worker only narrows. */
export const DEBRIEF_TOOL_CEILING = ['Read', 'Glob', 'Grep', 'Write', 'Edit'];
const DEBRIEF_ALLOW_RULE = /^(?:Read|Glob|Grep)(?:\(\.\/\*\*\))?$|^Edit\(\.\/\.lab\/keep\/\*\*\)$/;
const DEBRIEF_DENY_FLOOR = ['Edit(./.git/**)', 'Edit(**/.git/**)', 'Bash', 'WebFetch', 'WebSearch'];
export const DEBRIEF_MAX_USD = 2;
export const DEBRIEF_MAX_TIMEOUT_S = 1800;

/**
 * The resume invocation's argv (after the `claude` binary), or null when the request is not one
 * this worker will run. Every flag is one `claude --help` lists:
 *   -p <prompt> --resume <id> --fork-session   the work session, resumed, its own record untouched
 *   --output-format json --json-schema <s>     one result object whose structured output is the answer
 *   --model <m>                                the smaller model
 *   --tools …                                  read, search and write files: no shell, no web
 *   --allowedTools … --disallowedTools …       read the checkout, write only under .lab/keep/
 *   --permission-mode dontAsk                  anything else is refused, never prompted
 *   --max-budget-usd <n>                       the dollar ceiling the server set
 * The CLI has no turn-count flag; the runner's wall clock (`timeoutS`) and the dollar ceiling bound the turn.
 */
export function debriefArgs(request, { sessionId, model = null, settingsOverride = null }) {
  if (!request || typeof request !== 'object') return null;
  if (typeof sessionId !== 'string' || !SESSION_UUID.test(sessionId)) return null;
  if (typeof request.prompt !== 'string' || !request.prompt.trim() || request.prompt.length > 20_000) return null;
  if (!request.schema || typeof request.schema !== 'object') return null;
  const tools = (Array.isArray(request.tools) ? request.tools : []).filter((t) => DEBRIEF_TOOL_CEILING.includes(t));
  const allowed = (Array.isArray(request.allowedTools) ? request.allowedTools : []).filter((t) => typeof t === 'string' && DEBRIEF_ALLOW_RULE.test(t));
  const denied = [...new Set([...DEBRIEF_DENY_FLOOR, ...(Array.isArray(request.disallowedTools) ? request.disallowedTools : []).filter((t) => typeof t === 'string' && /^[A-Za-z]+(\([^\s]*\))?$/.test(t))])];
  const usd = Number(request.maxBudgetUsd);
  if (!tools.length || !allowed.length || !Number.isFinite(usd) || usd <= 0) return null;
  return [
    '-p', request.prompt,
    '--resume', sessionId, '--fork-session',
    '--output-format', 'json',
    '--json-schema', JSON.stringify(request.schema),
    ...(model ? ['--model', model] : []),
    '--tools', tools.join(','),
    '--allowedTools', allowed.join(','),
    '--disallowedTools', denied.join(','),
    '--permission-mode', 'dontAsk',
    '--max-budget-usd', String(Math.min(usd, DEBRIEF_MAX_USD)),
    ...(settingsOverride ? ['--settings', settingsOverride] : []),
  ];
}

/** The debrief's answer from the turn's single json result: its structured output, else its text as JSON. */
export function debriefAnswerOf(result) {
  if (!result || typeof result !== 'object') return null;
  const so = result.structured_output ?? result.structuredOutput;
  if (so && typeof so === 'object' && !Array.isArray(so)) return so;
  if (typeof result.result === 'string') {
    const t = result.result.trim();
    const m = /\{[\s\S]*\}$/.exec(t);
    if (m) { try { return JSON.parse(m[0]); } catch { /* not JSON */ } }
  }
  return null;
}

/**
 * The one folder the answer names, read with every rule `lab keep` uses (links never followed,
 * text only, names and sizes checked). `{ folder }`, `{ problems }`, or `{ missing: true }`.
 */
export function readDebriefFolder(workdir, name) {
  if (typeof name !== 'string' || !KEEP_NAME.test(name)) return { problems: ['the answer names no usable folder'] };
  const all = readKeptFolders(join(workdir, '.lab', 'keep'), { runRef: '', installed: new Set() });
  const hit = all.find((k) => k.name === name);
  if (!hit) return { missing: true };
  if (hit.problems?.length) return { problems: hit.problems.slice(0, 8) };
  return { folder: { name, skill_md: hit.body.skill_md, files: hit.body.files } };
}
