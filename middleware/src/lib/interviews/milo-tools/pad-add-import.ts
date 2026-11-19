// Milo's interview tool `pad_add_import`: standard-library import lines at the top of the pad, in the pad's language, as Milo.
import type { ServerToolDef } from '../../meeting-assistant/server-tools.js';
import type { SaidSource } from '../speak/store.js';
import { hasPad } from './context.js';
import { importsAddedLine, NOT_STANDARD_IMPORT, NOTHING_NEW, type MiloInterview } from './deps.js';
import { checkedImportLines, placeImports } from './imports.js';
import { argsOf, padMayAsk, writePad } from './pad-write.js';
import { PAD_TOOL_ARGS_BYTES } from './schema.js';

export const PAD_ADD_IMPORT: ServerToolDef<MiloInterview, SaidSource> = {
  name: 'pad_add_import',
  description: 'Add standard-library import lines at the top of the shared code pad, in the pad\'s language (for example "from functools import lru_cache" in Python). Only imports, never other code.',
  parameters: {
    type: 'object',
    properties: { lines: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'string', maxLength: 120 } } },
    required: ['lines'], additionalProperties: false,
  },
  says: 'Adds standard-library imports at the top of the pad as Milo.',
  mapsTo: 'server: lib/interviews/milo-tools pad_add_import (the pad, as Milo)',
  writes: true,
  spend: null,
  maxArgsBytes: PAD_TOOL_ARGS_BYTES,
  offered: hasPad,
  mayAsk: padMayAsk,
  run: (interview, _askedBy, args) => writePad(interview, async (step) => {
    const { language } = step;
    const lines = checkedImportLines(argsOf(args)['lines'], language);
    if (!lines) return step.refuse(NOT_STANDARD_IMPORT);
    step.kind('imports');
    return (current) => {
      const placed = placeImports(current, lines, language);
      if (!placed) return step.refuse(NOTHING_NEW);
      step.done(importsAddedLine(placed.text.trim().split('\n').length), 'imports');
      return placed;
    };
  }),
};
