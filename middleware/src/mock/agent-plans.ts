// `/agent` mock planner (docs/agentic-flows-migration.md slice 10), mock side.
// Under MOCK_AGENTCORE the planner answers from these registered rows instead of
// calling the drafter: the first row whose keyword appears in the goal wins, and
// the last row is the default. Rows hold PLAN TEMPLATES only (step kinds and
// wording, `{goal}` standing for the requester's goal); nothing here is a count or a timestamp. Registered, so POST
// /api/__mock/reset restores them and `empty` shows the single-note default.

import { defineFixture } from './core/fixture.js';

export type MockPlanKind = 'summarize' | 'deck' | 'diagram' | 'doc' | 'draft' | 'note' | 'document:create' | 'meeting:create' | 'approval';
export interface MockPlanStep { kind: MockPlanKind; title: string; instruction: string; acceptance: string; body?: string }
export interface MockPlanRow { id: string; keywords: string[]; summary: string; steps: MockPlanStep[] }

export const agentPlansFixture = defineFixture<MockPlanRow>({
  key: 'agent.plans',
  scenarios: {
    default: () => [
      { id: 'plan-deck', keywords: ['deck', 'slides', 'present'], summary: 'Summarize the thread, then turn it into a deck.', steps: [
        { kind: 'summarize', title: 'Summarize the thread', instruction: '', acceptance: 'The summary quotes the messages it rests on.' },
        { kind: 'deck', title: 'Build a deck from the thread', instruction: '', acceptance: 'The deck has a title slide and cites the conversation.' },
      ] },
      { id: 'plan-kickoff', keywords: ['kickoff', 'meeting', 'huddle'], summary: 'Write the kickoff notes as a document, then open a meeting for them.', steps: [
        { kind: 'document:create', title: 'Notes: {goal}', instruction: '', acceptance: 'The document exists and holds the agenda.',
          body: '# Notes: {goal}\n\n## Agenda\n\n1. Goals\n2. Owners\n3. Next steps\n' },
        { kind: 'meeting:create', title: 'Meeting: {goal}', instruction: '', acceptance: 'A meeting is open that the team can join.' },
      ] },
      { id: 'plan-approval', keywords: ['approve', 'approval', 'careful', 'confirm'], summary: 'Summarize the thread, check with you, then draft the page.', steps: [
        { kind: 'summarize', title: 'Summarize the thread', instruction: '', acceptance: 'The summary quotes the messages it rests on.' },
        { kind: 'approval', title: 'Check before drafting the page', instruction: 'Draft a page for {goal}?', acceptance: 'You approved or rejected the next step.' },
        { kind: 'doc', title: 'Draft a page for {goal}', instruction: '', acceptance: 'A page draft exists and cites the conversation.' },
      ] },
      { id: 'plan-default', keywords: [], summary: 'Summarize the thread, then draw its flow.', steps: [
        { kind: 'summarize', title: 'Summarize the thread', instruction: '', acceptance: 'The summary quotes the messages it rests on.' },
        { kind: 'diagram', title: 'Draw the flow of the conversation', instruction: '', acceptance: 'The diagram has one box per key message and shows their order.' },
      ] },
    ],
    empty: () => [
      { id: 'plan-note', keywords: [], summary: 'Record the goal.', steps: [
        { kind: 'note', title: 'Note the goal', instruction: '', acceptance: 'The goal is written down.' },
      ] },
    ],
  },
});

/** The plan template for `goal` (selector: never a stored number). */
export function mockPlanFor(goal: string): Omit<MockPlanRow, 'id' | 'keywords'> {
  const rows = agentPlansFixture.rows();
  const lower = goal.toLowerCase();
  const row = rows.find(r => r.keywords.some(k => lower.includes(k))) ?? rows[rows.length - 1]!;
  // `{goal}` in a template is the requester's own goal (clipped), so each run names what it creates
  // after the request and two runs never collide on a room name.
  const named = (text: string): string => text.replace(/\{goal\}/g, goal.replace(/\s+/g, ' ').trim().slice(0, 50));
  return { summary: row.summary, steps: structuredClone(row.steps).map(step => ({
    ...step, title: named(step.title), instruction: named(step.instruction), ...(step.body ? { body: named(step.body) } : {}),
  })) };
}
