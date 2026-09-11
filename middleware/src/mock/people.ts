import { asFraction, scoreColumnsFor } from './people-scores.js';

export interface Person {
  id: string;
  name: string;
  title: string;
  department: string;
  skills: string[];
  influenceScore: number;
  imageUrl?: string;
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

// schema/seed.sql is the source of truth for this cast (56 people, `people`
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
  { id: 'p-003', name: 'Marcus O\'Brien', title: 'Senior Engineer', department: 'Platform Engineering', skills: ['Go', 'Zero Trust', 'IAM'] },
  { id: 'p-004', name: 'Nora DaSilva', title: 'Senior Engineer', department: 'Platform Engineering', skills: ['Linux Internals', 'IAM', 'RAG', 'AWS Security', 'React', 'Rust'] },
  { id: 'p-005', name: 'Sienna Garcia', title: 'Engineer', department: 'Platform Engineering', skills: ['Terraform', 'Go', 'AWS'] },
  { id: 'p-006', name: 'Maria Johnson', title: 'Principal Engineer', department: 'Platform Engineering', skills: ['Terraform', 'IAM', 'Rust', 'Zero Trust', 'Docker'] },
  { id: 'p-007', name: 'Marcus Müller', title: 'Engineer', department: 'Platform Engineering', skills: ['Linux Internals', 'CI/CD', 'Kubernetes', 'dbt', 'Docker', 'AWS'] },
  { id: 'p-008', name: 'Layla Hassan', title: 'SRE Lead', department: 'Platform Engineering', skills: ['Terraform', 'Zero Trust', 'Docker', 'Penetration Testing', 'Python'] },
  { id: 'p-009', name: 'Marcus Shah', title: 'SRE', department: 'Platform Engineering', skills: ['AWS', 'Kubernetes', 'Observability', 'Linux Internals'] },
  { id: 'p-010', name: 'Tara Chen', title: 'Staff Engineer', department: 'Platform Engineering', skills: ['Go', 'Java', 'AWS Security'] },
  { id: 'p-011', name: 'Eli Garcia', title: 'Senior SRE', department: 'Platform Engineering', skills: ['Service Mesh', 'AWS', 'Observability', 'Docker'] },
  { id: 'p-012', name: 'Rachel Kowalski', title: 'Principal Engineer', department: 'Platform Engineering', skills: ['Docker', 'Python', 'Observability', 'AWS Security', 'Go'] },
  { id: 'p-013', name: 'Caleb Turner', title: 'Senior Engineer', department: 'Platform Engineering', skills: ['Go', 'Service Mesh', 'IAM', 'AWS', 'Docker'] },
  { id: 'p-014', name: 'Sarah Singh', title: 'Senior Engineer', department: 'Platform Engineering', skills: ['Kubernetes', 'TypeScript', 'Service Mesh', 'AWS'] },
  { id: 'p-015', name: 'Raj Mehta', title: 'Data Engineer', department: 'Data Platform', skills: ['Airflow', 'Docker', 'Service Mesh', 'Figma', 'Spark'] },
  { id: 'p-016', name: 'Tara Wright', title: 'Data Analyst', department: 'Data Platform', skills: ['Figma', 'Java', 'Terraform', 'dbt'] },
  { id: 'p-017', name: 'Daniel Chang', title: 'Staff Data Engineer', department: 'Data Platform', skills: ['Snowflake', 'Observability', 'Linux Internals', 'Go', 'Airflow', 'Kafka'] },
  { id: 'p-018', name: 'Sarah Ahmed', title: 'Data Engineer', department: 'Data Platform', skills: ['Java', 'Go', 'Snowflake', 'Data Modeling'] },
  { id: 'p-019', name: 'Lena Dubois', title: 'Senior Data Engineer', department: 'Data Platform', skills: ['Data Modeling', 'Service Mesh', 'Observability', 'Airflow', 'Docker', 'MLOps'] },
  { id: 'p-020', name: 'Henry Hassan', title: 'Senior Engineer', department: 'Data Platform', skills: ['Python', 'Kubernetes', 'Java', 'SQL', 'Observability', 'CI/CD'] },
  { id: 'p-021', name: 'James Thompson', title: 'Data Engineer', department: 'Data Platform', skills: ['Linux Internals', 'Python', 'Data Modeling'] },
  { id: 'p-022', name: 'Sarah Thompson', title: 'Senior Engineer', department: 'Data Platform', skills: ['Linux Internals', 'Service Mesh', 'Observability', 'Kubernetes', 'Rust', 'SQL'] },
  { id: 'p-023', name: 'Hiro Green', title: 'Data Analyst', department: 'Data Platform', skills: ['SQL', 'Kafka', 'Airflow', 'Analytics'] },
  { id: 'p-024', name: 'Theo Williams', title: 'Staff Engineer', department: 'Data Platform', skills: ['Roadmapping', 'Penetration Testing', 'Product Strategy', 'CI/CD', 'Airflow', 'Linux Internals'] },
  { id: 'p-025', name: 'Aisha Mehta', title: 'Principal Engineer', department: 'Data Platform', skills: ['SQL', 'Spark', 'AWS', 'Linux Internals'] },
  { id: 'p-026', name: 'Mateo Green', title: 'Senior UX Researcher', department: 'Product', skills: ['Accessibility', 'Embeddings', 'Zero Trust', 'AWS Security', 'Terraform', 'React'] },
  { id: 'p-027', name: 'Sasha Kim', title: 'UX Researcher', department: 'Product', skills: ['User Research', 'React', 'Storybook'] },
  { id: 'p-028', name: 'Theo Rivera', title: 'UX Researcher', department: 'Product', skills: ['User Research', 'Product Strategy', 'Accessibility', 'Analytics', 'React', 'Storybook'] },
  { id: 'p-029', name: 'Ezra Park', title: 'Senior PM', department: 'Product', skills: ['LLMs', 'Figma', 'Docker'] },
  { id: 'p-030', name: 'Mia Singh', title: 'Group PM', department: 'Product', skills: ['React', 'Figma', 'Accessibility'] },
  { id: 'p-031', name: 'Sasha Ahmed', title: 'Senior PM', department: 'Product', skills: ['Java', 'Observability', 'Storybook'] },
  { id: 'p-032', name: 'Nora Foster', title: 'Technical Writer', department: 'Product', skills: ['Zero Trust', 'Storybook', 'Linux Internals', 'Accessibility'] },
  { id: 'p-033', name: 'Iris Patel', title: 'Senior PM', department: 'Product', skills: ['Design Tokens', 'Observability', 'User Research', 'Analytics', 'Product Strategy'] },
  { id: 'p-034', name: 'Asher Wright', title: 'Accessibility Specialist', department: 'Design Systems', skills: ['Accessibility', 'CI/CD', 'Storybook', 'Analytics', 'User Research'] },
  { id: 'p-035', name: 'Ben Okafor', title: 'Staff Designer', department: 'Design Systems', skills: ['CI/CD', 'Roadmapping', 'Accessibility', 'User Research', 'Storybook'] },
  { id: 'p-036', name: 'David Tanaka', title: 'Head of Design', department: 'Design Systems', skills: ['Accessibility', 'Product Strategy', 'Roadmapping'] },
  { id: 'p-037', name: 'Hugo Foster', title: 'Senior Designer', department: 'Design Systems', skills: ['TypeScript', 'Accessibility', 'Roadmapping', 'Analytics'] },
  { id: 'p-038', name: 'Isabel Vasquez', title: 'Design Engineer', department: 'Design Systems', skills: ['Design Tokens', 'Go', 'React', 'Analytics'] },
  { id: 'p-039', name: 'Hugo Andersson', title: 'Senior Designer', department: 'Design Systems', skills: ['Figma', 'Analytics', 'React'] },
  { id: 'p-040', name: 'Jordan O\'Brien', title: 'Senior Designer', department: 'Design Systems', skills: ['Linux Internals', 'User Research', 'Accessibility'] },
  { id: 'p-041', name: 'Vera Ahmed', title: 'ML Engineer', department: 'ML / AI', skills: ['Snowflake', 'TypeScript', 'Spark', 'Python', 'Design Tokens'] },
  { id: 'p-042', name: 'Vera Petrov', title: 'Staff ML Engineer', department: 'ML / AI', skills: ['dbt', 'Airflow', 'Storybook', 'AWS Security', 'RAG'] },
  { id: 'p-043', name: 'Bria Petrov', title: 'Staff ML Engineer', department: 'ML / AI', skills: ['Airflow', 'LLMs', 'PyTorch', 'AWS'] },
  { id: 'p-044', name: 'Aisha Thompson', title: 'Staff Engineer', department: 'ML / AI', skills: ['Go', 'MLOps', 'LLMs', 'PyTorch', 'Embeddings'] },
  { id: 'p-045', name: 'Noah Vasquez', title: 'Senior Engineer', department: 'ML / AI', skills: ['LLMs', 'Spark', 'TypeScript', 'RAG', 'Design Tokens'] },
  { id: 'p-046', name: 'Caleb Patel', title: 'Senior Engineer', department: 'ML / AI', skills: ['Java', 'PyTorch', 'Penetration Testing', 'RAG'] },
  { id: 'p-047', name: 'Nina Rivera', title: 'Staff ML Engineer', department: 'ML / AI', skills: ['Kafka', 'LLMs', 'RAG'] },
  { id: 'p-048', name: 'Lucas Kim', title: 'Staff ML Engineer', department: 'ML / AI', skills: ['dbt', 'User Research', 'Accessibility', 'Data Modeling'] },
  { id: 'p-049', name: 'Hiro Mancini', title: 'Engineering Manager', department: 'ML / AI', skills: ['Rust', 'Airflow', 'TypeScript'] },
  { id: 'p-050', name: 'Ava Lee', title: 'Engineer', department: 'ML / AI', skills: ['Embeddings', 'Figma', 'Rust', 'Airflow', 'Go'] },
  { id: 'p-051', name: 'Nora Chang', title: 'Senior Security Engineer', department: 'Security', skills: ['Rust', 'Accessibility', 'TypeScript', 'dbt', 'Java', 'Linux Internals'] },
  { id: 'p-052', name: 'Hugo DaSilva', title: 'Security Lead', department: 'Security', skills: ['Penetration Testing', 'Java', 'Terraform', 'Accessibility'] },
  { id: 'p-053', name: 'Rachel Turner', title: 'Engineer', department: 'Security', skills: ['Rust', 'Java', 'Go'] },
  { id: 'p-054', name: 'Kevin Garcia', title: 'Senior Engineer', department: 'Security', skills: ['Zero Trust', 'CI/CD', 'Service Mesh', 'Python', 'Linux Internals'] },
  { id: 'p-055', name: 'Mia Chen', title: 'Senior Security Engineer', department: 'Security', skills: ['Terraform', 'TypeScript', 'CI/CD', 'Service Mesh', 'Linux Internals'] },
  { id: 'p-056', name: 'Hugo Lee', title: 'Security Engineer', department: 'Security', skills: ['Kubernetes', 'Storybook', 'Go', 'IAM'] },
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
