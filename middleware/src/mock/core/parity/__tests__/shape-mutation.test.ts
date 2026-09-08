// PROVING THE SHAPE CHECKS CAN FAIL.
//
// The sibling of value-parity.test.ts, and it exists for the same reason: the
// shape table is green against the live fixtures, and green proves nothing on
// its own. Every check ../shape.ts makes is asserted here by breaking one
// value and requiring the failure to NAME the column and BOTH values.
//
// It matters more here than anywhere else in the harness, because the
// assessment tenant has no seed to fall back on. If `auditShape` were ever
// weakened into passing everything, nothing else in the repo would notice:
// there is no second source for `assessment_*` to disagree with.

jest.mock('../../../../providers/aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../../../config.js', () => ({
  config: {
    mock: { aurora: true, cloudwatch: true, guardrails: false, agentcore: true },
    region: 'us-east-1',
    aurora: {},
  },
}));

import { SHAPE_ENTITIES } from '../shape-entities.js';
import { auditShape, describeShape, describeShapeDrift, type ShapeEntity } from '../shape.js';
import { defaultedColumns, tableShape } from '../ddl.js';
import { SURFACE_INVARIANTS } from '../invariants.js';

const entityNamed = (name: string): ShapeEntity<any> => {
  const found = SHAPE_ENTITIES.find((e) => e.name === name);
  if (!found) throw new Error(`no shape entity named '${name}' — this test is stale`);
  return found;
};

/** The same entity, with its rows perturbed. Everything else is the real thing. */
function withRows<M>(entity: ShapeEntity<M>, mutate: (rows: M[]) => M[]): ShapeEntity<M> {
  return {
    ...entity,
    mockRows: async () => mutate((await entity.mockRows()).map((r) => ({ ...r }))),
  };
}

const fail = async (entity: ShapeEntity<any>): Promise<string> => {
  const message = describeShape(entity, await auditShape(entity));
  if (message === null) throw new Error(`${entity.name}: the mutation produced NO failure — the check is not checking`);
  return message;
};

describe('the DDL reader reads the real CREATE TABLE', () => {
  it('takes a column vocabulary from its CHECK, not from a list in this file', () => {
    const status = tableShape('assessment_schema.sql', 'assessment_evidence')!
      .columns.find((c) => c.name === 'status')!;
    expect(status.vocabulary).toEqual(['PENDING', 'CLASSIFIED', 'SCORED']);
    expect(status.defaultValue).toBe('PENDING');
    expect(status.notNull).toBe(true);
  });

  it('sees a column added by ALTER TABLE, not only the ones in CREATE TABLE', () => {
    // `assessment_knowledge_nodes.version` and `app_users.session_epoch` are
    // both ALTER-added — and a column newer than the CREATE TABLE is exactly
    // the column most likely to be newer than the fixture.
    const version = tableShape('assessment_schema.sql', 'assessment_knowledge_nodes')!
      .columns.find((c) => c.name === 'version');
    expect(version?.defaultValue).toBe(1);
    const epoch = tableShape('identity_schema.sql', 'app_users')!
      .columns.find((c) => c.name === 'session_epoch');
    expect(epoch?.defaultValue).toBe(0);
  });

  it('knows which columns the seed leaves to their DEFAULT, and which tables have no seed', () => {
    expect(defaultedColumns('identity_schema.sql', 'app_users').map((c) => c.name))
      .toContain('session_epoch');
    // The assessment tenant has no INSERT at all, so "the default the seed
    // relies on" is not a thing there — and claiming otherwise would make the
    // fixtures answer to defaults no seed ever exercises.
    expect(defaultedColumns('assessment_schema.sql', 'assessment_teams')).toEqual([]);
  });
});

