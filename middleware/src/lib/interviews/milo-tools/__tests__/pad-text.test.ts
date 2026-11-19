// Review 1, item 2: no pattern over pad text may take more than a few milliseconds, whatever the candidate typed.
import { functionOf, renderTestCases } from '../../testcases/render.js';
import { parseToolCases } from '../../testcases/parse.js';
import { afterImports, placeImports } from '../imports.js';
import { checkHelper, entryOf, placeHelper } from '../helper.js';
import { questionForPad } from '../tests.js';
import { interviewBackendInstructions } from '../context.js';
import { scannable, MAX_PAD_LINE } from '../../pad-text.js';
import type { KitQuestion, PadLanguage } from '../../types.js';

const LANGUAGES: PadLanguage[] = ['python', 'javascript', 'typescript', 'java', 'go', 'swift', 'cpp'];
const SPACES = ' '.repeat(50_000);
// The lines that start each language's patterns, then a long run of spaces and no end to the match.
const PREFIXES = ['', 'public', 'public static ', 'int', 'std::vector<int>', 'def', 'function', 'import', 'from x import', '#include', 'func', 'const x', '//'];

const question = { id: 'q1', prompt: 'Two sum', starter: { python: 'def two_sum(nums, target):\n  pass\n' } } as unknown as KitQuestion;

function timed(fn: () => unknown): number {
  const t = performance.now();
  fn();
  return performance.now() - t;
}

describe('pad text bounds (review 1, item 2)', () => {
  it('every pad-text function returns within a few ms on a 50,000-space line, in all seven languages', () => {
    for (const language of LANGUAGES) {
      for (const prefix of PREFIXES) {
        const line = `${prefix}${SPACES}`;
        const pads = [line, `${line}x`, `import os\n${line}\nmore`, `${line}(`];
        for (const pad of pads) {
          const took = Math.max(
            timed(() => functionOf(pad, language)),
            timed(() => afterImports(pad, language)),
            timed(() => placeImports(pad, ['import os'], language)),
            timed(() => placeHelper(pad, 'block\n', language)),
            timed(() => questionForPad([question], pad, language)),
            timed(() => parseToolCases([{ args: '[1]', expected: '2' }], { pad, max: 20 })),
            timed(() => checkHelper('a helper', pad, language, 'two_sum')),
            timed(() => entryOf({ [language]: pad }, language)),
            timed(() => interviewBackendInstructions([question], { text: pad, language })),
            timed(() => renderTestCases([{ args: [1], expected: 2 }], language, functionOf(pad, language))),
          );
          expect({ language, prefix, fast: took < 50 }).toEqual({ language, prefix, fast: true });
        }
      }
    }
  });

  it('a line over the bound is empty to a scan, and the line count stays', () => {
    const long = 'x'.repeat(MAX_PAD_LINE + 1);
    expect(scannable(`a\n${long}\nb`)).toBe('a\n\nb');
    expect(scannable('short')).toBe('short');
  });

  it('the java and cpp declarations are still found', () => {
    expect(functionOf('class S {\n  public static int[] twoSum(int[] nums, int target) {\n', 'java')).toBe('twoSum');
    expect(functionOf('class S {\n  public Map<String, Integer> countAll(String s) {\n', 'java')).toBe('countAll');
    expect(functionOf('std::vector<int> twoSum(std::vector<int>& nums, int target) {\n', 'cpp')).toBe('twoSum');
    expect(functionOf('std::map<int, int> *build(int n)\n{\n', 'cpp')).toBe('build');
  });

  // Review 2, item 1: the line bound does not stop a pattern's whitespace from running across newlines.
  it('a pad of 100,000 newlines, or of `a b(` lines, is scanned within a few ms in all seven languages', () => {
    const pads = ['\n'.repeat(100_000), 'a b(\n'.repeat(20_000), ' \n'.repeat(50_000), 'def\n'.repeat(20_000), 'func \n'.repeat(15_000)];
    for (const language of LANGUAGES) {
      for (const pad of pads) {
        const took = Math.max(
          timed(() => functionOf(pad, language)),
          timed(() => afterImports(pad, language)),
          timed(() => placeImports(pad, ['import os'], language)),
          timed(() => placeHelper(pad, 'block\n', language)),
          timed(() => questionForPad([question], pad, language)),
          timed(() => checkHelper('a helper', pad.slice(0, 3000), language, 'two_sum')),
          timed(() => entryOf({ [language]: pad }, language)),
          timed(() => interviewBackendInstructions([question], { text: pad, language })),
        );
        expect({ language, pad: pad.slice(0, 6), fast: took < 100 }).toEqual({ language, pad: pad.slice(0, 6), fast: true });
      }
    }
  });

  it('a C++ declaration whose brace is on the next line is still found; one whose parameters run over lines is not looked for', () => {
    expect(functionOf('int build(int n)\n{\n', 'cpp')).toBe('build');
    expect(functionOf('int build(int n) const\n{\n', 'cpp')).toBe('build');
    expect(functionOf('  func twoSum(_ nums: [Int]) -> [Int] {\n', 'swift')).toBe('twoSum');
  });
});
