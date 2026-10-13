// The gate: every fixture in the repo, against the committed snapshot.
//
// This runs on the real snapshot and the real test files, so it is what
// actually stops the next `enterprise`. It also prints the known product bugs
// on the way past, because an exemption nobody reads is how one becomes
// permanent.

import { loadVocabulary, hasSnapshot } from '../vocabulary.js';
import { fixtureFiles, scanRepo, formatFindings, formatKnownBugs } from '../scan.js';
import { serverCorpus } from '../corpus.js';
import { ALLOWED } from '../allow.js';

describe('fixture / server agreement', () => {
  it('has a snapshot to check against', () => {
    expect(hasSnapshot()).toBe(true);
  });

  const vocab = loadVocabulary();

  it('captured a real share of the surface — an empty snapshot proves nothing', () => {
    expect(vocab.capturedCount).toBeGreaterThan(120);
    expect(vocab.objects.length).toBeGreaterThan(200);
  });

  it('read the server source, not just the tests', () => {
    const corpus = serverCorpus();
    expect(corpus.fileCount).toBeGreaterThan(100);
    // A route file's own strings must be in it; a test file's must not.
    expect(corpus.strings.has('enterprise_context')).toBe(true);
    // 'enterprise' became a real server string on 2026-10-10 (assessment-document-context.ts);
    // the test-only sentinel is a phrase only a test file spells.
    expect(corpus.strings.has('deleted seat')).toBe(false);
  });

  it('finds fixture files in both packages', () => {
    const files = fixtureFiles();
    expect(files.some((f) => f.startsWith('middleware/src/'))).toBe(true);
    expect(files.some((f) => f.startsWith('portal/src/'))).toBe(true);
    // Never its own tests: they carry deliberately wrong fixtures as input.
    expect(files.some((f) => f.includes('mock/core/wire/'))).toBe(false);
  });

  it('every exemption carries a reason', () => {
    for (const entry of ALLOWED.entries) {
      expect(entry.reason.trim().length).toBeGreaterThan(20);
      expect(Boolean(entry.key) || Boolean(entry.field) || Boolean(entry.value)).toBe(true);
    }
  });

  it('no fixture invents a wire string or a key the server never sends', () => {
    const findings = scanRepo(vocab);
    const bugs = formatKnownBugs();
    if (bugs) console.log(`\n${bugs}`);
    if (findings.length > 0) throw new Error(`\n${formatFindings(findings)}`);
  });
});
