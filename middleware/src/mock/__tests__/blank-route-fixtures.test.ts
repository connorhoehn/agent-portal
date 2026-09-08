// The four GET routes that had no mock branch, and the fixtures that gave
// them one (validate-mock-floor.sh rule 4).
//
// Each of these 500'd under `dev:mock` because its handler called `exec()` or
// the SSM client directly — `exec` reaches the RDS Data API whatever
// `config.mock.aurora` says, and offline the SSM client has no credential to
// throw `ParameterNotFound` with. What the tests below assert is what the
// floor asks of a fixture, not merely that a row exists:
//
//   1. `empty` is DECLARED. An undeclared scenario falls back to `default`,
//      so an unwritten `empty` would still hand the page six rows.
//   2. Nothing countable or derivable is stored — the two prompt SHAs are the
//      hash of the content beside them, and a run's duration is the span
//      between its two stamps.
//   3. Timestamps are sampled when the rows are built, so freezing the clock
//      moves them.

import { createHash } from 'node:crypto';
import { freezeClock, fixtureRegistry } from '../core/index.js';
import { seedRows } from '../core/parity/sql-seed.js';
import {
  agentProjectRuns,
  mockRecentRunsForProjects,
  mockRunsForProject,
} from '../agent-project-runs.js';
import {
  mockGetPromptVersion,
  mockListPromotedVersions,
  mockListPromptVersions,
  mockRegisterPromptVersion,
  promptVersions,
} from '../prompt-versions.js';
import {
  canaryWeight,
  mockGetControl,
  mockGetWeightB,
  mockSetControl,
  mockSetWeightB,
} from '../canary-weight.js';

const OBSERVABILITY = '4870e01d-9274-5c4a-91af-ea9acb7f857a';

afterEach(() => {
  fixtureRegistry.resetAll('default');
});

describe('registration and scenarios', () => {
  const KEYS = ['agent-project-runs', 'prompt-versions', 'canary-weight'];

  it('every fixture is in the shared registry, so the control plane can reach it', () => {
    const registered = new Set(fixtureRegistry.all().map((f) => f.key));
    for (const key of KEYS) expect(registered.has(key)).toBe(true);
  });

  it('the two collections declare `empty` — an undeclared one is not empty', () => {
    expect(agentProjectRuns.rows('empty')).toHaveLength(0);
    expect(promptVersions.rows('empty')).toHaveLength(0);
  });

  it('the canary keeps its single state row under `empty`, at weight 0', () => {
    // Deliberately not an empty array: an undeployed PromptCanary stack still
    // has an answer for "what is the weight" — zero — which is exactly what
    // getWeightB's ParameterNotFound branch returns against real SSM.
    fixtureRegistry.resetAll('empty');
    expect(canaryWeight.rows()).toHaveLength(1);
    expect(mockGetWeightB()).toBe(0);
    expect(mockGetControl()).toEqual({
      manual_override_until: '',
      cooldown_until: '',
      halted: false,
    });
  });

  it('every route reads empty under `empty`, which is what an audit pins it to', () => {
    fixtureRegistry.resetAll('empty');
    expect(mockListPromptVersions()).toHaveLength(0);
    expect(mockListPromotedVersions()).toHaveLength(0);
    expect(mockRunsForProject(OBSERVABILITY)).toHaveLength(0);
    expect(mockRecentRunsForProjects([OBSERVABILITY]).size).toBe(0);
  });
});

describe('prompt versions — the SHAs are derived, never stored', () => {
  it('promptVersion is the first 12 hex of the content SHA-256, and contentSha256 the whole one', () => {
    for (const v of mockListPromptVersions()) {
      const digest = createHash('sha256').update(v.content).digest('hex');
      expect(v.contentSha256).toBe(digest);
      expect(v.promptVersion).toBe(digest.slice(0, 12));
    }
  });

  it('a chip can look up any listed version by the id the list gave it', () => {
    for (const v of mockListPromptVersions()) {
      expect(mockGetPromptVersion(v.promptVersion)?.content).toBe(v.content);
    }
    expect(mockGetPromptVersion('deadbeefcafe')).toBeNull();
  });

  it('lists newest first, and the promote list is the promoted subset by promotion time', () => {
    const listed = mockListPromptVersions().map((v) => Date.parse(v.registeredAt));
    expect(listed).toEqual([...listed].sort((a, b) => b - a));

    const promoted = mockListPromotedVersions();
    const ids = new Set(mockListPromptVersions().map((v) => v.promptVersion));
    expect(promoted.length).toBeGreaterThan(0);
    expect(promoted.length).toBeLessThan(ids.size); // else the page shows nothing a human chose
    for (const p of promoted) expect(ids.has(p.promptVersion)).toBe(true);
    const stamps = promoted.map((p) => Date.parse(p.promotedAt));
    expect(stamps).toEqual([...stamps].sort((a, b) => b - a));
  });

  it('an agent has a newer unpromoted revision than the one that is promoted', () => {
    // The whole point of the promote list: what is live is not what is newest.
    const promoted = mockListPromotedVersions();
    const all = mockListPromptVersions();
    const drifted = promoted.filter((p) =>
      all.some(
        (v) =>
          v.agentId === p.agentId &&
          v.promptVersion !== p.promptVersion &&
          Date.parse(v.registeredAt) > Date.parse(p.registeredAt),
      ),
    );
    expect(drifted.length).toBeGreaterThan(0);
  });

  it('registering is idempotent and immediately readable back', () => {
    const before = mockListPromptVersions().length;
    const content = 'You are a brand new agent. Do the thing.';
    const pv = mockRegisterPromptVersion({ agentId: 'orgiq-search', content });
    expect(mockListPromptVersions()).toHaveLength(before + 1);
    expect(mockGetPromptVersion(pv)?.content).toBe(content);

    expect(mockRegisterPromptVersion({ agentId: 'orgiq-search', content })).toBe(pv);
    expect(mockListPromptVersions()).toHaveLength(before + 1);
  });
});

