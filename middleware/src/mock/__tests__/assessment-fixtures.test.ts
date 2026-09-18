// The assessment tenant on the mock floor.
//
// Three properties, one per class of bug the floor exists to close
// (src/mock/core/contract.ts):
//
//   1. Nothing countable is stored. A team's status and a doc version's size
//      are derived; both shipped wrong when they were fields.
//   2. Every scenario a surface needs is DECLARED. An undeclared `empty` is
//      not empty — it silently falls back to `default` — so "pin it to empty
//      and audit the empty state" has to be asserted, not assumed.
//   3. Timestamps are sampled when the rows are built, not at import.

import { freezeClock, fixtureRegistry } from '../core/index.js';
import * as M from '../assessment.js';

afterEach(() => {
  fixtureRegistry.resetAll('default');
});

describe('registration', () => {
  const KEYS = [
    'assessment-archetypes', 'assessment-teams', 'assessment-scores',
    'assessment-provenance', 'assessment-evidence-log', 'assessment-submissions',
    'assessment-runs', 'assessment-scoring-logs', 'assessment-feedback',
    'assessment-knowledge-sections', 'assessment-knowledge-docs',
    'assessment-knowledge-versions', 'assessment-motions',
    'assessment-configuration', 'assessment-stories',
  ];

  it('every collection is in the registry, so the control plane can reach it', () => {
    const registered = new Set(fixtureRegistry.all().map((f) => f.key));
    for (const key of KEYS) expect(registered.has(key)).toBe(true);
  });

  it('every fixture that has an empty state DECLARES it — an undeclared one is not empty', () => {
    // The one deliberate exception is the configuration: a tenant with nothing
    // in it still has a target level, so its `empty` keeps the row and drops
    // the motions instead. Assert that too, rather than exempting it silently.
    for (const key of KEYS) {
      const fixture = fixtureRegistry.get(key)!;
      if (key === 'assessment-configuration') {
        expect(fixture.rows('empty')).toHaveLength(1);
        expect(M.configurationFixture.rows('empty')[0]!.motions).toEqual([]);
        continue;
      }
      expect(fixture.rows('empty')).toEqual([]);
    }
  });

  it('`error` on the knowledge tree fails loudly rather than reading as "nothing synced"', () => {
    expect(() => M.knowledgeSectionsFixture.rows('error')).toThrow(/knowledge sync provider unavailable/);
  });

  it('`error` on the runs ledger is a fleet that is up and losing, not a thrown provider', () => {
    const failed = M.runsFixture.rows('error');
    expect(failed.length).toBeGreaterThan(0);
    expect(failed.every((r) => r.status !== 'completed')).toBe(true);
  });

  it('`error` on the roster, dimension scores, submissions, feedback and configuration tables fails loudly', () => {
    expect(() => M.teamsFixture.rows('error')).toThrow(/assessment_teams unavailable/);
    expect(() => M.scoresFixture.rows('error')).toThrow(/assessment_dimension_scores unavailable/);
    expect(() => M.submissionsFixture.rows('error')).toThrow(/assessment_submissions unavailable/);
    expect(() => M.feedbackFixture.rows('error')).toThrow(/assessment_feedback_tasks unavailable/);
    expect(() => M.configurationFixture.rows('error')).toThrow(/assessment_configuration unavailable/);
  });

  it('`large` gives the team list and the run ledger something to paginate', () => {
    expect(M.teamsFixture.rows('large').length).toBeGreaterThan(100);
    expect(M.runsFixture.rows('large').length).toBeGreaterThan(100);
    // Ids stay unique — a "large" world with duplicate keys tests nothing.
    const ids = M.teamsFixture.rows('large').map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('`fresh` is the cast with no history: every team reads NEW', () => {
    fixtureRegistry.resetAll('fresh');
    expect(M.teams().length).toBeGreaterThan(0);
    for (const team of M.teams()) expect(M.teamStatus(team.id)).toBe('NEW');
  });

  it('pinning teams to empty empties the roster and leaves the rubric alone', () => {
    expect(M.teamsFixture.rows('empty')).toEqual([]);
    // The rubric is reference data, not a fixture — 17 dimensions, always.
    expect(M.DIMENSION_IDS).toHaveLength(17);
  });
});

describe('no typed aggregates', () => {
  it('a team status is derived from its dimensions, not stored beside them', () => {
    for (const team of M.teams()) {
      expect(team.status).toBeUndefined();
      expect(['NEW', 'IN_PROGRESS', 'ASSESSED']).toContain(M.teamStatus(team.id));
    }
  });

  it('a team reading ASSESSED has every applicable dimension scored', () => {
    for (const team of M.teams()) {
      if (M.teamStatus(team.id) !== 'ASSESSED') continue;
      const dims = Object.values(M.scoresFor(team.id) ?? {});
      const applicable = dims.filter((d) => !d.is_na);
      expect(applicable.every((d) => d.current_level !== null)).toBe(true);
    }
  });

  it('a team reading NEW has nothing scored — the "New · 17/17" pairing cannot recur', () => {
    for (const team of M.teams()) {
      if (M.teamStatus(team.id) !== 'NEW') continue;
      const dims = Object.values(M.scoresFor(team.id) ?? {});
      expect(dims.filter((d) => d.current_level !== null || d.is_na)).toEqual([]);
    }
  });

  it('a doc version has no stored size; docVersionOut counts the markdown it ships', () => {
    for (const row of M.knowledgeVersionsFixture.rows()) {
      for (const version of row.versions) {
        expect(version).not.toHaveProperty('size');
        expect(M.docVersionOut(version).size).toBe(version.markdown.length);
      }
    }
  });

  it('the configuration serves the motions fixture, not a second copy of it', () => {
    expect(M.configuration().motions).toEqual(M.motions());
  });

  it('the run ledger counts its own statuses', () => {
    const counted = M.runCountsByStatus();
    let total = 0;
    for (const n of counted.values()) total += n;
    expect(total).toBe(M.runs().length);
  });
});

describe('the clock, not module load', () => {
  it('rows are stamped when the factory runs, so a frozen instant reaches them', () => {
    const restore = freezeClock('2026-03-04T00:05:00.000Z');
    try {
      M.runsFixture.reset();
      const run = M.runsFixture.rows().find((r) => r.started_at)!;
      expect(run.started_at.startsWith('2026-0')).toBe(true);
      expect(Date.parse(run.started_at)).toBeLessThanOrEqual(Date.parse('2026-03-04T00:05:00.000Z'));
    } finally {
      restore();
      M.runsFixture.reset();
    }
  });

  it('two freezes a day apart produce rows a day apart — nothing is baked at import', () => {
    const at = (iso: string): number => {
      const restore = freezeClock(iso);
      try {
        M.feedbackFixture.reset();
        return Date.parse(M.feedback()[0]!.created_at);
      } finally {
        restore();
      }
    };
    const day1 = at('2026-03-04T12:00:00.000Z');
    const day2 = at('2026-03-05T12:00:00.000Z');
    expect(day2 - day1).toBe(86_400_000);
    M.feedbackFixture.reset();
  });
});

describe('mutation and reset', () => {
  it('a write lands on the live rows and reset puts the seed back', () => {
    const before = M.teams().length;
    M.teams().push({
      id: 'TEAM-ZZZ', name: 'Scratch', cohort: 'general', workflow_step: 1,
      assessment_lead: '', contacts: [], repos: [], archetype: null,
      rubric_version: M.DEFAULT_RUBRIC_VERSION, exceptions: [],
      created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', contributors: [],
    });
    expect(M.findTeam('TEAM-ZZZ')).toBeDefined();
    M.teamsFixture.reset();
    expect(M.teams()).toHaveLength(before);
    expect(M.findTeam('TEAM-ZZZ')).toBeUndefined();
  });

  it('dropTeam takes every team-keyed fixture with it', () => {
    const id = 'TEAM-001';
    expect(M.scoresFor(id)).toBeDefined();
    expect(M.dropTeam(id)).toBe(true);
    expect(M.findTeam(id)).toBeUndefined();
    expect(M.scoresFor(id)).toBeUndefined();
    expect(M.provenanceFor(id)).toEqual([]);
    expect(M.submissionsFor(id)).toEqual([]);
    expect(M.scoringLogsFor(id)).toEqual([]);
    expect(M.storiesFor(id)).toEqual([]);
    fixtureRegistry.resetAll('default');
  });

  it('a read never creates a bucket — asking about an unknown team leaves the rows alone', () => {
    const before = M.provenanceFixture.rows().length;
    expect(M.provenanceFor('TEAM-NOPE')).toEqual([]);
    expect(M.evidenceLogFor('TEAM-NOPE')).toEqual([]);
    expect(M.provenanceFixture.rows()).toHaveLength(before);
  });
});

// A run id's middle field is a TIMESTAMP — `run-20260828T090211Z-…` — so the
// mock floor's rule about clock-derived timestamps applies to it just as much
// as to `started_at`. It used to be a literal baked into the string while
// `started_at` beside it came from the clock, so the two drifted by however
// long it had been since someone hand-edited the seed: on 2026-09-17 the
// Activity page showed `run-20260828…` labelled "7d ago" — thirteen days out,
// widening by a day every day. The `files_written` paths embed the same stamp.
describe('run ids carry the run\'s own time, not a baked one', () => {
  const stampOf = (id: string): string | null => /^run-(\d{8}T\d{6}Z)-/.exec(id)?.[1] ?? null;
  const isoToStamp = (iso: string): string => `${iso.slice(0, 19).replace(/[-:]/g, '')}Z`;

  it('every run id\'s stamp equals its own started_at', () => {
    const restore = freezeClock('2026-09-17T12:00:00.000Z');
    try {
      const runs = M.runs();
      expect(runs.length).toBeGreaterThan(0);
      for (const r of runs) {
        const stamp = stampOf(r.id);
        expect(stamp).not.toBeNull();
        expect(stamp).toBe(isoToStamp(r.started_at));
      }
    } finally { restore(); }
  });

  it('the stamps move with the clock — a literal would not', () => {
    // The actual regression: re-freeze a day later and the ids must follow.
    // A hardcoded id passes the test above on any single day and fails this.
    const first = (() => {
      const restore = freezeClock('2026-09-17T12:00:00.000Z');
      try { fixtureRegistry.resetAll('default'); return M.runs().map((r) => r.id); }
      finally { restore(); }
    })();
    const second = (() => {
      const restore = freezeClock('2026-09-18T12:00:00.000Z');
      try { fixtureRegistry.resetAll('default'); return M.runs().map((r) => r.id); }
      finally { restore(); }
    })();
    expect(second).not.toEqual(first);
    expect(second).toHaveLength(first.length);
  });

  it('a files_written path that carries a stamp carries the run\'s stamp', () => {
    const restore = freezeClock('2026-09-17T12:00:00.000Z');
    try {
      for (const r of M.runs()) {
        for (const f of r.files_written ?? []) {
          const m = /_(\d{8}T\d{6}Z)\./.exec(f);
          if (m) expect(m[1]).toBe(isoToStamp(r.started_at));
        }
      }
    } finally { restore(); }
  });
});

// ── Prompt docs say what their command actually does ────────────────────────
//
// All nine once shipped with the SAME 216-byte body — only the `# /name`
// heading differed — and that shared body asserted "Never persists a score
// directly", which is not a property seven of them have: they do not score at
// all. Nine copies of one sentence, wrong on most of them, on the surface
// whose whole job is to show what the accelerator's agents do.
//
// They were then replaced by nine hand-written summaries, one per command,
// which fixed the falsehood but were still a PARAGRAPH ABOUT the document
// rather than the document. The bodies are now the real command files from
// ~/Projects/agentic-assessment-accelerator/.claude/commands — the operator's
// actual working text, with its `## Input` contract, its output schema and the
// verb it hands off to. That is what makes the third property below worth
// something: "only the two scoring commands mention apply-scores" is now a
// statement about the real documents, not about a summary someone wrote.
describe('knowledge: the prompt docs are nine documents, not one', () => {
  const promptDocs = () => M.knowledgeDocs().filter((d) => d.id.startsWith('prompt:'));

  it('every prompt body is distinct', () => {
    const docs = promptDocs();
    expect(docs.length).toBeGreaterThanOrEqual(9);
    const bodies = new Set(docs.map((d) => d.markdown));
    expect(bodies.size).toBe(docs.length);
  });

  it("each body's heading names its own command", () => {
    // The real command files lead with YAML frontmatter and a title-case H1
    // ("# Classify Transcript"), not the `# /classify-transcript` the
    // hand-written stubs used. The invariant that matters is unchanged — a
    // body identifies the command it belongs to — so it is asserted against
    // the shape the documents actually have rather than the one the stubs did.
    for (const d of promptDocs()) {
      const command = d.id.replace(/^prompt:/, '').replace(/\.md$/, '');
      const heading = /^#\s+(.+)$/m.exec(d.markdown)?.[1]?.trim();
      expect(heading).toBeDefined();
      const slug = heading!.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      expect(slug).toBe(command);
    }
  });

  it('every body carries the frontmatter the command files ship with', () => {
    // `description` is what the source project's own tooling reads to list a
    // command; losing it in transit is the tell that a body was retyped rather
    // than carried across.
    for (const d of promptDocs()) {
      expect(d.markdown.startsWith('---\n')).toBe(true);
      expect(/^description:\s*\S/m.test(d.markdown)).toBe(true);
    }
  });

  it('bodies are the real documents, not a paragraph about them', () => {
    // The summaries they replaced were 274-483 bytes. The shortest real
    // command file is validate-outputs at ~2KB, so a floor of 1200 separates
    // the two without pinning anyone's exact length.
    //
    // NOT asserted: that every body carries a fenced block. Seven do; two —
    // draw-diagram and validate-outputs — are entirely prose, and an earlier
    // draft of this test claimed otherwise and failed against the real files.
    // The lesson is the point of the whole change: assert what the documents
    // are, not what a summary of them would have been.
    for (const d of promptDocs()) {
      expect(d.markdown.length).toBeGreaterThan(1200);
    }
    // Collectively they do carry copyable blocks — that is what a reader comes
    // to a command reference for — so the property holds in the aggregate.
    expect(promptDocs().filter((d) => d.markdown.includes('```')).length).toBeGreaterThanOrEqual(7);
  });

  // The claim that made the old shared body false. Only these two carry an
  // apply-scores handoff verb in providers/assessment.ts AGENT_COMMANDS, so
  // only these two may talk about persisting a score.
  it('only the two scoring commands mention applying scores', () => {
    const scoring = new Set(['prompt:score-dimensions.md', 'prompt:process-self-assessment.md']);
    for (const d of promptDocs()) {
      const claimsScoring = /apply-scores/.test(d.markdown);
      expect(claimsScoring).toBe(scoring.has(d.id));
    }
  });
});
