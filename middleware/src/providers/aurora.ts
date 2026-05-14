// Aurora provider — fetches org-graph + scores from Aurora PostgreSQL via the
// RDS Data API. The graph is modeled as relational tables (people + edge tables)
// since Aurora does not support Apache AGE. Schema: schema/orgiq_schema.sql.
//
// Exports:
//   - realAurora: live RDS Data API client. Handles empty tables gracefully.
//   - mockAurora: wraps the existing in-memory mock arrays in the same contract.

import {
  RDSDataClient,
  ExecuteStatementCommand,
  type SqlParameter,
  type Field,
} from '@aws-sdk/client-rds-data';

import { config } from '../config.js';
import type {
  AuroraProvider,
  GraphSnapshot,
  Person,
  Relationship,
  Department,
  PersonDetail,
  Leaderboard,
  ScoreEntry,
  SkillSummary,
} from './types.js';

import {
  mockPeople,
  mockRelationships,
  departments as mockDepartments,
} from '../mock/people.js';
import { mockScores } from '../mock/scores.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

const DEPT_PALETTE = [
  '#2563eb', // blue
  '#16a34a', // green
  '#9333ea', // purple
  '#ea580c', // orange
  '#dc2626', // red
  '#0891b2', // cyan
  '#ca8a04', // yellow
  '#db2777', // pink
];

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

function departmentsFromTeams(teams: Array<string | null | undefined>): Department[] {
  const seen = new Set<string>();
  const out: Department[] = [];
  for (const t of teams) {
    if (!t) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push({
      id: slugify(t) || `dept-${out.length}`,
      name: t,
      color: DEPT_PALETTE[out.length % DEPT_PALETTE.length]!,
    });
  }
  return out;
}

// Canonicalize an undirected edge so we don't emit (a,b) and (b,a) twice.
function edgeKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

// ─── RDS Data API plumbing (real provider only) ─────────────────────────────

let _client: RDSDataClient | null = null;
function client(): RDSDataClient {
  if (!_client) _client = new RDSDataClient({ region: config.region });
  return _client;
}

function readField(cell: Field | undefined): unknown {
  if (!cell) return null;
  if (cell.isNull) return null;
  if (cell.stringValue !== undefined) return cell.stringValue;
  if (cell.longValue !== undefined) return cell.longValue;
  if (cell.doubleValue !== undefined) return cell.doubleValue;
  if (cell.booleanValue !== undefined) return cell.booleanValue;
  return null;
}

export async function exec(sql: string, params: SqlParameter[] = []): Promise<Record<string, any>[]> {
  const resp = await client().send(
    new ExecuteStatementCommand({
      resourceArn: config.aurora.clusterArn,
      secretArn: config.aurora.secretArn,
      database: config.aurora.database,
      sql,
      parameters: params,
      includeResultMetadata: true,
    }),
  );
  const cols = (resp.columnMetadata ?? []).map((c) => c.name ?? '');
  return (resp.records ?? []).map((record) => {
    const row: Record<string, any> = {};
    record.forEach((cell, i) => {
      row[cols[i] ?? `col${i}`] = readField(cell);
    });
    return row;
  });
}

function strParam(name: string, value: string): SqlParameter {
  return { name, value: { stringValue: value } };
}

function intParam(name: string, value: number): SqlParameter {
  return { name, value: { longValue: value } };
}

function nullableStrParam(name: string, value: string | undefined | null): SqlParameter {
  if (value === undefined || value === null || value === '') {
    return { name, value: { isNull: true }, typeHint: undefined };
  }
  return { name, value: { stringValue: value } };
}

