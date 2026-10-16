// Capture (R8): a run that built a reusable tool leaves it in `.lab/keep/<rb-name>/`
// — a SKILL.md-shaped draft plus scripts/ and data/ — and at session end
// `lab keep` (agents/devbox/lab) turns each folder into a proposal with its files.
// This is the same reading in TypeScript, for the demo director and for the
// parity test that holds the two to one behaviour (lab-cli-skills.test.ts).
//
// The folder is UNTRUSTED (a model wrote it): links are never followed (a kept
// "file" pointing at ~/.ssh would otherwise ship a key), only regular UTF-8
// text files under scripts/ and data/ are read, names are checked, and sizes are
// capped before anything is read whole. The server re-checks all of it
// (files.ts filesOf, lint) — this only decides what is worth sending.
import { lstatSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { FILE_LIMITS } from './files.js';

const NAME = /^rb-[a-z0-9][a-z0-9-]{1,60}$/;
const SEG = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

export interface KeptTool {
  name: string;
  /** A proposal body for POST /api/runbooks/proposals, or why the folder is not sendable. */
  body?: {
    kind: 'new' | 'edit';
    skill_md: string;
    files: Array<{ path: string; content: string; mode: '644' | '755' }>;
    rationale: string;
    source: { run_ref: string; session_id: string; lab_experience_ids: string[] };
    runbook_id?: string;
  };
  problems?: string[];
}

const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Read every folder under `keepDir`, in name order. `installed` names the library skills on this box (an edit, not a new one). */
export function readKeepFolder(keepDir: string, opts: { runRef: string; sessionId?: string; installed?: ReadonlySet<string> }): KeptTool[] {
  if (!existsSync(keepDir)) return [];
  const out: KeptTool[] = [];
  for (const name of readdirSync(keepDir).sort(byName)) {
    const base = join(keepDir, name);
    const st = lstatSync(base);
    if (st.isSymbolicLink() || !st.isDirectory()) continue;
    const problems: string[] = [];
    if (!NAME.test(name)) problems.push("the folder name must look like rb-some-name (it becomes the skill's name)");
    const skillPath = join(base, 'SKILL.md');
    const skillSt = existsSync(skillPath) ? lstatSync(skillPath) : null;
    if (!skillSt || !skillSt.isFile()) problems.push('no SKILL.md');
    const files: Array<{ path: string; content: string; mode: '644' | '755' }> = [];
    let total = 0;
    const walk = (dir: string, rel: string): void => {
      for (const n of readdirSync(dir).sort(byName)) {
        const full = join(dir, n);
        const r = `${rel}/${n}`;
        const s = lstatSync(full);
        if (s.isSymbolicLink()) { problems.push(`${r} is not a regular file (links are not carried)`); continue; }
        if (s.isDirectory()) { walk(full, r); continue; }
        if (!s.isFile()) { problems.push(`${r} is not a regular file (links are not carried)`); continue; }
        if (!r.split('/').slice(1).every((p) => SEG.test(p))) { problems.push(`${r}: a name outside [A-Za-z0-9._-] or starting with . or -`); continue; }
        if (s.size > FILE_LIMITS.file_bytes) { problems.push(`${r} is ${s.size} bytes (max ${FILE_LIMITS.file_bytes})`); continue; }
        const raw = readFileSync(full);
        if (raw.includes(0)) { problems.push(`${r} is binary (only text is carried)`); continue; }
        let text: string;
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(raw); } catch { problems.push(`${r} is not UTF-8 text`); continue; }
        total += raw.length;
        files.push({ path: r, content: text, mode: (s.mode & 0o111) ? '755' : '644' });
      }
    };
    for (const root of ['scripts', 'data']) {
      const top = join(base, root);
      if (!existsSync(top)) continue;
      const s = lstatSync(top);
      if (s.isSymbolicLink() || !s.isDirectory()) continue;
      walk(top, root);
    }
    if (files.length > FILE_LIMITS.files) problems.push(`${files.length} files (max ${FILE_LIMITS.files})`);
    if (total > FILE_LIMITS.bundle_bytes) problems.push(`the files total ${total} bytes (max ${FILE_LIMITS.bundle_bytes})`);
    if (problems.length) { out.push({ name, problems }); continue; }
    const edit = opts.installed?.has(name) ?? false;
    out.push({
      name,
      body: {
        kind: edit ? 'edit' : 'new',
        skill_md: readFileSync(skillPath, 'utf8'),
        files,
        rationale: `Kept by run ${opts.runRef || '(no run)'} in .lab/keep/${name}: a tool this run built and wants every box to have.`,
        source: { run_ref: opts.runRef, session_id: opts.sessionId ?? '', lab_experience_ids: [] },
        ...(edit ? { runbook_id: name } : {}),
      },
    });
  }
  return out;
}
