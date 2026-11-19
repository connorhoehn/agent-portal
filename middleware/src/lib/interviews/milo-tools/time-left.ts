// Milo's interview tool `time_left`: the time left in the round, from its minutes and its start. Anyone in the interview may ask.
import type { ServerToolDef } from '../../meeting-assistant/server-tools.js';
import { candidateLine } from '../speak/index.js';
import type { Interview } from '../types.js';
import { REPEAT_WINDOW_MS, standingOf } from './deps.js';
import { noArgs } from './schema.js';

export const TIME_LEFT: ServerToolDef<Interview> = {
  name: 'time_left',
  description: 'Say how much time is left in this interview round.',
  parameters: noArgs(),
  says: 'Says the time left from the round\'s minutes and its start.',
  mapsTo: 'server: lib/interviews/milo-tools time_left',
  writes: false,
  spend: null,
  repeatWindowMs: REPEAT_WINDOW_MS,
  phrase: async (text) => (await import('../speak/index.js')).candidateRequestOf(text) === 'time',
  mayAsk: async (interview, askedBy) => ((await standingOf(interview, askedBy)) ? true : null),
  run: async (interview) => { const r = await candidateLine(interview, 'time'); return { line: r.text, kind: r.source }; },
};
