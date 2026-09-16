// The fields the portal's `pages/assessment/types.ts` DECLARES and READS,
// checked against what the server actually sends. This is bug class 2 from
// middleware/src/mock/core/contract.ts — `enterprise` vs `enterprise_context`
// — in its quietest form: not a wrong key, an *absent* one. A field the page
// reads and the server never sends renders as nothing at all, and every test
// on both sides stays green because neither side ever states the other's
// shape.
//
// An audit compared the two by hand and found eight. Four of them were the
// server failing to send something real, and this file pins those four so
// they cannot silently go hollow again:
//
//   below_target / above_target  — in the source app's own team rollup
//                                  (sdlcd/assessment/certification.py
//                                  `certify_team`), dropped in the port.
//   criteria_progress            — hard-coded `[]` in buildDimensionOut, so
//                                  DimensionMasterDetail's Met/Open chips
//                                  could never render.
//   evidence[].provenance        — declared REQUIRED on the portal, resolved
//                                  by the source app's `_provenance_out`,
//                                  never sent here.
//   next_level_criteria          — sent, but one rung too high (it read
//                                  `current_level + 1`), so a dimension
//                                  verified at Level 2 was shown the Level
//                                  3→4 ask.
//
// The other four were dead — see the last describe block, which says so with
// an assertion rather than a comment, so resurrecting one is a decision
// somebody has to make on purpose.

jest.mock('../../config.js', () => ({ config: { mock: { aurora: true } } }));

import * as provider from '../assessment.js';
import * as M from '../../mock/assessment.js';

const criteriaToReach = (dimensionId: string, level: number): string[] =>
  M.rubricDimension(dimensionId)!.levels.find((l) => l.level === level - 1)?.level_up_criteria ?? [];

describe('TeamCertification: below_target / above_target', () => {
  it('are sent on every team and partition `assessed` with at_or_above_target', async () => {
    const teams = await provider.listTeams();
    expect(teams.length).toBeGreaterThan(0);
    for (const t of teams) {
      const c = t.certification;
      expect(typeof c.below_target).toBe('number');
      expect(typeof c.above_target).toBe('number');
      // The whole point of the pair: they are selectors over the same list
      // `at_or_above_target` counts, so this identity holds by construction
      // and cannot drift the way a stored count would.
      expect(c.at_or_above_target + c.below_target).toBe(c.assessed);
      // "above target" is a subset of "at or above target".
      expect(c.above_target).toBeLessThanOrEqual(c.at_or_above_target);
      expect(c.below_target).toBeGreaterThanOrEqual(0);
    }
  });

  it('reports the split TEAM-001 actually has: one dimension over target, one under', async () => {
    const teams = await provider.listTeams();
    const t1 = teams.find((t) => t.id === 'TEAM-001')!;
    // Seeded: 15 applicable, 14 at/above the target of 3, dimension 9 at
    // Level 4 and dimension 1 stuck at Level 2 behind an open claim.
    expect(t1.certification.target_level).toBe(3);
    expect(t1.certification.at_or_above_target).toBe(14);
    expect(t1.certification.below_target).toBe(1);
    expect(t1.certification.above_target).toBe(1);
  });

  it('a brand-new team reports zero on both rather than omitting them', async () => {
    const teams = await provider.listTeams();
    const fresh = teams.find((t) => t.id === 'TEAM-006')!;
    expect(fresh.certification.assessed).toBe(0);
    expect(fresh.certification.below_target).toBe(0);
    expect(fresh.certification.above_target).toBe(0);
  });
});

describe('TeamSummary.workflow_steps', () => {
  it('is sent on every team summary, built by the same function the detail wire uses', async () => {
    const teams = await provider.listTeams();
    for (const t of teams) {
      expect(t.workflow_steps).toHaveLength(6);
      expect(t.workflow_steps.map((s) => s.label)).toEqual([...provider.WORKFLOW_STEP_LABELS]);
      expect(t.workflow_steps.filter((s) => s.active)).toHaveLength(1);
      expect(t.workflow_steps.find((s) => s.active)!.step).toBe(t.workflow_step);
    }
  });

  it('matches the detail wire\'s workflow_steps exactly for the same team — one source, not two', async () => {
    const teams = await provider.listTeams();
    for (const t of teams) {
      const detail = await provider.getTeamDetail(t.id);
      expect(t.workflow_steps).toEqual(detail!.workflow_steps);
    }
  });
});

