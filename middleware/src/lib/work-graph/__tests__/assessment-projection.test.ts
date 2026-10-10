// The assessment projection (assessment-projection.ts), pure: default deny, day membership and the
// honesty of what is drawn (one node per row, the row's own figures, the documented edges only).
import { workDayWindow } from '@connorhoehnslalom/realtime-modules/work-graph';
import { assessmentRunStatus, draftStatus, projectAssessmentWorkGraph, type AssessmentProjectionInput } from '../assessment-projection.js';
import { policyRevisionFor, assessmentPolicyRevisionFor } from '../snapshot.js';

const w = workDayWindow('2026-10-06', 'UTC');
const AT = '2026-10-06T12:00:00.000Z';
const base = (over: Partial<AssessmentProjectionInput> = {}): AssessmentProjectionInput => ({
  window: w, observedAt: AT, scope: 'workspace',
  teams: [{ id: 'TEAM-001', name: 'Payments', cohort: 'white_glove', lead: 'Ana Ruiz', updatedAt: '2026-10-06T09:00:00.000Z' }],
  dimensions: [
    { teamId: 'TEAM-001', id: '1', title: 'Source control', level: 3, isNa: false, confidence: 'high', changedAt: '2026-10-06T09:00:00.000Z', changedBy: 'ana', followupsOpen: 0 },
    { teamId: 'TEAM-001', id: '2', title: 'Builds', level: 2, isNa: false, confidence: 'low', changedAt: '2026-09-01T09:00:00.000Z', changedBy: 'ana', followupsOpen: 1 },
  ],
  evidence: [{ teamId: 'TEAM-001', id: 'EV-1', dimensionId: '2', sourceType: 'document', excerpt: 'Runbook', capturedAt: '2026-10-06T10:00:00.000Z', status: 'PENDING', supportsLevel: null }],
  drafts: [], decks: [], runs: [], flowRuns: [],
  reads: { view: true, score: true, run: true },
  ...over,
});
const ids = (p: { nodes: Array<{ id: string }> }) => p.nodes.map(n => n.id).sort();

it('draws nothing without ViewAssessment, whatever else is true', () => {
  const out = projectAssessmentWorkGraph(base({ reads: { view: false, score: true, run: true } }));
  expect(out.nodes).toEqual([]); expect(out.edges).toEqual([]); expect(out.details).toEqual([]);
});

it('the workspace draws only what moved in the day: a dimension scored last month appears only through today’s evidence', () => {
  const out = projectAssessmentWorkGraph(base());
  expect(ids(out)).toEqual(['dim:TEAM-001:1', 'dim:TEAM-001:2', 'evidence:TEAM-001:EV-1', 'team:TEAM-001']);
  const none = projectAssessmentWorkGraph(base({ evidence: [] }));
  expect(ids(none)).toEqual(['dim:TEAM-001:1', 'team:TEAM-001']);
});

it('a team page draws every assessed dimension of its own team and never another team', () => {
  const out = projectAssessmentWorkGraph(base({
    scope: 'team', focusTeamId: 'TEAM-001',
    teams: [...base().teams, { id: 'TEAM-002', name: 'Other', cohort: 'general', lead: null, updatedAt: AT }],
    dimensions: [...base().dimensions, { teamId: 'TEAM-002', id: '1', title: 'Source control', level: 4, isNa: false, confidence: 'high', changedAt: AT, changedBy: null, followupsOpen: 0 }],
  }));
  expect(ids(out).filter(id => id.includes('TEAM-002'))).toEqual([]);
  expect(ids(out)).toContain('dim:TEAM-001:2');
});

it('edges point team→dimension, evidence→dimension and draft→dimension, and every edge has both ends drawn', () => {
  const out = projectAssessmentWorkGraph(base({
    drafts: [{ id: 'adr-1', kind: 'assessment.followup-drafts', teamId: 'TEAM-001', dimensionId: '2', status: 'completed', decision: null, createdAt: '2026-10-06T10:30:00.000Z', updatedAt: '2026-10-06T10:31:00.000Z', finishedAt: '2026-10-06T10:31:00.000Z', requestedBy: 'ana', revision: 1, leaseExpiresAt: null }],
  }));
  const pairs = out.edges.map(e => `${e.fromId}>${e.toId}:${e.relation}`).sort();
  expect(pairs).toEqual(expect.arrayContaining([
    'team:TEAM-001>dim:TEAM-001:1:works-on', 'team:TEAM-001>dim:TEAM-001:2:works-on',
    'evidence:TEAM-001:EV-1>dim:TEAM-001:2:operates-on', 'draft:adr-1>dim:TEAM-001:2:operates-on',
  ]));
  const drawn = new Set(ids(out));
  for (const e of out.edges) { expect(drawn.has(e.fromId)).toBe(true); expect(drawn.has(e.toId)).toBe(true); }
  expect(out.nodes.find(n => n.id === 'draft:adr-1')).toMatchObject({ kind: 'change', status: 'waiting' });
});

it('capabilities follow the viewer’s gates, never widen what is drawn', () => {
  const draft = { id: 'adr-1', kind: 'assessment.evidence-summary', teamId: 'TEAM-001', dimensionId: '2', status: 'completed' as const, decision: null, createdAt: '2026-10-06T10:30:00.000Z', updatedAt: '2026-10-06T10:31:00.000Z', finishedAt: '2026-10-06T10:31:00.000Z', requestedBy: 'ana', revision: 1, leaseExpiresAt: null };
  const full = projectAssessmentWorkGraph(base({ drafts: [draft] }));
  const reader = projectAssessmentWorkGraph(base({ drafts: [draft], reads: { view: true, score: false, run: false } }));
  expect(ids(reader)).toEqual(ids(full));
  expect(full.nodes.find(n => n.id === 'draft:adr-1')!.capabilities).toEqual(['edit-document', 'dispatch-run']);
  expect(reader.nodes.find(n => n.id === 'draft:adr-1')!.capabilities).toEqual([]);
});

it('crosswalks statuses and keeps the three tenants’ policy revisions apart', () => {
  expect(assessmentRunStatus('running')).toBe('running'); expect(assessmentRunStatus('failed')).toBe('error');
  expect(draftStatus({ status: 'completed', decision: 'accepted' })).toBe('completed');
  expect(draftStatus({ status: 'completed', decision: 'discarded' })).toBe('stopped');
  expect(draftStatus({ status: 'queued', decision: null })).toBe('running');
  const a = assessmentPolicyRevisionFor('k', { view: true, score: true, run: true }, []);
  expect(a).toMatch(/^assessment\./);
  expect(assessmentPolicyRevisionFor('k', { view: true, score: true, run: false }, [])).not.toBe(a);
  expect(policyRevisionFor('k', { botRuns: true, marketplaceRuns: true, dispatch: true, sprintsWide: true, grants: true }, [])).toMatch(/^orgiq\./);
});