describe('project runs — duration is derived, and both surfaces read one set of rows', () => {
  it('durationMs is finished − started, and a run still in flight has none', () => {
    for (const r of mockRunsForProject(OBSERVABILITY)) {
      if (r.finishedAt === null) {
        expect(r.status).toBe('running');
        expect(r.durationMs).toBeNull();
      } else {
        expect(r.durationMs).toBe(Date.parse(r.finishedAt) - Date.parse(r.startedAt));
      }
    }
  });

  it('the list page and the focused detail cannot disagree about a repo', () => {
    // GET /api/agent-projects carries 5 runs per repo; GET /:id/runs carries
    // 50. The overlap must be the same rows in the same order — the two used
    // to disagree because one had an empty mock branch and the other had none.
    const detail = mockRunsForProject(OBSERVABILITY, 50);
    const listed = mockRecentRunsForProjects([OBSERVABILITY], 5).get(OBSERVABILITY)!;
    expect(listed).toEqual(detail.slice(0, listed.length));
  });

  it('every run points at a repo the seed actually links', () => {
    // Read from schema/seed_program.sql rather than a hand-copied id list —
    // inventing ids is the bug the parity harness exists to catch, and a run
    // against a project no seed creates is that bug in a new table.
    const linked = new Set(seedRows('seed_program.sql', 'agent_projects').map((r) => String(r.values['id'])));
    expect(linked.size).toBeGreaterThan(0);
    for (const r of agentProjectRuns.rows()) expect(linked.has(r.projectId)).toBe(true);
  });

  it('newest first', () => {
    const stamps = mockRunsForProject(OBSERVABILITY).map((r) => Date.parse(r.startedAt));
    expect(stamps).toEqual([...stamps].sort((a, b) => b - a));
  });
});

describe('canary weight — a write moves the row the read returns', () => {
  it('setWeightB then getWeightB, so the slider is confirmed rather than snapping back', () => {
    mockSetWeightB(60);
    expect(mockGetWeightB()).toBe(60);
  });

  it('setControl merges, so a partial update does not clobber the rest', () => {
    mockSetControl({ cooldown_until: '2026-09-08T00:00:00.000Z' });
    mockSetControl({ halted: true });
    expect(mockGetControl()).toEqual({
      manual_override_until: '',
      cooldown_until: '2026-09-08T00:00:00.000Z',
      halted: true,
    });
  });

  it('getControl hands back a copy — a caller mutating it cannot corrupt the fixture', () => {
    const control = mockGetControl();
    control.halted = true;
    expect(mockGetControl().halted).toBe(false);
  });
});

describe('timestamps come from the clock', () => {
  it('freezing the clock moves every stamp, so none was baked at import', () => {
    const restore = freezeClock('2026-03-04T00:05:00.000Z');
    try {
      fixtureRegistry.resetAll('default');
      for (const r of agentProjectRuns.rows()) expect(r.startedAt < '2026-03-05').toBe(true);
      for (const v of promptVersions.rows()) expect(v.registeredAt < '2026-03-05').toBe(true);
    } finally {
      restore();
    }
  });

  it('the run started "this morning" is still today at 00:05 UTC', () => {
    // hoursAgo(…, keepWithinToday) clamps to the elapsed part of the UTC day;
    // without it the freshest run falls into yesterday for the first hours
    // after midnight and the repo reads as idle.
    const restore = freezeClock('2026-03-04T00:05:00.000Z');
    try {
      fixtureRegistry.resetAll('default');
      const newest = mockRunsForProject(OBSERVABILITY)[0]!;
      expect(newest.startedAt.slice(0, 10)).toBe('2026-03-04');
    } finally {
      restore();
    }
  });
});
