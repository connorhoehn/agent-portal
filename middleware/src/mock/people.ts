import { asFraction, scoreColumnsFor } from './people-scores.js';
import { defineFixture } from './core/index.js';

export interface Person {
  id: string;
  name: string;
  title: string;
  department: string;
  skills: string[];
  influenceScore: number;
  /** people.avatar_url — a portrait URL, or null/absent for initials. */
  avatarUrl?: string | null;
}

/**
 * Who a person IS: the half of a `people` row the graph builder writes, plus
 * the `person_skills` edges beside it. The three score columns the scoring
 * pass writes back live in ./people-scores.ts under the same id, and that
 * file says why they are not on this row.
 */
export type PersonIdentity = Omit<Person, 'influenceScore'>;

export interface Relationship {
  source: string;
  target: string;
  type: 'collaborates' | 'mentors' | 'reports_to' | 'expert_in_common';
  strength: number;
}

// schema/seed.sql is the source of truth for this cast (56 generated people plus the three of the access cast, `people`
// table). Keep this file's ids/names/titles/departments byte-for-byte in sync
// with the seed's `people` rows — this array previously predated the seed and
// drifted to a different 24-person cast, so the same person id (e.g. p-004)
// resolved to two different humans depending which mock endpoint answered.
// skills: sourced from seed.sql's person_skills (joined to skills.name), sorted
// by weight descending. People the seed gives no skills get [] rather than an
// invented list.
export const seededPeople: PersonIdentity[] = [
  { id: 'p-001', name: 'Theo Chang', title: 'Engineer', department: 'Platform Engineering', skills: ['AWS', 'Data Modeling', 'Analytics', 'Docker'] },
  { id: 'p-002', name: 'Vera Green', title: 'Principal Engineer', department: 'Platform Engineering', skills: ['Data Modeling', 'Zero Trust', 'TypeScript'] },
  { id: 'p-003', name: 'Owen Brooks', title: 'Senior Engineer', department: 'Platform Engineering', skills: ['Go', 'Zero Trust', 'IAM'] },
  { id: 'p-004', name: 'Nora DaSilva', title: 'Senior Engineer', department: 'Platform Engineering', skills: ['Linux Internals', 'IAM', 'RAG', 'AWS Security', 'React', 'Rust'] },
  { id: 'p-005', name: 'Sienna Garcia', title: 'Release Manager', department: 'Platform Engineering', skills: ['Terraform', 'Go', 'AWS'] },
  { id: 'p-006', name: 'Maria Johnson', title: 'Principal Engineer', department: 'Platform Engineering', skills: ['Terraform', 'IAM', 'Rust', 'Zero Trust', 'Docker'] },
  { id: 'p-007', name: 'Marcus Müller', title: 'Engineer', department: 'Platform Engineering', skills: ['Linux Internals', 'CI/CD', 'Kubernetes', 'dbt', 'Docker', 'AWS'] },
  { id: 'p-008', name: 'Layla Hassan', title: 'SRE Lead', department: 'Platform Engineering', skills: ['Terraform', 'Zero Trust', 'Docker', 'Penetration Testing', 'Python'] },
  { id: 'p-009', name: 'Arjun Shah', title: 'SRE', department: 'Platform Engineering', skills: ['AWS', 'Kubernetes', 'Observability', 'Linux Internals'] },
  { id: 'p-010', name: 'Kenji Chen', title: 'Staff Engineer', department: 'Platform Engineering', skills: ['Go', 'Java', 'AWS Security'] },
  { id: 'p-011', name: 'Eli Garcia', title: 'Senior SRE', department: 'Platform Engineering', skills: ['Service Mesh', 'AWS', 'Observability', 'Docker'] },
  { id: 'p-012', name: 'Rachel Kowalski', title: 'Principal Engineer', department: 'Platform Engineering', skills: ['Docker', 'Python', 'Observability', 'AWS Security', 'Go'] },
  { id: 'p-013', name: 'Caleb Turner', title: 'Senior Engineer', department: 'Platform Engineering', skills: ['Go', 'Service Mesh', 'IAM', 'AWS', 'Docker'] },
  { id: 'p-014', name: 'Grace Singh', title: 'Senior Engineer', department: 'Platform Engineering', skills: ['Kubernetes', 'TypeScript', 'Service Mesh', 'AWS'] },
  { id: 'p-015', name: 'Raj Mehta', title: 'Data Engineer', department: 'Data Platform', skills: ['Airflow', 'Docker', 'Service Mesh', 'Figma', 'Spark'] },
  { id: 'p-016', name: 'Tara Wright', title: 'Data Analyst', department: 'Data Platform', skills: ['Figma', 'Java', 'Terraform', 'dbt'] },
  { id: 'p-017', name: 'Daniel Chang', title: 'Staff Data Engineer', department: 'Data Platform', skills: ['Snowflake', 'Observability', 'Linux Internals', 'Go', 'Airflow', 'Kafka'] },
  { id: 'p-018', name: 'Yusuf Ahmed', title: 'Data Engineer', department: 'Data Platform', skills: ['Java', 'Go', 'Snowflake', 'Data Modeling'] },
  { id: 'p-019', name: 'Camille Dubois', title: 'Senior Data Engineer', department: 'Data Platform', skills: ['Data Modeling', 'Service Mesh', 'Observability', 'Airflow', 'Docker', 'MLOps'] },
  { id: 'p-020', name: 'Henry Hassan', title: 'Senior Engineer', department: 'Data Platform', skills: ['Python', 'Kubernetes', 'Java', 'SQL', 'Observability', 'CI/CD'] },
  { id: 'p-021', name: 'James Thompson', title: 'Data Engineer', department: 'Data Platform', skills: ['Linux Internals', 'Python', 'Data Modeling'] },
  { id: 'p-022', name: 'Sarah Thompson', title: 'Senior Engineer', department: 'Data Platform', skills: ['Linux Internals', 'Service Mesh', 'Observability', 'Kubernetes', 'Rust', 'SQL'] },
  { id: 'p-023', name: 'Hiro Green', title: 'Data Analyst', department: 'Data Platform', skills: ['SQL', 'Kafka', 'Airflow', 'Analytics'] },
  { id: 'p-024', name: 'Andre Williams', title: 'Staff Engineer', department: 'Data Platform', skills: ['Roadmapping', 'Penetration Testing', 'Product Strategy', 'CI/CD', 'Airflow', 'Linux Internals'] },
  { id: 'p-025', name: 'Anika Mehta', title: 'Principal Engineer', department: 'Data Platform', skills: ['SQL', 'Spark', 'AWS', 'Linux Internals'] },
  { id: 'p-026', name: 'Mateo Green', title: 'Senior UX Researcher', department: 'Product', skills: ['Accessibility', 'Embeddings', 'Zero Trust', 'AWS Security', 'Terraform', 'React'] },
  { id: 'p-027', name: 'Sasha Kim', title: 'UX Researcher', department: 'Product', skills: ['User Research', 'React', 'Storybook'] },
  { id: 'p-028', name: 'Felix Rivera', title: 'UX Researcher', department: 'Product', skills: ['User Research', 'Product Strategy', 'Accessibility', 'Analytics', 'React', 'Storybook'] },
  { id: 'p-029', name: 'Ezra Park', title: 'Senior PM', department: 'Product', skills: ['LLMs', 'Figma', 'Docker'] },
  { id: 'p-030', name: 'Mia Singh', title: 'Group PM', department: 'Product', skills: ['React', 'Figma', 'Accessibility'] },
  { id: 'p-031', name: 'Fatima Ahmed', title: 'Senior PM', department: 'Product', skills: ['Java', 'Observability', 'Storybook'] },
  { id: 'p-032', name: 'Ruth Foster', title: 'Technical Writer', department: 'Product', skills: ['Zero Trust', 'Storybook', 'Linux Internals', 'Accessibility'] },
  { id: 'p-033', name: 'Iris Patel', title: 'Senior PM', department: 'Product', skills: ['Design Tokens', 'Observability', 'User Research', 'Analytics', 'Product Strategy'] },
  { id: 'p-034', name: 'Miles Wright', title: 'Accessibility Specialist', department: 'Design Systems', skills: ['Accessibility', 'CI/CD', 'Storybook', 'Analytics', 'User Research'] },
  { id: 'p-035', name: 'Ben Okafor', title: 'Staff Designer', department: 'Design Systems', skills: ['CI/CD', 'Roadmapping', 'Accessibility', 'User Research', 'Storybook'] },
  { id: 'p-036', name: 'David Tanaka', title: 'Head of Design', department: 'Design Systems', skills: ['Accessibility', 'Product Strategy', 'Roadmapping'] },
  { id: 'p-037', name: 'Oscar Foster', title: 'Senior Designer', department: 'Design Systems', skills: ['TypeScript', 'Accessibility', 'Roadmapping', 'Analytics'] },
  { id: 'p-038', name: 'Isabel Vasquez', title: 'Design Engineer', department: 'Design Systems', skills: ['Design Tokens', 'Go', 'React', 'Analytics'] },
  { id: 'p-039', name: 'Nils Andersson', title: 'Senior Designer', department: 'Design Systems', skills: ['Figma', 'Analytics', 'React'] },
  { id: 'p-040', name: 'Jordan O\'Brien', title: 'Senior Designer', department: 'Design Systems', skills: ['Linux Internals', 'User Research', 'Accessibility'] },
  { id: 'p-041', name: 'Rosa Ahmed', title: 'ML Engineer', department: 'ML / AI', skills: ['Snowflake', 'TypeScript', 'Spark', 'Python', 'Design Tokens'] },
  { id: 'p-042', name: 'Katya Petrov', title: 'Staff ML Engineer', department: 'ML / AI', skills: ['dbt', 'Airflow', 'Storybook', 'AWS Security', 'RAG'] },
  { id: 'p-043', name: 'Bria Petrov', title: 'Staff ML Engineer', department: 'ML / AI', skills: ['Airflow', 'LLMs', 'PyTorch', 'AWS'] },
  { id: 'p-044', name: 'Zoe Thompson', title: 'Staff Engineer', department: 'ML / AI', skills: ['Go', 'MLOps', 'LLMs', 'PyTorch', 'Embeddings'] },
  { id: 'p-045', name: 'Noah Vasquez', title: 'Senior Engineer', department: 'ML / AI', skills: ['LLMs', 'Spark', 'TypeScript', 'RAG', 'Design Tokens'] },
  { id: 'p-046', name: 'Vikram Patel', title: 'Senior Engineer', department: 'ML / AI', skills: ['Java', 'PyTorch', 'Penetration Testing', 'RAG'] },
  { id: 'p-047', name: 'Nina Rivera', title: 'Staff ML Engineer', department: 'ML / AI', skills: ['Kafka', 'LLMs', 'RAG'] },
  { id: 'p-048', name: 'Lucas Kim', title: 'Staff ML Engineer', department: 'ML / AI', skills: ['dbt', 'User Research', 'Accessibility', 'Data Modeling'] },
  { id: 'p-049', name: 'Paolo Mancini', title: 'Engineering Manager', department: 'ML / AI', skills: ['Rust', 'Airflow', 'TypeScript'] },
  { id: 'p-050', name: 'Ava Lee', title: 'Engineer', department: 'ML / AI', skills: ['Embeddings', 'Figma', 'Rust', 'Airflow', 'Go'] },
  { id: 'p-051', name: 'Simone Chang', title: 'Senior Security Engineer', department: 'Security', skills: ['Rust', 'Accessibility', 'TypeScript', 'dbt', 'Java', 'Linux Internals'] },
  { id: 'p-052', name: 'Diego Ortiz', title: 'Security Lead', department: 'Security', skills: ['Penetration Testing', 'Java', 'Terraform', 'Accessibility'] },
  { id: 'p-053', name: 'Ingrid Larsen', title: 'Engineer', department: 'Security', skills: ['Rust', 'Java', 'Go'] },
  { id: 'p-054', name: 'Kevin Garcia', title: 'Senior Engineer', department: 'Security', skills: ['Zero Trust', 'CI/CD', 'Service Mesh', 'Python', 'Linux Internals'] },
  { id: 'p-055', name: 'Joy Chen', title: 'Senior Security Engineer', department: 'Security', skills: ['Terraform', 'TypeScript', 'CI/CD', 'Service Mesh', 'Linux Internals'] },
  { id: 'p-056', name: 'Hugo Lee', title: 'Security Engineer', department: 'Security', skills: ['Kubernetes', 'Storybook', 'Go', 'IAM'] },
  // The access cast (seed.sql's appended block; schema/access_schema.sql links
  // them and sets people.manager_id: Priya manages Omar, Omar manages Rhea).
  { id: 'p-priya', name: 'Priya Venkataraman', title: 'Identity Governance Lead', department: 'Security', skills: ['IAM', 'Zero Trust', 'AWS Security'] },
  { id: 'p-omar', name: 'Omar Haddad', title: 'Engineering Manager', department: 'Security', skills: ['Zero Trust', 'AWS Security', 'Terraform'] },
  { id: 'p-rhea', name: 'Rhea Castellanos', title: 'Security Engineer', department: 'Security', skills: ['Penetration Testing', 'AWS Security', 'IAM', 'Python'] },
];

