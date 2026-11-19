// Milo's interview tool `pad_add_tests`: test cases for the round's coding question, written at the bottom of the pad as Milo. The
// cases come from the session's background agent; an expected value is kept only when the question's reference agrees (tests.ts).
import type { ServerToolDef } from '../../meeting-assistant/server-tools.js';
import type { SaidSource } from '../speak/store.js';
import { atEnd } from '../pad/milo-writer.js';
import { functionOf } from '../testcases/render.js';
import type { Interview } from '../types.js';
import { hasPad } from './context.js';
import { TESTS_NOT_ADDED, testsAddedLine } from './deps.js';
import { entryOf } from './helper.js';
import { argsOf, padMayAsk, writePad } from './pad-write.js';
import { PAD_TOOL_ARGS_BYTES } from './schema.js';
import { questionForPad, testCasesFor } from './tests.js';

export const PAD_ADD_TESTS: ServerToolDef<Interview, SaidSource> = {
  name: 'pad_add_tests',
  description: 'Add test cases for the interview\'s coding question at the bottom of the shared code pad. You write the cases: for each, the arguments of one call to the question\'s function as a JSON array, and the value the question says it returns as JSON. Put the number asked for in count (a dozen is 12; 12 when no number was said) and write about three more cases than that: the system drops any the pad already has and keeps the first count that pass. Never the solution.',
  parameters: {
    type: 'object',
    properties: {
      cases: {
        type: 'array', minItems: 1, maxItems: 24,
        items: {
          type: 'object',
          properties: {
            args: { type: 'string', maxLength: 400, description: 'The arguments as a JSON array, in order, e.g. [[3, 2, 4], 6].' },
            expected: { type: 'string', maxLength: 200, description: 'The return value as JSON, e.g. [1, 2].' },
          },
          required: ['args', 'expected'], additionalProperties: false,
        },
      },
      count: { type: 'integer', minimum: 1, maximum: 20, description: 'How many test cases were asked for.' },
    },
    required: ['cases', 'count'], additionalProperties: false,
  },
  says: 'Writes the test cases into the pad as Milo; an expected value is kept only when the question\'s reference agrees.',
  mapsTo: 'server: lib/interviews/milo-tools pad_add_tests (the pad, as Milo)',
  writes: true,
  spend: null,
  slow: /\btest\s*(?:cases?|inputs?)\b/i,
  maxArgsBytes: PAD_TOOL_ARGS_BYTES,
  offered: hasPad,
  mayAsk: padMayAsk,
  run: (interview, _askedBy, args) => writePad(interview, async (step) => {
    const a = argsOf(args);
    const { text, language, questions } = step;
    const question = questionForPad(questions, text, language);
    const made = testCasesFor(a['cases'], { pad: text, language, question, fn: functionOf(text, language) ?? entryOf(question?.starter, language), count: a['count'] });
    if (!made.ok) return step.refuse(TESTS_NOT_ADDED);
    // Strings that could carry the algorithm (words, a long one, or many short ones): the batch is judged like a helper, and
    // refused with no question to judge by.
    if (made.needsVerdict) {
      if (!step.prompts.length) return step.refuse(TESTS_NOT_ADDED);
      const verdict = await step.judge({ questions: step.prompts, code: made.block, entries: step.entries, kind: 'tests' });
      if (verdict !== 'helper') return step.refuse(TESTS_NOT_ADDED);
    }
    step.done(testsAddedLine(made.count, made.checked), 'tests');
    step.kind('tests');
    return atEnd(made.block);
  }, { testsBatch: true }),
};
