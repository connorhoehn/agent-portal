// R8 model: a runbook carries files (scripts/, data/) and becomes a Claude Code
// skill. Files are checked as untrusted input, hash into the version, render to
// SKILL.md deterministically, and the whole org-wide library has one sha.
import { lintRunbook, LINT_RULES } from '../index.js';
import { renderRunbook } from '../render.js';
import { versionOf } from '../version.js';
import { FILE_LIMITS, RunbookFileError, bundleSha, checkFilePath, fileOf, filesOf } from '../files.js';
import { parseSkill, renderSkill, skillDescription, SKILL_LIMITS } from '../skill.js';
import { buildSkillLibrary } from '../library.js';
import { repoLintContext } from '../repo-context.js';
import type { LintRuleId, Runbook, RunbookDoc } from '../types.js';
import { BUNDLE_FAILING, BUNDLE_RULES, csvCountDoc, csvCountFiles } from './fixtures/bundles.js';
import { GOOD_DOCS } from './fixtures/good.js';
import { seedDocs } from './fixtures/seeds.js';

const ctx = repoLintContext();
const lintWith = (doc: RunbookDoc, files = csvCountFiles, others?: Array<{ name: string; description: string }>) =>
  lintRunbook(doc, { ...ctx, files, skill: { name: 'rb-csv-count', ...(others ? { others } : {}) } });
const rulesOf = (doc: RunbookDoc, files = csvCountFiles, others?: Array<{ name: string; description: string }>) =>
  [...new Set(lintWith(doc, files, others).map((f) => f.rule))].sort();

describe('bundle and skill lint rules', () => {
  it('the R8 rules are in the rule table', () => {
    for (const id of BUNDLE_RULES) expect(LINT_RULES.map((r) => r.id)).toContain(id);
  });
  it('the clean bundle has zero findings with its files', () => {
    expect(lintWith(csvCountDoc)).toEqual([]);
  });
  for (const id of BUNDLE_RULES) {
    it(`lint rule ${id}: fails its bad fixture`, () => {
      const c = BUNDLE_FAILING[id]!;
      expect(rulesOf(c.doc, c.files, c.others)).toContain(id as LintRuleId);
    });
    it(`lint rule ${id}: passes its good fixture`, () => expect(rulesOf(csvCountDoc)).not.toContain(id));
  }
  it('lint: R-command-real accepts a bundle-relative script the bundle carries', () => {
    expect(lintWith(csvCountDoc).filter((f) => f.rule === 'R-command-real')).toEqual([]);
    // …and refuses the same command when the bundle does not carry it.
    expect(lintRunbook(csvCountDoc, ctx).filter((f) => f.rule === 'R-command-real').map((f) => f.message))
      .toEqual(expect.arrayContaining(['runs scripts/count.mjs, which is not in the repository']));
  });
  it('lint: R-secrets reads file contents', () => {
    const leaky = [csvCountFiles[0]!, fileOf({ path: 'data/sample.csv', content: `tenant,key\nacme,${'AKIA'}ABCDEFGHIJKLMNOP\n` })];
    expect(lintWith(csvCountDoc, leaky).filter((f) => f.rule === 'R-secrets').map((f) => f.path)).toEqual(['files[data/sample.csv]']);
  });
  it('lint: every seed runbook still passes the skill rules (description length, "Use when")', () => {
    for (const [label, doc] of seedDocs()) {
      expect([label, lintRunbook(doc, ctx).filter((f) => f.rule.startsWith('R-skill'))]).toEqual([label, []]);
    }
  });
});

