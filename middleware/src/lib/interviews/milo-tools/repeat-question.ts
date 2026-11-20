// Milo's interview tool `repeat_question`: the question, again: the last one the interviewer had Milo ask, or, when the lead
// asked it himself, the round's question as the candidate has it on screen (speak/index.ts `questionOf`). Anyone in the interview may ask.
import type { ServerToolDef } from '../../meeting-assistant/server-tools.js';
import type { SaidSource } from '../speak/store.js';
import { candidateLine, candidateRequestOf } from '../speak/index.js';
import { REPEAT_WINDOW_MS, standingOf, type MiloInterview } from './deps.js';
import { noArgs } from './schema.js';

export const REPEAT_QUESTION: ServerToolDef<MiloInterview, SaidSource> = {
  name: 'repeat_question',
  description: 'Read the interview question out again: the last question Milo asked, or the round\'s question the candidate has on screen. Use it whenever the speaker asks Milo to repeat, say again or read out the question.',
  parameters: noArgs(),
  says: 'Says the last approved question again.',
  mapsTo: 'server: lib/interviews/milo-tools repeat_question',
  writes: false,
  spend: null,
  repeatWindowMs: REPEAT_WINDOW_MS,
  phrase: async (text) => candidateRequestOf(text) === 'repeat',
  mayAsk: async (interview, askedBy) => ((await standingOf(interview, askedBy)) ? true : null),
  run: async (interview) => { const r = await candidateLine(interview, 'repeat'); return { line: r.text, kind: r.source }; },
};
