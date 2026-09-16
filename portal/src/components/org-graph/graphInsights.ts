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

/** Parse a `?focus=` query param into individual ids. Accepts a single id
 *  (related-people cards on /search) or a comma-joined list ("Open in Ask →"
 *  / "Show all N in Explore" round-trip) alike; trims whitespace and drops
 *  empties so a trailing comma or stray space never adds a blank selection. */
export function parseFocusIds(focus: string | null): string[] {
  if (!focus) return [];
  return focus.split(',').map((s) => s.trim()).filter(Boolean);
}

// ── Org-wide rare skills ─────────────────────────────────────────────────────

/** Same bus-factor rule as `departmentInsight`'s `atRisk`, but with no
 *  department to pick "the" holder from — every holder of a rare skill gets
 *  its own entry (same `AtRiskSkill` shape, so callers that already render
 *  `atRisk` need no branching), sorted rarest-first. */
export function orgInsight(people: GraphPerson[]): { atRisk: AtRiskSkill[] } {
  const orgHolders = new Map<string, GraphPerson[]>();
  for (const p of people) {
    for (const s of p.skills) {
      const arr = orgHolders.get(s);
      if (arr) arr.push(p);
      else orgHolders.set(s, [p]);
    }
  }
  const atRisk = [...orgHolders.entries()]
    .filter(([, holders]) => holders.length <= RARE_THRESHOLD)
    .flatMap(([skill, holders]) =>
      holders.map((holder) => ({ skill, holder, holderCount: holders.length })))
    .sort((a, b) => a.holderCount - b.holderCount || a.skill.localeCompare(b.skill))
    .slice(0, 16);
  return { atRisk };
}

/** Sweep id the org-sweep scheduler files bus-factor findings under
 *  (`schema`/work findings — see `findingsFilter.ts`'s `SWEEP_TITLES`). */
export const RARE_SKILL_SWEEP = 'bus_factor';

/** Where the rare-skill pill sends you: Work → Findings, filtered to the
 *  bus-factor sweep and this skill, or (once we know a specific finding
 *  exists for it) straight to that finding. `FindingsPage` reads
 *  `?sweep=`/`?q=`/`?finding=`. */
export function rareSkillFindingsUrl(skill: string, findingId?: string | null): string {
  const params = findingId
    ? new URLSearchParams({ sweep: RARE_SKILL_SWEEP, finding: findingId })
    : new URLSearchParams({ sweep: RARE_SKILL_SWEEP, q: skill });
  return `/iq/work/findings?${params.toString()}`;
}

// ── Joining Explore's rare-skill read to the server's bus-factor sweep ─────
//
// `orgInsight`/`departmentInsight` compute "rare skill" client-side from
// `/api/graph/entities` — a live, cheap read with no notion of "has a human
// already been told about this." `GET /api/work/findings` is the server's
// own opinion: a persisted, promotable/dismissable finding the nightly sweep
// (`middleware/src/providers/org-sweeps.ts::sweepBusFactor`) filed. The two
// are independent reads over data that can drift (the sweep runs on a
// schedule; the graph read is live), so a rare-skill pill and "finding →"
// can legitimately disagree — the join below is how the strip tells the
// reader which case it's in instead of linking to "Nothing here."
//
// The only thing a `Finding` carries that names the skill at all is its
// title, and only for the REAL sweep: `sweepBusFactor` writes
// `${skillName}: N holder(s) org-wide` verbatim. A finding whose title
// doesn't follow that shape (a hand-written mock fixture, say) can't be
// matched to a skill and is correctly treated as not about any skill here —
// that is the disagreement made visible, not a bug in the parse.

export interface FindingLike {
  id: string;
  sweep: string;
  status: string;
  entityType: string | null;
  title: string;
}

function skillNameFromBusFactorTitle(title: string): string | null {
  const idx = title.indexOf(':');
  if (idx <= 0) return null;
  const rest = title.slice(idx + 1).trim().toLowerCase();
  if (!rest.includes('holder')) return null; // not the sweep's own "N holder(s) org-wide" shape
  return title.slice(0, idx).trim().toLowerCase();
}

/** skill name (lowercased) → the bus-factor finding for it. Later findings
 *  for a name already seen are ignored — `sweepBusFactor` upserts by
 *  fingerprint, so the caller's list should carry at most one open finding
 *  per skill; if it ever carries more, the first (most-recently-fetched
 *  order) wins over silently picking one at random on every render. */
export function indexBusFactorFindings(findings: FindingLike[]): Map<string, FindingLike> {
  const m = new Map<string, FindingLike>();
  for (const f of findings) {
    if (f.sweep !== RARE_SKILL_SWEEP || f.entityType !== 'skill') continue;
    const name = skillNameFromBusFactorTitle(f.title);
    if (!name || m.has(name)) continue;
    m.set(name, f);
  }
  return m;
}

/** Look up the server's bus-factor finding for a skill name, case-insensitive. */
export function findingForSkill(index: Map<string, FindingLike>, skill: string): FindingLike | null {
  return index.get(skill.trim().toLowerCase()) ?? null;
}

// ── Node sizing ──────────────────────────────────────────────────────────────
//
// Influence is leadership analytics — the same ViewLeaderboard-tier number
// OrgGraphTooltip and PersonDetailCard already hide from everyone but
// org-leader/hr-admin/admin. Sizing every node by influenceScore regardless of
// role leaked that number visually: a bigger circle IS the figure, so a member
// who can't see it in the tooltip could still read it off the canvas. For
// roles that may not see it, size by degree (how many edges touch the node in
// the graph currently on screen) instead — a real, role-agnostic signal.

const MIN_RADIUS = 12;
const RADIUS_RANGE = 18;

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/**
 * `showInfluence` true → size by `influenceScore` (0..1), the original rule.
 * `showInfluence` false → size by `degree` relative to `maxDegree` in the
 * currently-rendered graph (0 when there are no edges at all, so an edgeless
 * graph draws every node at the minimum radius rather than one arbitrary node
 * reading as "biggest").
 */
export function nodeRadius(
  showInfluence: boolean,
  influenceScore: number,
  degree: number,
  maxDegree: number,
): number {
  const t = showInfluence
    ? clamp01(influenceScore)
    : maxDegree > 0
      ? clamp01(degree / maxDegree)
      : 0;
  return MIN_RADIUS + t * RADIUS_RANGE;
}

/** id → degree (count of links touching that id), from a flat list of
 *  {source, target} pairs. Self-loops (shouldn't occur in this graph) count
 *  once, not twice. */
export function degreeMap(links: Array<{ source: string; target: string }>): Map<string, number> {
  const m = new Map<string, number>();
  const bump = (id: string) => m.set(id, (m.get(id) ?? 0) + 1);
  for (const l of links) {
    bump(l.source);
    if (l.target !== l.source) bump(l.target);
  }
  return m;
}

/** Largest value in a degree map, or 0 for an empty graph. */
export function maxDegree(map: Map<string, number>): number {
  let max = 0;
  for (const v of map.values()) if (v > max) max = v;
  return max;
}
