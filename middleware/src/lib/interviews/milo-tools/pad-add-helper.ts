// Milo's interview tool `pad_add_helper`: a helper someone asked for (an LRU cache class, a small data structure) at the top of the
// pad, marked as Milo's. Every helper is judged against the round's questions first (verdict.ts, a model call held under the
// interview's `tools` part); a standard-library one becomes an import.
import type { ServerToolDef } from '../../meeting-assistant/server-tools.js';
import type { SaidSource } from '../speak/store.js';
import type { Interview } from '../types.js';
import { hasPad, padContextNote } from './context.js';
import { HELPER_ADDED, HELPER_NOT_ADDED, importsAddedLine, NOT_SOLUTION, NOTHING_NEW } from './deps.js';
import { checkHelper, helperBlock, placeHelper } from './helper.js';
import { placeImports } from './imports.js';
import { argsOf, padMayAsk, writePad } from './pad-write.js';
import { PAD_TOOL_ARGS_BYTES } from './schema.js';

export const PAD_ADD_HELPER: ServerToolDef<Interview, SaidSource> = {
  name: 'pad_add_helper',
  description: 'Add a helper someone asked for (an LRU cache class, a small data structure) at the top of the shared code pad, written by you in the pad\'s language, at most 60 lines. Use it only when the language has no standard-library import for it; otherwise use pad_add_import. Never the interview question\'s own answer, and never the question\'s function.',
  parameters: {
    type: 'object',
    properties: {
      what: { type: 'string', maxLength: 120, description: 'What the helper is, in a few words, e.g. "an LRU cache".' },
      code: { type: 'string', maxLength: 6000, description: 'The helper\'s code in the pad\'s language.' },
    },
    required: ['what', 'code'], additionalProperties: false,
  },
  says: 'Adds a marked helper block at the top of the pad as Milo; never the question\'s answer.',
  mapsTo: 'server: lib/interviews/milo-tools pad_add_helper (the pad, as Milo)',
  writes: true,
  spend: 'tools',
  slow: /\bhelper\b|\b(?:class|data structure|cache|trie|heap|linked list)\b/i,
  maxArgsBytes: PAD_TOOL_ARGS_BYTES,
  offered: hasPad,
  mayAsk: padMayAsk,
  run: (interview, _askedBy, args) => writePad(interview, async (step) => {
    const a = argsOf(args);
    const { text, language } = step;
    const what = typeof a['what'] === 'string' ? a['what'] : '';
    const checked = checkHelper(what, a['code'], language, step.entries);
    if (!checked.ok) {
      // Code in another language: likely written for the pad as the session last knew it. Not the request's one run.
      return step.refuse(checked.why === 'entry' ? NOT_SOLUTION : HELPER_NOT_ADDED, checked.why === 'language' ? padContextNote({ text, language }) : undefined);
    }
    if (checked.kind === 'import') {
      step.kind('imports');
      return (current) => {
        const placed = placeImports(current, [checked.line], language);
        if (!placed) return step.refuse(NOTHING_NEW);
        step.done(importsAddedLine(1), 'imports');
        return placed;
      };
    }
    // Every helper is judged, whoever asked; with no question to judge it by, it is refused (fail closed; review 1, item 3).
    if (!step.prompts.length) return step.refuse(HELPER_NOT_ADDED);
    const verdict = await step.judge({ questions: step.prompts, code: checked.code, entries: step.entries, kind: 'helper' });
    if (verdict !== 'helper') return step.refuse(NOT_SOLUTION);
    step.kind('helper');
    const block = helperBlock(checked.code, what, language);
    return (current) => {
      step.done(HELPER_ADDED, 'helper');
      return placeHelper(current, block, language);
    };
  }),
};