describe('a value the column could not hold fails, naming both', () => {
  it('catches a status outside the CHECK vocabulary, and quotes the vocabulary', async () => {
    // The canonical assessment defect in the form a database can refuse: the
    // lowercase spelling that used to be this column's unreachable default.
    const log = entityNamed('assessment_evidence (intake log)');
    const broken = await fail(withRows(log, (rows) => rows.map((r, i) => (i === 0 ? { ...r, status: 'pending' } : r))));
    expect(broken).toContain('[vocabulary]');
    expect(broken).toContain('status');
    expect(broken).toContain("'pending'");
    expect(broken).toContain("'PENDING', 'CLASSIFIED', 'SCORED'");
    expect(broken).toContain('assessment_schema.sql:');
  });

  it('catches a NOT NULL column holding null', async () => {
    const teams = entityNamed('assessment_teams');
    const broken = await fail(withRows(teams, (rows) => rows.map((r, i) => (i === 0 ? { ...r, name: null } : r))));
    expect(broken).toContain('[not-null]');
    expect(broken).toContain('TEAM-001');
    expect(broken).toContain('name is null on the mock row');
    expect(broken).toContain('NOT NULL');
  });

  it('catches a value of the wrong type for the column that would store it', async () => {
    // `''` in a TIMESTAMPTZ — the real shape of the one drift this table
    // tolerates (assessment_team_exceptions.approved_at), proven here on a
    // column where it is not tolerated.
    const runs = entityNamed('assessment_runs');
    const broken = await fail(withRows(runs, (rows) => rows.map((r, i) => (i === 0 ? { ...r, started_at: '' } : r))));
    expect(broken).toContain('[type]');
    expect(broken).toContain('started_at');
    expect(broken).toContain('TIMESTAMPTZ');

    const teams = entityNamed('assessment_teams');
    const wrongType = await fail(withRows(teams, (rows) => rows.map((r, i) => (i === 0 ? { ...r, workflow_step: '4' } : r))));
    expect(wrongType).toContain('is not an integer');
    expect(wrongType).toContain("'4'");
  });

  it('catches a mock value that disagrees with the DEFAULT the seed leaves in place', async () => {
    // The identity gap this whole module was added for: no INSERT names
    // `session_epoch`, so nothing in ../columns.ts can see it, and it is the
    // column the ≤120s session-replay window is enforced on.
    const users = entityNamed('app_users (shape)');
    const broken = await fail(withRows(users, (rows) => rows.map((r, i) => (i === 0 ? { ...r, epoch: 3 } : r))));
    expect(broken).toContain('[seeded-default]');
    expect(broken).toContain('session_epoch');
    expect(broken).toContain('DEFAULT 0');
    expect(broken).toContain('the mock holds 3');
  });
});

describe('a column or key nobody declared fails', () => {
  it('names a column the table declares and the fixture stops carrying', async () => {
    const stories = entityNamed('assessment_stories');
    const broken = await fail(withRows(stories, (rows) => rows.map(({ jira_key: _drop, ...rest }: any) => rest)));
    expect(broken).toContain('models NOTHING for');
    expect(broken).toContain('jira_key');
    expect(broken).toContain('nullable');
    expect(broken).toContain('assessment_schema.sql:');
  });

  it('names a key the fixture invents that the table has no column for', async () => {
    // The `enterprise` / `enterprise_context` class, one level up: a field
    // that exists only in the fixture's imagination.
    const stories = entityNamed('assessment_stories');
    const broken = await fail(withRows(stories, (rows) => rows.map((r: any) => ({ ...r, sprint_id: 'sp-1' }))));
    expect(broken).toContain('NO column for');
    expect(broken).toContain('sprint_id');
  });
});

describe('an exemption that has outlived its problem fails', () => {
  const reason = 'a reason long enough to read as deliberate, and no longer true of anything';

  it('rejects an unmodelledColumns entry for a column the fixture models', async () => {
    const stories = entityNamed('assessment_stories');
    const broken = await fail({ ...stories, unmodelledColumns: { title: reason } });
    expect(broken).toContain('OUTLIVED');
    expect(broken).toContain("unmodelledColumns['title']");
    expect(broken).toContain('AND modelled');
  });

  it('rejects an unmodelledColumns entry for a column the table no longer declares', async () => {
    const stories = entityNamed('assessment_stories');
    const broken = await fail({ ...stories, unmodelledColumns: { column_that_never_existed: reason } });
    expect(broken).toContain('no longer declares');
  });

  it('rejects an exemption with no usable reason', async () => {
    const stories = entityNamed('assessment_stories');
    const broken = await fail({ ...stories, unmodelledColumns: { jira_key: 'later' } });
    expect(broken).toContain('no usable reason');
  });

  it('rejects an extraKeys entry no row carries, and a knownDrift nothing violates', async () => {
    const stories = entityNamed('assessment_stories');
    expect(await fail({ ...stories, extraKeys: { nothing_carries_this: reason } }))
      .toContain('no mock row carries any more');
    expect(await fail({ ...stories, knownDrift: { status: reason } }))
      .toContain('no longer happens');
  });
});

