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
});
