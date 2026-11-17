// A fixed recap input, shared by the prompt, model and parse tests.
import type { RecapInput } from '../prompt.js';

export const FIXED_INPUT: RecapInput = {
  competencies: [
    { id: 'communication', name: 'Communication', lookFor: 'Explains their thinking as they go.',
      anchors: { 1: 'Hard to follow.', 2: 'Gets the point across with help.', 3: 'Clear and structured.', 4: 'Explains trade-offs.' } },
    { id: 'collaboration', name: 'Collaboration', lookFor: 'Talks about other people\'s work specifically.',
      anchors: { 1: 'Works around people.', 2: 'Cooperates when asked.', 3: 'Seeks input.', 4: 'Makes others better.' } },
  ],
  questions: [
    { text: 'Tell me about an incident you led. What happened first?', competencyId: 'communication', how: 'chosen' },
    { text: 'Who did you bring in, and when?', competencyId: 'communication', how: 'milo-ask' },
  ],
  lines: [
    { seq: 1, side: 'panel', text: 'Tell me about an incident you led. What happened first?' },
    { seq: 2, side: 'candidate', text: 'The payments queue backed up, so I paged the on-call lead and we split the work.' },
    { seq: 3, side: 'panel', text: 'Who did you bring in, and when?' },
    { seq: 4, side: 'candidate', text: 'The database owner, about ten minutes in, once we saw the lock waits.' },
  ],
};

export const FENCE_TOKEN = '0123456789abcdef0123456789abcdef';
