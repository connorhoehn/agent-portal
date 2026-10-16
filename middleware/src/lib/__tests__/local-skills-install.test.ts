// R8 follow-up — a LOCAL worker's half of skills (tools/local-compute-skills.mjs), offline.
//
// The worker runs on the operator's own machine, so the org's skill library goes into the run's
// checkout as project skills (<workdir>/.claude/skills/<rb-id>/), never ~/.claude/skills. Driven
// through a real `node` process against the real module, with a library built by the real
// buildSkillLibrary (the bytes GET /api/runs/:ref/skills and POST /jobs/:id/skills serve):
//
//   install            every file at its sha, the state file, nothing committable (.git/info/exclude,
//                      never .gitignore), the operator's own skill untouched
//   unchanged          the second sync sends the installed sha and a 304 copies nothing
//   tamper refusal     a changed byte, a climbing path, a wrong set sha: nothing written
//   foreign / changed  an rb- skill it did not install, or one it did that was since edited, stays
//   symlinked dir      .claude/skills pointing elsewhere (e.g. ~/.claude/skills) is refused

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { buildSkillLibrary, versionOf, LIBRARY_FORMAT, type Runbook } from '../runbooks/index.js';
import { cdpWebsocketDoc, presenceClientDoc, bundleFiles, CDP_RUNBOOK_ID, PRESENCE_RUNBOOK_ID } from '../../mock/runbook-bundles.js';
import { skillsNote } from './local-skills-note.js';

const MODULE = join(__dirname, '..', '..', '..', '..', 'tools', 'local-compute-skills.mjs');
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

type Resp = { status: number; body?: string; sha?: string };
type SyncResult = { status: string; why?: string; sha?: string; dir?: string; installed?: string[]; skipped?: string[]; kept?: string[]; removed?: string[]; have: string };

/** Run one sync in a fresh node: the fetch answers with `resp` and records the `have` it was sent. */
function sync(workdir: string, resp: Resp): SyncResult {
  const driver = `
    const { syncProjectSkills } = await import(${JSON.stringify(MODULE)});
    const resp = JSON.parse(process.argv[1]);
    let have = null;
    const r = await syncProjectSkills({ workdir: process.argv[2], fetchLibrary: async (h) => { have = h; return resp; } });
    process.stdout.write(JSON.stringify({ ...r, have }));`;
  const p = spawnSync(process.execPath, ['--input-type=module', '-e', driver, JSON.stringify(resp), workdir], {
    encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '', HOME: tmpdir(), GIT_CONFIG_NOSYSTEM: '1' },
  });
  if (p.status !== 0) throw new Error(`driver failed: ${p.stderr}`);
  return JSON.parse(p.stdout) as SyncResult;
}

const at = '2026-10-15T00:00:00.000Z';
const rb = (id: string): Runbook => ({ id, scope: { kind: 'org', ref: null }, owner_person_id: 'p-100', status: 'published', current_version: 1, created_at: at, updated_at: at });
function library(ids: string[] = [CDP_RUNBOOK_ID, PRESENCE_RUNBOOK_ID]) {
  const docs: Record<string, typeof cdpWebsocketDoc> = { [CDP_RUNBOOK_ID]: cdpWebsocketDoc, [PRESENCE_RUNBOOK_ID]: presenceClientDoc };
  const lib = buildSkillLibrary(ids.map((id) => ({
    runbook: rb(id),
    version: versionOf({ runbook_id: id, version: 1, doc: docs[id]!, author: { kind: 'person', id: 'p-100' }, files: bundleFiles(id) }),
  })));
  return { lib, wire: { format: LIBRARY_FORMAT, sha256: lib.sha256, bytes: lib.bytes, skills: lib.skills, files: lib.files, skipped: lib.skipped } };
}
const ok200 = (wire: object, headerSha?: string): Resp => ({ status: 200, body: JSON.stringify(wire), sha: headerSha ?? (wire as { sha256: string }).sha256 });

function gitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'local-skills-'));
  execFileSync('git', ['init', '-q', dir]);
  writeFileSync(join(dir, 'README.md'), '# app\n');
  execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.']);
  execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
  return dir;
}
const skillsDir = (w: string) => join(w, '.claude', 'skills');
/** Every file under the skills dir with its sha: what "nothing written" is measured against. */
function snapshot(w: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (abs: string, rel: string) => {
    if (!existsSync(abs)) return;
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const a = join(abs, e.name), r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(a, r); else out[r] = sha(readFileSync(a));
    }
  };
  walk(skillsDir(w), '');
  return out;
}
const userSkill = '---\nname: my-deploy\ndescription: the operator\'s own deploy skill\n---\n\nDeploy it my way.\n';

