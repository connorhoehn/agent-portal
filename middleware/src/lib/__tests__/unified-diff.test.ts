import { unifiedDiff } from '../unified-diff.js';

describe('unifiedDiff', () => {
  const labels = { from: 'a', to: 'b' };
  it('is empty for identical text', () => {
    expect(unifiedDiff('x\ny\n', 'x\ny\n', labels)).toEqual({ text: '', added: 0, removed: 0 });
  });
  it('shows a changed line with context and a hunk header', () => {
    const a = ['1', '2', '3', '4', '5', '6', '7', '8', '9'].join('\n');
    const b = ['1', '2', '3', '4', 'five', '6', '7', '8', '9'].join('\n');
    const d = unifiedDiff(a, b, labels, 2);
    expect(d.added).toBe(1);
    expect(d.removed).toBe(1);
    expect(d.text).toBe('--- a\n+++ b\n@@ -3,5 +3,5 @@\n 3\n 4\n-5\n+five\n 6\n 7\n');
  });
  it('handles a wholly new file (the base of a new runbook)', () => {
    const d = unifiedDiff('', 'a\nb\n', { from: '/dev/null', to: 'proposed' });
    expect(d.text).toBe('--- /dev/null\n+++ proposed\n@@ -0,0 +1,2 @@\n+a\n+b\n');
  });
  it('bounds its work: two 40,000-line inputs diff without an n*m table (a reader cannot exhaust the BFF)', () => {
    const a = Array.from({ length: 40_000 }, (_, i) => `a${i}`).join('\n');
    const b = Array.from({ length: 40_000 }, (_, i) => `b${i}`).join('\n');
    const t0 = Date.now();
    const d = unifiedDiff(a, b, labels);
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(d.added).toBe(40_000);
    expect(d.removed).toBe(40_000);
  });
  it('still finds a small edit inside large identical text (common prefix and suffix are trimmed first)', () => {
    const lines = Array.from({ length: 20_000 }, (_, i) => `line ${i}`);
    const edited = [...lines]; edited[10_000] = 'changed';
    const d = unifiedDiff(lines.join('\n'), edited.join('\n'), labels, 1);
    expect(d).toEqual({ added: 1, removed: 1, text: '--- a\n+++ b\n@@ -10000,3 +10000,3 @@\n line 9999\n-line 10000\n+changed\n line 10001\n' });
  });
});
