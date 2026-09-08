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
  BeginTransactionCommand,
  CommitTransactionCommand,
  RollbackTransactionCommand,
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
  CohortStats,
  BrokerSummary,
  RadarResponse,
  RadarAxes,
  RadarBatchEntry,
  ContributionsResponse,
  CollaboratorContribution,
  ProjectContribution,
  DecisionContribution,
  SkillsGraphSnapshot,
  ProjectsGraphSnapshot,
  EvidenceDoc,
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
  if (cell.arrayValue !== undefined) {
    // TEXT[] → string[]
    return cell.arrayValue.stringValues ?? [];
  }
  return null;
}

export async function exec(sql: string, params: SqlParameter[] = [], transactionId?: string): Promise<Record<string, any>[]> {
  const resp = await client().send(
    new ExecuteStatementCommand({
      resourceArn: config.aurora.clusterArn,
      secretArn: config.aurora.secretArn,
      database: config.aurora.database,
      sql,
      parameters: params,
      includeResultMetadata: true,
      ...(transactionId ? { transactionId } : {}),
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

/** The subset of `exec`'s signature a transaction-bound statement needs. */
export type TxExec = (sql: string, params?: SqlParameter[]) => Promise<Record<string, any>[]>;

/**
 * Runs `fn` inside a single RDS Data API transaction: begins one, hands `fn`
 * an `exec`-shaped function that threads the transactionId through every
 * statement it issues, commits on success, and rolls back (best-effort —
 * a rollback failure is swallowed so it never masks the original error)
 * before re-throwing on any error `fn` throws.
 *
 * No other provider in this codebase issues more than one autocommit
 * statement per call (budgets.ts, bots.ts, agent-jobs.ts, assessment-aurora.ts
 * elsewhere) — this is the first seam that needs multi-statement atomicity:
 * assessment.ts's commitSubmissions superseding an existing envelope and
 * inserting its replacement must not be observable half-done.
 */
export async function withTransaction<T>(fn: (tx: TxExec) => Promise<T>): Promise<T> {
  const begun = await client().send(
    new BeginTransactionCommand({
      resourceArn: config.aurora.clusterArn,
      secretArn: config.aurora.secretArn,
      database: config.aurora.database,
    }),
  );
  const transactionId = begun.transactionId;
  if (!transactionId) throw new Error('BeginTransactionCommand did not return a transactionId');

  try {
    const result = await fn((sql, params = []) => exec(sql, params, transactionId));
    await client().send(
      new CommitTransactionCommand({
        resourceArn: config.aurora.clusterArn,
        secretArn: config.aurora.secretArn,
        transactionId,
      }),
    );
    return result;
  } catch (err) {
    try {
      await client().send(
        new RollbackTransactionCommand({
          resourceArn: config.aurora.clusterArn,
          secretArn: config.aurora.secretArn,
          transactionId,
        }),
      );
    } catch {
      // Best-effort — the transaction times out and auto-rolls-back on its
      // own if this fails too; never let a rollback failure hide the real
      // error that triggered it.
    }
    throw err;
  }
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

// ─── Presence generator ─────────────────────────────────────────────────────
// Deterministic per (personId, date) — stable within a calendar day, changes
// nightly. Weekends everyone is 'vacation'. Weekdays: ~40% office, ~30% wfh,
// ~15% pto/vacation, ~10% travel, ~5% sick.

import type { PresenceStatus } from './types.js';

function djb2Presence(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (((h * 33) ^ s.charCodeAt(i)) >>> 0);
  return h;
}

function generatePresence(personId: string): PresenceStatus {
  const now = new Date();
  const dow = now.getDay(); // 0=Sun 6=Sat
  if (dow === 0 || dow === 6) return 'vacation'; // everyone off on weekends

  const dateKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
  const h = djb2Presence(`${personId}:${dateKey}`);
  const bucket = h % 100;
  if (bucket < 40) return 'office';    // 40%
  if (bucket < 70) return 'wfh';       // 30%
  if (bucket < 80) return 'pto';       // 10%
  if (bucket < 88) return 'travel';    // 8%
  if (bucket < 94) return 'vacation';  //  6%
  if (bucket < 98) return 'sick';      //  4%
  return 'unknown';                    //  2%
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
            COALESCE(pagerank_score, expertise_score / 100.0, 0) AS influence
       FROM people`,
  );
  const skills = await fetchSkillsByPerson();
  return rows.map<Person>((r) => {
    const id = toStr(r.id);
    return {
      id,
      name: toStr(r.name),
      title: toStr(r.title),
      department: toStr(r.team),
      skills: skills.get(id) ?? [],
      influenceScore: clamp01(toNumber(r.influence, 0)),
      presence: generatePresence(id),
    };
  });
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

// Derive org-hierarchy edges from title seniority within each team.
// No schema changes needed — uses the existing `people.title` and `people.team` columns.
function titleRank(title: string): number {
  const t = (title ?? '').toLowerCase();
  if (t.includes('principal') || t.includes('director') || t.includes('vp') || t.includes('head')) return 1;
  if (t.includes('staff') || t.includes('lead') || t.includes('manager') || t.includes('architect')) return 2;
  if (t.includes('senior') || t.includes('sr ') || t.includes('sr.')) return 3;
  return 4;
}

function deriveHierarchyEdges(people: Person[]): Relationship[] {
  const byTeam = new Map<string, Person[]>();
  for (const p of people) {
    const team = p.department ?? '_unknown';
    const arr = byTeam.get(team) ?? [];
    arr.push(p);
    byTeam.set(team, arr);
  }

  const edges: Relationship[] = [];
  for (const members of byTeam.values()) {
    if (members.length < 2) continue;
    const sorted = [...members].sort((a, b) => titleRank(a.title ?? '') - titleRank(b.title ?? ''));
    const lead = sorted[0];
    const leadRank = titleRank(lead.title ?? '');

    // reports_to: everyone below lead rank reports to lead
    for (let i = 1; i < sorted.length; i++) {
      if (titleRank(sorted[i].title ?? '') > leadRank) {
        edges.push({ source: sorted[i].id, target: lead.id, type: 'reports_to', strength: 0.75 });
      }
    }

    // mentors: each rank-1/2 person mentors up to 2 of the most-junior members (rank 4)
    const seniors = sorted.filter((p) => titleRank(p.title ?? '') <= 2);
    const juniors = sorted.filter((p) => titleRank(p.title ?? '') === 4);
    seniors.forEach((s, si) => {
      // Round-robin assign 1-2 juniors per senior
      const start = (si * 2) % Math.max(juniors.length, 1);
      const picks = juniors.slice(start, start + 2);
      for (const j of picks) {
        edges.push({ source: s.id, target: j.id, type: 'mentors', strength: 0.55 });
      }
    });
  }

  return edges;
}

async function realFetchGraph(): Promise<GraphSnapshot> {
  const [nodes, edges] = await Promise.all([fetchAllPeople(), fetchAllEdges()]);
  const departments = departmentsFromTeams(nodes.map((n) => n.department));
  return { nodes, edges: [...edges, ...deriveHierarchyEdges(nodes)], departments };
}

async function realFetchSkillsGraph(): Promise<SkillsGraphSnapshot> {
  const [people, skillRows, edgeRows] = await Promise.all([
    fetchAllPeople(),
    exec(
      `SELECT s.id, s.name, COALESCE(s.domain, 'General') AS domain,
              COUNT(ps.person_id) AS person_count
         FROM skills s
         LEFT JOIN person_skills ps ON ps.skill_id = s.id
        GROUP BY s.id, s.name, s.domain`,
    ),
    exec(
      `SELECT ps.person_id, ps.skill_id, COALESCE(ps.weight, 0.5) AS weight
         FROM person_skills ps
         JOIN skills s ON s.id = ps.skill_id`,
    ),
  ]);

  const skills: SkillsGraphSnapshot['skills'] = skillRows.map((r) => ({
    id: `skill:${toStr(r.id)}`,
    name: toStr(r.name),
    domain: toStr(r.domain) || 'General',
    personCount: toNumber(r.person_count, 0),
  }));

  const domainMap = new Map<string, number>();
  for (const s of skills) domainMap.set(s.domain, (domainMap.get(s.domain) ?? 0) + 1);
  const domains: SkillsGraphSnapshot['domains'] = Array.from(domainMap.entries()).map(([name, skillCount]) => ({
    id: `domain:${name}`,
    name,
    skillCount,
  }));

  const personSkillEdges: SkillsGraphSnapshot['personSkillEdges'] = edgeRows.map((r) => ({
    personId: toStr(r.person_id),
    skillId: `skill:${toStr(r.skill_id)}`,
    weight: clamp01(toNumber(r.weight, 0.5)),
  }));

  return { domains, skills, people, personSkillEdges };
}

async function realFetchProjectsGraph(): Promise<ProjectsGraphSnapshot> {
  const [people, projectRows, edgeRows] = await Promise.all([
    fetchAllPeople(),
    exec(
      `SELECT p.id, p.name, COALESCE(p.status, 'active') AS status,
              COUNT(pc.person_id) AS contributor_count
         FROM projects p
         LEFT JOIN project_contributions pc ON pc.project_id = p.id
        GROUP BY p.id, p.name, p.status`,
    ),
    exec(
      `SELECT pc.person_id, pc.project_id, COALESCE(pc.weight, 0.5) AS weight
         FROM project_contributions pc`,
    ),
  ]);

  const projects: ProjectsGraphSnapshot['projects'] = projectRows.map((r) => ({
    id: `proj:${toStr(r.id)}`,
    name: toStr(r.name),
    status: toStr(r.status) || 'active',
    contributorCount: toNumber(r.contributor_count, 0),
  }));

  const personProjectEdges: ProjectsGraphSnapshot['personProjectEdges'] = edgeRows.map((r) => ({
    personId: toStr(r.person_id),
    projectId: `proj:${toStr(r.project_id)}`,
    weight: clamp01(toNumber(r.weight, 0.5)),
  }));

  return { projects, people, personProjectEdges };
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

async function realGetCohorts(): Promise<CohortStats[]> {
  // ── 1. Per-department aggregates ────────────────────────────────────────────
  const aggRows = await exec(
    `SELECT team,
            COUNT(*) AS cnt,
            AVG(COALESCE(composite_score, 0)) AS mean_composite,
            PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY COALESCE(composite_score, 0)) AS median_composite,
            SUM(CASE WHEN COALESCE(composite_score, 0) < 20  THEN 1 ELSE 0 END) AS b0,
            SUM(CASE WHEN COALESCE(composite_score, 0) >= 20
                      AND COALESCE(composite_score, 0) < 40  THEN 1 ELSE 0 END) AS b1,
            SUM(CASE WHEN COALESCE(composite_score, 0) >= 40
                      AND COALESCE(composite_score, 0) < 60  THEN 1 ELSE 0 END) AS b2,
            SUM(CASE WHEN COALESCE(composite_score, 0) >= 60
                      AND COALESCE(composite_score, 0) < 80  THEN 1 ELSE 0 END) AS b3,
            SUM(CASE WHEN COALESCE(composite_score, 0) >= 80  THEN 1 ELSE 0 END) AS b4
       FROM people
      WHERE team IS NOT NULL AND team <> ''
      GROUP BY team
      ORDER BY team`,
  );

  // ── 2. Gini coefficients per department ─────────────────────────────────────
  const giniRows = await exec(
    `WITH ranked AS (
       SELECT team, expertise_score,
              ROW_NUMBER() OVER (PARTITION BY team ORDER BY expertise_score) AS rn,
              COUNT(*) OVER (PARTITION BY team) AS n,
              SUM(expertise_score) OVER (PARTITION BY team) AS total
         FROM people
        WHERE expertise_score IS NOT NULL AND team IS NOT NULL AND team <> ''
     )
     SELECT team,
            MAX(n) AS n,
            MAX(total) AS total,
            (2.0 * SUM(rn * expertise_score)) / NULLIF(MAX(n) * MAX(total), 0)
              - (MAX(n) + 1.0) / NULLIF(MAX(n), 0) AS gini
       FROM ranked
      GROUP BY team`,
  );
  const giniByDept = new Map<string, number>();
  for (const r of giniRows) {
    const dept = toStr(r.team);
    const n = toNumber(r.n, 0);
    const total = toNumber(r.total, 0);
    const gini = n < 2 || total === 0 ? 0 : Math.max(0, Math.min(1, toNumber(r.gini, 0)));
    giniByDept.set(dept, gini);
  }

  // ── 3. Broker detection ─────────────────────────────────────────────────────
  // Top-3 collaborators per person (by weight DESC); broker = top-3 from ≥3 distinct depts.
  const brokerRows = await exec(
    `WITH top3 AS (
       SELECT c.person_a_id AS person_id,
              p2.team AS collab_team,
              ROW_NUMBER() OVER (
                PARTITION BY c.person_a_id
                ORDER BY c.weight DESC NULLS LAST
              ) AS rn
         FROM collaborations c
         JOIN people p2 ON p2.id = c.person_b_id
        WHERE p2.team IS NOT NULL AND p2.team <> ''
       UNION ALL
       SELECT c.person_b_id AS person_id,
              p2.team AS collab_team,
              ROW_NUMBER() OVER (
                PARTITION BY c.person_b_id
                ORDER BY c.weight DESC NULLS LAST
              ) AS rn
         FROM collaborations c
         JOIN people p2 ON p2.id = c.person_a_id
        WHERE p2.team IS NOT NULL AND p2.team <> ''
     ),
     filtered AS (
       SELECT person_id, collab_team FROM top3 WHERE rn <= 3
     ),
     broker_check AS (
       SELECT person_id, COUNT(DISTINCT collab_team) AS dept_count
         FROM filtered
        GROUP BY person_id
       HAVING COUNT(DISTINCT collab_team) >= 3
     )
     SELECT p.id, p.name, p.team, bc.dept_count
       FROM broker_check bc
       JOIN people p ON p.id = bc.person_id
      WHERE p.team IS NOT NULL AND p.team <> ''
      ORDER BY p.team, bc.dept_count DESC`,
  );
  const brokersByDept = new Map<string, BrokerSummary[]>();
  for (const r of brokerRows) {
    const dept = toStr(r.team);
    const list = brokersByDept.get(dept) ?? [];
    list.push({ id: toStr(r.id), name: toStr(r.name), departmentsTouched: toNumber(r.dept_count, 3) });
    brokersByDept.set(dept, list);
  }

  // ── 4. Assemble ─────────────────────────────────────────────────────────────
  return aggRows.map<CohortStats>((r) => {
    const dept = toStr(r.team);
    return {
      department: dept,
      count: toNumber(r.cnt, 0),
      medianComposite: toNumber(r.median_composite, 0),
      meanComposite: toNumber(r.mean_composite, 0),
      compositeBuckets: [
        toNumber(r.b0, 0),
        toNumber(r.b1, 0),
        toNumber(r.b2, 0),
        toNumber(r.b3, 0),
        toNumber(r.b4, 0),
      ],
      expertiseGini: giniByDept.get(dept) ?? 0,
      brokers: brokersByDept.get(dept) ?? [],
    };
  });
}

async function realGetPersonRadar(personId: string): Promise<RadarResponse | null> {
  // Single round-trip: compute per-person aggregates for everyone, then select
  // the requested person's row and the population max in one query.
  const rows = await exec(
    `WITH stats AS (
       SELECT
         p.id                                                         AS person_id,
         COALESCE(p.pagerank_score, 0) * 100                          AS influence,
         COALESCE(p.expertise_score, 0)                               AS expertise,
         COUNT(DISTINCT CASE
           WHEN c.person_a_id = p.id THEN c.person_b_id
           WHEN c.person_b_id = p.id THEN c.person_a_id
         END)                                                         AS collaboration_breadth,
         COUNT(DISTINCT dp.decision_id)                               AS decision_impact,
         COUNT(DISTINCT o.team)                                       AS cross_team_reach,
         COUNT(DISTINCT CASE
           WHEN c2.last_seen > NOW() - INTERVAL '30 days'
             AND (c2.person_a_id = p.id OR c2.person_b_id = p.id)
           THEN CASE
             WHEN c2.person_a_id = p.id THEN c2.person_b_id
             ELSE c2.person_a_id
           END
         END)                                                         AS recency
       FROM people p
       LEFT JOIN collaborations c
         ON c.person_a_id = p.id OR c.person_b_id = p.id
       LEFT JOIN decision_participants dp
         ON dp.person_id = p.id
       LEFT JOIN collaborations c2
         ON c2.person_a_id = p.id OR c2.person_b_id = p.id
       LEFT JOIN people o
         ON o.id = CASE
           WHEN c.person_a_id = p.id THEN c.person_b_id
           WHEN c.person_b_id = p.id THEN c.person_a_id
           ELSE NULL
         END
       WHERE p.composite_score IS NOT NULL
       GROUP BY p.id
     )
     SELECT 'person' AS kind, person_id, influence, expertise,
            collaboration_breadth, decision_impact, cross_team_reach, recency
       FROM stats
      WHERE person_id = :pid
     UNION ALL
     SELECT 'max' AS kind, NULL AS person_id,
            MAX(influence), MAX(expertise),
            MAX(collaboration_breadth), MAX(decision_impact),
            MAX(cross_team_reach), MAX(recency)
       FROM stats`,
    [strParam('pid', personId)],
  );

  const personRow = rows.find((r) => r['kind'] === 'person');
  const maxRow = rows.find((r) => r['kind'] === 'max');
  if (!personRow) return null;

  const toAxes = (r: Record<string, unknown>): RadarAxes => ({
    influence: toNumber(r['influence'], 0),
    expertise: toNumber(r['expertise'], 0),
    collaborationBreadth: toNumber(r['collaboration_breadth'], 0),
    decisionImpact: toNumber(r['decision_impact'], 0),
    crossTeamReach: toNumber(r['cross_team_reach'], 0),
    recency: toNumber(r['recency'], 0),
  });

  return {
    personId,
    person: toAxes(personRow),
    peerMax: maxRow ? toAxes(maxRow) : toAxes(personRow),
  };
}

async function realGetRadarBatch(personIds: string[]): Promise<RadarBatchEntry[]> {
  if (personIds.length === 0) return [];

  // Build parameterized IN-list for the requested person IDs.
  const placeholders = personIds.map((_, i) => `:p${i}`).join(', ');
  const idParams = personIds.map((id, i) => strParam(`p${i}`, id));

  const rows = await exec(
    `WITH stats AS (
       SELECT
         p.id                                                         AS person_id,
         p.name                                                       AS person_name,
         COALESCE(p.pagerank_score, 0) * 100                          AS influence,
         COALESCE(p.expertise_score, 0)                               AS expertise,
         COUNT(DISTINCT CASE
           WHEN c.person_a_id = p.id THEN c.person_b_id
           WHEN c.person_b_id = p.id THEN c.person_a_id
         END)                                                         AS collaboration_breadth,
         COUNT(DISTINCT dp.decision_id)                               AS decision_impact,
         COUNT(DISTINCT o.team)                                       AS cross_team_reach,
         COUNT(DISTINCT CASE
           WHEN c2.last_seen > NOW() - INTERVAL '30 days'
             AND (c2.person_a_id = p.id OR c2.person_b_id = p.id)
           THEN CASE
             WHEN c2.person_a_id = p.id THEN c2.person_b_id
             ELSE c2.person_a_id
           END
         END)                                                         AS recency
       FROM people p
       LEFT JOIN collaborations c
         ON c.person_a_id = p.id OR c.person_b_id = p.id
       LEFT JOIN decision_participants dp
         ON dp.person_id = p.id
       LEFT JOIN collaborations c2
         ON c2.person_a_id = p.id OR c2.person_b_id = p.id
       LEFT JOIN people o
         ON o.id = CASE
           WHEN c.person_a_id = p.id THEN c.person_b_id
           WHEN c.person_b_id = p.id THEN c.person_a_id
           ELSE NULL
         END
       WHERE p.composite_score IS NOT NULL
       GROUP BY p.id, p.name
     ),
     pop_max AS (
       SELECT
         MAX(influence)             AS max_influence,
         MAX(expertise)             AS max_expertise,
         MAX(collaboration_breadth) AS max_collaboration_breadth,
         MAX(decision_impact)       AS max_decision_impact,
         MAX(cross_team_reach)      AS max_cross_team_reach,
         MAX(recency)               AS max_recency
       FROM stats
     )
     SELECT s.person_id, s.person_name,
            s.influence, s.expertise,
            s.collaboration_breadth, s.decision_impact,
            s.cross_team_reach, s.recency,
            pm.max_influence, pm.max_expertise,
            pm.max_collaboration_breadth, pm.max_decision_impact,
            pm.max_cross_team_reach, pm.max_recency
       FROM stats s
       CROSS JOIN pop_max pm
      WHERE s.person_id IN (${placeholders})`,
    idParams,
  );

  return rows.map<RadarBatchEntry>((r) => ({
    personId: toStr(r['person_id']),
    name: toStr(r['person_name']),
    person: {
      influence: toNumber(r['influence'], 0),
      expertise: toNumber(r['expertise'], 0),
      collaborationBreadth: toNumber(r['collaboration_breadth'], 0),
      decisionImpact: toNumber(r['decision_impact'], 0),
      crossTeamReach: toNumber(r['cross_team_reach'], 0),
      recency: toNumber(r['recency'], 0),
    },
    peerMax: {
      influence: toNumber(r['max_influence'], 0),
      expertise: toNumber(r['max_expertise'], 0),
      collaborationBreadth: toNumber(r['max_collaboration_breadth'], 0),
      decisionImpact: toNumber(r['max_decision_impact'], 0),
      crossTeamReach: toNumber(r['max_cross_team_reach'], 0),
      recency: toNumber(r['max_recency'], 0),
    },
  }));
}

async function realFetchPersonEvidence(personId: string): Promise<EvidenceDoc[]> {
  const rows = await exec(
    `SELECT d.id, d.title, d.source, d.source_uri,
            d.ingested_at::text AS ingested_at, m.count
       FROM mentions m
       JOIN documents d ON d.id = m.document_id
      WHERE m.entity_type = 'person' AND m.entity_id = :pid
      ORDER BY m.count DESC, d.ingested_at DESC
      LIMIT 12`,
    [strParam('pid', personId)],
  );
  return rows.map((r) => ({
    id: toStr(r['id']),
    title: toStr(r['title'], '(untitled)'),
    source: toStr(r['source']),
    sourceUri: r['source_uri'] != null ? toStr(r['source_uri']) : null,
    ingestedAt: r['ingested_at'] != null ? toStr(r['ingested_at']) : null,
    mentionCount: toNumber(r['count'], 1),
  }));
}

export const realAurora: AuroraProvider = {
  fetchGraph: realFetchGraph,
  fetchSkillsGraph: realFetchSkillsGraph,
  fetchProjectsGraph: realFetchProjectsGraph,
  fetchPersonGraph: realFetchPersonGraph,
  getLeaderboard: realGetLeaderboard,
  getScore: realGetScore,
  getSkillLeaderboard: realGetSkillLeaderboard,
  getTopSkills: realGetTopSkills,
  getCohorts: realGetCohorts,
  getPersonRadar: realGetPersonRadar,
  getRadarBatch: realGetRadarBatch,
  getContributions: realGetContributions,
  fetchPersonEvidence: realFetchPersonEvidence,
};

async function realGetContributions(personId: string): Promise<ContributionsResponse | null> {
  const check = await exec(
    `SELECT id FROM people WHERE id = :pid`,
    [strParam('pid', personId)],
  );
  if (check.length === 0) return null;

  const [collabRows, projectRows, decisionRows] = await Promise.all([
    exec(
      `SELECT CASE WHEN c.person_a_id = :pid THEN c.person_b_id ELSE c.person_a_id END AS other_id,
              o.name AS other_name,
              COALESCE(c.weight, 1.0) AS weight
         FROM collaborations c
         JOIN people o ON o.id = CASE WHEN c.person_a_id = :pid THEN c.person_b_id ELSE c.person_a_id END
        WHERE c.person_a_id = :pid OR c.person_b_id = :pid
        ORDER BY c.weight DESC
        LIMIT 3`,
      [strParam('pid', personId)],
    ),
    exec(
      `SELECT pc.role, COALESCE(pc.weight, 1.0) AS weight, p.name
         FROM project_contributions pc
         JOIN projects p ON p.id = pc.project_id
        WHERE pc.person_id = :pid
        ORDER BY pc.weight DESC
        LIMIT 3`,
      [strParam('pid', personId)],
    ),
    exec(
      `SELECT dp.role, COALESCE(dp.weight, 1.0) AS weight, d.topic
         FROM decision_participants dp
         JOIN decisions d ON d.id = dp.decision_id
        WHERE dp.person_id = :pid
        ORDER BY dp.weight DESC
        LIMIT 3`,
      [strParam('pid', personId)],
    ),
  ]);

  const collaborators: CollaboratorContribution[] = collabRows.map((r) => ({
    otherId: toStr(r['other_id']),
    otherName: toStr(r['other_name']),
    weight: toNumber(r['weight'], 1),
  }));
  const projects: ProjectContribution[] = projectRows.map((r) => ({
    projectName: toStr(r['name']),
    role: r['role'] !== null && r['role'] !== undefined ? toStr(r['role']) : null,
    weight: toNumber(r['weight'], 1),
  }));
  const decisions: DecisionContribution[] = decisionRows.map((r) => ({
    topic: toStr(r['topic']),
    role: r['role'] !== null && r['role'] !== undefined ? toStr(r['role']) : null,
    weight: toNumber(r['weight'], 1),
  }));

  return { personId, collaborators, projects, decisions };
}

// ─── Mock provider — wraps the existing mock arrays in the AuroraProvider shape.

const mockPeopleByDept = (): Department[] =>
  mockDepartments.map((d) => ({ id: d.id, name: d.name, color: d.color }));

async function mockFetchGraph(): Promise<GraphSnapshot> {
  const nodes = (mockPeople as Person[]).map(p => ({
    ...p,
    presence: generatePresence(p.id),
  }));
  return {
    nodes,
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

async function mockGetCohorts(): Promise<CohortStats[]> {
  // Build cohort stats from the in-memory mock data.
  const deptMap = new Map<string, typeof mockScores>();
  for (const s of mockScores) {
    const list = deptMap.get(s.department) ?? [];
    list.push(s);
    deptMap.set(s.department, list);
  }

  const results: CohortStats[] = [];
  for (const [dept, entries] of deptMap) {
    const sorted = [...entries].sort((a, b) => a.composite - b.composite);
    const n = sorted.length;
    const mean = entries.reduce((sum, e) => sum + e.composite, 0) / n;
    const median =
      n % 2 === 0
        ? ((sorted[n / 2 - 1]?.composite ?? 0) + (sorted[n / 2]?.composite ?? 0)) / 2
        : (sorted[Math.floor(n / 2)]?.composite ?? 0);

    const bucket = (v: number): number => {
      if (v < 20) return 0;
      if (v < 40) return 1;
      if (v < 60) return 2;
      if (v < 80) return 3;
      return 4;
    };
    const compositeBuckets: [number, number, number, number, number] = [0, 0, 0, 0, 0];
    for (const e of entries) compositeBuckets[bucket(e.composite)]++;

    // Gini on expertise_score within dept.
    const expertiseVals = [...entries].map((e) => e.expertise).sort((a, b) => a - b);
    const total = expertiseVals.reduce((s, v) => s + v, 0);
    let gini = 0;
    if (expertiseVals.length >= 2 && total > 0) {
      const weightedSum = expertiseVals.reduce((s, v, i) => s + (i + 1) * v, 0);
      gini = Math.max(0, (2 * weightedSum) / (n * total) - (n + 1) / n);
    }

    // Mock brokers: people in this dept that collaborate outside it.
    // Use mockRelationships to find cross-dept connections.
    const mockPeopleById = new Map((mockPeople as Person[]).map((p) => [p.id, p]));
    const deptPeople = (mockPeople as Person[]).filter((p) => p.department === dept);
    const brokers: BrokerSummary[] = [];
    for (const person of deptPeople) {
      const connected = (mockRelationships as Array<{ source: string; target: string }>)
        .filter((r) => r.source === person.id || r.target === person.id)
        .map((r) => (r.source === person.id ? r.target : r.source));
      const connectedDepts = new Set(
        connected
          .map((id) => mockPeopleById.get(id)?.department)
          .filter((d): d is string => !!d && d !== dept),
      );
      if (connectedDepts.size >= 3) {
        brokers.push({ id: person.id, name: person.name, departmentsTouched: connectedDepts.size });
      }
    }

    results.push({ department: dept, count: n, medianComposite: median, meanComposite: mean, compositeBuckets, expertiseGini: gini, brokers });
  }

  return results.sort((a, b) => a.department.localeCompare(b.department));
}

async function mockGetPersonRadar(_personId: string): Promise<RadarResponse | null> {
  return null;
}

async function mockGetRadarBatch(_personIds: string[]): Promise<RadarBatchEntry[]> {
  return [];
}

export const mockAurora: AuroraProvider = {
  fetchGraph: mockFetchGraph,
  fetchSkillsGraph: async () => ({ domains: [], skills: [], people: [], personSkillEdges: [] }),
  fetchProjectsGraph: async () => ({ projects: [], people: [], personProjectEdges: [] }),
  fetchPersonGraph: mockFetchPersonGraph,
  getLeaderboard: mockGetLeaderboard,
  getScore: mockGetScore,
  getSkillLeaderboard: mockGetSkillLeaderboard,
  getTopSkills: mockGetTopSkills,
  getCohorts: mockGetCohorts,
  getPersonRadar: mockGetPersonRadar,
  getRadarBatch: mockGetRadarBatch,
  getContributions: mockGetContributions,
  fetchPersonEvidence: async () => [],
};

async function mockGetContributions(_personId: string): Promise<ContributionsResponse | null> {
  return null;
}