describe('knownDrift moves a disagreement into the roll-up rather than hiding it', () => {
  it('reports the tolerated value with both sides and its reason', async () => {
    const log = entityNamed('assessment_evidence (intake log)');
    const tolerated: ShapeEntity<any> = {
      ...withRows(log, (rows) => rows.map((r, i) => (i === 0 ? { ...r, status: 'pending' } : r))),
      knownDrift: { status: 'a documented reason long enough to pass the floor, for this test only' },
    };
    const audit = await auditShape(tolerated);
    expect(describeShape(tolerated, audit)).toBeNull();
    // Tolerated, but never silent: the roll-up still quotes the value.
    const drift = describeShapeDrift(audit).join('\n');
    expect(drift).toContain("status = 'pending'");
    expect(drift).toContain('a documented reason long enough');
  });
});

describe('the assessment foreign-key invariant fails when a fixture invents an id', () => {
  const invariant = SURFACE_INVARIANTS.find((i) => i.name.startsWith('the assessment fixtures join'))!;
  const ctx = { app: async () => { throw new Error('this invariant needs no express app'); } } as never;

  it('catches a story pointing at a team that is on no roster', async () => {
    const { storiesFixture } = await import('../../../assessment.js');
    const rows = storiesFixture.rows('default');
    rows.push({ ...rows[0]!, filename: 'story-invented.md', team_id: 'TEAM-999' });
    try {
      const violations = await invariant.check(ctx);
      expect(violations.join('\n')).toContain("team_id 'TEAM-999' is in no team the roster carries");
      expect(violations.join('\n')).toContain('story-invented.md');
    } finally {
      storiesFixture.reset('default');
    }
  });

  it('catches a history entry citing evidence no fixture carries', async () => {
    const { scoresFixture } = await import('../../../assessment.js');
    const dim = Object.values(scoresFixture.rows('default')[0]!.dimensions).find((d) => d.history.length > 0)!;
    dim.history[0]!.evidence_ids.push('EV-neverwas');
    try {
      const violations = await invariant.check(ctx);
      expect(violations.join('\n')).toContain("history cites evidence 'EV-neverwas'");
    } finally {
      scoresFixture.reset('default');
    }
  });

  it('catches a scoring log naming an envelope no submission carries', async () => {
    const { scoringLogsFixture } = await import('../../../assessment.js');
    scoringLogsFixture.rows('default')[0]!.envelope_id = 'sub-neverwas';
    try {
      const violations = await invariant.check(ctx);
      expect(violations.join('\n')).toContain("names envelope 'sub-neverwas'");
    } finally {
      scoringLogsFixture.reset('default');
    }
  });

  it('refuses to pass vacuously over an empty corpus', async () => {
    // The most convincing false green there is: a cross-surface rule that
    // holds because it had nothing to check, and reads in the report exactly
    // like one that holds because the data agrees.
    //
    // Emptied by splicing the live default rows rather than by switching the
    // registry to its `empty` scenario, because the invariant reads
    // `rows('default')` explicitly — a scenario switch would leave it looking
    // at a full corpus and prove nothing. `resetAll()` rebuilds every fixture
    // from its factory afterwards.
    const { fixtureRegistry } = await import('../../fixture.js');
    const assessmentFixtures = fixtureRegistry.all().filter((f) => f.key.startsWith('assessment-'));
    expect(assessmentFixtures.length).toBeGreaterThan(10);
    try {
      for (const f of assessmentFixtures) f.rows('default').splice(0);
      const violations = await invariant.check(ctx);
      expect(violations.join('\n')).toContain('near-vacuous');
      expect(violations.join('\n')).toContain('0 teams');
    } finally {
      fixtureRegistry.resetAll();
    }
  });
});