/**
 * The graph's cast, and the rows every other mock reader joins to by id —
 * mock/scores.ts builds the expertise leaderboard out of exactly these people.
 *
 * `influenceScore` is DERIVED — composite_score as a fraction — never typed.
 * It was a hand-written 0.79 beside a seed that said 79.36, which is right
 * until either moves; and a fixture may not carry a number it could compute
 * from rows it already exports (mock/core/contract.ts, rule 1). The 0–1 scale
 * is the one this field has always used and the one the real provider clamps
 * to (`clamp01` in providers/aurora.ts), so the wire is unchanged.
 */
export const mockPeople: Person[] = seededPeople.map((person): Person => ({
  ...person,
  influenceScore: asFraction(scoreColumnsFor(person.id).compositeScore),
}));

// The seed's `skills` table (38 rows, id/name/domain) lives in
// mock/graph-taxonomy.ts — the one copy every mock reader joins to. Each
// person's `skills: string[]` above is a list of those NAMES. There is
// deliberately no mention count beside a row there: that is a count over
// `seededPeople[].skills`, so it is a selector (providers/aurora.ts's
// `mockGetTopSkills`), never a stored number.


// Mirrors schema/seed.sql's `collaborations` table (WORKED_WITH edges) — the
// seed only models undirected collaboration, so every edge here is
// 'collaborates'; 'mentors'/'reports_to'/'expert_in_common' are left available
// on the type for callers but the seed has no source data for them.
export const mockRelationships: Relationship[] = [
  { source: 'p-003', target: 'p-005', type: 'collaborates', strength: 0.65 },
  { source: 'p-013', target: 'p-014', type: 'collaborates', strength: 0.65 },
  { source: 'p-012', target: 'p-014', type: 'collaborates', strength: 0.78 },
  { source: 'p-029', target: 'p-033', type: 'collaborates', strength: 0.59 },
  { source: 'p-023', target: 'p-025', type: 'collaborates', strength: 0.89 },
  { source: 'p-027', target: 'p-049', type: 'collaborates', strength: 0.64 },
  { source: 'p-018', target: 'p-022', type: 'collaborates', strength: 0.36 },
  { source: 'p-031', target: 'p-046', type: 'collaborates', strength: 0.32 },
  { source: 'p-005', target: 'p-006', type: 'collaborates', strength: 0.83 },
  { source: 'p-001', target: 'p-004', type: 'collaborates', strength: 0.5 },
  { source: 'p-001', target: 'p-013', type: 'collaborates', strength: 0.49 },
  { source: 'p-044', target: 'p-046', type: 'collaborates', strength: 0.68 },
  { source: 'p-022', target: 'p-038', type: 'collaborates', strength: 0.42 },
  { source: 'p-041', target: 'p-048', type: 'collaborates', strength: 0.62 },
  { source: 'p-017', target: 'p-022', type: 'collaborates', strength: 0.82 },
  { source: 'p-050', target: 'p-053', type: 'collaborates', strength: 0.84 },
  { source: 'p-035', target: 'p-039', type: 'collaborates', strength: 0.68 },
  { source: 'p-015', target: 'p-022', type: 'collaborates', strength: 0.38 },
  { source: 'p-026', target: 'p-030', type: 'collaborates', strength: 0.38 },
  { source: 'p-006', target: 'p-033', type: 'collaborates', strength: 0.84 },
  { source: 'p-038', target: 'p-040', type: 'collaborates', strength: 0.88 },
  { source: 'p-007', target: 'p-026', type: 'collaborates', strength: 0.56 },
  { source: 'p-015', target: 'p-031', type: 'collaborates', strength: 0.88 },
  { source: 'p-029', target: 'p-031', type: 'collaborates', strength: 0.33 },
  { source: 'p-047', target: 'p-049', type: 'collaborates', strength: 0.8 },
  { source: 'p-028', target: 'p-040', type: 'collaborates', strength: 0.68 },
  { source: 'p-008', target: 'p-013', type: 'collaborates', strength: 0.99 },
  { source: 'p-045', target: 'p-049', type: 'collaborates', strength: 0.37 },
  { source: 'p-027', target: 'p-028', type: 'collaborates', strength: 0.88 },
  { source: 'p-044', target: 'p-048', type: 'collaborates', strength: 0.83 },
  { source: 'p-049', target: 'p-050', type: 'collaborates', strength: 0.51 },
  { source: 'p-009', target: 'p-039', type: 'collaborates', strength: 1.0 },
  { source: 'p-017', target: 'p-025', type: 'collaborates', strength: 0.61 },
  { source: 'p-037', target: 'p-039', type: 'collaborates', strength: 0.54 },
  { source: 'p-012', target: 'p-013', type: 'collaborates', strength: 0.87 },
  { source: 'p-015', target: 'p-025', type: 'collaborates', strength: 0.61 },
  { source: 'p-001', target: 'p-007', type: 'collaborates', strength: 1.0 },
  { source: 'p-030', target: 'p-032', type: 'collaborates', strength: 0.84 },
  { source: 'p-036', target: 'p-038', type: 'collaborates', strength: 0.47 },
  { source: 'p-005', target: 'p-014', type: 'collaborates', strength: 0.87 },
  { source: 'p-021', target: 'p-022', type: 'collaborates', strength: 0.71 },
  { source: 'p-034', target: 'p-036', type: 'collaborates', strength: 0.55 },
  { source: 'p-042', target: 'p-050', type: 'collaborates', strength: 0.8 },
  { source: 'p-002', target: 'p-008', type: 'collaborates', strength: 0.74 },
  { source: 'p-026', target: 'p-032', type: 'collaborates', strength: 0.42 },
  { source: 'p-041', target: 'p-056', type: 'collaborates', strength: 0.4 },
  { source: 'p-006', target: 'p-009', type: 'collaborates', strength: 0.44 },
  { source: 'p-004', target: 'p-012', type: 'collaborates', strength: 0.44 },
  { source: 'p-008', target: 'p-010', type: 'collaborates', strength: 0.34 },
  { source: 'p-041', target: 'p-044', type: 'collaborates', strength: 0.55 },
  { source: 'p-019', target: 'p-025', type: 'collaborates', strength: 0.5 },
  { source: 'p-005', target: 'p-011', type: 'collaborates', strength: 0.68 },
  { source: 'p-009', target: 'p-012', type: 'collaborates', strength: 0.53 },
  { source: 'p-016', target: 'p-022', type: 'collaborates', strength: 0.79 },
  { source: 'p-022', target: 'p-037', type: 'collaborates', strength: 0.5 },
  { source: 'p-002', target: 'p-005', type: 'collaborates', strength: 0.49 },
  { source: 'p-022', target: 'p-023', type: 'collaborates', strength: 0.9 },
  { source: 'p-041', target: 'p-043', type: 'collaborates', strength: 0.99 },
  { source: 'p-039', target: 'p-040', type: 'collaborates', strength: 0.78 },
  { source: 'p-001', target: 'p-044', type: 'collaborates', strength: 0.37 },
  { source: 'p-002', target: 'p-003', type: 'collaborates', strength: 0.97 },
  { source: 'p-018', target: 'p-036', type: 'collaborates', strength: 0.85 },
  { source: 'p-004', target: 'p-013', type: 'collaborates', strength: 0.94 },
  { source: 'p-003', target: 'p-006', type: 'collaborates', strength: 0.99 },
  { source: 'p-051', target: 'p-054', type: 'collaborates', strength: 0.91 },
  { source: 'p-010', target: 'p-011', type: 'collaborates', strength: 0.39 },
  { source: 'p-044', target: 'p-045', type: 'collaborates', strength: 0.91 },
  { source: 'p-041', target: 'p-050', type: 'collaborates', strength: 0.47 },
  { source: 'p-001', target: 'p-055', type: 'collaborates', strength: 0.8 },
  { source: 'p-027', target: 'p-030', type: 'collaborates', strength: 0.88 },
  { source: 'p-006', target: 'p-051', type: 'collaborates', strength: 0.83 },
  { source: 'p-032', target: 'p-043', type: 'collaborates', strength: 0.77 },
  { source: 'p-017', target: 'p-018', type: 'collaborates', strength: 0.64 },
  { source: 'p-007', target: 'p-009', type: 'collaborates', strength: 0.7 },
  { source: 'p-002', target: 'p-021', type: 'collaborates', strength: 0.49 },
  { source: 'p-015', target: 'p-018', type: 'collaborates', strength: 0.59 },
  { source: 'p-035', target: 'p-038', type: 'collaborates', strength: 0.62 },
  { source: 'p-052', target: 'p-056', type: 'collaborates', strength: 0.74 },
  { source: 'p-047', target: 'p-048', type: 'collaborates', strength: 0.92 },
  { source: 'p-052', target: 'p-053', type: 'collaborates', strength: 0.37 },
  { source: 'p-022', target: 'p-054', type: 'collaborates', strength: 0.66 },
  { source: 'p-043', target: 'p-044', type: 'collaborates', strength: 0.49 },
  { source: 'p-001', target: 'p-003', type: 'collaborates', strength: 0.96 },
  { source: 'p-017', target: 'p-019', type: 'collaborates', strength: 0.56 },
  { source: 'p-007', target: 'p-011', type: 'collaborates', strength: 0.97 },
  { source: 'p-009', target: 'p-010', type: 'collaborates', strength: 0.53 },
  { source: 'p-015', target: 'p-019', type: 'collaborates', strength: 0.3 },
  { source: 'p-001', target: 'p-010', type: 'collaborates', strength: 0.84 },
  { source: 'p-006', target: 'p-007', type: 'collaborates', strength: 0.81 },
  { source: 'p-027', target: 'p-032', type: 'collaborates', strength: 0.81 },
  { source: 'p-022', target: 'p-025', type: 'collaborates', strength: 0.62 },
  { source: 'p-003', target: 'p-009', type: 'collaborates', strength: 0.76 },
  { source: 'p-052', target: 'p-055', type: 'collaborates', strength: 0.55 },
  { source: 'p-034', target: 'p-039', type: 'collaborates', strength: 0.34 },
  { source: 'p-028', target: 'p-029', type: 'collaborates', strength: 0.67 },
  { source: 'p-043', target: 'p-045', type: 'collaborates', strength: 0.45 },
  { source: 'p-034', target: 'p-035', type: 'collaborates', strength: 0.6 },
  { source: 'p-029', target: 'p-032', type: 'collaborates', strength: 0.45 },
  { source: 'p-015', target: 'p-028', type: 'collaborates', strength: 0.49 },
  { source: 'p-028', target: 'p-033', type: 'collaborates', strength: 0.88 },
  { source: 'p-003', target: 'p-011', type: 'collaborates', strength: 0.54 },
  { source: 'p-042', target: 'p-049', type: 'collaborates', strength: 0.7 },
  { source: 'p-053', target: 'p-054', type: 'collaborates', strength: 0.7 },
  { source: 'p-030', target: 'p-040', type: 'collaborates', strength: 0.64 },
  { source: 'p-016', target: 'p-018', type: 'collaborates', strength: 0.54 },
  { source: 'p-002', target: 'p-006', type: 'collaborates', strength: 0.78 },
  { source: 'p-004', target: 'p-008', type: 'collaborates', strength: 0.33 },
  { source: 'p-021', target: 'p-025', type: 'collaborates', strength: 0.37 },
  { source: 'p-035', target: 'p-037', type: 'collaborates', strength: 0.85 },
  { source: 'p-016', target: 'p-019', type: 'collaborates', strength: 0.62 },
  { source: 'p-046', target: 'p-050', type: 'collaborates', strength: 0.39 },
  { source: 'p-010', target: 'p-014', type: 'collaborates', strength: 0.9 },
  { source: 'p-001', target: 'p-008', type: 'collaborates', strength: 0.61 },
  { source: 'p-023', target: 'p-026', type: 'collaborates', strength: 0.3 },
  { source: 'p-020', target: 'p-024', type: 'collaborates', strength: 0.97 },
  { source: 'p-041', target: 'p-042', type: 'collaborates', strength: 0.44 },
  { source: 'p-016', target: 'p-017', type: 'collaborates', strength: 0.78 },
  { source: 'p-004', target: 'p-005', type: 'collaborates', strength: 0.39 },
  { source: 'p-037', target: 'p-040', type: 'collaborates', strength: 0.75 },
  { source: 'p-021', target: 'p-046', type: 'collaborates', strength: 0.41 },
  { source: 'p-054', target: 'p-056', type: 'collaborates', strength: 0.95 },
  { source: 'p-007', target: 'p-014', type: 'collaborates', strength: 0.49 },
  { source: 'p-031', target: 'p-033', type: 'collaborates', strength: 0.76 },
  { source: 'p-007', target: 'p-012', type: 'collaborates', strength: 0.48 },
  { source: 'p-003', target: 'p-007', type: 'collaborates', strength: 0.56 },
  { source: 'p-026', target: 'p-027', type: 'collaborates', strength: 0.93 },
  { source: 'p-002', target: 'p-009', type: 'collaborates', strength: 0.42 },
  { source: 'p-042', target: 'p-046', type: 'collaborates', strength: 0.58 },
  { source: 'p-044', target: 'p-047', type: 'collaborates', strength: 0.51 },
  { source: 'p-032', target: 'p-033', type: 'collaborates', strength: 0.79 },
  { source: 'p-011', target: 'p-012', type: 'collaborates', strength: 0.46 },
  { source: 'p-019', target: 'p-043', type: 'collaborates', strength: 0.76 },
  { source: 'p-044', target: 'p-050', type: 'collaborates', strength: 0.79 },
  { source: 'p-025', target: 'p-033', type: 'collaborates', strength: 0.3 },
  { source: 'p-023', target: 'p-024', type: 'collaborates', strength: 0.63 },
  { source: 'p-006', target: 'p-039', type: 'collaborates', strength: 0.39 },
  { source: 'p-001', target: 'p-002', type: 'collaborates', strength: 0.46 },
  { source: 'p-054', target: 'p-055', type: 'collaborates', strength: 0.78 },
  { source: 'p-020', target: 'p-021', type: 'collaborates', strength: 0.31 },
  { source: 'p-003', target: 'p-014', type: 'collaborates', strength: 0.79 },
  { source: 'p-001', target: 'p-038', type: 'collaborates', strength: 0.87 },
  { source: 'p-037', target: 'p-038', type: 'collaborates', strength: 0.99 },
  { source: 'p-013', target: 'p-023', type: 'collaborates', strength: 0.6 },
  { source: 'p-034', target: 'p-038', type: 'collaborates', strength: 0.39 },
  { source: 'p-042', target: 'p-048', type: 'collaborates', strength: 0.35 },
  { source: 'p-015', target: 'p-017', type: 'collaborates', strength: 0.57 },
  { source: 'p-001', target: 'p-009', type: 'collaborates', strength: 0.81 },
  { source: 'p-029', target: 'p-044', type: 'collaborates', strength: 0.37 },
  { source: 'p-007', target: 'p-013', type: 'collaborates', strength: 0.52 },
  { source: 'p-018', target: 'p-024', type: 'collaborates', strength: 0.92 },
  { source: 'p-027', target: 'p-040', type: 'collaborates', strength: 0.4 },
  { source: 'p-016', target: 'p-021', type: 'collaborates', strength: 0.84 },
  { source: 'p-010', target: 'p-048', type: 'collaborates', strength: 0.83 },
  { source: 'p-011', target: 'p-013', type: 'collaborates', strength: 0.39 },
  { source: 'p-019', target: 'p-021', type: 'collaborates', strength: 1.0 },
  { source: 'p-028', target: 'p-036', type: 'collaborates', strength: 0.4 },
  { source: 'p-038', target: 'p-049', type: 'collaborates', strength: 0.67 },
  { source: 'p-017', target: 'p-024', type: 'collaborates', strength: 0.31 },
  { source: 'p-015', target: 'p-024', type: 'collaborates', strength: 0.76 },
  { source: 'p-043', target: 'p-050', type: 'collaborates', strength: 0.61 },
  { source: 'p-008', target: 'p-009', type: 'collaborates', strength: 0.81 },
  { source: 'p-003', target: 'p-004', type: 'collaborates', strength: 0.74 },
  { source: 'p-003', target: 'p-013', type: 'collaborates', strength: 0.41 },
  { source: 'p-026', target: 'p-029', type: 'collaborates', strength: 0.59 },
  { source: 'p-012', target: 'p-016', type: 'collaborates', strength: 0.78 },
  { source: 'p-052', target: 'p-054', type: 'collaborates', strength: 0.9 },
  { source: 'p-005', target: 'p-024', type: 'collaborates', strength: 0.36 },
  { source: 'p-048', target: 'p-050', type: 'collaborates', strength: 0.37 },
  { source: 'p-019', target: 'p-020', type: 'collaborates', strength: 0.83 },
  { source: 'p-004', target: 'p-006', type: 'collaborates', strength: 0.71 },
  { source: 'p-018', target: 'p-021', type: 'collaborates', strength: 0.57 },
  { source: 'p-020', target: 'p-023', type: 'collaborates', strength: 0.97 },
  { source: 'p-021', target: 'p-024', type: 'collaborates', strength: 0.52 },
  { source: 'p-017', target: 'p-038', type: 'collaborates', strength: 0.4 },
  { source: 'p-028', target: 'p-032', type: 'collaborates', strength: 0.49 },
  { source: 'p-027', target: 'p-031', type: 'collaborates', strength: 0.36 },
  { source: 'p-034', target: 'p-037', type: 'collaborates', strength: 0.69 },
  { source: 'p-035', target: 'p-036', type: 'collaborates', strength: 0.72 },
  { source: 'p-001', target: 'p-006', type: 'collaborates', strength: 0.73 },
  { source: 'p-045', target: 'p-047', type: 'collaborates', strength: 0.85 },
  { source: 'p-030', target: 'p-031', type: 'collaborates', strength: 0.78 },
  { source: 'p-042', target: 'p-043', type: 'collaborates', strength: 0.89 },
  { source: 'p-014', target: 'p-045', type: 'collaborates', strength: 0.76 },
  { source: 'p-002', target: 'p-014', type: 'collaborates', strength: 0.51 },
  { source: 'p-016', target: 'p-023', type: 'collaborates', strength: 0.66 },
  { source: 'p-051', target: 'p-053', type: 'collaborates', strength: 0.66 },
  { source: 'p-002', target: 'p-012', type: 'collaborates', strength: 0.82 },
  { source: 'p-019', target: 'p-023', type: 'collaborates', strength: 0.51 },
  { source: 'p-018', target: 'p-020', type: 'collaborates', strength: 0.34 },
  { source: 'p-042', target: 'p-047', type: 'collaborates', strength: 0.93 },
  { source: 'p-044', target: 'p-049', type: 'collaborates', strength: 0.97 },
  { source: 'p-005', target: 'p-009', type: 'collaborates', strength: 0.65 },
  { source: 'p-017', target: 'p-020', type: 'collaborates', strength: 0.38 },
  { source: 'p-026', target: 'p-028', type: 'collaborates', strength: 0.65 },
  { source: 'p-004', target: 'p-009', type: 'collaborates', strength: 0.72 },
  { source: 'p-051', target: 'p-055', type: 'collaborates', strength: 0.67 },
  { source: 'p-028', target: 'p-034', type: 'collaborates', strength: 0.98 },
  { source: 'p-009', target: 'p-014', type: 'collaborates', strength: 0.99 },
  { source: 'p-038', target: 'p-039', type: 'collaborates', strength: 0.95 },
  { source: 'p-004', target: 'p-011', type: 'collaborates', strength: 0.39 },
  { source: 'p-018', target: 'p-023', type: 'collaborates', strength: 0.9 },
  { source: 'p-019', target: 'p-022', type: 'collaborates', strength: 0.7 },
  { source: 'p-002', target: 'p-004', type: 'collaborates', strength: 0.56 },
  { source: 'p-031', target: 'p-032', type: 'collaborates', strength: 0.78 },
  { source: 'p-022', target: 'p-024', type: 'collaborates', strength: 0.83 },
  { source: 'p-041', target: 'p-045', type: 'collaborates', strength: 0.97 },
  { source: 'p-017', target: 'p-023', type: 'collaborates', strength: 0.84 },
  { source: 'p-001', target: 'p-011', type: 'collaborates', strength: 0.31 },
  { source: 'p-007', target: 'p-047', type: 'collaborates', strength: 0.35 },
  { source: 'p-055', target: 'p-056', type: 'collaborates', strength: 0.48 },
  { source: 'p-041', target: 'p-046', type: 'collaborates', strength: 0.33 },
  { source: 'p-039', target: 'p-045', type: 'collaborates', strength: 0.34 },
  { source: 'p-053', target: 'p-056', type: 'collaborates', strength: 0.85 },
  { source: 'p-008', target: 'p-014', type: 'collaborates', strength: 0.65 },
  { source: 'p-002', target: 'p-010', type: 'collaborates', strength: 0.74 },
  { source: 'p-032', target: 'p-052', type: 'collaborates', strength: 0.65 },
];

