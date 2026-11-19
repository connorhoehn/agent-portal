// The Engineering Manager opening's kit (docs/interviews-tenant-plan.md, row I1.8): a behavioural kit.
//
// Its Leadership round is behavioural, so it has no code pad (lib/interviews/kit.ts roundHasPad) and none
// of its questions carries starter code: competencies with what good looks like and the four rating
// anchors, and questions with the follow-ups to ask when an answer stays general. The opening keeps its
// technical System design round, which Nadia Petrova is booked on; the kit holds one design question for
// it, with no starter code because a design round is talked through, not typed.
//
// The opening itself is in mock/interviews.ts, which reads this kit (one import). No candidates, users or
// interviews are added here: the walk counts them.

import type { OpeningKit } from '../lib/interviews/types.js';

const anchors = (one: string, two: string, three: string, four: string) => ({ 1: one, 2: two, 3: three, 4: four });

export const EM_KIT: OpeningKit = {
  rounds: [
    { id: 'rd-leadership', name: 'Leadership', type: 'behavioural', minutes: 60, competencyIds: ['people-leadership', 'delivery', 'influence', 'communication'] },
    { id: 'rd-design', name: 'System design', type: 'technical', minutes: 60, surface: 'board', competencyIds: ['communication', 'system-design'] },
  ],
  competencies: [
    {
      id: 'people-leadership', name: 'People leadership',
      lookFor: 'Talks about a real person and a real outcome, shows how their support changed as they learned more, and owns what did not work.',
      anchors: anchors('Manages tasks, not people.', 'Supports people when asked.', 'Grows people and handles hard conversations.', 'Builds a team that grows its own people.'),
    },
    {
      id: 'delivery', name: 'Delivery',
      lookFor: 'Sees a slip coming, says so early with options, and changes the plan rather than only the date.',
      anchors: anchors('Surprised by their own slips.', 'Reports slips once they happen.', 'Sees slips early and resets plans openly.', 'Shapes the plan so slips are rare and cheap.'),
    },
    {
      id: 'influence', name: 'Influence across teams',
      lookFor: 'Gets a decision made between teams that want different things, and keeps both teams willing to work together afterwards.',
      anchors: anchors('Escalates every disagreement.', 'Settles disagreements when someone senior steps in.', 'Brings teams to a decision and explains it to both.', 'Sets up how teams decide, so fewer disagreements reach them.'),
    },
    {
      id: 'communication', name: 'Communication',
      lookFor: 'Gives hard news and hard feedback plainly, prepares for it, and checks how it landed.',
      anchors: anchors('Hard to follow even when prompted.', 'Gets the point across with help.', 'Clear and structured; checks they were understood.', 'Explains trade-offs so others can decide with them.'),
    },
    {
      id: 'system-design', name: 'System design',
      lookFor: 'Starts from what the teams need, names the failure modes and says what the design costs to run and to adopt.',
      anchors: anchors('No coherent design.', 'A design with gaps in failure handling.', 'A sound design with failure modes covered.', 'Covers failure, cost and how it would be rolled out.'),
    },
  ],
  questions: [
    {
      id: 'q-em-struggling', competencyId: 'people-leadership', roundType: 'behavioural',
      prompt: 'Tell me about someone on your team who was struggling. What did you do, and what happened?',
      followUps: ['What did you try first, and why that?', 'How did you know whether it was working?', 'What would you do differently now?'],
    },
    {
      id: 'q-em-slip', competencyId: 'delivery', roundType: 'behavioural',
      prompt: 'Your team\'s roadmap slips by a quarter. Walk me through how you tell your stakeholders and what you change.',
      followUps: ['When did you first see the slip coming?', 'What did you cut, and who agreed to it?', 'What changed in how the team plans since?'],
    },
    {
      id: 'q-em-hiring', competencyId: 'people-leadership', roundType: 'behavioural',
      prompt: 'How have you built a team? Who did you hire first, and why?',
      followUps: ['What did you look for in that first hire that you could not teach?', 'Tell me about a hire that did not work out. What did you learn?'],
    },
    {
      id: 'q-em-two-teams', competencyId: 'influence', roundType: 'behavioural',
      prompt: 'Tell me about a time two teams needed opposite things from your team. How was it decided?',
      followUps: ['Who made the final call?', 'How did the team that lost out hear about it?'],
    },
    {
      id: 'q-em-feedback', competencyId: 'communication', roundType: 'behavioural',
      prompt: 'Describe the last piece of hard feedback you gave. How did you prepare, and how did it land?',
      followUps: ['What did the person do differently afterwards?', 'What feedback have you had recently that changed how you work?'],
    },
    {
      id: 'q-em-platform', competencyId: 'system-design', roundType: 'technical',
      prompt: 'Design a self-service deploy platform for forty product teams. What do you build first?',
      followUps: ['Which team do you bring on first, and why?', 'How do you know the platform is working for the teams?'],
    },
  ],
};
