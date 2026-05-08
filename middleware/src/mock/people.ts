export interface Person {
  id: string;
  name: string;
  title: string;
  department: string;
  skills: string[];
  influenceScore: number;
  imageUrl?: string;
}

export interface Relationship {
  source: string;
  target: string;
  type: 'collaborates' | 'mentors' | 'reports_to' | 'expert_in_common';
  strength: number;
}

export const mockPeople: Person[] = [
  { id: 'p-001', name: 'Alex Chen', title: 'Staff Engineer', department: 'Platform Engineering', skills: ['Kubernetes', 'Go', 'Terraform', 'Service Mesh'], influenceScore: 0.89 },
  { id: 'p-002', name: 'Maria Santos', title: 'Senior Engineer', department: 'Platform Engineering', skills: ['Python', 'AWS', 'CI/CD', 'Docker'], influenceScore: 0.72 },
  { id: 'p-003', name: 'James Wright', title: 'Engineer', department: 'Platform Engineering', skills: ['TypeScript', 'React', 'Node.js'], influenceScore: 0.45 },
  { id: 'p-004', name: 'Priya Patel', title: 'Senior Engineer', department: 'Platform Engineering', skills: ['Java', 'Kafka', 'Distributed Systems', 'AWS'], influenceScore: 0.68 },
  { id: 'p-005', name: 'David Kim', title: 'Engineering Manager', department: 'Platform Engineering', skills: ['Architecture', 'People Management', 'Go'], influenceScore: 0.82 },
  { id: 'p-006', name: 'Sarah Johnson', title: 'Senior PM', department: 'Product', skills: ['Strategy', 'User Research', 'Roadmapping'], influenceScore: 0.76 },
  { id: 'p-007', name: 'Tom Nakamura', title: 'Product Manager', department: 'Product', skills: ['Analytics', 'A/B Testing', 'SQL'], influenceScore: 0.55 },
  { id: 'p-008', name: 'Lisa Chang', title: 'UX Researcher', department: 'Product', skills: ['User Interviews', 'Surveys', 'Data Analysis'], influenceScore: 0.48 },
  { id: 'p-009', name: 'Ryan O\'Brien', title: 'Technical Writer', department: 'Product', skills: ['Documentation', 'API Design', 'Markdown'], influenceScore: 0.35 },
  { id: 'p-010', name: 'Nina Kowalski', title: 'Director of Product', department: 'Product', skills: ['Vision', 'Stakeholder Mgmt', 'OKRs', 'Strategy'], influenceScore: 0.91 },
  { id: 'p-011', name: 'Carlos Rivera', title: 'Staff Data Engineer', department: 'Data Platform', skills: ['Spark', 'Python', 'dbt', 'Snowflake', 'Airflow'], influenceScore: 0.85 },
  { id: 'p-012', name: 'Emma Wilson', title: 'Senior Data Engineer', department: 'Data Platform', skills: ['SQL', 'Python', 'Kafka', 'Data Modeling'], influenceScore: 0.67 },
  { id: 'p-013', name: 'Ahmed Hassan', title: 'ML Engineer', department: 'Data Platform', skills: ['PyTorch', 'MLOps', 'Python', 'LLMs', 'RAG'], influenceScore: 0.62 },
  { id: 'p-014', name: 'Yuki Tanaka', title: 'Data Analyst', department: 'Data Platform', skills: ['SQL', 'Tableau', 'Python', 'Statistics'], influenceScore: 0.38 },
  { id: 'p-015', name: 'Marcus Thompson', title: 'Engineering Manager', department: 'Data Platform', skills: ['Team Building', 'Data Architecture', 'AWS'], influenceScore: 0.79 },
  { id: 'p-016', name: 'Olivia Park', title: 'Senior Designer', department: 'Design Systems', skills: ['Figma', 'Design Tokens', 'Accessibility', 'React'], influenceScore: 0.71 },
  { id: 'p-017', name: 'Jordan Lee', title: 'Frontend Engineer', department: 'Design Systems', skills: ['React', 'TypeScript', 'CSS', 'Storybook'], influenceScore: 0.58 },
  { id: 'p-018', name: 'Rachel Green', title: 'Design Engineer', department: 'Design Systems', skills: ['SVG', 'Animation', 'Figma', 'React'], influenceScore: 0.52 },
  { id: 'p-019', name: 'Kevin Nguyen', title: 'Accessibility Specialist', department: 'Design Systems', skills: ['WCAG', 'ARIA', 'Screen Readers', 'Testing'], influenceScore: 0.44 },
  { id: 'p-020', name: 'Diana Martinez', title: 'Head of Design', department: 'Design Systems', skills: ['Design Strategy', 'Brand', 'Leadership', 'Figma'], influenceScore: 0.88 },
  { id: 'p-021', name: 'Ben Foster', title: 'SRE Lead', department: 'Platform Engineering', skills: ['Observability', 'Incident Response', 'Terraform', 'Go'], influenceScore: 0.74 },
  { id: 'p-022', name: 'Sophie Turner', title: 'Security Engineer', department: 'Platform Engineering', skills: ['IAM', 'Penetration Testing', 'AWS Security', 'Zero Trust'], influenceScore: 0.66 },
  { id: 'p-023', name: 'Raj Mehta', title: 'Principal Engineer', department: 'Data Platform', skills: ['System Design', 'Distributed Systems', 'Mentoring', 'Kafka'], influenceScore: 0.93 },
  { id: 'p-024', name: 'Aisha Williams', title: 'Product Designer', department: 'Design Systems', skills: ['UX Design', 'Prototyping', 'User Testing', 'Figma'], influenceScore: 0.56 },
];

