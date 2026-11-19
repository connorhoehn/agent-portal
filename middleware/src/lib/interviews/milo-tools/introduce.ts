// Milo's interview tool `introduce`: Milo's fixed introduction, once an interview, for the lead only. Three triggers: the lead's
// words ("Milo, introduce yourself"), the live model's call, and the lead's "Introduce Milo" button (routes/interviews/milo.ts),
// which posts and says it at once (speak/intro.ts `introduceMilo`); the others log it for the orchestrator to post and say.
import type { ServerToolDef } from '../../meeting-assistant/server-tools.js';
import type { SaidSource } from '../speak/store.js';
import { utterance } from '../speak/utterance.js';
import { introduceMilo, isIntroduction, logIntroduction } from '../speak/intro.js';
import { deps, INTRO_LEAD_ONLY, REPEAT_WINDOW_MS, standingOf, type MiloInterview } from './deps.js';
import { noArgs } from './schema.js';

const LEAD = String.raw`(?:(?:um|uh|sorry|so|ok|okay|hey|hi|and|but)\s+)*(?:(?:hey\s+)?milo\s+)?(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?|please\s+)?`;
const INTRO = new RegExp(String.raw`^${LEAD}(?:introduce\s+yourself|say\s+(?:hello|hi)(?:\s+to\s+\w+)?)(?:\s+(?:please|to\s+\w+|to\s+the\s+candidate))*$`);

export const INTRODUCE: ServerToolDef<MiloInterview, SaidSource> = {
  name: 'introduce',
  description: 'Introduce Milo to the candidate, when the lead interviewer asks Milo to introduce itself or says Milo is here to help.',
  parameters: noArgs(),
  says: 'Says Milo\'s fixed introduction, once an interview.',
  mapsTo: 'server: lib/interviews/milo-tools introduce',
  writes: false,
  spend: null,
  repeatWindowMs: REPEAT_WINDOW_MS,
  phrase: (text) => INTRO.test(utterance(text)) || isIntroduction(text),
  mayAsk: async (interview, askedBy) => {
    const standing = await standingOf(interview, askedBy);
    if (!standing) return null;
    return standing === 'lead' ? true : { refusal: INTRO_LEAD_ONLY };
  },
  run: async (interview, askedBy, _args, via) => {
    if (via === 'button') {
      const out = await introduceMilo(interview, askedBy);
      return out === 'already' ? null : { line: out.line, kind: 'intro', logged: true, delivered: out.said };
    }
    const d = deps();
    const line = await logIntroduction(interview, askedBy, d.now, d.newId);
    return line === null ? null : { line, kind: 'intro', logged: true };
  },
};