// ─── The graph routes' `large` scenario ────────────────────────────────────
//
// `providers/aurora.ts`'s `mockFetch{Graph,SkillsGraph,ProjectsGraph}` are the
// only mock readers that need an inflated cast — every OTHER reader here
// (scores, decisions, work items, roster) joins to the 56 real seeded ids and
// must keep doing so, so this does not touch `mockPeople`/`mockRelationships`
// above. It exists because the real graph route caps at 500 rows
// (`PEOPLE_GRAPH_LIMIT`, providers/aurora.ts) and reports the true count
// beside it as `peopleTotal` — a scenario that never grows the cast past 56
// can never make that cap, or the portal's 200-node canvas cap, actually
// engage.
//
// `LARGE_ROUNDS` clones of the seeded 56 — 56 * 11 = 616, past both caps.
// Each clone keeps its source person's name/title/department/skills/score (a
// modulo over the real cast, not an invented one) and only its id changes;
// the id encodes which round and which seeded person it clones
// (`p-large-<round>-<index>`), so `largeRelationships` below can translate the
// seeded collaboration edges into every round by the same index rather than
// inventing new pairs.
const LARGE_ROUNDS = 11;

function toLargeId(round: number, index: number): string {
  return `p-large-${String(round).padStart(2, '0')}-${String(index + 1).padStart(3, '0')}`;
}

