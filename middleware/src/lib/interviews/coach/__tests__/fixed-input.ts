// A fixed coach input, shared by the prompt, model and parse tests.
import type { CoachInput } from '../prompt.js';

export const FIXED_INPUT: CoachInput = {
  roundType: 'behavioural',
  competencies: [
    { id: 'communication', name: 'Communication', lookFor: 'Explains their thinking as they go.',
      anchors: { 1: 'Hard to follow.', 2: 'Gets the point across with help.', 3: 'Clear and structured.', 4: 'Explains trade-offs.' } },
    { id: 'collaboration', name: 'Collaboration', lookFor: 'Talks about other people\'s work specifically.',
      anchors: { 1: 'Works around people.', 2: 'Cooperates when asked.', 3: 'Seeks input.', 4: 'Makes others better.' } },
  ],
  questions: [
    { id: 'q-incident', prompt: 'Tell me about an incident you led. What happened first?', followUps: ['Who did you bring in, and when?'], competencyId: 'communication' },
    { id: 'q-disagree', prompt: 'Tell me about a time you disagreed with a technical decision.', followUps: ['What did you do once it was decided?'], competencyId: 'collaboration' },
  ],
  chosenQuestionIds: ['q-incident'],
  lines: [
    { seq: 1, side: 'panel', text: 'Tell me about an incident you led. What happened first?' },
    { seq: 2, side: 'candidate', text: 'The payments queue backed up, so I paged the on-call lead and we split the work.' },
  ],
  previous: [],
};

export const FENCE_TOKEN = '0123456789abcdef0123456789abcdef';
