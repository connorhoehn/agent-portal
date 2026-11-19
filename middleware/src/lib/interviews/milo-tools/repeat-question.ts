// Milo's interview tool `repeat_question`: the last question the interviewer had Milo ask, again. Anyone in the interview may ask.
import type { ServerToolDef } from '../../meeting-assistant/server-tools.js';
import { candidateLine } from '../speak/index.js';
import type { Interview } from '../types.js';
import { REPEAT_WINDOW_MS, standingOf } from './deps.js';
import { noArgs } from './schema.js';

export const REPEAT_QUESTION: ServerToolDef<Interview> = {
  name: 'repeat_question',
  description: 'Repeat the last question the interviewer had Milo ask.',
  parameters: noArgs(),
  says: 'Says the last approved question again.',
  mapsTo: 'server: lib/interviews/milo-tools repeat_question',
  writes: false,
  spend: null,
  repeatWindowMs: REPEAT_WINDOW_MS,
  phrase: async (text) => (await import('../speak/index.js')).candidateRequestOf(text) === 'repeat',
  mayAsk: async (interview, askedBy) => ((await standingOf(interview, askedBy)) ? true : null),
  run: async (interview) => { const r = await candidateLine(interview, 'repeat'); return { line: r.text, kind: r.source }; },
};