function largePeople(): Person[] {
  const out: Person[] = [];
  for (let round = 0; round < LARGE_ROUNDS; round += 1) {
    seededPeople.forEach((person, index) => {
      out.push({
        ...person,
        id: toLargeId(round, index),
        // Same score the real person carries — an id the scoring pass has
        // never seen (people-scores.ts's UNSCORED fallback) would read as an
        // influence-free cast, which is not what a "busy org" scenario means.
        influenceScore: asFraction(scoreColumnsFor(person.id).compositeScore),
      });
    });
  }
  return out;
}

/**
 * `mockRelationships`, replayed into every `largePeople` round by the same
 * seeded index its endpoints held — so the large graph's edges are the
 * seeded collaboration structure repeated across the cast, never invented.
 */
function largeRelationships(): Relationship[] {
  const indexById = new Map(seededPeople.map((person, index) => [person.id, index]));
  const out: Relationship[] = [];
  for (let round = 0; round < LARGE_ROUNDS; round += 1) {
    for (const rel of mockRelationships) {
      const sourceIndex = indexById.get(rel.source);
      const targetIndex = indexById.get(rel.target);
      if (sourceIndex === undefined || targetIndex === undefined) continue;
      out.push({ ...rel, source: toLargeId(round, sourceIndex), target: toLargeId(round, targetIndex) });
    }
  }
  return out;
}

