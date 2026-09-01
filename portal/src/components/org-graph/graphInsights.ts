// The derivations behind the Explore page's panels: search matching,
// department rollups, and the bus-factor read.
//
// All pure. These were three separate useMemo bodies inlined in render, which
// is where the "what counts as a rare skill?" rule was hiding.

import type { GraphPerson } from './types';

export const CONNECTION_TYPE_LABELS: Record<string, string> = {
  collaborates: 'collaborates',
  mentors: 'mentors',
  reports_to: 'reports to',
  expert_in_common: 'shared expertise',
};

/** A skill held org-wide by this many people or fewer is a bus-factor risk. */
export const RARE_THRESHOLD = 2;

/** Below this many characters a search matches too much to be useful. */
const MIN_QUERY = 2;

export interface SkillMatch {
  skill: string;
  personIds: string[];
}

export interface GraphSearchResult {
  personMatches: GraphPerson[];
  skillMatches: SkillMatch[];
}

const EMPTY_SEARCH: GraphSearchResult = { personMatches: [], skillMatches: [] };

/** Name/title/department matches first, then skills ordered by how many people
 *  hold them — a skill five people share is a more useful jump than one only
 *  one person has. */
export function searchGraph(people: GraphPerson[], query: string): GraphSearchResult {
  const needle = query.trim().toLowerCase();
  if (needle.length < MIN_QUERY) return EMPTY_SEARCH;

  const personMatches = people
    .filter((p) =>
      p.name.toLowerCase().includes(needle) ||
      p.title.toLowerCase().includes(needle) ||
      p.department.toLowerCase().includes(needle))
    .slice(0, 6);

  const bySkill = new Map<string, string[]>();
  for (const p of people) {
    for (const s of p.skills) {
      if (!s.toLowerCase().includes(needle)) continue;
      const arr = bySkill.get(s);
      if (arr) arr.push(p.id);
      else bySkill.set(s, [p.id]);
    }
  }
  const skillMatches = [...bySkill.entries()]
    .map(([skill, personIds]) => ({ skill, personIds }))
    .sort((a, b) => b.personIds.length - a.personIds.length)
    .slice(0, 4);

  return { personMatches, skillMatches };
}

/** department name → the ids of everyone in it. */
export function membersByDepartment(people: GraphPerson[]): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const p of people) {
    const arr = m.get(p.department);
    if (arr) arr.push(p.id);
    else m.set(p.department, [p.id]);
  }
  return m;
}

export interface AtRiskSkill {
  skill: string;
  /** A holder who sits in the department being inspected. */
  holder: GraphPerson;
  /** How many people hold it ORG-WIDE, not just in this department. */
  holderCount: number;
}

export interface DepartmentInsight {
  members: GraphPerson[];
  /** [skill, headcount within the department], most common first. */
  topSkills: [string, number][];
  atRisk: AtRiskSkill[];
}

/** Headcount, the department's most common skills, and the skills it depends
 *  on that almost nobody in the org holds. */
export function departmentInsight(people: GraphPerson[], department: string): DepartmentInsight {
  const members = people.filter((p) => p.department === department);

  const deptSkillCount = new Map<string, number>();
  for (const p of members) {
    for (const s of p.skills) deptSkillCount.set(s, (deptSkillCount.get(s) ?? 0) + 1);
  }
  const topSkills = [...deptSkillCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);

  // Rarity is an ORG-WIDE property. A skill five people in this department
  // share is not a risk; one that only this department's single holder has is.
  const orgHolders = new Map<string, GraphPerson[]>();
  for (const p of people) {
    for (const s of p.skills) {
      const arr = orgHolders.get(s);
      if (arr) arr.push(p);
      else orgHolders.set(s, [p]);
    }
  }
  const atRisk = [...orgHolders.entries()]
    .filter(([, holders]) =>
      holders.length <= RARE_THRESHOLD &&
      holders.some((h) => h.department === department))
    .map(([skill, holders]) => ({
      skill,
      holder: holders.find((h) => h.department === department)!,
      holderCount: holders.length,
    }))
    .sort((a, b) => a.holderCount - b.holderCount)
    .slice(0, 8);

  return { members, topSkills, atRisk };
}

export function firstName(full: string): string {
  return full.split(' ')[0] ?? full;
}
