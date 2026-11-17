// A fixed private question for the request pin and the parse tests (row I3.6).
import type { AskInput } from '../prompt.js';

export const FENCE_TOKEN = '0123456789abcdef0123456789abcdef';

export const FIXED_ASK: AskInput = {
  roundType: 'behavioural',
  competencies: [
    { id: 'communication', name: 'Communication', lookFor: 'Explains their thinking as they go.' },
    { id: 'collaboration', name: 'Collaboration', lookFor: 'Talks about other people\'s work specifically.' },
  ],
  questions: [{ id: 'q-incident', prompt: 'Tell me about an incident you led. What happened first?', competencyId: 'communication' }],
  lines: [
    { seq: 1, side: 'panel', text: 'Tell me about an incident you led. What happened first?' },
    { seq: 2, side: 'candidate', text: 'The payments queue backed up, so I paged the on-call lead and we split the work.' },
    { seq: 3, side: 'candidate', text: 'Afterwards we wrote the postmortem together and added an alert on queue depth.' },
  ],
  question: 'Who did they page?',
};