function toNumber(v: unknown, fallback = 0): number {
  if (v === null || v === undefined) return fallback;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

function toStr(v: unknown, fallback = ''): string {
  if (v === null || v === undefined) return fallback;
  return String(v);
}

// Clamp a score-like value into [0,1] for influenceScore display.
function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

// ─── Real provider ──────────────────────────────────────────────────────────

async function fetchSkillsByPerson(): Promise<Map<string, string[]>> {
  const rows = await exec(
    `SELECT ps.person_id AS person_id, s.name AS skill_name
       FROM person_skills ps
       JOIN skills s ON s.id = ps.skill_id`,
  );
  const out = new Map<string, string[]>();
  for (const r of rows) {
    const pid = toStr(r.person_id);
    const name = toStr(r.skill_name);
    if (!pid || !name) continue;
    const arr = out.get(pid) ?? [];
    arr.push(name);
    out.set(pid, arr);
  }
  return out;
}

async function fetchAllPeople(): Promise<Person[]> {
  const rows = await exec(
    `SELECT id, name, title, team,
            COALESCE(pagerank_score, expertise_score, 0) AS influence
       FROM people`,
  );
  const skills = await fetchSkillsByPerson();
  return rows.map<Person>((r) => ({
    id: toStr(r.id),
    name: toStr(r.name),
    title: toStr(r.title),
    department: toStr(r.team),
    skills: skills.get(toStr(r.id)) ?? [],
    influenceScore: clamp01(toNumber(r.influence, 0)),
  }));
}

async function fetchAllEdges(): Promise<Relationship[]> {
  // We currently only model 'collaborates' from Aurora because the schema has
  // no reports_to table. Strengths are taken from the edge `weight` column
  // and clamped to [0,1].
  const collabs = await exec(
    `SELECT person_a_id AS source, person_b_id AS target,
            COALESCE(weight, 1.0) AS w
       FROM collaborations`,
  );

  // Same-project = collaborates. Self-pairs eliminated; one row per unordered pair.
  const projectPairs = await exec(
    `SELECT LEAST(a.person_id, b.person_id) AS source,
            GREATEST(a.person_id, b.person_id) AS target,
            COUNT(*) AS pair_count
       FROM project_contributions a
       JOIN project_contributions b
         ON a.project_id = b.project_id
        AND a.person_id < b.person_id
      GROUP BY 1, 2`,
  );

  const decisionPairs = await exec(
    `SELECT LEAST(a.person_id, b.person_id) AS source,
            GREATEST(a.person_id, b.person_id) AS target,
            COUNT(*) AS pair_count
       FROM decision_participants a
       JOIN decision_participants b
         ON a.decision_id = b.decision_id
        AND a.person_id < b.person_id
      GROUP BY 1, 2`,
  );

  const teamPairs = await exec(
    `SELECT LEAST(a.person_id, b.person_id) AS source,
            GREATEST(a.person_id, b.person_id) AS target,
            COUNT(*) AS pair_count
       FROM team_memberships a
       JOIN team_memberships b
         ON a.team_id = b.team_id
        AND a.person_id < b.person_id
      GROUP BY 1, 2`,
  );

  // Bundle into a single map keyed by canonical edge, summing strength contributions.
  const bundle = new Map<string, { source: string; target: string; strength: number }>();
  const add = (src: string, tgt: string, w: number) => {
    if (!src || !tgt || src === tgt) return;
    const key = edgeKey(src, tgt);
    const a = src < tgt ? src : tgt;
    const b = src < tgt ? tgt : src;
    const cur = bundle.get(key) ?? { source: a, target: b, strength: 0 };
    cur.strength += w;
    bundle.set(key, cur);
  };

  for (const r of collabs) add(toStr(r.source), toStr(r.target), toNumber(r.w, 1));
  for (const r of projectPairs) add(toStr(r.source), toStr(r.target), 0.2 * toNumber(r.pair_count, 1));
  for (const r of decisionPairs) add(toStr(r.source), toStr(r.target), 0.2 * toNumber(r.pair_count, 1));
  for (const r of teamPairs) add(toStr(r.source), toStr(r.target), 0.1 * toNumber(r.pair_count, 1));

  return Array.from(bundle.values()).map<Relationship>((e) => ({
    source: e.source,
    target: e.target,
    type: 'collaborates',
    strength: clamp01(e.strength),
  }));
}

async function realFetchGraph(): Promise<GraphSnapshot> {
  const [nodes, edges] = await Promise.all([fetchAllPeople(), fetchAllEdges()]);
  const departments = departmentsFromTeams(nodes.map((n) => n.department));
  return { nodes, edges, departments };
}

async function realFetchPersonGraph(personId: string): Promise<PersonDetail | null> {
  const rows = await exec(
    `SELECT id, name, title, team,
            COALESCE(pagerank_score, expertise_score, 0) AS influence,
            scored_at::text AS scored_at
       FROM people
      WHERE id = :pid`,
    [strParam('pid', personId)],
  );
  if (rows.length === 0) return null;
  const r = rows[0]!;

  const skillsRows = await exec(
    `SELECT s.name AS skill_name
       FROM person_skills ps
       JOIN skills s ON s.id = ps.skill_id
      WHERE ps.person_id = :pid`,
    [strParam('pid', personId)],
  );

  // All edges touching this person, normalized to (otherId, weight).
  // Collaborations are stored canonically (a<b), so we union both directions.
  const edgeRows = await exec(
    `SELECT CASE WHEN person_a_id = :pid THEN person_b_id ELSE person_a_id END AS other_id,
            COALESCE(weight, 1.0) AS w
       FROM collaborations
      WHERE person_a_id = :pid OR person_b_id = :pid
      UNION ALL
      SELECT b.person_id AS other_id, 0.2 AS w
        FROM project_contributions a
        JOIN project_contributions b ON a.project_id = b.project_id
       WHERE a.person_id = :pid AND b.person_id <> :pid
      UNION ALL
      SELECT b.person_id AS other_id, 0.2 AS w
        FROM decision_participants a
        JOIN decision_participants b ON a.decision_id = b.decision_id
       WHERE a.person_id = :pid AND b.person_id <> :pid
      UNION ALL
      SELECT b.person_id AS other_id, 0.1 AS w
        FROM team_memberships a
        JOIN team_memberships b ON a.team_id = b.team_id
       WHERE a.person_id = :pid AND b.person_id <> :pid`,
    [strParam('pid', personId)],
  );

  // Aggregate by other_id and pull the other person's name/title in one shot.
  const byOther = new Map<string, number>();
  for (const e of edgeRows) {
    const other = toStr(e.other_id);
    if (!other) continue;
    byOther.set(other, (byOther.get(other) ?? 0) + toNumber(e.w, 1));
  }

  const otherIds = Array.from(byOther.keys());
  const others = new Map<string, { id: string; name: string; title: string }>();
  if (otherIds.length > 0) {
    // Build a parameterized IN-list. RDS Data API doesn't support arrays of strings,
    // so emit :p0, :p1, ... and bind each.
    const placeholders = otherIds.map((_, i) => `:p${i}`).join(', ');
    const params = otherIds.map((id, i) => strParam(`p${i}`, id));
    const peopleRows = await exec(
      `SELECT id, name, title FROM people WHERE id IN (${placeholders})`,
      params,
    );
    for (const pr of peopleRows) {
      const id = toStr(pr.id);
      others.set(id, { id, name: toStr(pr.name), title: toStr(pr.title) });
    }
  }

  const connections = Array.from(byOther.entries()).map(([otherId, w]) => ({
    source: personId,
    target: otherId,
    type: 'collaborates' as const,
    strength: clamp01(w),
    otherPerson: others.get(otherId) ?? null,
  }));

  return {
    id: toStr(r.id),
    name: toStr(r.name),
    title: toStr(r.title),
    department: toStr(r.team),
    skills: skillsRows.map((s) => toStr(s.skill_name)).filter(Boolean),
    influenceScore: clamp01(toNumber(r.influence, 0)),
    scoredAt: r.scored_at ?? null,
    connections,
  };
}

async function realGetLeaderboard(opts: { department?: string; limit?: number }): Promise<Leaderboard> {
  const limit = Math.max(1, Math.min(opts.limit ?? 25, 200));
  const params: SqlParameter[] = [
    intParam('lim', limit),
    nullableStrParam('dept', opts.department ?? null),
  ];
  const rows = await exec(
    `SELECT id, name, team,
            COALESCE(pagerank_score, 0) * 100   AS influence,
            COALESCE(expertise_score, 0)         AS expertise,
            COALESCE(composite_score, 0)         AS composite,
            scored_at::text                      AS scored_at
       FROM people
      WHERE (:dept::text IS NULL OR LOWER(team) LIKE LOWER('%' || :dept || '%'))
      ORDER BY composite_score DESC NULLS LAST
      LIMIT :lim`,
    params,
  );
  const entries: ScoreEntry[] = rows.map((r) => ({
    personId: toStr(r.id),
    name: toStr(r.name),
    department: toStr(r.team),
    influence: toNumber(r.influence, 0),
    collaboration: 50,
    expertise: toNumber(r.expertise, 0),
    velocity: 50,
    quality: 50,
    composite: toNumber(r.composite, 0),
    trend: [0, 0, 0, 0, 0, 0, 0],
    scoredAt: r.scored_at ?? null,
  }));
  const nonNullDates = entries.map((e) => e.scoredAt).filter((d): d is string => d !== null);
  const mostRecentScoredAt = nonNullDates.length > 0
    ? nonNullDates.reduce((a, b) => (a > b ? a : b))
    : null;
  return { entries, total: entries.length, mostRecentScoredAt };
}

async function realGetSkillLeaderboard(opts: { skill: string; limit?: number }): Promise<Leaderboard> {
  const limit = Math.max(1, Math.min(opts.limit ?? 25, 100));
  const rows = await exec(
    `SELECT p.id, p.name, p.team,
            COALESCE(p.pagerank_score, 0) * 100 AS influence,
            COALESCE(p.expertise_score, 0)       AS expertise,
            COALESCE(p.composite_score, 0)       AS composite,
            p.scored_at::text                    AS scored_at,
            SUM(ps.weight)                       AS skill_strength
       FROM people p
       JOIN person_skills ps ON p.id = ps.person_id
       JOIN skills s         ON ps.skill_id = s.id
      WHERE LOWER(s.name) = LOWER(:skill)
      GROUP BY p.id, p.name, p.team, p.pagerank_score, p.expertise_score, p.composite_score, p.scored_at
      ORDER BY skill_strength DESC NULLS LAST
      LIMIT :lim`,
    [strParam('skill', opts.skill), intParam('lim', limit)],
  );
  const entries: ScoreEntry[] = rows.map((r) => ({
    personId: toStr(r.id),
    name: toStr(r.name),
    department: toStr(r.team),
    influence: toNumber(r.influence, 0),
    collaboration: 50,
    expertise: toNumber(r.expertise, 0),
    velocity: 50,
    quality: 50,
    composite: toNumber(r.composite, 0),
    trend: [0, 0, 0, 0, 0, 0, 0],
    scoredAt: r.scored_at ?? null,
  }));
  const nonNullDates = entries.map((e) => e.scoredAt).filter((d): d is string => d !== null);
  const mostRecentScoredAt = nonNullDates.length > 0
    ? nonNullDates.reduce((a, b) => (a > b ? a : b))
    : null;
  return { entries, total: entries.length, mostRecentScoredAt };
}

async function realGetTopSkills(limit = 30): Promise<SkillSummary[]> {
  const lim = Math.max(1, Math.min(limit, 100));
  const rows = await exec(
    `SELECT s.id, s.name, COUNT(*) AS mention_count
       FROM skills s
       JOIN person_skills ps ON ps.skill_id = s.id
      GROUP BY s.id, s.name
      ORDER BY mention_count DESC
      LIMIT :lim`,
    [intParam('lim', lim)],
  );
  return rows.map((r) => ({
    id: toStr(r.id),
    name: toStr(r.name),
    mentionCount: toNumber(r.mention_count, 0),
  }));
}

async function realGetScore(personId: string): Promise<ScoreEntry | null> {
  const rows = await exec(
    `SELECT id, name, team,
            COALESCE(pagerank_score, 0) * 100   AS influence,
            COALESCE(expertise_score, 0)         AS expertise,
            COALESCE(composite_score, 0)         AS composite,
            scored_at::text                      AS scored_at
       FROM people
      WHERE id = :pid`,
    [strParam('pid', personId)],
  );
  if (rows.length === 0) return null;
  const r = rows[0]!;
  return {
    personId: toStr(r.id),
    name: toStr(r.name),
    department: toStr(r.team),
    influence: toNumber(r.influence, 0),
    collaboration: 50,
    expertise: toNumber(r.expertise, 0),
    velocity: 50,
    quality: 50,
    composite: toNumber(r.composite, 0),
    trend: [0, 0, 0, 0, 0, 0, 0],
    scoredAt: r.scored_at ?? null,
  };
}

export const realAurora: AuroraProvider = {
  fetchGraph: realFetchGraph,
  fetchPersonGraph: realFetchPersonGraph,
  getLeaderboard: realGetLeaderboard,
  getScore: realGetScore,
  getSkillLeaderboard: realGetSkillLeaderboard,
  getTopSkills: realGetTopSkills,
};

// ─── Mock provider — wraps the existing mock arrays in the AuroraProvider shape.

const mockPeopleByDept = (): Department[] =>
  mockDepartments.map((d) => ({ id: d.id, name: d.name, color: d.color }));

async function mockFetchGraph(): Promise<GraphSnapshot> {
  return {
    nodes: mockPeople as Person[],
    edges: mockRelationships as Relationship[],
    departments: mockPeopleByDept(),
  };
}

async function mockFetchPersonGraph(personId: string): Promise<PersonDetail | null> {
  const p = (mockPeople as Person[]).find((x) => x.id === personId);
  if (!p) return null;
  const peopleById = new Map((mockPeople as Person[]).map((x) => [x.id, x]));
  const connections = (mockRelationships as Relationship[])
    .filter((r) => r.source === personId || r.target === personId)
    .map((r) => {
      const otherId = r.source === personId ? r.target : r.source;
      const other = peopleById.get(otherId);
      return {
        ...r,
        otherPerson: other ? { id: other.id, name: other.name, title: other.title } : null,
      };
    });
  return { ...p, scoredAt: null, connections };
}

async function mockGetLeaderboard(opts: { department?: string; limit?: number }): Promise<Leaderboard> {
  const limit = Math.max(1, Math.min(opts.limit ?? 25, 200));
  let entries = [...mockScores];
  if (opts.department) {
    const needle = opts.department.toLowerCase();
    entries = entries.filter((e) => e.department.toLowerCase().includes(needle));
  }
  entries.sort((a, b) => b.composite - a.composite);
  return { entries: entries.slice(0, limit), total: entries.length, mostRecentScoredAt: null };
}

async function mockGetScore(personId: string): Promise<ScoreEntry | null> {
  return mockScores.find((s) => s.personId === personId) ?? null;
}

async function mockGetSkillLeaderboard(_opts: { skill: string; limit?: number }): Promise<Leaderboard> {
  return { entries: [], total: 0, mostRecentScoredAt: null };
}

async function mockGetTopSkills(_limit?: number): Promise<SkillSummary[]> {
  return [];
}

export const mockAurora: AuroraProvider = {
  fetchGraph: mockFetchGraph,
  fetchPersonGraph: mockFetchPersonGraph,
  getLeaderboard: mockGetLeaderboard,
  getScore: mockGetScore,
  getSkillLeaderboard: mockGetSkillLeaderboard,
  getTopSkills: mockGetTopSkills,
};