describe('files are untrusted input', () => {
  it.each([
    ['../escape.sh', 'climbs'], ['scripts/../../etc/passwd', 'climbs'], ['/etc/passwd', 'absolute'], ['C:/x.ps1', 'absolute'],
    ['scripts\\x.sh', 'backslash'], ['bin/x.sh', 'not under scripts/'], ['scripts/.hidden', 'segment'], ['scripts/-rf', 'segment'],
    ['scripts//x', 'empty'], ['scripts/./x', 'empty or "."'], ['scripts', 'folder'], ['scripts/a b.sh', 'segment'],
  ])('files: rejects path %s', (path, why) => {
    expect(checkFilePath(path)).toContain(why);
  });
  it('files: accepts scripts/ and data/ paths', () => {
    expect(checkFilePath('scripts/cdp-ws-frames.mjs')).toBeNull();
    expect(checkFilePath('data/fixtures/sample-frames.jsonl')).toBeNull();
  });
  it('files: caps a file, a bundle and the count', () => {
    expect(() => fileOf({ path: 'data/big.txt', content: 'x'.repeat(FILE_LIMITS.file_bytes + 1) })).toThrow(RunbookFileError);
    const many = Array.from({ length: 3 }, (_, i) => ({ path: `data/f${i}.txt`, content: 'x'.repeat(30 * 1024) }));
    expect(() => filesOf(many)).toThrow(/over the .*-byte limit per runbook/);
    expect(() => filesOf(Array.from({ length: FILE_LIMITS.files + 1 }, (_, i) => ({ path: `data/f${i}`, content: '' })))).toThrow(/over the limit/);
    expect(() => filesOf([{ path: 'data/a', content: '1' }, { path: 'data/A', content: '2' }])).toThrow(/twice/);
    expect(() => filesOf([{ path: 'data/a', content: 'x\0y' }])).toThrow(/NUL/);
  });
  it('files: sha and size are derived, never taken from the caller', () => {
    const f = fileOf({ path: 'data/a.txt', content: 'é', sha256: 'f'.repeat(64), size: 99 } as never);
    expect(f.size).toBe(2);
    expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(f.mode).toBe('644');
    expect(fileOf({ path: 'scripts/x.sh', content: '' }).mode).toBe('755');
  });
});

describe('files hash into the version', () => {
  it('model: a version with files carries them sorted, with a bundle sha over markdown + files', () => {
    const v = versionOf({ runbook_id: 'rb-csv-count', version: 1, doc: csvCountDoc, author: { kind: 'person', id: 'p-001' }, files: [...csvCountFiles].reverse() });
    expect(v.files!.map((f) => f.path)).toEqual(['data/sample.csv', 'scripts/count.mjs']);
    expect(v.bundle_sha256).toBe(bundleSha(v.sha256, csvCountFiles));
    expect(v.markdown).toBe(renderRunbook(csvCountDoc)); // the markdown is unchanged by files
    const edited = versionOf({ runbook_id: 'rb-csv-count', version: 2, doc: csvCountDoc, author: { kind: 'person', id: 'p-001' }, files: [csvCountFiles[0]!, fileOf({ path: 'data/sample.csv', content: 'a\n' })] });
    expect(edited.sha256).toBe(v.sha256);
    expect(edited.bundle_sha256).not.toBe(v.bundle_sha256);
  });
  it('model: a procedure-only version keeps its pre-R8 shape', () => {
    const v = versionOf({ runbook_id: 'rb-x', version: 1, doc: csvCountDoc, author: { kind: 'person', id: 'p-001' } });
    expect('files' in v).toBe(false);
    expect('bundle_sha256' in v).toBe(false);
  });
});

