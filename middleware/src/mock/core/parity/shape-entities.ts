// THE SHAPE TABLE — one row per table whose fixture is checked against the DDL.
//
// The sibling of `./entities.ts`. That table compares mock rows to seed rows;
// this one compares mock rows to the shape `schema/*.sql` declares, because
// two seeded domains cannot be covered by a row comparison alone:
//
//   * ASSESSMENT has no seed at all. There is no `INSERT INTO assessment_*`
//     in the repo — `schema/assessment_schema.sql` is DDL, and its header says
//     the ids are the mock's. Every one of the fifteen registered
//     `assessment-*` fixtures IS the seed for its table, so the only thing the
//     SQL can hold it to is the shape: which columns exist, which cannot be
//     null, which type each is, and — where a `CHECK (col IN (…))` is written
//     — what the column is allowed to say. That last one is the canonical
//     assessment defect (`enterprise` vs `enterprise_context`) in the one form
//     a database can refuse.
//
//   * IDENTITY seeds four columns of `app_users` and two of `tenants`, so
//     `./columns.ts` — which derives its column set from the INSERTs — cannot
//     see `session_epoch`, `external_sub`, `status` or `settings` at all. The
//     seeded row still holds the DDL default for each, and
//     `providers/identity.ts` opens by claiming to be "an in-memory mirror of
//     the seed data". Nothing checked the half of that claim the INSERTs don't
//     spell out.
//
// ADDING A ROW. Name the table, hand `mockRows` the fixture flattened INTO the
// table's shape (one row per table row, keys spelled as the columns are), and
// let `./shape.ts` derive the rest. A column the fixture models nothing for
// goes in `unmodelledColumns` WITH A REASON; a key that is no column of the
// table goes in `extraKeys` WITH A REASON; an accepted value disagreement goes
// in `knownDrift` WITH A REASON, `DEFECT:`-prefixed when it is a bug rather
// than a difference. All three are printed on every run and all three fail
// when they go stale.

import type { ShapeEntity } from './shape.js';

// ── flattening helpers ────────────────────────────────────────────────────────
//
// A fixture row is not always a table row: `assessment-scores` holds one row
// per TEAM carrying a map of 17 dimensions, each with its evidence, follow-ups
// and history nested inside. The table has five tables' worth of rows in there.
// These helpers do the un-nesting in one place so each entity below reads as
// "the table, from the fixture" rather than as a comprehension.

type Row = Record<string, unknown>;

const assessment = () => import('../../assessment.js');

/** Every (team, dimension) score row, with the team id its fixture row carries. */
async function dimensionRows(): Promise<Row[]> {
  const { scoresFixture } = await assessment();
  return scoresFixture.rows('default').flatMap((t) =>
    Object.values(t.dimensions).map((d) => ({ team_id: t.team_id, ...d } as unknown as Row)));
}

// ── the table ─────────────────────────────────────────────────────────────────

/**
 * The registered `assessment-*` fixtures that get NO row above, and why. The
 * partition has to be total: an assessment fixture is the only seed its data
 * has, so one that is silently outside the shape table is data nothing checks
 * at all. `schema-shape.test.ts` walks the live registry against this map and
 * the table below, and fails on anything in neither.
 */
export const FIXTURES_WITHOUT_A_TABLE: Record<string, string> = {
  'assessment-archetypes':
    'The N/A archetype registry (ARCHETYPES) is reference data with no table — `assessment_teams.archetype` stores the chosen key as bare TEXT and the schema deliberately does not constrain it, because the registry is configuration a deployment supplies.',
  'assessment-motions':
    'Motions are not their own table: they live inside `assessment_configuration.motions` (jsonb), and the configuration fixture hands over its own copy of these rows rather than typing them twice — so they are checked through the `assessment_configuration` row above.',
};