describe('Dimension.criteria_progress', () => {
  it('is no longer empty for an assessed dimension, and every bullet is verbatim rubric text', async () => {
    const detail = await provider.getTeamDetail('TEAM-001');
    const dim = detail!.dimensions.find((d) => d.id === '1')!;
    expect(dim.current_level).toBe(2);
    expect(dim.criteria_progress.length).toBeGreaterThan(0);

    // No invented text: a bullet is a string lifted out of THIS dimension's
    // rubric, never composed here.
    const rubricText = new Set(
      M.rubricDimension('1')!.levels.flatMap((l) => l.level_up_criteria),
    );
    for (const c of dim.criteria_progress) expect(rubricText.has(c.text)).toBe(true);
  });

  it('splits into the level just reached (met, with the evidence that reached it) and the next rung (open)', async () => {
    const detail = await provider.getTeamDetail('TEAM-001');
    const dim = detail!.dimensions.find((d) => d.id === '1')!;
    const verified = dim.current_level!;

    const met = dim.criteria_progress.filter((c) => c.met);
    const open = dim.criteria_progress.filter((c) => !c.met);

    expect(met.map((c) => c.text)).toEqual(criteriaToReach('1', verified));
    expect(open.map((c) => c.text)).toEqual(criteriaToReach('1', verified + 1));
    expect(met.every((c) => c.target_level === verified)).toBe(true);
    expect(open.every((c) => c.target_level === verified + 1)).toBe(true);

    // A met bullet points at the scored evidence that carried the dimension
    // to that level — so a reader can go from the claim to the artifact.
    const supporting = dim.evidence
      .filter((e) => e.scored && e.supports_level !== null && e.supports_level >= verified)
      .map((e) => e.evidence_id);
    expect(supporting.length).toBeGreaterThan(0);
    expect(met.every((c) => c.evidence_ids.length > 0)).toBe(true);
    for (const c of met) expect(c.evidence_ids).toEqual(supporting);
    // An open bullet claims no evidence, because none has been shown for it.
    expect(open.every((c) => c.evidence_ids.length === 0)).toBe(true);
  });

  it('an unassessed dimension has only the Level 1 rung open — never a "met" bullet at Level 0', async () => {
    const detail = await provider.getTeamDetail('TEAM-006');
    const dim = detail!.dimensions.find((d) => d.id === '1')!;
    expect(dim.current_level).toBeNull();
    expect(dim.criteria_progress.every((c) => !c.met)).toBe(true);
    expect(dim.criteria_progress.every((c) => c.target_level === 1)).toBe(true);
    expect(dim.criteria_progress.map((c) => c.text)).toEqual(criteriaToReach('1', 1));
  });

  it('an approved N/A has no criteria and no next-level ask — it was excused from the rubric', async () => {
    // TEAM-001 dimension 6: approved archetype exception.
    const detail = await provider.getTeamDetail('TEAM-001');
    const dim = detail!.dimensions.find((d) => d.id === '6')!;
    expect(dim.is_na).toBe(true);
    expect(dim.criteria_progress).toEqual([]);
    expect(dim.next_level_criteria).toEqual([]);
    expect(dim.certification.to_verify_higher).toBe('');
  });

  it('a dimension verified at the rubric max has met bullets and nothing open above them', async () => {
    // Reach Level 5 the only way the deterministic path allows: Observed
    // evidence. The self-rating cap only bites on `attested`.
    const applied = await provider.applyScores('TEAM-005', {
      relevant_dimension_ids: ['3'],
      scores: [{
        dimension_id: '3', suggested_level: 5, confidence: 'high', evidence_class: 'observed',
        rationale: 'Sustained automation metrics reviewed across four release cycles.',
        evidence_excerpts: ['Automation coverage trend, four consecutive cycles.'],
      }],
    });
    expect(applied!.rejected).toEqual([]);

    const detail = await provider.getTeamDetail('TEAM-005');
    const dim = detail!.dimensions.find((d) => d.id === '3')!;
    expect(dim.current_level).toBe(5);
    expect(dim.criteria_progress.length).toBeGreaterThan(0);
    expect(dim.criteria_progress.every((c) => c.met && c.target_level === 5)).toBe(true);
    expect(dim.criteria_progress.map((c) => c.text)).toEqual(criteriaToReach('3', 5));
  });
});

describe('Dimension.next_level_criteria — one rung up, not two', () => {
  it('asks for what the NEXT level needs, matching the open half of criteria_progress', async () => {
    const detail = await provider.getTeamDetail('TEAM-001');
    for (const dim of detail!.dimensions) {
      if (dim.is_na) { expect(dim.next_level_criteria).toEqual([]); continue; }
      const next = dim.current_level === null ? 1 : dim.current_level + 1;
      const expected = next > 5 ? [] : criteriaToReach(dim.id, next);
      expect(dim.next_level_criteria).toEqual(expected);
      // The two fields describe the same rung and must never disagree.
      expect(dim.criteria_progress.filter((c) => !c.met).map((c) => c.text)).toEqual(expected);
    }
  });

  it('regression: a dimension verified at Level 2 is shown the Level 3 ask, not the Level 4 one', async () => {
    const detail = await provider.getTeamDetail('TEAM-001');
    const dim = detail!.dimensions.find((d) => d.id === '1')!;
    expect(dim.current_level).toBe(2);
    expect(dim.next_level_criteria).toEqual(criteriaToReach('1', 3));
    // The bug sent this list — the criteria to go from Level 3 to Level 4.
    expect(dim.next_level_criteria).not.toEqual(criteriaToReach('1', 4));
  });
});

