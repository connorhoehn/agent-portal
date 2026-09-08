// Assessment provider tests (providers/assessment.ts) against the real mock
// fixture (mock/assessment.ts) — MOCK_AURORA is the path that must work, so
// these tests exercise it directly rather than stubbing it out.
//
// Covers: every dimension shape carries all 17 dimensions; applyScores
// rejects an unknown dimension id and an invalid confidence value, and caps
// a self-rating-only (evidence_class "attested") suggestion at Level 3;
// launchRun's duplicate guard (409) and concurrency cap (429); team id
// validation.

jest.mock('../../config.js', () => ({ config: { mock: { aurora: true } } }));

import * as provider from '../assessment.js';
import * as M from '../../mock/assessment.js';
import { fixtureRegistry } from '../../mock/core/index.js';

describe('dimension shapes', () => {
  it('GET-equivalent team detail always carries all 17 dimensions', async () => {
    const detail = await provider.getTeamDetail('TEAM-002');
    expect(detail).not.toBeNull();
    expect(detail!.dimensions).toHaveLength(17);
    expect(detail!.dimensions.map((d) => d.id).sort((a, b) => Number(a) - Number(b))).toEqual(
      Array.from({ length: 17 }, (_, i) => String(i + 1)),
    );
  });

  it('a brand-new team (no scores yet) still reports all 17 dimensions, all unassessed', async () => {
    const detail = await provider.getTeamDetail('TEAM-006');
    expect(detail!.dimensions).toHaveLength(17);
    expect(detail!.dimensions.every((d) => d.current_level === null && !d.is_na)).toBe(true);
  });

  it('unknown team returns null, not a throw', async () => {
    expect(await provider.getTeamDetail('TEAM-999')).toBeNull();
  });
});

describe('listTeams summaries', () => {
  it('returns a TeamSummary per seeded team with certification attached', async () => {
    const teams = await provider.listTeams();
    expect(teams.length).toBeGreaterThanOrEqual(7);
    const t002 = teams.find((t) => t.id === 'TEAM-002')!;
    expect(t002.dimensions_total).toBe(17);
    expect(t002.certification).toBeTruthy();
    expect(t002.certification.target_level).toBe(M.configuration().target_level);
  });
});

