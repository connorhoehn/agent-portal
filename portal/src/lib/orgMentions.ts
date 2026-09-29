// Organizational-intelligence enrichment for a chat answer: which org-graph
// people the response actually named, and smart follow-up questions built from
// them. Harvested from the retired SearchPage so the flagship Ask surface shows
// *who* an answer is about — the differentiator over a plain chatbot — with
// links straight into the graph.
//
// Pure and dependency-light so it can be unit-tested and reused.

import type { OrgGraphPerson as GraphPerson } from '@connorhoehnslalom/ui-components';

export type { GraphPerson };

export interface GraphEntities {
  nodes: GraphPerson[];
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * People sorted longest-name-first, so a full name ("Sarah Thompson") is
 * matched before a bare first name ("Sarah") that is a substring of it.
 */
export function sortPeople(nodes: GraphPerson[] | undefined): GraphPerson[] {
  return nodes ? [...nodes].sort((a, b) => b.name.length - a.name.length) : [];
}

/** Word-boundary, case-insensitive name matchers keyed by person id. */
export function buildMentionRegexes(sortedPeople: GraphPerson[]): Map<string, RegExp> {
  return new Map(
    sortedPeople.map((p) => [p.id, new RegExp(`(?<![\\w])${escapeRe(p.name)}(?![\\w])`, 'i')]),
  );
}

/** Org-graph people whose names appear in the text (bold markers stripped). */
export function findMentionedPeople(
  text: string,
  sortedPeople: GraphPerson[],
  regexes: Map<string, RegExp>,
): GraphPerson[] {
  if (!text || sortedPeople.length === 0) return [];
  const stripped = text.replace(/\*\*([^*]+)\*\*/g, '$1');
  const matched = new Map<string, GraphPerson>();
  for (const p of sortedPeople) {
    const re = regexes.get(p.id);
    if (re && re.test(stripped)) matched.set(p.id, p);
  }
  return Array.from(matched.values());
}

const KNOWN_PROJECTS = [
  'Auth Migration', 'Observability Platform', 'RAG Knowledge Search',
  'LLM Application Platform', 'ML Feature Store', 'Mobile App Redesign',
  'Design System v3', 'Zero Trust Network', 'SOC2 Compliance',
  'Cost Optimization', 'Real-time Analytics Pipeline', 'Data Lake Migration',
  'Inference Platform', 'Design System API',
];

/** Up to four next-question suggestions, tuned to who/what the answer named. */
export function generateFollowUps(content: string, mentionedPeople: GraphPerson[]): string[] {
  const suggestions: string[] = [];
  if (mentionedPeople.length >= 2) {
    const first = mentionedPeople[0]!.name;
    suggestions.push(`What departments do these ${mentionedPeople.length} people work in?`);
    suggestions.push(`Who among them has the highest expertise score?`);
    suggestions.push(`Who collaborates most closely with ${first}?`);
    suggestions.push(`Which of these people are still active at the company?`);
  } else if (mentionedPeople.length === 1) {
    const name = mentionedPeople[0]!.name;
    suggestions.push(`What projects is ${name} currently working on?`);
    suggestions.push(`Who does ${name} collaborate with most closely?`);
    suggestions.push(`What decisions has ${name} participated in?`);
    suggestions.push(`What skills does ${name} have?`);
  }
  const mentionedProject = KNOWN_PROJECTS.find((p) => content.includes(p));
  if (mentionedProject && suggestions.length < 4) {
    suggestions.push(`Who led the ${mentionedProject}?`);
    suggestions.push(`What decisions did the ${mentionedProject} team make?`);
  }
  const generics = [
    'Who in the org has the most cross-team connections?',
    'Which team has the highest average expertise score?',
    'What were the most recent architectural decisions?',
    'Who are the top experts in ML and AI?',
  ];
  for (const g of generics) {
    if (suggestions.length >= 4) break;
    suggestions.push(g);
  }
  return suggestions.slice(0, 4);
}