/** The people the graph routes read. `default` is `mockPeople` itself. */
export const graphPeople = defineFixture<Person>({
  key: 'graph-people',
  scenarios: {
    default: () => mockPeople.slice(),
    large: largePeople,
    // The org graph's node table. Explore renders a graph from it, and a
    // graph with no nodes reads as "this org has nobody" rather than "the
    // read failed" unless the surface is told which it is.
    error: () => { throw new Error('graph_people unavailable: relation does not exist'); },
  },
});

/** The edges the graph routes read, alongside `graphPeople`. */
export const graphRelationships = defineFixture<Relationship>({
  key: 'graph-relationships',
  scenarios: {
    default: () => mockRelationships.slice(),
    large: largeRelationships,
  },
});

// Distinct schema/seed.sql `teams`, in seed order, with a display color per
// department for graph rendering.
export const departments = [
  { id: 'platform-engineering', name: 'Platform Engineering', color: '#2563eb' },
  { id: 'data-platform', name: 'Data Platform', color: '#9333ea' },
  { id: 'product', name: 'Product', color: '#16a34a' },
  { id: 'design-systems', name: 'Design Systems', color: '#ea580c' },
  { id: 'ml-ai', name: 'ML / AI', color: '#0891b2' },
  { id: 'security', name: 'Security', color: '#dc2626' },
];

/**
 * The seed's `teams` rows (schema/seed.sql, six teams, no parents yet) under
 * their SEED ids — what `GET /api/graph/teams?scope=mine` (routes/org-teams.ts)
 * answers from under MOCK_AURORA. Membership is not restated here: the same
 * fact already lives in `people.department` (the `team_memberships` half the
 * parity table reads, mock/core/parity/entities.ts), and a person's team role
 * is their title, so providers/org-teams.ts derives both from `graphPeople`.
 * `departments` above keeps the slug ids the graph canvases colour by; the two
 * are joined by name, the way the parity audit joins them.
 */
export interface OrgTeamRow { id: string; name: string; parentId: string | null }

export const graphTeams = defineFixture<OrgTeamRow>({
  key: 'graph.teams',
  scenarios: {
    default: () => [
      { id: 't-platform', name: 'Platform Engineering', parentId: null },
      { id: 't-data', name: 'Data Platform', parentId: null },
      { id: 't-product', name: 'Product', parentId: null },
      { id: 't-design', name: 'Design Systems', parentId: null },
      { id: 't-ml', name: 'ML / AI', parentId: null },
      { id: 't-security', name: 'Security', parentId: null },
    ],
    empty: () => [],
  },
});
