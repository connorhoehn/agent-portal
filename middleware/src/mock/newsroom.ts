// Newsroom demo fixture — backs providers/newsroom-articles.ts and
// providers/newsroom-beats.ts under MOCK_AURORA.
//
// Every read in those two providers hits Aurora directly with no mock branch.
// listArticles/getArticle/getTodayStats/getEntity at least wrap their queries
// in try/catch and fall back to an empty default, so they degraded to "[]" —
// bare, but not a 500. getClusters/getPitches/getPitchBoard/updatePitchStatus/
// publishArticle have no try/catch at all, so under mock (no cluster ARN,
// unreachable Data API) they threw straight through asyncHandler into a 500,
// and the newsroom home page rendered "Couldn't load" for two of its four
// cards while the other two quietly showed nothing.
//
// This is a small, internally-consistent newsroom: 3 beats, 3 story clusters,
// 6 articles (2 per cluster, one published today so the Today card has
// something to show), a handful of entities, and 4 pitches (2 open) so the
// pitch board's status counts aren't a wall of zeros.

const hoursAgo = (n: number): string => new Date(Date.now() - n * 3_600_000).toISOString();
const daysAgo = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString();

// ─── Beats / sections ──────────────────────────────────────────────────────

export const MOCK_BEATS = ['AI Policy', 'Cloud Infrastructure', 'Labor & Workplace'] as const;

// ─── Entities ───────────────────────────────────────────────────────────────

export interface MockEntity {
  id: string;
  name: string;
  entityType: string;
  aliases: string[];
}

export const mockEntities: MockEntity[] = [
  { id: 'ent-openai', name: 'OpenAI', entityType: 'organization', aliases: [] },
  { id: 'ent-nimbus-cloud', name: 'Nimbus Cloud', entityType: 'organization', aliases: ['Nimbus'] },
  { id: 'ent-eu-commission', name: 'EU Commission', entityType: 'organization', aliases: ['European Commission'] },
  { id: 'ent-sen-alvarez', name: 'Sen. Marta Alvarez', entityType: 'person', aliases: ['Marta Alvarez'] },
  { id: 'ent-remoteco', name: 'RemoteCo', entityType: 'organization', aliases: [] },
];

// ─── Clusters ───────────────────────────────────────────────────────────────

export interface MockCluster {
  id: string;
  title: string;
  beat: string;
  lastUpdated: string;
}

export const mockClusters: MockCluster[] = [
  { id: 'cl-antitrust-cloud', title: 'Antitrust probes widen for major cloud providers', beat: 'Cloud Infrastructure', lastUpdated: hoursAgo(6) },
  { id: 'cl-ai-safety-bill', title: 'Federal AI safety framework moves to markup', beat: 'AI Policy', lastUpdated: hoursAgo(20) },
  { id: 'cl-rto-backlash', title: 'Return-to-office mandates spark a reorganization wave', beat: 'Labor & Workplace', lastUpdated: daysAgo(3) },
];

// ─── Articles ───────────────────────────────────────────────────────────────

export interface MockArticle {
  id: string;
  headline: string;
  subheadline: string | null;
  section: string;
  status: string;
  publishedAt: string | null;
  wordCount: number;
  byline: { id: string; name: string };
  clusterId: string;
  body: string;
  entityIds: Array<{ id: string; salience: number; role: string | null }>;
}

