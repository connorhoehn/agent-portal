// The hidden references behind Milo's test cases (docs/interviews-tenant-plan.md, "Milo's interview tools", `pad_add_tests`).
// Pure. Never shown to anyone and never in a model's context.
//
// An expected value goes into the pad only when the question's reference agrees with it; a case it disagrees with is dropped,
// and a question with no reference gets inputs only. A reference is a check, not an answer generator: `agrees(args, expected)`
// is true when `expected` is a right answer for `args` under the question's own rules (Two Sum: a pair of distinct indices
// whose numbers add up to the target, in an input that has exactly one such pair), false when it is not, and null when the
// arguments are not an input the question allows (the case is dropped too).
//
// Why not the run harness: a reference that runs in a sandbox would cost a container run per request and seconds of wait, and
// the mock runner (the walks, the film) prints what it is told instead of running anything. These checks are bounded arithmetic
// over arguments the parser has already bounded (parse.ts), so they run in-process.

export interface QuestionReference {
  agrees(args: readonly unknown[], expected: unknown): boolean | null;
}

const ints = (v: unknown): v is number[] => Array.isArray(v) && v.every((x) => Number.isSafeInteger(x));

const TWO_SUM: QuestionReference = {
  agrees(args, expected) {
    const [nums, target] = args;
    if (args.length !== 2 || !ints(nums) || !Number.isSafeInteger(target) || nums.length < 2) return null;
    const pairs: Array<[number, number]> = [];
    for (let i = 0; i < nums.length; i += 1) for (let j = i + 1; j < nums.length; j += 1) if (nums[i]! + nums[j]! === target) pairs.push([i, j]);
    // The question promises exactly one answer: an input with none or several is not one of its inputs.
    if (pairs.length !== 1) return null;
    if (!ints(expected) || expected.length !== 2) return false;
    const [a, b] = [...expected].sort((x, y) => x - y);
    return a === pairs[0]![0] && b === pairs[0]![1];
  },
};

/** By kit question id. */
const REFERENCES: Readonly<Record<string, QuestionReference>> = { 'q-be-twosum': TWO_SUM };

export function referenceFor(questionId: string): QuestionReference | null {
  return REFERENCES[questionId] ?? null;
}