describe('SKILL.md', () => {
  it('skill: round-trip — parseSkill(renderSkill(id, doc)) gives back the doc for every seed runbook', () => {
    for (const [label, doc] of [...seedDocs(), ['bundle', csvCountDoc] as [string, RunbookDoc]]) {
      const parsed = parseSkill(renderSkill('rb-x', doc));
      expect([label, parsed.ok && parsed.doc]).toEqual([label, doc]);
      expect([label, parsed.ok && parsed.name]).toEqual([label, 'rb-x']);
    }
  });
  it('skill: the body is the canonical runbook markdown, byte for byte, under name + description frontmatter', () => {
    const md = renderSkill('rb-csv-count', csvCountDoc);
    expect(md.startsWith('---\nname: rb-csv-count\ndescription: "Count the distinct values')).toBe(true);
    expect(md.endsWith(renderRunbook(csvCountDoc))).toBe(true);
    expect(renderSkill('rb-csv-count', csvCountDoc)).toBe(md);
  });
  it('skill: the description says what and when, within Claude Code\'s limit, with no tags', () => {
    const d = skillDescription({ ...csvCountDoc, summary: 'Use <script> carefully.' });
    expect(d).toContain('Use when: An export arrived as CSV');
    expect(d).toContain('Not for: Exports in JSON');
    expect(d).not.toMatch(/[<>]/);
    for (const [, doc] of Object.entries(GOOD_DOCS)) expect(skillDescription(doc).length).toBeLessThanOrEqual(SKILL_LIMITS.description);
  });
  it('skill: plain runbook markdown (no frontmatter) parses too, and a broken frontmatter is an error', () => {
    const plain = parseSkill(renderRunbook(csvCountDoc));
    expect(plain.ok && plain.name).toBeNull();
    expect(parseSkill('---\nname: rb-x\n# Title\n').ok).toBe(false);
  });
});

describe('the skill library', () => {
  const rb = (id: string, over: Partial<Runbook> = {}): Runbook => ({
    id, scope: { kind: 'initiative', ref: 'p-auth-migration' }, owner_person_id: 'p-001', status: 'published', current_version: 1,
    created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z', ...over,
  });
  const ver = (id: string, doc = csvCountDoc, files = csvCountFiles) => versionOf({ runbook_id: id, version: 1, doc, author: { kind: 'person', id: 'p-001' }, files });
  it('library: one org-wide set — every published runbook, whatever its scope, laid out as <id>/SKILL.md + files', () => {
    const lib = buildSkillLibrary([
      { runbook: rb('rb-csv-count'), version: ver('rb-csv-count') },
      { runbook: rb('rb-other', { scope: { kind: 'repo', ref: 'orgiq-x' } }), version: ver('rb-other', GOOD_DOCS['ssoNewOrigin'] ?? Object.values(GOOD_DOCS)[0]!, []) },
      { runbook: rb('rb-draft', { status: 'draft' }), version: ver('rb-draft') },
      { runbook: rb('rb-retired', { status: 'retired' }), version: ver('rb-retired') },
    ]);
    expect(lib.skills.map((s) => s.name)).toEqual(['rb-csv-count', 'rb-other']);
    expect(lib.files.map((f) => f.path)).toEqual(['rb-csv-count/SKILL.md', 'rb-csv-count/data/sample.csv', 'rb-csv-count/scripts/count.mjs', 'rb-other/SKILL.md']);
    expect(lib.skills[1]!.scope_label).toBe('repo orgiq-x');
  });
  it('library: the set sha is content-addressed — stable for the same rows, moved by any accepted change', () => {
    const a = buildSkillLibrary([{ runbook: rb('rb-csv-count'), version: ver('rb-csv-count') }]);
    const b = buildSkillLibrary([{ runbook: rb('rb-csv-count'), version: ver('rb-csv-count') }]);
    expect(a.sha256).toBe(b.sha256);
    const c = buildSkillLibrary([{ runbook: rb('rb-csv-count'), version: ver('rb-csv-count', csvCountDoc, [csvCountFiles[0]!, fileOf({ path: 'data/sample.csv', content: 'a\n' })]) }]);
    expect(c.sha256).not.toBe(a.sha256);
    const d = buildSkillLibrary([{ runbook: rb('rb-csv-count'), version: ver('rb-csv-count') }, { runbook: rb('rb-csv-two'), version: ver('rb-csv-two') }]);
    expect(d.sha256).not.toBe(a.sha256);
  });
});