describe('Evidence.provenance — the lineage record, resolved not faked', () => {
  it('is present on every scored evidence row and matches the team ledger entry its source_ref names', async () => {
    const detail = await provider.getTeamDetail('TEAM-001');
    const ledger = M.provenanceFor('TEAM-001');
    const rows = detail!.dimensions.flatMap((d) => d.evidence);
    expect(rows.length).toBeGreaterThan(0);

    let resolved = 0;
    for (const ev of rows) {
      // The key is always present — `null` is a statement, an absent key is
      // the bug this file exists for.
      expect(ev).toHaveProperty('provenance');
      const expected = ledger.find((p) => p.provenance_id === ev.source_ref) ?? null;
      expect(ev.provenance).toEqual(expected);
      if (ev.provenance) {
        resolved += 1;
        expect(ev.provenance.provenance_id).toBe(ev.source_ref);
        expect(ev.provenance.source_uri).toBeTruthy();
        expect(ev.provenance.captured_at).toBeTruthy();
      }
    }
    expect(resolved).toBeGreaterThan(0);
  });

  it('is null — never invented — when the source_ref names nothing the ledger holds', async () => {
    const dims = M.scoresFor('TEAM-003')!;
    const dim = dims['1']!;
    const before = dim.evidence.length;
    dim.evidence.push({
      evidence_id: 'EV-orphan-ref', dimension_id: '1', source_type: 'document',
      excerpt: 'A note whose lineage record was never written.',
      supports_level: 1, captured_at: dim.updated_at,
      source_ref: 'PROV-nothing-here', scored: true, status: 'SCORED',
    });
    try {
      const detail = await provider.getTeamDetail('TEAM-003');
      const out = detail!.dimensions.find((d) => d.id === '1')!.evidence
        .find((e) => e.evidence_id === 'EV-orphan-ref')!;
      expect(out.provenance).toBeNull();
    } finally {
      dim.evidence.length = before;
    }
  });
});

describe('Evidence.status vocabulary', () => {
  it('only ever spells one of the three the middleware and the fixture actually write', async () => {
    // PENDING (intake, providers/assessment.ts) · SCORED (scoring, same
    // file) · CLASSIFIED (seeded intake rows). The portal types this as a
    // bare `string`; these three are the whole set the server can produce,
    // and a fourth appearing here means a new state nobody declared.
    const allowed = new Set(['PENDING', 'SCORED', 'CLASSIFIED']);
    for (const team of M.teams()) {
      const detail = await provider.getTeamDetail(team.id);
      for (const dim of detail!.dimensions) {
        for (const ev of dim.evidence) expect(allowed.has(ev.status)).toBe(true);
      }
      for (const item of M.evidenceLogFor(team.id)) expect(allowed.has(item.status)).toBe(true);
    }
  });
});

describe('the dead half of the audit — fields the server does not send, on purpose', () => {
  // Each of these is declared by the portal and produced by nothing here.
  // They are asserted absent rather than left unmentioned, because "the
  // server happens not to send it today" and "we decided it is dead" read
  // identically in a response body. If one of these ever needs to exist,
  // this test is where the decision gets revisited — and the portal type
  // has to be corrected in the same change.
  it('sends no person ids on a team: the assessment tenant has no org-graph link to send', async () => {
    // `assessment_teams` (schema/assessment_schema.sql) carries
    // `assessment_lead TEXT` and `contributors JSONB {initials,name}[]` —
    // no person column. All three assessment `app_users` carry
    // `personId: null`, and the leads in the fixture are not app_users at
    // all. PersonRef additionally refuses to link outside orgiq and its
    // hover card reads /api/graph/people, which requireTenant('orgiq')
    // 403s an assessment session.
    const teams = await provider.listTeams();
    for (const t of teams) {
      expect(t).not.toHaveProperty('assessment_lead_person_id');
      for (const c of t.contributors) expect(c).not.toHaveProperty('person_id');
    }
    const detail = await provider.getTeamDetail('TEAM-001');
    expect(detail!.team).not.toHaveProperty('assessment_lead_person_id');
  });

  it('sends `claims_open` and never the pre-amendment `contested`', async () => {
    // `contested` is absent from the source app's server rollup too — it
    // survives only in the source's own client types as a read fallback.
    const teams = await provider.listTeams();
    for (const t of teams) {
      expect(t.certification).toHaveProperty('claims_open');
      expect(t.certification).not.toHaveProperty('contested');
    }
  });

  it('spells the team sub-line `subline`, and does not also send `sub_line`', async () => {
    // The source app spells it `sub_line`; this port spells it `subline`
    // and has since it shipped. One fact, one key — sending both is the
    // drift this whole file is about.
    const teams = await provider.listTeams();
    for (const t of teams) {
      expect(t.certification).toHaveProperty('subline');
      expect(t.certification).not.toHaveProperty('sub_line');
    }
  });
});
