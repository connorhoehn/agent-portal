// Who in the org can help with a domain — evidence-ranked, score-free.
//
// The SME's question is "who can help me with Kubernetes?", and until now the
// only surface that could answer it was the scores router — leadership-gated
// (ViewLeaderboard) and shaped as a leaderboard: ranks, composites, weight
// sliders. An SME doesn't hold that capability and doesn't need that view;
// they need a lookup. This module is the lookup, built entirely from data the
// ViewOrgChart tier already exposes: the roster's skill strings, the skills
// graph's person→skill edges, and the projects graph for "where do they spend
// their time".
//
// Deliberately absent: influence/expertise/composite scores. Ranking here is
// by strength of the MATCH (edge weights, breadth of matched skills), so the
// order answers "who has the most evidence for this domain", not "who is the
// best employee" — the distinction that keeps this surface out of HR's lane.

import type {
  GraphSnapshot,
  ProjectsGraphSnapshot,
  SkillsGraphSnapshot,
} from '../providers/types.js';

export interface HelpSkillMatch {
  name: string;
  /** 0..1 evidence strength for this skill on this person. */
  strength: number;
}

export interface HelpMatch {
  id: string;
  name: string;
  title: string;
  department: string;
  matchedSkills: HelpSkillMatch[];
  /** The person's remaining skills, for context. */
  otherSkills: string[];
  /** Initiative/project names this person is on, strongest first. */
  contexts: string[];
}

export interface HelpSearchInputs {
  graph: GraphSnapshot;
  skillsGraph: SkillsGraphSnapshot;
  projectsGraph: ProjectsGraphSnapshot;
}

/** Words that carry no domain signal when someone types a whole question. */
const STOP_WORDS = new Set([
  'who', 'can', 'help', 'me', 'with', 'the', 'a', 'an', 'on', 'in', 'for',
  'knows', 'know', 'about', 'best', 'expert', 'experts', 'experienced',
]);

function tokens(q: string): string[] {
  return q.toLowerCase().split(/[^a-z0-9+#.-]+/).filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

/**
 * Does this skill name answer the query? Whole-query containment first (so
 * "service mesh" matches the "Service Mesh" skill, not every skill containing
 * "service"), then token containment either way — "k8s admin" should still
 * find "Kubernetes"-adjacent names like "K8s".
 */
function skillMatches(skillName: string, query: string, queryTokens: string[]): boolean {
  const s = skillName.toLowerCase();
  const q = query.toLowerCase().trim();
  if (q.length > 1 && (s.includes(q) || q.includes(s))) return true;
  return queryTokens.some((t) => s.includes(t) || t.includes(s));
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/**
 * Rank people by evidence for a domain. Pure — callers fetch the snapshots.
 *
 * `limit` is small by default: the answer to "who can help" is three people
 * you could actually message, not a directory page.
 */
export function findHelp(query: string, inputs: HelpSearchInputs, limit = 6): HelpMatch[] {
  const queryTokens = tokens(query);
  if (queryTokens.length === 0 && query.trim().length < 2) return [];

  // person id → skill name → strength. Strings from the roster count as
  // evidence too (weight 0.5 — asserted but unweighted), so the search works
  // even before the skills graph is built (or in dev:mock, where it's empty).
  const matched = new Map<string, Map<string, number>>();
  const note = (personId: string, skill: string, strength: number) => {
    const per = matched.get(personId) ?? new Map<string, number>();
    per.set(skill, Math.max(per.get(skill) ?? 0, clamp01(strength)));
    matched.set(personId, per);
  };

  // Skill nodes that match by name, or whose whole DOMAIN matches — asking
  // for "infrastructure" should surface people strong in any skill under it.
  const skillById = new Map(inputs.skillsGraph.skills.map((s) => [s.id, s]));
  const matchingSkillIds = new Set(
    inputs.skillsGraph.skills
      .filter((s) => skillMatches(s.name, query, queryTokens) || skillMatches(s.domain, query, queryTokens))
      .map((s) => s.id),
  );
  for (const edge of inputs.skillsGraph.personSkillEdges) {
    if (!matchingSkillIds.has(edge.skillId)) continue;
    const skill = skillById.get(edge.skillId);
    if (skill) note(edge.personId, skill.name, edge.weight);
  }

  const peopleById = new Map(inputs.graph.nodes.map((p) => [p.id, p]));
  for (const person of inputs.graph.nodes) {
    for (const s of person.skills) {
      if (skillMatches(s, query, queryTokens)) note(person.id, s, 0.5);
    }
  }

  // Contexts: project names by edge weight, strongest first.
  const projectById = new Map(inputs.projectsGraph.projects.map((p) => [p.id, p]));
  const contextsFor = (personId: string): string[] =>
    inputs.projectsGraph.personProjectEdges
      .filter((e) => e.personId === personId)
      .sort((a, b) => b.weight - a.weight)
      .map((e) => projectById.get(e.projectId)?.name)
      .filter((n): n is string => !!n)
      .slice(0, 3);

  return [...matched.entries()]
    .map(([personId, skills]) => {
      const person = peopleById.get(personId);
      if (!person) return null;
      const matchedSkills = [...skills.entries()]
        .map(([name, strength]) => ({ name, strength }))
        .sort((a, b) => b.strength - a.strength || a.name.localeCompare(b.name));
      const matchedNames = new Set(matchedSkills.map((m) => m.name.toLowerCase()));
      return {
        id: person.id,
        name: person.name,
        title: person.title,
        department: person.department,
        matchedSkills,
        otherSkills: person.skills.filter((s) => !matchedNames.has(s.toLowerCase())),
        contexts: contextsFor(personId),
        // Evidence total ranks; breadth breaks ties — someone matching three
        // skills weakly usually beats one strong hit for a broad domain ask.
        evidenceTotal: matchedSkills.reduce((sum, m) => sum + m.strength, 0),
      };
    })
    .filter((m): m is HelpMatch & { evidenceTotal: number } => m !== null)
    .sort((a, b) =>
      b.evidenceTotal - a.evidenceTotal ||
      b.matchedSkills.length - a.matchedSkills.length ||
      a.name.localeCompare(b.name))
    .slice(0, limit)
    .map(({ evidenceTotal: _evidenceTotal, ...rest }) => rest);
}
