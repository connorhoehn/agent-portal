// The seeded tool runbooks (R8) are real: their bundles lint clean as bundles,
// render as skills, and every Verify command runs OFFLINE against the bundled
// data and passes — from a fresh copy laid out exactly as a box receives it
// (<skills dir>/<runbook-id>/SKILL.md + scripts/ + data/).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { lintRunbook, renderSkill, parseSkill, skillDescription } from '../../lib/runbooks/index.js';
import { repoLintContext } from '../../lib/runbooks/repo-context.js';
import { PRESENCE_BUSY_PROPOSAL, PRESENCE_RUNBOOK_ID, SEEDED_BUNDLES, bundleFiles } from '../runbook-bundles.js';

const ctx = repoLintContext();

describe('seeded tool runbooks', () => {
  it('bundles: the packed module matches the files on disk', () => {
    expect(() => execFileSync('node', ['../scripts/runbooks/pack-bundles.mjs', '--check'], { stdio: 'pipe' })).not.toThrow();
  });

  const cases = [...SEEDED_BUNDLES.map((b) => ({ ...b, key: b.id })), { id: PRESENCE_RUNBOOK_ID, key: PRESENCE_BUSY_PROPOSAL.bundle, doc: PRESENCE_BUSY_PROPOSAL.doc }];
  for (const { id, key, doc } of cases) {
    const files = bundleFiles(key);
    it(`bundles: ${key} lints clean with its files and as a skill`, () => {
      const others = SEEDED_BUNDLES.filter((b) => b.id !== id).map((b) => ({ name: b.id, description: skillDescription(b.doc) }));
      expect(lintRunbook(doc, { ...ctx, files, skill: { name: id, others } })).toEqual([]);
      const parsed = parseSkill(renderSkill(id, doc));
      expect(parsed.ok && parsed.doc).toEqual(doc);
    });

    it(`bundles: ${key} verify steps run offline and pass`, () => {
      const skills = mkdtempSync(join(tmpdir(), 'rb-skills-'));
      try {
        const home = join(skills, id);
        mkdirSync(home, { recursive: true });
        writeFileSync(join(home, 'SKILL.md'), renderSkill(id, doc));
        for (const f of files) {
          mkdirSync(dirname(join(home, f.path)), { recursive: true });
          writeFileSync(join(home, f.path), f.content, { mode: parseInt(f.mode, 8) });
        }
        for (const v of doc.verify) {
          const out = execFileSync('bash', ['-c', v.command!.text], { cwd: home, encoding: 'utf8', timeout: 20_000, env: { PATH: process.env['PATH'] ?? '' } });
          expect(out.trim().split('\n').pop()).toMatch(/-ok$/);
        }
        expect(readFileSync(join(home, 'SKILL.md'), 'utf8')).toContain(`name: ${id}`);
      } finally {
        rmSync(skills, { recursive: true, force: true });
      }
    });
  }
});
