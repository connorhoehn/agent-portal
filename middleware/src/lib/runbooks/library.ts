// The skill library (R8): ONE org-wide set. Every published runbook's current
// version becomes a Claude Code skill directory, and every box receives the
// whole set at boot, whatever initiative, repo or work item it runs for. A
// runbook's scope is a label here: it never stops a skill reaching a box.
//
//   <runbook-id>/SKILL.md            skill.ts renderSkill(id, doc)
//   <runbook-id>/scripts/…           the version's files, verbatim
//   <runbook-id>/data/…
//
// The set is versioned as a whole: `sha256` is content-addressed over every
// file's path, mode and sha (sorted), so a box that already holds that sha
// skips the copy, and any accepted change — a new skill, an edit, a retirement
// — moves it. Only accepted versions are in it: a run's captured tool reaches
// the library only through a proposal a person accepted.
//
// Pure: the caller lists the rows (store-backed loader: loadSkillLibrary).
import type { Runbook, RunbookFile, RunbookVersion } from './types.js';
import type { RunbookStore } from './store.js';
import { FILE_LIMITS, byteLength, sortFiles } from './files.js';
import { checkSkillDescription, checkSkillName, renderSkill, skillDescription } from './skill.js';
import { sha256Hex } from './tokens.js';

export interface LibrarySkill {
  /** = the runbook id; the skill's directory and frontmatter name. */
  name: string;
  version: number;
  title: string;
  description: string;
  /** The version's bundle sha (or its markdown sha when it carries no files). */
  sha256: string;
  /** Scope as a label only. */
  scope_label: string;
  files: number;
}

export interface LibraryFile extends RunbookFile {
  /** Library-relative: "<runbook-id>/SKILL.md", "<runbook-id>/scripts/x.mjs". */
  path: string;
}

export interface SkillLibrary {
  /** sha256 over every file line; the box compares this to skip the copy. */
  sha256: string;
  skills: LibrarySkill[];
  files: LibraryFile[];
  bytes: number;
  /** Published runbooks left out, and why (an invalid name or description, or the library cap). */
  skipped: Array<{ runbook_id: string; reason: string }>;
}

export const LIBRARY_FORMAT = 'orgiq-skill-library/1';
/** Where a devbox installs the library: Claude Code's personal skills folder under the box user's HOME (main.py points HOME at the workspace). */
export const BOX_SKILLS_DIR = '~/.claude/skills';
/**
 * Where a local-compute worker installs it: PROJECT skills in the run's checkout
 * (tools/local-compute-skills.mjs). The worker runs on the operator's own machine, so it never
 * writes their personal ~/.claude/skills; Claude Code discovers `.claude/skills/` from the cwd
 * `claude -p` starts in. Relative on purpose: it is read against the run's working directory.
 */
export const PROJECT_SKILLS_DIR = './.claude/skills';

const scopeLabel = (r: Runbook): string => (r.scope.kind === 'org' ? 'org-wide' : `${r.scope.kind} ${r.scope.ref ?? ''}`.trim());

export function librarySha(files: ReadonlyArray<Pick<RunbookFile, 'path' | 'mode' | 'sha256'>>): string {
  const lines = [LIBRARY_FORMAT, ...sortFiles(files as RunbookFile[]).map((f) => `${f.path} ${f.mode} ${f.sha256}`)];
  return sha256Hex(lines.join('\n') + '\n');
}

export function buildSkillLibrary(rows: ReadonlyArray<{ runbook: Runbook; version: RunbookVersion }>): SkillLibrary {
  const skills: LibrarySkill[] = [];
  const files: LibraryFile[] = [];
  const skipped: SkillLibrary['skipped'] = [];
  let bytes = 0;
  const ordered = [...rows].filter((r) => r.runbook.status === 'published').sort((a, b) => (a.runbook.id < b.runbook.id ? -1 : 1));
  for (const { runbook, version } of ordered) {
    const bad = checkSkillName(runbook.id) ?? checkSkillDescription(skillDescription(version.doc));
    if (bad) { skipped.push({ runbook_id: runbook.id, reason: bad }); continue; }
    const skillMd = renderSkill(runbook.id, version.doc);
    const own: LibraryFile[] = [
      { path: `${runbook.id}/SKILL.md`, content: skillMd, mode: '644', sha256: sha256Hex(skillMd), size: byteLength(skillMd) },
      ...(version.files ?? []).map((f) => ({ ...f, path: `${runbook.id}/${f.path}` })),
    ];
    const size = own.reduce((n, f) => n + f.size, 0);
    if (bytes + size > FILE_LIMITS.library_bytes) { skipped.push({ runbook_id: runbook.id, reason: `the library would pass ${FILE_LIMITS.library_bytes} bytes` }); continue; }
    bytes += size;
    files.push(...own);
    skills.push({
      name: runbook.id, version: version.version, title: version.doc.title, description: skillDescription(version.doc),
      sha256: version.bundle_sha256 ?? version.sha256, scope_label: scopeLabel(runbook), files: (version.files ?? []).length,
    });
  }
  const sorted = sortFiles(files) as LibraryFile[];
  return { sha256: librarySha(sorted), skills, files: sorted, bytes, skipped };
}

/** Every published runbook's current version, from the store (paged). */
export async function loadSkillLibrary(store: RunbookStore): Promise<SkillLibrary> {
  const rows: Array<{ runbook: Runbook; version: RunbookVersion }> = [];
  let cursor: string | undefined;
  do {
    const page = await store.listRunbooks({ status: ['published'], limit: 200, ...(cursor ? { cursor } : {}) });
    for (const r of page.items) {
      const v = await store.getVersion(r.id, r.current_version);
      if (v) rows.push({ runbook: r, version: v });
    }
    cursor = page.next ?? undefined;
  } while (cursor);
  return buildSkillLibrary(rows);
}

/** The library as a session brief records it (brief.ts BriefSkillLibrary). */
export function briefLibraryOf(lib: SkillLibrary, dir: string | null = BOX_SKILLS_DIR): { sha256: string; dir: string | null; skills: Array<{ name: string; version: number }> } {
  return { sha256: lib.sha256, dir, skills: lib.skills.map((k) => ({ name: k.name, version: k.version })) };
}