describe('local worker skills: install into the run\'s checkout as project skills', () => {
  it('installs every file at its sha, leaves the operator\'s own skill alone and makes nothing committable', () => {
    const w = gitRepo();
    mkdirSync(join(skillsDir(w), 'my-deploy'), { recursive: true });
    writeFileSync(join(skillsDir(w), 'my-deploy', 'SKILL.md'), userSkill);
    const { lib, wire } = library();

    const r = sync(w, ok200(wire));
    expect(r.status).toBe('installed');
    expect(r.have).toBe('');
    expect(r.sha).toBe(lib.sha256);
    expect(r.installed).toEqual([PRESENCE_RUNBOOK_ID, CDP_RUNBOOK_ID].sort());
    for (const f of lib.files) {
      const p = join(skillsDir(w), ...f.path.split('/'));
      expect([f.path, sha(readFileSync(p))]).toEqual([f.path, f.sha256]);
      expect([f.path, (statSync(p).mode & 0o777).toString(8)]).toEqual([f.path, f.mode]);
    }
    expect(readFileSync(join(skillsDir(w), 'my-deploy', 'SKILL.md'), 'utf8')).toBe(userSkill);
    const state = JSON.parse(readFileSync(join(skillsDir(w), '.orgiq-library.json'), 'utf8'));
    expect(state.sha256).toBe(lib.sha256);
    expect(state.skills).not.toContain('my-deploy');

    // Excluded, not ignored: the repo's .gitignore is never created, and git sees only the operator's skill.
    expect(existsSync(join(w, '.gitignore'))).toBe(false);
    const exclude = readFileSync(join(w, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude).toContain(`/.claude/skills/${CDP_RUNBOOK_ID}/`);
    expect(exclude).toContain('/.claude/skills/.orgiq-library.json');
    const status = execFileSync('git', ['-C', w, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' });
    expect(status.trim().split('\n')).toEqual(['?? .claude/skills/my-deploy/SKILL.md']);
    // And `git clean -fd`, which the worker runs between jobs, keeps them for the next run's skip.
    execFileSync('git', ['-C', w, 'clean', '-fdq']);
    expect(existsSync(join(skillsDir(w), CDP_RUNBOOK_ID, 'SKILL.md'))).toBe(true);
  });

  it('skips the copy when the installed sha is unchanged (304)', () => {
    const w = gitRepo();
    const { lib, wire } = library();
    expect(sync(w, ok200(wire)).status).toBe('installed');
    const before = snapshot(w);
    const mtime = statSync(join(skillsDir(w), CDP_RUNBOOK_ID, 'SKILL.md')).mtimeMs;

    const r = sync(w, { status: 304 });
    expect(r.have).toBe(lib.sha256);
    expect(r.status).toBe('unchanged');
    expect(snapshot(w)).toEqual(before);
    expect(statSync(join(skillsDir(w), CDP_RUNBOOK_ID, 'SKILL.md')).mtimeMs).toBe(mtime);
  });

  it('re-fetches instead of skipping when an installed skill went missing', () => {
    const w = gitRepo();
    const { wire } = library();
    sync(w, ok200(wire));
    execFileSync('rm', ['-rf', join(skillsDir(w), CDP_RUNBOOK_ID)]);
    const r = sync(w, ok200(wire));
    expect(r.have).toBe('');
    expect(r.status).toBe('installed');
    expect(existsSync(join(skillsDir(w), CDP_RUNBOOK_ID, 'SKILL.md'))).toBe(true);
  });

  it('refuses a tampered library and writes nothing', () => {
    const w = gitRepo();
    mkdirSync(join(skillsDir(w), 'my-deploy'), { recursive: true });
    writeFileSync(join(skillsDir(w), 'my-deploy', 'SKILL.md'), userSkill);
    const { wire } = library();
    const before = snapshot(w);
    const files = wire.files.map((f) => ({ ...f }));
    const tampered: Array<[string, Resp]> = [
      ['a changed byte', ok200({ ...wire, files: files.map((f, i) => (i === 0 ? { ...f, content: f.content + ' ' } : f)) })],
      ['a climbing path', ok200({ ...wire, files: [...files, { ...files[0]!, path: `${CDP_RUNBOOK_ID}/scripts/../../../evil` }] })],
      ['a personal-skills path', ok200({ ...wire, files: [...files, { ...files[0]!, path: '/Users/x/.claude/skills/rb-x/SKILL.md' }] })],
      ['a non-rb name', ok200({ ...wire, files: [...files, { ...files[0]!, path: 'my-deploy/SKILL.md' }] })],
      ['a wrong set sha', ok200({ ...wire, sha256: '0'.repeat(64) })],
      ['a header sha that disagrees', ok200(wire, 'f'.repeat(64))],
      ['an unknown format', ok200({ ...wire, format: 'other/1' })],
      ['not JSON', { status: 200, body: '<html>', sha: wire.sha256 }],
    ];
    for (const [what, resp] of tampered) {
      const r = sync(w, resp);
      expect([what, r.status]).toEqual([what, 'refused']);
      expect([what, snapshot(w)]).toEqual([what, before]);
    }
    expect(existsSync(join(w, 'evil'))).toBe(false);
  });

  it('never overwrites an rb- skill it did not install, nor one it installed that was since edited', () => {
    const w = gitRepo();
    const foreign = '---\nname: rb-ws-cdp-debug\ndescription: mine\n---\n\nmine\n';
    mkdirSync(join(skillsDir(w), CDP_RUNBOOK_ID), { recursive: true });
    writeFileSync(join(skillsDir(w), CDP_RUNBOOK_ID, 'SKILL.md'), foreign);
    const { wire } = library();

    const r = sync(w, ok200(wire));
    expect(r.status).toBe('installed');
    expect(r.skipped).toEqual([CDP_RUNBOOK_ID]);
    expect(r.installed).toEqual([PRESENCE_RUNBOOK_ID]);
    expect(readFileSync(join(skillsDir(w), CDP_RUNBOOK_ID, 'SKILL.md'), 'utf8')).toBe(foreign);
    // Not excluded either: a skill that is not the library's stays visible to git.
    expect(readFileSync(join(w, '.git', 'info', 'exclude'), 'utf8')).not.toContain(`/${CDP_RUNBOOK_ID}/`);

    // Someone edits the installed presence skill; a library that retires it leaves it in place.
    const edited = join(skillsDir(w), PRESENCE_RUNBOOK_ID, 'notes.md');
    writeFileSync(edited, 'my notes\n');
    const r2 = sync(w, ok200(library([CDP_RUNBOOK_ID]).wire));
    expect(r2.removed).toEqual([]);
    expect(r2.kept).toContain(PRESENCE_RUNBOOK_ID);
    expect(readFileSync(edited, 'utf8')).toBe('my notes\n');
  });

  it('removes a retired skill it installed and nobody changed', () => {
    const w = gitRepo();
    sync(w, ok200(library().wire));
    const r = sync(w, ok200(library([CDP_RUNBOOK_ID]).wire));
    expect(r.removed).toEqual([PRESENCE_RUNBOOK_ID]);
    expect(existsSync(join(skillsDir(w), PRESENCE_RUNBOOK_ID))).toBe(false);
    expect(readFileSync(join(w, '.git', 'info', 'exclude'), 'utf8')).not.toContain(PRESENCE_RUNBOOK_ID);
  });

  it('refuses a .claude/skills that is a symlink (it could be the operator\'s ~/.claude/skills)', () => {
    const w = gitRepo();
    const personal = mkdtempSync(join(tmpdir(), 'personal-skills-'));
    mkdirSync(join(w, '.claude'));
    symlinkSync(personal, join(w, '.claude', 'skills'));
    const r = sync(w, ok200(library().wire));
    expect(r.status).toBe('refused');
    expect(r.why).toMatch(/symlink/);
    expect(readdirSync(personal)).toEqual([]);
  });

  it('installs into a workdir that is not a git checkout, with no git bookkeeping', () => {
    const w = mkdtempSync(join(tmpdir(), 'local-skills-plain-'));
    const r = sync(w, ok200(library().wire));
    expect(r.status).toBe('installed');
    expect(existsSync(join(w, '.git'))).toBe(false);
  });

  it('a fetch failure writes nothing and says so', () => {
    const w = gitRepo();
    const r = sync(w, { status: 409 });
    expect(r.status).toBe('unavailable');
    expect(snapshot(w)).toEqual({});
  });
});

describe('what the run is told', () => {
  const installed = { status: 'installed', sha: 'a'.repeat(64), installed: ['rb-x'] };
  it('says nothing when the brief and the install agree', () => {
    expect(skillsNote(installed, './.claude/skills')).toBeNull();
    expect(skillsNote({ status: 'refused', why: 'x' }, null)).toBeNull();
  });
  it('corrects a brief that promised skills the install could not deliver', () => {
    expect(skillsNote({ status: 'refused', why: 'the set does not match its sha256' }, './.claude/skills')).toMatch(/could not be installed.*No org skills are available/);
  });
  it('tells a run whose brief said "not here" that they are here after all', () => {
    expect(skillsNote(installed, null)).toMatch(/installed as project skills in \.\/\.claude\/skills/);
  });
});