export const SHAPE_ENTITIES: Array<ShapeEntity<any>> = [
  // ── identity & tenancy (schema/identity_schema.sql) ────────────────────────
  {
    name: 'tenants (shape)',
    describes: 'The two tenants the BFF serves, against the columns the seeded row really ends up holding.',
    sqlFile: 'identity_schema.sql',
    table: 'tenants',
    mockRows: async () => (await import('../../../providers/identity.js')).listTenants(),
    mockId: (t: { id: string }) => t.id,
    unmodelledColumns: {
      settings:
        'The seed never writes it and no read path in the middleware ever selects it — `settings` exists for a future per-tenant config blob. A fallback that invented `settings: {}` would be claiming a shape nothing serves.',
      created_at:
        'A tenant\'s creation instant is not on TenantInfo and no surface renders it; the DDL default is NOW(), so there is no fixed value a fixture could mirror anyway.',
    },
  },
  {
    name: 'app_users (shape)',
    describes: 'The sign-in cast against app_users — including the two columns the seed INSERT never names.',
    sqlFile: 'identity_schema.sql',
    table: 'app_users',
    mockRows: async () => (await import('../../../providers/identity.js')).listUsers(),
    mockId: (u: { id: string }) => u.id,
    // `session_epoch` is the whole reason this row exists: it is the column the
    // ≤120s replay window is enforced on, no INSERT names it, and the mock
    // calls it `epoch` — so neither the column check nor camelCase finds it.
    columnKey: { session_epoch: 'epoch' },
    unmodelledColumns: {
      external_sub:
        'The IdP subject, filled on first SSO login (routes/auth.ts links by external_sub then email). Every seeded user is a picker-login user, so the seeded row holds NULL — and a fallback that invented one would make a user look already-linked to a Cognito pool that is minted fresh on every rebuild.',
      created_at:
        'Not on UserInfo and rendered nowhere; the DDL default is NOW(), so there is no fixed value to mirror.',
    },
    extraKeys: {
      grants:
        'The user\'s tenant→roles map, which is `user_tenant_roles` — its own table, checked by the `user_tenant_roles (shape)` row below and by the `user_tenant_roles` row in the seed table.',
    },
  },
  {
    name: 'user_tenant_roles (shape)',
    describes: 'The grants the session cookie carries, flattened out of each user into the join table\'s own shape.',
    sqlFile: 'identity_schema.sql',
    table: 'user_tenant_roles',
    mockRows: async () => {
      const { listUsers } = await import('../../../providers/identity.js');
      const out: Row[] = [];
      for (const u of await listUsers()) {
        for (const [tenant, roles] of Object.entries(u.grants)) {
          for (const role of roles as string[]) out.push({ user_id: u.id, tenant_id: tenant, role });
        }
      }
      return out;
    },
    mockId: (g: { user_id: string; tenant_id: string; role: string }) => `${g.user_id}@${g.tenant_id}:${g.role}`,
    unmodelledColumns: {
      granted_at:
        'When a grant was made is not on the wire — `Grants` is tenant → role[] and nothing renders a grant date. The DDL default is NOW(), so there is no fixed instant to mirror.',
    },
  },

  // ── the assessment tenant (schema/assessment_schema.sql — DDL, no seed) ────
  {
    name: 'assessment_teams',
    fixture: 'assessment-teams',
    describes: 'The seven-team cast every assessment surface renders, against the table that would store it.',
    sqlFile: 'assessment_schema.sql',
    table: 'assessment_teams',
    mockRows: async () => (await assessment()).teamsFixture.rows('default'),
    mockId: (t: { id: string }) => t.id,
    unmodelledColumns: {
      status:
        'Deliberately never stored. A team\'s status is `deriveTeamStatus(dimensions)` at read time — typing it beside the scores is how a team shipped reading "New · 17/17 assessed". The column\'s own default is `\'active\'`, which is not even one of the three values the portal can render, so the fixture carrying it would be worse than carrying nothing.',
    },
    extraKeys: {
      exceptions:
        'The team\'s N/A exceptions, which are their own table (`assessment_team_exceptions`) precisely because they carry an approval workflow — checked by the row below.',
    },
  },
  {
    name: 'assessment_team_exceptions',
    fixture: 'assessment-teams',
    describes: 'N/A exceptions, flattened off the teams they hang from — the approval workflow N/A is never self-granting through.',
    sqlFile: 'assessment_schema.sql',
    table: 'assessment_team_exceptions',
    mockRows: async () => (await assessment()).teamsFixture.rows('default')
      .flatMap((t) => (t.exceptions ?? []).map((e) => ({ team_id: t.id, ...e } as unknown as Row))),
    mockId: (e: { team_id: string; dimension_id: string }) => `${e.team_id}:${e.dimension_id}`,
    unmodelledColumns: {
      requested_by:
        'Who staged the claim, added to back the "never the assessor who proposed it" self-approval refusal in patchException. Optional on TeamException by design — the seeded exceptions predate the field, and inventing a requester would invent the very identity that rule turns on.',
    },
    knownDrift: {
      approved_at:
        'The fixture stores the WIRE shape, not the column: an exception nobody has approved carries `\'\'`, and the Aurora row-mapper deliberately normalizes a NULL approved_at to `\'\'` on the way out (providers/assessment-aurora.ts:67) so both paths hand the portal the same empty string. `\'\'` is not a TIMESTAMPTZ any Postgres would accept, which is exactly why the mapper exists.',
    },
  },
  {
    name: 'assessment_dimension_scores',
    fixture: 'assessment-scores',
    describes: 'The current (team, dimension) sheet — 17 dimensions per assessed team, un-nested from the per-team fixture row.',
    sqlFile: 'assessment_schema.sql',
    table: 'assessment_dimension_scores',
    mockRows: dimensionRows,
    mockId: (d: { team_id: string; dimension_id: string }) => `${d.team_id}/${d.dimension_id}`,
    extraKeys: {
      evidence:
        'The excerpts a scoring pass used, which are `assessment_evidence` rows with `scored = TRUE` — their own table, checked by the `assessment_evidence (scored)` row below.',
      follow_up_questions:
        'Its own table (`assessment_follow_up_questions`), nested here only because a dimension sheet renders them together. Checked by its own row below.',
      history:
        'Its own append-only table (`assessment_dimension_history`), nested here for the same rendering reason. Checked by its own row below.',
    },
  },
  {
    name: 'assessment_evidence (scored)',
    fixture: 'assessment-scores',
    describes: 'Evidence a scoring pass used, nested under the dimension it supports — half of one table with two fixtures.',
    sqlFile: 'assessment_schema.sql',
    table: 'assessment_evidence',
    mockRows: async () => (await dimensionRows())
      .flatMap((d) => (d['evidence'] as Row[]).map((e) => ({ team_id: d['team_id'], ...e }))),
    mockId: (e: { evidence_id: string }) => e.evidence_id,
    unmodelledColumns: {
      title:
        'Intake metadata, carried only on `EvidenceLogItem` (the un-scored half of this table) so the provenance ledger has something better than a raw excerpt to show. Scored evidence is read through its dimension, which supplies the heading.',
      captured_by:
        'Same: intake metadata on the log side. Scored evidence carries its `source_ref`, which is the provenance id the ledger resolves a capturer from.',
    },
  },
  {
    name: 'assessment_evidence (intake log)',
    fixture: 'assessment-evidence-log',
    describes: 'The un-scored intake queue — the other author of assessment_evidence, and the fixture the status vocabulary was corrected for.',
    sqlFile: 'assessment_schema.sql',
    table: 'assessment_evidence',
    mockRows: async () => (await assessment()).evidenceLogFixture.rows('default')
      .flatMap((r) => r.items.map((i) => ({ team_id: r.team_id, ...i } as unknown as Row))),
    mockId: (e: { evidence_id: string }) => e.evidence_id,
    unmodelledColumns: {
      title:
        'Optional intake metadata on EvidenceLogItem, populated only by the intake form (POST /evidence). All three seeded log items predate the field, and a title invented here would be a heading the provenance ledger renders as if a person had typed it.',
      captured_by:
        'Same: filled by the intake form from the session, so a seeded value would name a capturer who never captured anything. The seeded items carry `source_ref` instead, which resolves to a real provenance row.',
    },
  },
  {
    name: 'assessment_follow_up_questions',
    fixture: 'assessment-scores',
    describes: 'Open questions a scoring pass raised — the rows the feedback queue synthesizes its virtual tasks from.',
    sqlFile: 'assessment_schema.sql',
    table: 'assessment_follow_up_questions',
    mockRows: async () => (await dimensionRows())
      .flatMap((d) => (d['follow_up_questions'] as Row[]).map((q) => ({ team_id: d['team_id'], ...q }))),
    mockId: (q: { question_id: string }) => q.question_id,
    unmodelledColumns: {
      created_at:
        'A follow-up is rendered inside the dimension that raised it and ordered by the scoring log that minted it, never by its own age — `FollowUpQuestion` has no timestamp, and the DDL default is NOW(), so there is no fixed instant to mirror.',
    },
  },
  {
    name: 'assessment_dimension_history',
    fixture: 'assessment-scores',
    describes: 'The append-only trail behind "How it was assessed" — every level change, with the evidence that moved it.',
    sqlFile: 'assessment_schema.sql',
    table: 'assessment_dimension_history',
    mockRows: async () => (await dimensionRows())
      .flatMap((d, di) => (d['history'] as Row[]).map((h, hi) => ({
        team_id: d['team_id'], dimension_id: d['dimension_id'], _at: `${di}.${hi}`, ...h,
      }))),
    // The table's own id is a BIGSERIAL the fixture cannot mint; a history
    // entry is addressed by the dimension it belongs to and its position in
    // that dimension's trail, which is how the portal renders it too.
    mockId: (h: { team_id: string; dimension_id: string; _at: string }) =>
      `${h.team_id}/${h.dimension_id}#${h._at.split('.')[1]}`,
    unmodelledColumns: {
      id:
        'A BIGSERIAL the database mints. A fixture that carried one would be inventing a sequence value, and nothing addresses a history entry by it — the portal reads a dimension\'s trail in order.',
      na_claimed:
        'Records an N/A CLAIM independent of `is_na` (N/A is never self-granting, so a claim with no approved exception leaves is_na false). Optional on DimensionHistoryEntry for backward compatibility, and every seeded entry predates it; the column\'s NOT NULL DEFAULT FALSE is exactly what an absent claim means.',
    },
    extraKeys: {
      _at:
        'Not a column: the harness\'s own positional address for a history entry, since the table keys them on a BIGSERIAL no fixture can mint.',
    },
  },
  {
    name: 'assessment_provenance',
    fixture: 'assessment-provenance',
    describes: 'Where each piece of evidence came from — the ledger the Evidence tab reads.',
    sqlFile: 'assessment_schema.sql',
    table: 'assessment_provenance',
    mockRows: async () => (await assessment()).provenanceFixture.rows('default')
      .flatMap((r) => r.records.map((p) => ({ team_id: r.team_id, ...p } as unknown as Row))),
    mockId: (p: { provenance_id: string }) => p.provenance_id,
  },
  {
    name: 'assessment_submissions',
    fixture: 'assessment-submissions',
    describes: 'Forms envelopes, stored whole with the columns the list and the commit path filter on lifted out.',
    sqlFile: 'assessment_schema.sql',
    table: 'assessment_submissions',
    mockRows: async () => (await assessment()).submissionsFixture.rows('default'),
    mockId: (e: { envelope_id: string }) => e.envelope_id,
    // The column really is a lift, not a second copy: the DDL comments it as
    // "lifted from envelope.source.form_submission_id", and the unique index
    // that enforces one committed envelope per (team, form) is built on it.
    columnValue: {
      form_submission_id: (e: { source?: { form_submission_id?: string } }) => e.source?.form_submission_id ?? null,
    },
    unmodelledColumns: {
      envelope:
        'This row IS the envelope — the column stores the whole `SubmissionEnvelope` the fixture row is, so a fixture field mirroring it would be the row nested inside itself.',
    },
    extraKeys: {
      schema_version: 'Inside the stored `envelope` blob, not a lifted column: nothing filters or joins on it.',
      source: 'The envelope\'s origin block. Only its `form_submission_id` is lifted to a column (for the one-committed-envelope-per-form unique index); the rest stays in the blob.',
      team_name_raw: 'The team name exactly as the Forms submitter typed it, kept in the envelope for provenance. The joinable id is `team_id`, which IS a column.',
      dimension_hints: 'The self-assessment answers, read as a unit and never queried by field — which is the stated reason the envelope is stored whole.',
    },
  },
  {
    name: 'assessment_runs',
    fixture: 'assessment-runs',
    describes: 'The Activity ledger — every agent run, who launched it, and what it wrote.',
    sqlFile: 'assessment_schema.sql',
    table: 'assessment_runs',
    mockRows: async () => (await assessment()).runsFixture.rows('default'),
    mockId: (r: { id: string }) => r.id,
    unmodelledColumns: {
      launched_by:
        'The session sub, and the DDL comment says "never the body" — it is attribution the server stamps from the cookie at launch. A seeded run has no session behind it, so a fixture value here would be a fabricated actor on an audit column.',
    },
  },
  {
    name: 'assessment_scoring_logs',
    fixture: 'assessment-scoring-logs',
    describes: 'What a scoring pass concluded per dimension, kept whole so "How it was assessed" can replay it.',
    sqlFile: 'assessment_schema.sql',
    table: 'assessment_scoring_logs',
    mockRows: async () => (await assessment()).scoringLogsFixture.rows('default'),
    mockId: (l: { team_id: string; stamp: string }) => `${l.team_id}@${l.stamp}`,
    unmodelledColumns: {
      run_id:
        'The agent run that produced the log, when there was one. Optional on ScoringLog by design: none of the seeded logs has a run behind it, and pointing one at a seeded run id would assert a lineage that never happened.',
      created_at:
        'A log is addressed and ordered by its `stamp`, which is its creation instant in the id\'s own format; `created_at` is the database\'s copy of the same thing, defaulted to NOW().',
    },
  },
  {
    name: 'assessment_feedback_tasks',
    fixture: 'assessment-feedback',
    describes: 'The stored half of the HITL queue — the provider still synthesizes a virtual task per OPEN follow-up at read time.',
    sqlFile: 'assessment_schema.sql',
    table: 'assessment_feedback_tasks',
    mockRows: async () => (await assessment()).feedbackFixture.rows('default'),
    mockId: (t: { task_id: string }) => t.task_id,
    unmodelledColumns: {
      resolved_by:
        'Who closed the task, stamped from the session at resolve time. FeedbackTask carries the response text but not the responder; a seeded value would attribute a resolution to someone who never made one.',
    },
  },
  {
    name: 'assessment_knowledge_sections',
    fixture: 'assessment-knowledge-sections',
    describes: 'The four knowledge rails — and the fixture whose key spelling (`enterprise_context`) is the canonical wire bug.',
    sqlFile: 'assessment_schema.sql',
    table: 'assessment_knowledge_sections',
    mockRows: async () => (await assessment()).knowledgeSectionsFixture.rows('default'),
    mockId: (s: { key: string }) => s.key,
    unmodelledColumns: {
      position:
        'The rail\'s order, which the fixture expresses as array order — the one place where the list itself is the ordering. A stored position beside an ordered array is a second source of truth for the same fact, and the mock floor\'s first rule is that nothing countable from the rows is stored beside them.',
    },
    extraKeys: {
      nodes:
        'The section\'s tree, which is `assessment_knowledge_nodes` — its own table, nested here because a rail is fetched whole. Checked by the row below.',
    },
  },
  {
    name: 'assessment_knowledge_nodes',
    fixture: 'assessment-knowledge-sections',
    describes: 'The knowledge tree itself, flattened out of the rails — 27 nodes across four sections.',
    sqlFile: 'assessment_schema.sql',
    table: 'assessment_knowledge_nodes',
    mockRows: async () => (await assessment()).knowledgeSectionsFixture.rows('default')
      .flatMap((s) => s.nodes.map((n) => ({ section_key: s.key, ...n } as unknown as Row))),
    mockId: (n: { id: string }) => n.id,
    unmodelledColumns: {
      position:
        'Sibling order, which the fixture expresses as the order of `nodes` within its section — same argument as the section rail above: an ordered array plus a stored index is two sources for one fact.',
      version:
        'Added for the Aurora path of publishKnowledgeDoc, which increments it in place on a re-publish. The mock provider keeps the same counter in memory (`publishedVersions`) rather than on the node, so a seeded value here would be a starting count the mock does not read.',
    },
  },
  {
    name: 'assessment_knowledge_docs',
    fixture: 'assessment-knowledge-docs',
    describes: 'The 18 documents behind the knowledge rails, with the markdown each editor opens.',
    sqlFile: 'assessment_schema.sql',
    table: 'assessment_knowledge_docs',
    mockRows: async () => (await assessment()).knowledgeDocsFixture.rows('default'),
    mockId: (d: { id: string }) => d.id,
  },
  {
    name: 'assessment_knowledge_comments',
    fixture: 'assessment-knowledge-comments',
    describes: "The comment thread on a document — the rows GET /knowledge/doc/comments returns.",
    sqlFile: 'assessment_schema.sql',
    table: 'assessment_knowledge_comments',
    mockRows: async () => (await assessment()).knowledgeCommentsFixture.rows('default'),
    mockId: (c: { id: string }) => c.id,
    unmodelledColumns: {
      deleted_at:
        'A soft delete, set by DELETE /knowledge/doc/comment. Deliberately not seeded: a tombstone in the seed is a comment nobody ever wrote, and the state is one POST plus one DELETE away for anyone who wants to see how the panel renders it.',
    },
  },
  {
    name: 'assessment_knowledge_doc_versions',
    fixture: 'assessment-knowledge-versions',
    describes: 'The snapshot taken before every save — the version list a doc\'s history panel renders.',
    sqlFile: 'assessment_schema.sql',
    table: 'assessment_knowledge_doc_versions',
    mockRows: async () => (await assessment()).knowledgeVersionsFixture.rows('default')
      .flatMap((r) => r.versions.map((v) => ({ doc_id: r.doc_id, ...v } as unknown as Row))),
    mockId: (v: { doc_id: string; stamp: string }) => `${v.doc_id}@${v.stamp}`,
    unmodelledColumns: {
      size:
        'Deliberately not stored — it is a count of bytes the same row already carries. The seeded snapshots said 210 B and 340 B over 61 and 130 bytes of markdown and the version list rendered those numbers verbatim; `docVersionOut` now derives it from `markdown.length`, so the number cannot be wrong. This is the mock floor\'s "no typed aggregate beside the rows it counts" rule, and the column is the aggregate.',
      saved_by:
        'Who saved the snapshot, stamped from the session on write. The seeded history has no session behind it, so a value here would attribute an edit to someone who never made one.',
    },
  },
  {
    name: 'assessment_configuration',
    fixture: 'assessment-configuration',
    describes: 'The single programme configuration row — the certification target and the three motions.',
    sqlFile: 'assessment_schema.sql',
    table: 'assessment_configuration',
    mockRows: async () => (await assessment()).configurationFixture.rows('default'),
    mockId: () => 'default',
    unmodelledColumns: {
      key:
        'The table holds exactly one row, keyed `\'default\'` by the column\'s own DEFAULT, and PUT /configuration replaces it wholesale. The fixture is that one row, so there is no second row a key could distinguish it from.',
    },
  },
  {
    name: 'assessment_stories',
    fixture: 'assessment-stories',
    describes: 'Story drafts written from a recommendation. Jira push is withheld in both apps, so jira_key stays NULL.',
    sqlFile: 'assessment_schema.sql',
    table: 'assessment_stories',
    mockRows: async () => (await assessment()).storiesFixture.rows('default'),
    mockId: (s: { filename: string }) => s.filename,
  },
  {
    name: 'assessment_rubric_dimensions',
    describes: 'The 17-dimension rubric every score is expressed against — static reference data, versioned so a score can name what it was scored against.',
    sqlFile: 'assessment_schema.sql',
    table: 'assessment_rubric_dimensions',
    // Every version's rows, not just the current one: the table holds them all
    // side by side, which is what `PRIMARY KEY (rubric_version, id)` is for.
    // `RUBRIC_DIMENSIONS` is the current version alone — the right answer for a
    // caller scoring a team, and a subset of this table.
    mockRows: async () => (await assessment()).allRubricDimensions(),
    mockId: (d: { rubric_version: string; id: string }) => `${d.rubric_version}/${d.id}`,
  },
];