export const mockArticles: MockArticle[] = [
  {
    id: 'art-001', headline: 'Nimbus Cloud faces second antitrust inquiry this year',
    subheadline: 'EU regulators expand scrutiny of bundled storage pricing',
    section: 'Cloud Infrastructure', status: 'published', publishedAt: hoursAgo(3),
    wordCount: 640, byline: { id: 'p-006', name: 'Sarah Johnson' }, clusterId: 'cl-antitrust-cloud',
    body: 'The EU Commission opened a second formal inquiry into Nimbus Cloud\'s storage bundling practices...',
    entityIds: [{ id: 'ent-nimbus-cloud', salience: 0.92, role: 'subject' }, { id: 'ent-eu-commission', salience: 0.71, role: 'source' }],
  },
  {
    id: 'art-002', headline: 'Rival providers welcome Nimbus probe, brief filings show',
    subheadline: null,
    section: 'Cloud Infrastructure', status: 'published', publishedAt: hoursAgo(9),
    wordCount: 410, byline: { id: 'p-002', name: 'Maria Santos' }, clusterId: 'cl-antitrust-cloud',
    body: 'Amicus filings from three competing cloud vendors backed the EU Commission\'s expanded inquiry...',
    entityIds: [{ id: 'ent-nimbus-cloud', salience: 0.65, role: 'subject' }],
  },
  {
    id: 'art-003', headline: 'AI safety framework clears committee, heads to markup',
    subheadline: 'Bipartisan bill would require pre-deployment model evaluations',
    section: 'AI Policy', status: 'published', publishedAt: hoursAgo(20),
    wordCount: 720, byline: { id: 'p-010', name: 'Nina Kowalski' }, clusterId: 'cl-ai-safety-bill',
    body: 'The Senate Commerce Committee advanced the AI Safety and Accountability Act on a 14-6 vote...',
    entityIds: [{ id: 'ent-sen-alvarez', salience: 0.88, role: 'source' }, { id: 'ent-openai', salience: 0.4, role: 'mentioned' }],
  },
  {
    id: 'art-004', headline: 'What the AI safety bill would actually require of model builders',
    subheadline: 'An explainer on evaluation thresholds and reporting deadlines',
    section: 'AI Policy', status: 'draft', publishedAt: null,
    wordCount: 0, byline: { id: 'p-010', name: 'Nina Kowalski' }, clusterId: 'cl-ai-safety-bill',
    body: 'Draft explainer — not yet published.',
    entityIds: [{ id: 'ent-openai', salience: 0.5, role: 'mentioned' }],
  },
  {
    id: 'art-005', headline: 'RemoteCo\'s return-to-office mandate triggers a wave of departures',
    subheadline: null,
    section: 'Labor & Workplace', status: 'published', publishedAt: daysAgo(3),
    wordCount: 580, byline: { id: 'p-020', name: 'Diana Martinez' }, clusterId: 'cl-rto-backlash',
    body: 'RemoteCo\'s five-day office mandate has driven a measurable spike in senior engineer attrition...',
    entityIds: [{ id: 'ent-remoteco', salience: 0.9, role: 'subject' }],
  },
  {
    id: 'art-006', headline: 'Other firms watch RemoteCo\'s attrition numbers before following suit',
    subheadline: null,
    section: 'Labor & Workplace', status: 'published', publishedAt: daysAgo(4),
    wordCount: 390, byline: { id: 'p-021', name: 'Ben Foster' }, clusterId: 'cl-rto-backlash',
    body: 'Three peer companies say they are holding off on office mandates pending RemoteCo\'s Q3 numbers...',
    entityIds: [{ id: 'ent-remoteco', salience: 0.55, role: 'mentioned' }],
  },
];

// ─── Pitches ────────────────────────────────────────────────────────────────

export interface MockPitch {
  id: string;
  title: string;
  body: string | null;
  beat: string;
  status: string;
  proposedBy: { id: string; name: string };
  assignedTo: { id: string; name: string } | null;
  clusterId: string | null;
  createdAt: string;
  updatedAt: string;
}

const pitches: MockPitch[] = [
  {
    id: 'pitch-001', title: 'Interview the EU Commission\'s lead counsel on the Nimbus probe',
    body: 'Requested comment already sent; awaiting scheduling.', beat: 'Cloud Infrastructure', status: 'open',
    proposedBy: { id: 'p-002', name: 'Maria Santos' }, assignedTo: null, clusterId: 'cl-antitrust-cloud',
    createdAt: daysAgo(2), updatedAt: daysAgo(2),
  },
  {
    id: 'pitch-002', title: 'Explainer: what the AI safety bill actually requires', body: null,
    beat: 'AI Policy', status: 'open',
    proposedBy: { id: 'p-010', name: 'Nina Kowalski' }, assignedTo: null, clusterId: 'cl-ai-safety-bill',
    createdAt: daysAgo(1), updatedAt: daysAgo(1),
  },
  {
    id: 'pitch-003', title: 'Follow-up: which companies blink first after RemoteCo\'s numbers',
    body: 'Sarah has two sourced leads already.', beat: 'Labor & Workplace', status: 'assigned',
    proposedBy: { id: 'p-021', name: 'Ben Foster' }, assignedTo: { id: 'p-006', name: 'Sarah Johnson' },
    clusterId: 'cl-rto-backlash', createdAt: daysAgo(5), updatedAt: daysAgo(1),
  },
  {
    id: 'pitch-004', title: 'Profile: the committee staffer who wrote the evaluation thresholds',
    body: null, beat: 'AI Policy', status: 'filed',
    proposedBy: { id: 'p-010', name: 'Nina Kowalski' }, assignedTo: { id: 'p-010', name: 'Nina Kowalski' },
    clusterId: 'cl-ai-safety-bill', createdAt: daysAgo(9), updatedAt: daysAgo(6),
  },
];

export function mockUpdatePitchStatus(id: string, status: string): boolean {
  const p = pitches.find((x) => x.id === id);
  if (!p) return false;
  p.status = status;
  p.updatedAt = new Date().toISOString();
  return true;
}

export function mockPitches(): MockPitch[] {
  return pitches;
}

export function mockPublishArticle(id: string): boolean {
  const a = mockArticles.find((x) => x.id === id);
  if (!a) return false;
  a.status = 'published';
  a.publishedAt = a.publishedAt ?? new Date().toISOString();
  return true;
}