describe('certification: TEAM-001 claim_open + Level-4 observed', () => {
  it('dimension 1 reports an open claim (claimed 5 > verified 2)', async () => {
    const detail = await provider.getTeamDetail('TEAM-001');
    const dim1 = detail!.dimensions.find((d) => d.id === '1')!;
    expect(dim1.certification.status).toBe('claim_open');
    expect(dim1.certification.verification_gap).toBeGreaterThanOrEqual(2);
  });

  // The portal has rendered "To confirm a higher level, we would need …" from
  // cert.to_verify_higher since the port; the server never sent the field, so
  // the sentence never appeared and Recommendation.what_would_help was always
  // empty. It is a real concept in the domain (the "evidence ask" of a
  // close-the-claim recommendation, sdlcd/assessment/certification.py) — so
  // the server sends it, computed from the level one above what is verified.
  it('names the artifact that would let verification go higher', async () => {
    const detail = await provider.getTeamDetail('TEAM-001');
    const dim1 = detail!.dimensions.find((d) => d.id === '1')!;
    // Verified at 2, so the ask is for Level 3 — not for the claimed Level 5.
    expect(dim1.certification.verified_level).toBe(2);
    expect(dim1.certification.to_verify_higher).toMatch(/^To verify higher: consistent practice at Level 3 \(/);
  });

  it('asks for something we can check ourselves at Level 4, and for endurance at Level 5', async () => {
    const detail = await provider.getTeamDetail('TEAM-001');
    const atL3 = detail!.dimensions.find((d) => d.certification.verified_level === 3);
    if (atL3) expect(atL3.certification.to_verify_higher).toMatch(/evidence we can check for ourselves/);
    const dim9 = detail!.dimensions.find((d) => d.id === '9')!;
    expect(dim9.certification.verified_level).toBe(4);
    expect(dim9.certification.to_verify_higher).toMatch(/held up over time/);
  });

  it('has nothing to ask for when nothing is verified yet, or the dimension is N/A', async () => {
    const detail = await provider.getTeamDetail('TEAM-006');
    for (const dim of detail!.dimensions) {
      expect(dim.certification.verified_level).toBeNull();
      expect(dim.certification.to_verify_higher).toBe('');
    }
    const t1 = await provider.getTeamDetail('TEAM-001');
    const na = t1!.dimensions.find((d) => d.is_na)!;
    expect(na.certification.to_verify_higher).toBe('');
  });

  it('every recommendation carries the ask, which is what the plan renders', async () => {
    const plan = await provider.getTeamRecommendations('TEAM-001');
    const closeClaim = plan!.recommendations.filter((r) => r.kind === 'close_claim');
    expect(closeClaim.length).toBeGreaterThan(0);
    for (const rec of closeClaim) {
      expect(rec.certification.to_verify_higher).toMatch(/^To verify higher: /);
    }
  });

  it('dimension 9 is Level 4 backed by Observed evidence, high confidence', async () => {
    const detail = await provider.getTeamDetail('TEAM-001');
    const dim9 = detail!.dimensions.find((d) => d.id === '9')!;
    expect(dim9.current_level).toBe(4);
    expect(dim9.confidence).toBe('high');
    expect(dim9.evidence.some((e) => e.status === 'SCORED')).toBe(true);
  });

  it('dimension 6 is an approved N/A exception; dimension 7 is requested', async () => {
    const teams = await provider.listTeams();
    const t001 = teams.find((t) => t.id === 'TEAM-001')!;
    void t001;
    const exceptions = await provider.listExceptions('TEAM-001');
    const dim6 = exceptions!.exceptions.find((e) => e.dimension_id === '6')!;
    const dim7 = exceptions!.exceptions.find((e) => e.dimension_id === '7')!;
    expect(dim6.status).toBe('approved');
    expect(dim7.status).toBe('requested');
  });
});

describe('applyScores validation', () => {
  it('rejects an unknown dimension id ("18")', async () => {
    const result = await provider.applyScores('TEAM-006', {
      relevant_dimension_ids: ['18'],
      scores: [{ dimension_id: '18', suggested_level: 3, confidence: 'moderate', rationale: 'test' }],
    });
    expect(result!.applied).toHaveLength(0);
    expect(result!.rejected[0]).toMatchObject({ dimension_id: '18' });
    expect(result!.rejected[0]!.reason).toMatch(/unknown dimension/);
  });

  it('rejects an invalid confidence value ("medium")', async () => {
    const result = await provider.applyScores('TEAM-006', {
      relevant_dimension_ids: ['2'],
      scores: [{ dimension_id: '2', suggested_level: 3, confidence: 'medium', rationale: 'test' }],
    });
    expect(result!.applied).toHaveLength(0);
    expect(result!.rejected[0]!.reason).toMatch(/invalid confidence/);
  });

  it('refuses to score a dimension outside relevant_dimension_ids', async () => {
    const result = await provider.applyScores('TEAM-006', {
      relevant_dimension_ids: ['3'],
      scores: [{ dimension_id: '4', suggested_level: 2, confidence: 'moderate', rationale: 'test' }],
    });
    expect(result!.applied).toHaveLength(0);
    expect(result!.rejected[0]!.reason).toMatch(/not in relevant_dimension_ids/);
  });

  it('caps a self-rating-only (attested) suggestion above Level 3 at Level 3, cap_applied true', async () => {
    const result = await provider.applyScores('TEAM-006', {
      relevant_dimension_ids: ['5'],
      scores: [{
        dimension_id: '5', suggested_level: 5, confidence: 'low', rationale: 'self-report only',
        evidence_class: 'attested', self_claimed_level: 5,
      }],
    });
    expect(result!.applied).toEqual([{ dimension_id: '5', current_level: 3, cap_applied: true }]);
    const detail = await provider.getTeamDetail('TEAM-006');
    const dim5 = detail!.dimensions.find((d) => d.id === '5')!;
    expect(dim5.current_level).toBe(3);
    expect(dim5.history[dim5.history.length - 1]!.to_level).toBe(3);
  });

  it('does not cap a Level-4 suggestion backed by Observed evidence', async () => {
    const result = await provider.applyScores('TEAM-007', {
      relevant_dimension_ids: ['9'],
      scores: [{
        dimension_id: '9', suggested_level: 4, confidence: 'high', rationale: 'observed directly',
        evidence_class: 'observed', evidence_excerpts: ['Opened the dashboard directly.'],
      }],
    });
    expect(result!.applied).toEqual([{ dimension_id: '9', current_level: 4, cap_applied: false }]);
  });

  it('unknown team returns null', async () => {
    const result = await provider.applyScores('TEAM-999', { relevant_dimension_ids: [], scores: [] });
    expect(result).toBeNull();
  });
});

describe('launchRun: duplicate guard and concurrency cap', () => {
  it('409s a duplicate (command, team) while one is already running', async () => {
    const first = await provider.launchRun('score-dimensions', {}, 'TEAM-cap-a');
    expect(first.ok).toBe(true);
    const second = await provider.launchRun('score-dimensions', {}, 'TEAM-cap-a');
    expect(second).toMatchObject({ ok: false, status: 409 });
  });

  it("a different (command, team) pair is not blocked by someone else's running duplicate", async () => {
    const result = await provider.launchRun('classify-transcript', {}, 'TEAM-cap-b');
    expect(result.ok).toBe(true);
  });

  it('429s once the concurrency cap (3) is already reached by other running records', async () => {
    // The mock fixture seeds one running record (TEAM-003's score-dimensions
    // run), and the two tests above each added one more — three concurrently
    // running against the live ledger.
    const running = M.runs().filter((r) => r.status === 'running').length;
    expect(running).toBeGreaterThanOrEqual(3);
    const capped = await provider.launchRun('draw-diagram', {}, 'TEAM-cap-c');
    expect(capped).toMatchObject({ ok: false, status: 429 });
  });
});

describe('team id validation', () => {
  it('accepts TEAM-001 and rejects a traversal attempt', () => {
    expect(provider.isValidTeamId('TEAM-001')).toBe(true);
    expect(provider.isValidTeamId('TEAM-../../etc')).toBe(false);
    expect(provider.isValidTeamId('../x')).toBe(false);
  });
});

describe('knowledge docs: versions + restore', () => {
  it('PUT snapshots the previous version, and restore brings old content back', async () => {
    const before = await provider.getKnowledgeDoc('rule:na-exception-policy.md');
    const originalMarkdown = before!.markdown;
    const put = await provider.putKnowledgeDoc('rule:na-exception-policy.md', '# edited\n');
    expect(put!.ok).toBe(true);
    const versions = await provider.getKnowledgeDocVersions('rule:na-exception-policy.md');
    expect(versions!.length).toBeGreaterThanOrEqual(1);
    const snapshot = versions!.find((v) => v.markdown === originalMarkdown);
    expect(snapshot).toBeTruthy();
    const restored = await provider.restoreKnowledgeDocVersion('rule:na-exception-policy.md', snapshot!.stamp);
    expect(restored!.ok).toBe(true);
    const after = await provider.getKnowledgeDoc('rule:na-exception-policy.md');
    expect(after!.markdown).toBe(originalMarkdown);
  });

  it('unknown doc id returns null', async () => {
    expect(await provider.getKnowledgeDoc('rule:does-not-exist.md')).toBeNull();
    expect(await provider.putKnowledgeDoc('rule:does-not-exist.md', 'x')).toBeNull();
  });
});

// ─── Derived over stored, end to end ────────────────────────────────────────

describe('a count always matches the list it sits above', () => {
  it('groups[].revisions counts the envelopes in the group, not the newest revision number', async () => {

    const before = await provider.listSubmissions();
    const chain = before.groups.find((g) => g.revisions > 1)!;
    expect(chain.revisions).toBe(
      before.envelopes.filter((e) => e.team_id === chain.team_id
        && e.envelope_id.replace(/-r\d+$/, '') === chain.base_id).length,
    );

    // Clear the FIRST revision. `revision` on the surviving envelopes still
    // reads 2 and 3, so the old "revisions = latest.revision" would go on
    // claiming 3 above two rows — a banner over the wrong number of cards.
    expect(await provider.deleteSubmission(chain.team_id, chain.base_id)).toBe(true);

    const after = await provider.listSubmissions();
    const group = after.groups.find((g) => g.base_id === chain.base_id)!;
    const remaining = after.envelopes.filter((e) => e.team_id === group.team_id
      && e.envelope_id.replace(/-r\d+$/, '') === group.base_id);
    expect(group.revisions).toBe(chain.revisions - 1);
    expect(group.revisions).toBe(remaining.length);
    expect(Math.max(...remaining.map((e) => e.revision))).toBeGreaterThan(group.revisions);
  });

  it('pinning teams to empty empties the roster the API serves', async () => {
    expect((await provider.listTeams()).length).toBeGreaterThan(0);
    fixtureRegistry.resetAll('empty');
    expect(await provider.listTeams()).toEqual([]);
    expect(await provider.listSubmissions()).toEqual({ envelopes: [], groups: [] });
    expect((await provider.getKnowledgeTree()).sections).toEqual([]);
    const rollup = await provider.getRollup();
    expect(rollup.teams_total).toBe(0);
    expect(rollup.dimensions_assessed).toBe(0);
  });
});

afterAll(() => {
  fixtureRegistry.resetAll('default');
});