export const mockRelationships: Relationship[] = [
  { source: 'p-001', target: 'p-002', type: 'collaborates', strength: 0.9 },
  { source: 'p-001', target: 'p-004', type: 'collaborates', strength: 0.85 },
  { source: 'p-001', target: 'p-005', type: 'reports_to', strength: 1.0 },
  { source: 'p-001', target: 'p-011', type: 'collaborates', strength: 0.6 },
  { source: 'p-001', target: 'p-021', type: 'collaborates', strength: 0.75 },
  { source: 'p-002', target: 'p-003', type: 'mentors', strength: 0.7 },
  { source: 'p-002', target: 'p-005', type: 'reports_to', strength: 1.0 },
  { source: 'p-002', target: 'p-012', type: 'expert_in_common', strength: 0.5 },
  { source: 'p-003', target: 'p-017', type: 'collaborates', strength: 0.65 },
  { source: 'p-004', target: 'p-005', type: 'reports_to', strength: 1.0 },
  { source: 'p-004', target: 'p-012', type: 'collaborates', strength: 0.7 },
  { source: 'p-004', target: 'p-023', type: 'collaborates', strength: 0.8 },
  { source: 'p-005', target: 'p-010', type: 'collaborates', strength: 0.6 },
  { source: 'p-005', target: 'p-015', type: 'collaborates', strength: 0.55 },
  { source: 'p-006', target: 'p-007', type: 'collaborates', strength: 0.8 },
  { source: 'p-006', target: 'p-008', type: 'collaborates', strength: 0.7 },
  { source: 'p-006', target: 'p-010', type: 'reports_to', strength: 1.0 },
  { source: 'p-006', target: 'p-016', type: 'collaborates', strength: 0.6 },
  { source: 'p-007', target: 'p-010', type: 'reports_to', strength: 1.0 },
  { source: 'p-008', target: 'p-010', type: 'reports_to', strength: 1.0 },
  { source: 'p-009', target: 'p-010', type: 'reports_to', strength: 1.0 },
  { source: 'p-009', target: 'p-001', type: 'collaborates', strength: 0.4 },
  { source: 'p-011', target: 'p-012', type: 'collaborates', strength: 0.9 },
  { source: 'p-011', target: 'p-013', type: 'collaborates', strength: 0.75 },
  { source: 'p-011', target: 'p-015', type: 'reports_to', strength: 1.0 },
  { source: 'p-011', target: 'p-023', type: 'collaborates', strength: 0.85 },
  { source: 'p-012', target: 'p-015', type: 'reports_to', strength: 1.0 },
  { source: 'p-013', target: 'p-015', type: 'reports_to', strength: 1.0 },
  { source: 'p-013', target: 'p-023', type: 'mentors', strength: 0.7 },
  { source: 'p-014', target: 'p-015', type: 'reports_to', strength: 1.0 },
  { source: 'p-014', target: 'p-012', type: 'collaborates', strength: 0.6 },
  { source: 'p-016', target: 'p-017', type: 'collaborates', strength: 0.85 },
  { source: 'p-016', target: 'p-018', type: 'collaborates', strength: 0.8 },
  { source: 'p-016', target: 'p-020', type: 'reports_to', strength: 1.0 },
  { source: 'p-017', target: 'p-020', type: 'reports_to', strength: 1.0 },
  { source: 'p-017', target: 'p-003', type: 'collaborates', strength: 0.65 },
  { source: 'p-018', target: 'p-020', type: 'reports_to', strength: 1.0 },
  { source: 'p-019', target: 'p-020', type: 'reports_to', strength: 1.0 },
  { source: 'p-019', target: 'p-016', type: 'collaborates', strength: 0.7 },
  { source: 'p-020', target: 'p-010', type: 'collaborates', strength: 0.65 },
  { source: 'p-021', target: 'p-005', type: 'reports_to', strength: 1.0 },
  { source: 'p-021', target: 'p-022', type: 'collaborates', strength: 0.8 },
  { source: 'p-022', target: 'p-005', type: 'reports_to', strength: 1.0 },
  { source: 'p-023', target: 'p-015', type: 'reports_to', strength: 1.0 },
  { source: 'p-024', target: 'p-020', type: 'reports_to', strength: 1.0 },
  { source: 'p-024', target: 'p-016', type: 'collaborates', strength: 0.6 },
];

export const departments = [
  { id: 'platform-engineering', name: 'Platform Engineering', color: '#2563eb' },
  { id: 'product', name: 'Product', color: '#16a34a' },
  { id: 'data-platform', name: 'Data Platform', color: '#9333ea' },
  { id: 'design-systems', name: 'Design Systems', color: '#ea580c' },
];
