// THE INVARIANT TABLE — cross-surface rules that no single fixture can check.
//
// The seed table (./entities.ts) answers "does this fixture still say what the
// SQL says". This one answers the other half of what the nine one-off tests
// were really about: two surfaces reading the SAME fixture must not disagree
// with each other. A ledger showing $19.77 beside a card saying "no agent runs
// yet"; a Health summary promising 25 errors over a list that can only show 6;
// an architecture graph reading all-zero next to a summary reporting thousands.
// None of those is a seed mismatch — both sides were internally consistent and
// jointly incoherent.
//
// ADDING A ROW. An invariant is a name, the lesson it carries, and a `check`
// that returns one line per violation (empty array = pass). Returning lines
// rather than throwing is what lets the driver report EVERY violated invariant
// in one run instead of stopping at the first.

import type { Express } from 'express';

export interface InvariantContext {
  /** An express app mounting the routers `dev:mock` serves. Built once, lazily. */
  app(): Promise<Express>;
}

export interface SurfaceInvariant {
  /** Short, greppable. */
  name: string;
  /** Which of the nine originals' lessons this carries — keep this accurate. */
  replaces: string;
  /** Why a developer should care, in one sentence. */
  lesson: string;
  /** One line per violation; empty means the invariant holds. */
  check(ctx: InvariantContext): Promise<string[]>;
}

const OPEN_STATUSES = new Set(['open', 'in_progress', 'in_review']);

export const SURFACE_INVARIANTS: SurfaceInvariant[] = [
  // ── work items ─────────────────────────────────────────────────────────────
  {
    name: 'initiative rollup equals its own work items',
    replaces: 'work-items-seed-parity (org-leader.md #2, program-owner.md #3)',
    lesson:
      'The Initiatives list and an initiative\'s Work tab must count the same items — they once read "34/72 pts · 47%" and "0/10 pts" for the same initiative.',
    async check() {
      const { searchWorkItems } = await import('../../../providers/work-items.js');
      const { listProjects } = await import('../../../providers/projects.js');
      const all = await searchWorkItems({ limit: 1000 });
      const rollups = await listProjects({ limit: 200 });
      const out: string[] = [];
      if (rollups.length < 14) {
        out.push(`only ${rollups.length} initiatives in the mock — the seed has 14, so this check would be near-vacuous`);
      }
      for (const p of rollups) {
        const items = all.filter((i) => i.projectId === p.id);
        const sized = items.filter((i) => i.type === 'story' || i.type === 'bug');
        const want = {
          openStories: items.filter((i) => i.type === 'story' && OPEN_STATUSES.has(i.status)).length,
          openBugs: items.filter((i) => i.type === 'bug' && OPEN_STATUSES.has(i.status)).length,
          pointsTotal: sized.reduce((n, i) => n + (i.storyPoints ?? 0), 0),
          pointsDone: sized.filter((i) => i.status === 'done').reduce((n, i) => n + (i.storyPoints ?? 0), 0),
        };
        for (const key of Object.keys(want) as Array<keyof typeof want>) {
          const got = (p as unknown as Record<string, number>)[key];
          if (got !== want[key]) {
            out.push(`${p.id}: list rollup ${key}=${got} but its own work items give ${want[key]}`);
          }
        }
      }
      return out;
    },
  },
  {
    name: 'a work item names the initiative it belongs to',
    replaces: 'work-items-seed-parity (generalised — the fabricated families carried a foreign initiative name)',
    lesson:
      'A work item\'s projectName is rendered above the item; if it disagrees with the initiative header the reader sees two names for one initiative.',
    async check() {
      const { searchWorkItems } = await import('../../../providers/work-items.js');
      const { listProjects } = await import('../../../providers/projects.js');
      const nameById = new Map((await listProjects({ limit: 200 })).map((p) => [p.id, p.name]));
      const out: string[] = [];
      for (const i of await searchWorkItems({ limit: 1000 })) {
        const real = nameById.get(i.projectId);
        if (real === undefined) {
          out.push(`${i.id}: projectId '${i.projectId}' is not an initiative any surface knows`);
        } else if (i.projectName !== real) {
          out.push(`${i.id}: projectName '${i.projectName}' but initiative ${i.projectId} is named '${real}'`);
        }
      }
      return out;
    },
  },
  {
    name: 'the fabricated work-item families stay deleted',
    replaces: 'work-items-seed-parity (sme.md #8, program-owner.md #3)',
    lesson:
      'wi-k8s-* (Kubernetes upgrade on Observability) and wi-onboard-* (Developer Onboarding on Mobile) were narratives the seed never gave those initiatives.',
    async check() {
      const { searchWorkItems } = await import('../../../providers/work-items.js');
      const items = await searchWorkItems({ limit: 1000 });
      return ['wi-k8s-', 'wi-onboard-']
        .flatMap((prefix) => items.filter((i) => i.id.startsWith(prefix)).map((i) => `${prefix}* is back: ${i.id} on ${i.projectId}`));
    },
  },

  // ── decisions ──────────────────────────────────────────────────────────────
  {
    name: 'the two decision surfaces read one table',
    replaces: 'new — the divergence an orphaned-route audit found, made a standing check',
    lesson:
      '`GET /api/graph/decisions` and an initiative\'s Decisions tab are two reads of `decisions`; they once shared nothing at all, because each seed filled only the half of the column set its own reader looked at.',
    async check() {
      const { listDecisions, getDecision } = await import('../../../providers/decisions.js');
      const { getProjectDecisions, searchWorkItems } = await import('../../../providers/work-items.js');
      const { listProjects } = await import('../../../providers/projects.js');

      const all = await listDecisions({ limit: 200 });
      const byId = new Map(all.map((d) => [d.id, d]));
      const projects = await listProjects({ limit: 200 });
      const items = new Map((await searchWorkItems({ limit: 1000 })).map((i) => [i.id, i]));
      const out: string[] = [];

      if (all.length === 0) return ['GET /api/graph/decisions is empty — this check would be vacuous'];

      // 1. Nothing an initiative shows is unknown to the graph's list, and the
      //    two agree on what the decision SAYS. A tab rendering a topic the
      //    list has never heard of is the original bug, exactly.
      const shownByAnInitiative = new Set<string>();
      for (const p of projects) {
        for (const d of await getProjectDecisions(p.id)) {
          shownByAnInitiative.add(d.id);
          const listed = byId.get(d.id);
          if (!listed) {
            out.push(`${p.id}'s Decisions tab shows ${d.id} ('${d.topic}'), which /api/graph/decisions has never heard of`);
            continue;
          }
          if (listed.topic !== d.topic) {
            out.push(`${d.id}: the tab calls it '${d.topic}', the decision list calls it '${listed.topic}'`);
          }
          if (listed.summary !== d.summary) {
            out.push(`${d.id}: the tab and the decision list carry different summaries`);
          }
          if (listed.status !== d.status) {
            out.push(`${d.id}: the tab says '${d.status}', the decision list says '${listed.status}'`);
          }
          if (listed.projectId !== p.id) {
            out.push(`${d.id} is on ${p.id}'s tab but the decision list files it under ${listed.projectId ?? 'no initiative'}`);
          }
        }
      }

      // 2. And the other direction: a decision the list files under an
      //    initiative must be reachable from that initiative. This is the half
      //    that was broken — every seeded ADR named no initiative, so the tab
      //    could not reach one of them.
      for (const d of all) {
        if (d.projectId != null && !shownByAnInitiative.has(d.id)) {
          out.push(`${d.id} is filed under ${d.projectId} but that initiative's Decisions tab does not return it`);
        }
      }
      if (!all.some((d) => d.projectId != null)) {
        out.push('not one decision names an initiative — the two surfaces are disjoint again');
      }
      if (!all.some((d) => d.projectId === null)) {
        out.push('every decision names an initiative — the org-wide half of the table has gone missing');
      }

      // 3. The lifecycle is coherent: decided exactly when settled, and the
      //    room is never empty for a call that has been made.
      for (const d of all) {
        const settled = d.status === 'resolved' || d.status === 'rejected';
        if (settled && d.decidedAt === null) {
          out.push(`${d.id} is '${d.status}' but carries no decidedAt`);
        }
        if (!settled && d.decidedAt !== null) {
          out.push(`${d.id} is '${d.status}' but carries decidedAt ${d.decidedAt}`);
        }
        if (d.participantCount === 0) {
          out.push(`${d.id} has no participants — every decision records who was in the room`);
        }
        const detail = await getDecision(d.id);
        if (!detail) {
          out.push(`${d.id} is in the list but GET /api/graph/decisions/${d.id} 404s`);
          continue;
        }
        if (detail.status !== d.status || detail.projectId !== d.projectId) {
          out.push(`${d.id}: the list and the detail disagree about status/projectId`);
        }
      }

      // 4. A work-item link is a LEFT JOIN, not a caption. The hand-typed
      //    decision fixture captioned items the board denied existed, so the
      //    title has to be exactly what the join would produce: the board's
      //    title when the board carries the item, null when it does not (the
      //    mock work board is a documented subset of the seed).
      for (const p of projects) {
        for (const d of await getProjectDecisions(p.id)) {
          const item = d.workItemId != null ? items.get(d.workItemId) : undefined;
          const joined = item?.title ?? null;
          if (d.workItemTitle !== joined) {
            out.push(
              `${d.id} captions its work item '${d.workItemTitle ?? 'null'}' but joining ${d.workItemId ?? 'no id'} gives '${joined ?? 'null'}'`,
            );
          }
          if (item && item.projectId !== p.id) {
            out.push(`${d.id} is ${p.id}'s decision but blocks ${d.workItemId}, which belongs to ${item.projectId}`);
          }
        }
      }
      return out;
    },
  },

  {
    name: 'both seeds fill the whole decisions column set',
    replaces: 'new — the root cause under the divergence above, checked at the source',
    lesson:
      'schema/seed.sql wrote no status/project_id and schema/seed_program.sql wrote no decided_at/participants, so each reader saw only the half its own seed filled. A column one seed writes and the other omits is that bug returning.',
    async check() {
      const { seedRows } = await import('./sql-seed.js');
      const out: string[] = [];
      // The union across a file's rows, plus the per-row check that no single
      // INSERT is short of it — a union alone lets six full rows hide a
      // seventh that omits `project_id`, which is the shape of the original
      // bug rather than a variation on it.
      const columns = (file: string): string[] => {
        const rows = seedRows(file, 'decisions');
        if (rows.length === 0) return [];
        const union = [...new Set(rows.flatMap((r) => Object.keys(r.values)))].sort();
        for (const r of rows) {
          const missing = union.filter((c) => !Object.hasOwn(r.values, c));
          if (missing.length > 0) {
            out.push(`schema/${file}:${r.line} omits decisions.${missing.join(', .')} that its sibling rows write`);
          }
        }
        return union;
      };
      const org = columns('seed.sql');
      const program = columns('seed_program.sql');
      if (org.length === 0) return ['schema/seed.sql seeds no decisions at all — this check would be vacuous'];
      if (program.length === 0) return ['schema/seed_program.sql seeds no decisions at all — this check would be vacuous'];
      for (const col of org) {
        if (!program.includes(col)) out.push(`schema/seed.sql writes decisions.${col}; schema/seed_program.sql does not`);
      }
      for (const col of program) {
        if (!org.includes(col)) out.push(`schema/seed_program.sql writes decisions.${col}; schema/seed.sql does not`);
      }
      // Every decision must record its room, in both files.
      for (const file of ['seed.sql', 'seed_program.sql']) {
        const decided = new Set(seedRows(file, 'decisions').map((r) => String(r.values['id'] ?? '')));
        const withRoom = new Set(
          seedRows(file, 'decision_participants').map((r) => String(r.values['decision_id'] ?? '')),
        );
        for (const id of decided) {
          if (!withRoom.has(id)) out.push(`schema/${file} seeds decision ${id} with no decision_participants row`);
        }
      }
      return out;
    },
  },

  // ── people ─────────────────────────────────────────────────────────────────
  {
    name: 'one person id resolves to one human everywhere',
    replaces: 'person-identity-parity',
    lesson:
      'The portal renders person ids as links with hover cards — p-004 once hovered "Nora DaSilva" and opened "Priya Patel".',
    async check() {
      const { mockPeople } = await import('../../people.js');
      const { mockScores } = await import('../../scores.js');
      const { listProjects, getProject } = await import('../../../providers/projects.js');
      const { searchWorkItems } = await import('../../../providers/work-items.js');
      const nameById = new Map(mockPeople.map((p) => [p.id, p.name]));
      const out: string[] = [];
      const claim = (where: string, id: string | null, name: string | null | undefined): void => {
        if (!id) return;
        if (!nameById.has(id)) { out.push(`${where}: person id '${id}' is in no cast mock/people.ts knows`); return; }
        if (name != null && name !== nameById.get(id)) {
          out.push(`${where}: ${id} is '${nameById.get(id)}' in mock/people.ts but '${name}' here`);
        }
      };
      for (const s of mockScores) claim('mock/scores.ts', s.personId, s.name);
      for (const summary of await listProjects({ limit: 200 })) {
        const detail = await getProject(summary.id);
        if (!detail) continue;
        claim(`${summary.id} owner`, detail.ownerId, detail.ownerName);
        claim(`${summary.id} sponsor`, detail.sponsorId, detail.sponsorName);
        for (const c of detail.contributors) claim(`${summary.id} contributor`, c.personId, c.name);
      }
      for (const i of await searchWorkItems({ limit: 1000 })) {
        claim(`work item ${i.id} assignee`, i.assigneeId, i.assigneeName);
      }
      return out;
    },
  },
  {
    name: 'a person\'s skills are listed in the seed\'s weight order',
    replaces: 'new — the half of person_skills a per-row parity check structurally cannot see',
    lesson:
      '`person_skills.weight` is how strongly the seed says someone knows something, and mock/people.ts carries it only as the ORDER of a name list — so "Nora\'s top skill" is a claim the mock makes with no column to check it against, and a reordered list moves an expert from first to last with nothing failing.',
    async check() {
      const { mockPeople } = await import('../../people.js');
      const { seedRows } = await import('./sql-seed.js');
      const { idByName } = await import('./joins.js');

      const skillNameById = new Map(
        [...idByName('seed.sql', 'skills')].map(([name, id]) => [id, name]),
      );
      const weights = new Map<string, number>();
      for (const row of seedRows('seed.sql', 'person_skills')) {
        const name = skillNameById.get(String(row.values['skill_id']));
        const weight = row.values['weight'];
        if (name !== undefined && typeof weight === 'number') {
          weights.set(`${String(row.values['person_id'])}@${name}`, weight);
        }
      }

      const out: string[] = [];
      // Vacuity guard, and it reads exactly what the check below reads: an
      // empty cast, an empty seed join, or a cast where nobody holds two
      // skills makes "non-increasing" true for free.
      if (weights.size === 0) {
        out.push('schema/seed.sql yielded no person_skills weights — the join is broken, not the order');
      }
      const comparable = mockPeople.filter((p) => p.skills.length >= 2).length;
      if (comparable === 0) {
        out.push(`no person in mock/people.ts holds two skills (${mockPeople.length} people), so ordering is vacuous`);
      }

      for (const person of mockPeople) {
        let previous: { name: string; weight: number } | null = null;
        for (const name of person.skills) {
          const weight = weights.get(`${person.id}@${name}`);
          if (weight === undefined) continue; // an unseeded pair is person_skills' finding, not this one
          if (previous && weight > previous.weight) {
            out.push(
              `${person.id}: lists '${previous.name}' (seed weight ${previous.weight}) before `
              + `'${name}' (seed weight ${weight}) — the seed ranks ${name} higher`,
            );
          }
          previous = { name, weight };
        }
      }
      return out;
    },
  },

  // ── money ──────────────────────────────────────────────────────────────────
  {
    name: 'Initiatives and Budgets report the same money',
    replaces: 'mock-parity',
    lesson:
      '/iq/projects said "no agent runs yet" while /admin/budgets reported $19.77 spent on those very initiative ids.',
    async check() {
      const { listProjects } = await import('../../../providers/projects.js');
      const { listBudgets } = await import('../../../providers/budgets.js');
      // Both fixtures derive liveness from Date.now() at CALL time, so two
      // calls a millisecond apart produce two ISO strings. These surfaces are
      // meant to read ONE ledger row, so freeze the clock rather than weaken
      // the equality this exists to check.
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-08-20T12:00:00.000Z'));
      try {
        const projects = await listProjects({ limit: 200 });
        const budgets = await listBudgets();
        const out: string[] = [];
        if (budgets.length === 0) return ['the mock ledger is empty — this check would pass vacuously'];
        for (const b of budgets) {
          const p = projects.find((x) => x.id === b.orgProjectId);
          if (!p) { out.push(`ledger row ${b.orgProjectId} names an initiative /iq/projects has never heard of`); continue; }
          if (p.agentSpendUsd !== b.spentThisPeriodUsd) {
            out.push(`${b.orgProjectId}: Initiatives says agentSpendUsd=${p.agentSpendUsd}, Budgets says spentThisPeriodUsd=${b.spentThisPeriodUsd}`);
          }
          if (p.lastAgentActivityAt !== b.lastAgentActivityAt) {
            out.push(`${b.orgProjectId}: last agent activity ${p.lastAgentActivityAt} (Initiatives) vs ${b.lastAgentActivityAt} (Budgets)`);
          }
          // Only when there IS activity. Aurora derives the card's
          // `lastActivityAt` as `lastAgent ?? createdAt`, so an initiative with
          // no attributed run shows its creation date on the card and null on
          // the ledger — those are different by design, not a disagreement.
          // This line used to demand equality unconditionally, which held only
          // because every fixture row carried a hand-typed `activityHoursAgo`;
          // once the ledger started COUNTING activity from the runs, an
          // initiative with none became expressible and this failed on it.
          if (b.lastAgentActivityAt !== null && p.lastActivityAt !== b.lastAgentActivityAt) {
            out.push(`${b.orgProjectId}: card lastActivityAt ${p.lastActivityAt} disagrees with the ledger's ${b.lastAgentActivityAt}`);
          }
          if (b.lastAgentActivityAt === null && p.lastActivityAt !== p.createdAt) {
            out.push(`${b.orgProjectId}: no attributed run, so the card must fall back to createdAt (${p.createdAt}), not ${p.lastActivityAt}`);
          }
          if (b.spentThisPeriodUsd > 0 && !(p.agentSpendUsd && p.agentSpendUsd > 0)) {
            out.push(`${b.orgProjectId}: ledger shows $${b.spentThisPeriodUsd} but the card claims no agent runs yet`);
          }
        }
        // An initiative with no ledger row spent $0 — Aurora returns 0, not
        // null; null is reserved for a cluster too old to have the rollup.
        //
        // "Every initiative has a ledger row" used to be reported as a lost
        // branch. It is not, and saying so was actively harmful: it made
        // COMPLETING the ledger — giving p-data-lake and p-zero-trust the
        // allocations schema/seed_program.sql really gives them — fail this
        // invariant, so the fixture was rewarded for staying short. Whether
        // the branch is reachable at all is a property of the SEED, so ask the
        // seed: an initiative the seed allocates to must have a row, and only
        // an initiative it does not allocate to can exercise the $0 path.
        const ledgerIds = new Set(budgets.map((b) => b.orgProjectId));
        const offLedger = projects.filter((p) => !ledgerIds.has(p.id));
        if (offLedger.length === 0) {
          const { seedRows } = await import('./sql-seed.js');
          const allocated = new Set(
            seedRows('seed_program.sql', 'initiative_budgets')
              .map((r) => String(r.values['org_project_id'])),
          );
          const unallocated = projects.filter((p) => !allocated.has(p.id));
          if (unallocated.length > 0) {
            out.push(
              `the ledger carries a row for ${unallocated.map((p) => p.id).join(', ')}, which schema/seed_program.sql `
              + 'never allocates to and which has no spend — the $0 branch is being papered over rather than exercised',
            );
          }
        }
        for (const p of offLedger) {
          if (p.agentSpendUsd !== 0) out.push(`${p.id}: no ledger row, so agentSpendUsd must be 0, not ${p.agentSpendUsd}`);
          if (p.lastAgentActivityAt !== null) out.push(`${p.id}: no ledger row, so lastAgentActivityAt must be null`);
        }
        // Per-initiative liveness, not one flat `now - 3h` for every card.
        //
        // The REQUIREMENT is that liveness varies per initiative. This used to
        // assert every row carries a DISTINCT instant, which is a stronger
        // claim and was only satisfiable because each row had its own
        // hand-typed `activityHoursAgo`. Now that the instant is MAX(started_at)
        // over the initiative's real runs, two initiatives whose last run fell
        // in the same hour legitimately share one — and asserting otherwise
        // rewards the typed value that caused the bug this check exists near
        // (a card reading "0 runs this period" beside "last activity 2d ago").
        // So: not flat, rather than all-distinct.
        const liveness = new Set(budgets.map((b) => b.lastAgentActivityAt));
        if (budgets.length > 1 && liveness.size === 1) {
          out.push('every ledger row reports the same last-activity instant — the liveness stub is flat again');
        }
        return out;
      } finally {
        nowSpy.mockRestore();
      }
    },
  },
  {
    name: 'every sprint envelope names an initiative the ledger knows',
    replaces: 'mock-parity',
    lesson: 'An envelope against an initiative with no ledger row cannot be read against an allocation.',
    async check() {
      const { listBudgets, listGrants } = await import('../../../providers/budgets.js');
      const ledgerIds = new Set((await listBudgets()).map((b) => b.orgProjectId));
      const grants = await listGrants();
      if (grants.length === 0) return ['no mock grants — this check would pass vacuously'];
      return grants
        .filter((g) => !ledgerIds.has(g.orgProjectId))
        .map((g) => `grant ${g.id} is on ${g.orgProjectId}, which /admin/budgets has no row for`);
    },
  },

  // ── dispatch ───────────────────────────────────────────────────────────────
  {
    name: 'every seeded initiative clears the dispatch codebase check',
    replaces: 'agent-projects-seed-parity (org-leader.md #3)',
    lesson:
      'listAgentProjects() once returned [] in mock mode, so preflightWorkItem 400\'d every initiative with "no codebase delivers this initiative".',
    async check() {
      const { preflightWorkItem } = await import('../../../lib/bot-runner.js');
      const { searchWorkItems } = await import('../../../providers/work-items.js');
      const { listAgentProjects, getAgentProject } = await import('../../../providers/agent-projects.js');
      const out: string[] = [];
      const codebases = await listAgentProjects();
      if (codebases.length === 0) return ['listAgentProjects() is empty in mock mode — every dispatch would 400'];

      let attempted = 0;
      for (const project of codebases) {
        if (!project.orgProjectId) continue;
        const items = (await searchWorkItems({ limit: 1000, projectId: project.orgProjectId }))
          .filter((i) => (i.type === 'story' || i.type === 'bug') && (i.status === 'open' || i.status === 'in_progress'));
        if (items.length === 0) continue;
        attempted += 1;
        const pre = await preflightWorkItem(items[0]!.id);
        if (!pre.ok) out.push(`${project.orgProjectId}: preflight on ${items[0]!.id} refused — ${JSON.stringify(pre)}`);
      }
      if (attempted === 0) out.push('no initiative had a dispatchable item — this check would pass vacuously');

      // getAgentProject() had no mock branch at all, so a dispatch that
      // cleared every gate 500'd on real Aurora instead of proceeding.
      const first = codebases[0]!;
      const found = await getAgentProject(first.id);
      if (!found) out.push(`getAgentProject('${first.id}') returned null for a codebase listAgentProjects() just returned`);
      else if (found.repoFullName !== first.repoFullName) {
        out.push(`getAgentProject('${first.id}') resolved '${found.repoFullName}', list says '${first.repoFullName}'`);
      }
      if (await getAgentProject('00000000-0000-0000-0000-000000000000') !== null) {
        out.push('getAgentProject() answers for an id no fixture carries — it is matching by wildcard, not identity');
      }
      return out;
    },
  },
  {
    name: 'every bot run\'s jobId resolves, with the run\'s own provenance',
    replaces: 'bots-run-job-parity (sme.md #11)',
    lesson:
      'BotDetailPage links each run to /iq/work/<jobId>; no job provider had heard of those ids, so JobDetailPage spun on "Loading job…" forever.',
    async check() {
      const { listBots, listBotRuns } = await import('../../../providers/bots.js');
      const { getJob } = await import('../../../providers/agent-jobs.js');
      const out: string[] = [];
      let seen = 0;
      for (const bot of await listBots()) {
        for (const run of await listBotRuns(bot.id, 200)) {
          if (!run.jobId) continue;
          seen += 1;
          const job = await getJob(run.jobId);
          if (!job) { out.push(`run ${run.id} links to job ${run.jobId}, which getJob() 404s`); continue; }
          const wantStatus = run.status === 'skipped' ? 'cancelled' : run.status;
          if (job.status !== wantStatus) out.push(`${run.jobId}: run is '${run.status}' but the job is '${job.status}'`);
          if (job.botId !== bot.id) out.push(`${run.jobId}: job.botId=${job.botId}, the run came from ${bot.id}`);
          if (job.botName !== bot.name) out.push(`${run.jobId}: job.botName='${job.botName}', the run's bot is '${bot.name}'`);
          if (job.botTrigger !== run.trigger) out.push(`${run.jobId}: job.botTrigger='${job.botTrigger}', run.trigger='${run.trigger}'`);
          if (run.status === 'done' && job.error !== null) out.push(`${run.jobId}: run succeeded but the job carries an error`);
          if (run.status === 'failed' && job.error === null) out.push(`${run.jobId}: run failed but the job carries no error`);
        }
      }
      if (seen === 0) out.push('no mock bot run carries a jobId — this check would pass vacuously');
      // A real store, not a wildcard: an id nothing minted still 404s.
      if (await getJob('job-does-not-exist') !== null) {
        out.push('getJob() answers for an id nothing ever minted — the mock queue is a wildcard, not a store');
      }
      return out;
    },
  },

  // ── observability ──────────────────────────────────────────────────────────
  {
    name: 'the invocation tail carries exactly the errors Health promises',
    replaces: 'invocations-error-parity (org-leader.md #14)',
    lesson:
      'Health says "N errored invocations" and links to ?status=error; the list that link opens must be able to show N.',
    async check() {
      const { buildMockInvocations } = await import('../../invocations.js');
      const { mockAgents } = await import('../../agent-statuses.js');
      const rows = buildMockInvocations();
      const out: string[] = [];
      for (const a of mockAgents) {
        const got = rows.filter((r) => r.agentId === a.id && r.error).length;
        if (got !== a.errorsLast24h) {
          out.push(`${a.id}: Health promises ${a.errorsLast24h} errors in 24h, the tail carries ${got}`);
        }
      }
      const total = rows.filter((r) => r.error).length;
      const promised = mockAgents.reduce((s, a) => s + a.errorsLast24h, 0);
      if (total !== promised) out.push(`totalErrors24h promises ${promised}, the tail carries ${total}`);
      return out;
    },
  },
  {
    name: 'no error row is fabricated outside the window it is counted in',
    replaces: 'invocations-error-parity (the recency half)',
    lesson:
      'A row dated outside "the last 24h" still counted toward a 24h total is a number the list can never justify.',
    async check() {
      const { buildMockInvocations } = await import('../../invocations.js');
      const now = Date.now();
      return buildMockInvocations()
        .filter((r) => r.error)
        .flatMap((r) => {
          const ageMs = now - new Date(r.startedAt).getTime();
          if (ageMs < 0) return [`${r.id}: error row is stamped in the future (${r.startedAt})`];
          if (ageMs > 24 * 3_600_000) return [`${r.id}: error row is ${(ageMs / 3_600_000).toFixed(1)}h old but counted in a 24h total`];
          return [];
        });
    },
  },
  {
    name: 'a fresh resubmission is not read as already processed',
    replaces: 'the recency lesson the assessment status transitions filed',
    lesson:
      'A brand-new revision arriving AFTER a team was fully scored must read unprocessed until IT is scored — otherwise "Processed" means "some older thing was processed".',
    async check() {
      const M = await import('../../assessment.js');
      const scoredAt = '2026-08-01T00:00:00.000Z';
      const runId = 'run-provenance-check';
      const dims: Record<string, unknown> = {
        '1': { dimension_id: '1', history: [{ changed_at: scoredAt, source_meeting: runId }] },
        '2': { dimension_id: '2', history: [{ changed_at: scoredAt, source_meeting: runId }] },
      };
      const hints = ['1', '2'].map((dimension_id) => ({ dimension_id }));
      const out: string[] = [];
      // Only the envelope explicitly linked to the applied run is processed.
      const older = { envelope_id: 'scored-envelope', status: 'committed', dimension_hints: hints, ingested_at: '2026-07-01T00:00:00.000Z' };
      const logs = [{ envelope_id: older.envelope_id, run_id: runId }];
      if (!M.isSubmissionProcessed(older as never, dims as never, logs as never)) {
        out.push('an envelope explicitly linked to its applied scoring run does not read as processed');
      }
      const unrelated = { ...older, envelope_id: 'unscored-envelope' };
      if (M.isSubmissionProcessed(unrelated as never, dims as never, logs as never)) {
        out.push('an unrelated envelope reads as processed merely because its team has later scores');
      }
      // Even a claimed link cannot make histories before ingestion process a revision.
      const fresh = { ...older, envelope_id: 'fresh-envelope', ingested_at: '2026-09-01T00:00:00.000Z' };
      const freshLogs = [{ envelope_id: fresh.envelope_id, run_id: runId }];
      if (M.isSubmissionProcessed(fresh as never, dims as never, freshLogs as never)) {
        out.push('a resubmission that arrived after the last scoring pass reads as processed — recency is not being compared');
      }
      return out;
    },
  },
  {
    name: 'Architecture and Health agree on how much ran today',
    replaces: 'topology-summary-parity (org-leader.md #13)',
    lesson:
      '/iq/agents read "calls 0 · err 0" for every node while Health reported thousands of invocations for the same 24h window.',
    async check(ctx) {
      const request = (await import('supertest')).default;
      const app = await ctx.app();
      const [topo, summary] = await Promise.all([
        request(app).get('/api/topology/a2a?windowHours=24'),
        request(app).get('/api/observability/summary'),
      ]);
      const out: string[] = [];
      if (topo.status !== 200) return [`GET /api/topology/a2a returned ${topo.status}`];
      if (summary.status !== 200) return [`GET /api/observability/summary returned ${summary.status}`];
      const nodes = topo.body.nodes as Array<{ invocationCount: number; errorCount: number }>;
      if (!nodes || nodes.length === 0) return ['the topology graph has no nodes at all'];
      if (!nodes.some((n) => n.invocationCount > 0)) {
        out.push('every topology node reads calls 0 — the route has lost its mock branch again');
      }
      const calls = nodes.reduce((s, n) => s + n.invocationCount, 0);
      const errors = nodes.reduce((s, n) => s + n.errorCount, 0);
      if (calls !== summary.body.totalInvocations24h) {
        out.push(`topology sums ${calls} calls, Health reports totalInvocations24h=${summary.body.totalInvocations24h}`);
      }
      if (errors !== summary.body.totalErrors24h) {
        out.push(`topology sums ${errors} errors, Health reports totalErrors24h=${summary.body.totalErrors24h}`);
      }
      return out;
    },
  },
  {
    // Ranked last on purpose: it pushes rows into the shared in-memory ring.
    name: 'the promised errors survive the default 50-row window',
    replaces: 'invocations-window-parity (org-leader.md #14, re-audit)',
    lesson:
      'Health links to a list capped at 50 rows and prepending live ring traffic; spreading the day\'s errors evenly pushed two of them past the cutoff.',
    async check() {
      const { getRecentInvocations, recordInvocation } = await import('../../../lib/invocations.js');
      const { mockAgents } = await import('../../agent-statuses.js');
      const promised = mockAgents.reduce((s, a) => s + a.errorsLast24h, 0);
      const out: string[] = [];

      const fresh = getRecentInvocations(50);
      if (fresh.filter((r) => r.error).length !== promised) {
        out.push(`fresh ring: the 50-row window carries ${fresh.filter((r) => r.error).length} errors, Health promises ${promised}`);
      }
      for (const a of mockAgents) {
        const got = fresh.filter((r) => r.agentId === a.id && r.error).length;
        if (got !== a.errorsLast24h) out.push(`fresh ring: ${a.id} shows ${got} of its ${a.errorsLast24h} errors in the window`);
      }

      // A handful of real chat turns, as a manual audit session leaves behind.
      for (let i = 0; i < 10; i++) {
        recordInvocation({
          id: `parity-live-${i}`,
          agentId: 'orgiq-supervisor',
          agentName: 'Supervisor',
          startedAt: new Date().toISOString(),
          durationMs: 500,
          promptSnippet: 'parity harness live traffic',
          responseSnippet: 'parity harness live response',
          guardrailIntervened: false,
        });
      }
      const afterLive = getRecentInvocations(50).filter((r) => r.error).length;
      if (afterLive !== promised) {
        out.push(`with 10 live rows ranked ahead: the window carries ${afterLive} errors, Health still promises ${promised}`);
      }
      return out;
    },
  },

  // ── identity & tenancy ─────────────────────────────────────────────────────
  {
    name: 'every grant names a role its tenant actually has',
    replaces: 'new — the half of "providers/identity.ts mirrors the seed" that no row comparison can reach',
    lesson:
      'A grant is a (user, tenant, role) triple and the role half is validated against nothing: `user_tenant_roles.role` is plain TEXT, the seed says only "must match a seeded Cedar role for the tenant", and the roles themselves live in `middleware/seeds/roles/{tenant}/{role}.cedar`. A grant naming a role that does not exist is a login that half-works — the switch is accepted because the grant is present, and then every Cedar decision for that role denies.',
    async check() {
      const { listUsers } = await import('../../../providers/identity.js');
      const { crossTenantRoles, rolesByTenant } = await import('./cedar-roles.js');
      // A cross-tenant role (a .cedar directly under seeds/roles/ — `admin` is
      // the only one) is valid in every tenant; a tenant-scoped one only in its
      // own directory's tenant.
      const crossTenant = crossTenantRoles();
      const byTenant = rolesByTenant();

      const out: string[] = [];
      const held = new Set<string>();
      for (const u of await listUsers()) {
        for (const [tenant, granted] of Object.entries(u.grants)) {
          for (const role of granted as string[]) {
            held.add(`${tenant}:${role}`);
            if (crossTenant.has(role)) continue;
            const known = byTenant.get(tenant);
            if (!known) {
              out.push(`${u.id}: granted '${role}' in tenant '${tenant}', but seeds/roles/ defines no roles for that tenant at all`);
            } else if (!known.has(role)) {
              out.push(
                `${u.id}: granted '${role}' in '${tenant}', which has no seeds/roles/${tenant}/${role}.cedar — ` +
                `the tenant's roles are ${[...known].sort().join(', ')}`,
              );
            }
          }
        }
      }
      // And the other direction: a role nobody in the seeded cast holds cannot
      // be picked in the user picker, so no audit can ever exercise its policy.
      for (const [tenant, known] of byTenant) {
        for (const role of known) {
          if (!held.has(`${tenant}:${role}`)) {
            out.push(`seeds/roles/${tenant}/${role}.cedar defines a role no seeded user holds — nothing in dev:mock can sign in as it`);
          }
        }
      }
      return out;
    },
  },

  // ── the assessment tenant ──────────────────────────────────────────────────
  {
    name: 'the assessment fixtures join the way their foreign keys do',
    replaces: 'new — the tenant that produced `enterprise` vs `enterprise_context`, on the ids rather than the keys',
    lesson:
      'The assessment tenant has NO SQL seed: its fifteen fixtures are the seed, and they are separate modules-worth of rows that `schema/assessment_schema.sql` joins with real REFERENCES. Nothing was checking those joins, so a team id, dimension id or envelope id could be typed into one fixture and nowhere else — which is the same defect as `enterprise` vs `enterprise_context`, one table over.',
    async check() {
      const A = await import('../../assessment.js');
      const out: string[] = [];

      const teamIds = new Set(A.teamsFixture.rows('default').map((t) => t.id));
      const dimensionIds = new Set(A.DIMENSION_IDS);
      // A reference this check actually resolved. Counted so an empty fixture
      // cannot make the whole rule pass by having nothing to check — the same
      // near-vacuous guard the initiative rollup carries.
      let resolved = 0;
      const need = (where: string, id: string | null | undefined, set: Set<string>, what: string): void => {
        if (id == null) return;
        resolved += 1;
        if (!set.has(id)) out.push(`${where}: ${what} '${id}' is in no ${what === 'team_id' ? 'team the roster carries' : 'rubric dimension'}`);
      };

      // Every team-scoped fixture points at a team on the roster.
      for (const s of A.scoresFixture.rows('default')) need(`assessment-scores`, s.team_id, teamIds, 'team_id');
      for (const p of A.provenanceFixture.rows('default')) need('assessment-provenance', p.team_id, teamIds, 'team_id');
      for (const e of A.evidenceLogFixture.rows('default')) need('assessment-evidence-log', e.team_id, teamIds, 'team_id');
      for (const e of A.submissionsFixture.rows('default')) need(`assessment-submissions ${e.envelope_id}`, e.team_id, teamIds, 'team_id');
      for (const r of A.runsFixture.rows('default')) need(`assessment-runs ${r.id}`, r.team_id, teamIds, 'team_id');
      for (const l of A.scoringLogsFixture.rows('default')) need(`assessment-scoring-logs ${l.stamp}`, l.team_id, teamIds, 'team_id');
      for (const f of A.feedbackFixture.rows('default')) need(`assessment-feedback ${f.task_id}`, f.team_id, teamIds, 'team_id');
      for (const s of A.storiesFixture.rows('default')) need(`assessment-stories ${s.filename}`, s.team_id, teamIds, 'team_id');

      // Every dimension id is one of the rubric's seventeen. A dimension the
      // rubric has never heard of renders as a blank row with a score on it.
      const evidenceIds = new Set<string>();
      for (const t of A.scoresFixture.rows('default')) {
        for (const [key, d] of Object.entries(t.dimensions)) {
          if (key !== d.dimension_id) {
            out.push(`assessment-scores ${t.team_id}: keyed under '${key}' but the row says dimension_id '${d.dimension_id}'`);
          }
          need(`assessment-scores ${t.team_id}`, d.dimension_id, dimensionIds, 'dimension_id');
          for (const e of d.evidence) {
            evidenceIds.add(e.evidence_id);
            if (e.dimension_id !== d.dimension_id) {
              out.push(`assessment-scores ${t.team_id}/${d.dimension_id}: evidence ${e.evidence_id} claims dimension '${e.dimension_id}'`);
            }
          }
          for (const q of d.follow_up_questions) {
            need(`assessment-scores ${t.team_id} follow-up ${q.question_id}`, q.dimension_id, dimensionIds, 'dimension_id');
          }
        }
      }
      for (const r of A.evidenceLogFixture.rows('default')) {
        for (const i of r.items) {
          evidenceIds.add(i.evidence_id);
          need(`assessment-evidence-log ${i.evidence_id}`, i.dimension_id, dimensionIds, 'dimension_id');
        }
      }
      for (const t of A.teamsFixture.rows('default')) {
        for (const e of t.exceptions) need(`assessment-teams ${t.id} exception`, e.dimension_id, dimensionIds, 'dimension_id');
      }
      for (const f of A.feedbackFixture.rows('default')) {
        need(`assessment-feedback ${f.task_id}`, f.dimension_id, dimensionIds, 'dimension_id');
      }
      for (const s of A.storiesFixture.rows('default')) {
        need(`assessment-stories ${s.filename}`, s.dimension_id, dimensionIds, 'dimension_id');
      }
      for (const l of A.scoringLogsFixture.rows('default')) {
        for (const e of l.scores) need(`assessment-scoring-logs ${l.stamp}`, e.dimension_id, dimensionIds, 'dimension_id');
      }

      // An evidence id is what "How it was assessed" cites; a history entry
      // citing one that exists nowhere renders a rationale with no excerpt.
      for (const t of A.scoresFixture.rows('default')) {
        for (const d of Object.values(t.dimensions)) {
          for (const h of d.history) {
            for (const id of h.evidence_ids) {
              if (!evidenceIds.has(id)) {
                out.push(`assessment-scores ${t.team_id}/${d.dimension_id}: history cites evidence '${id}' that no fixture carries`);
              }
            }
          }
        }
      }

      // Envelope references: `supersedes` and a scoring log's `envelope_id`
      // are both REFERENCES assessment_submissions(envelope_id) in the DDL.
      const envelopeIds = new Set(A.submissionsFixture.rows('default').map((e) => e.envelope_id));
      for (const e of A.submissionsFixture.rows('default')) {
        if (e.supersedes != null && !envelopeIds.has(e.supersedes)) {
          out.push(`assessment-submissions ${e.envelope_id}: supersedes '${e.supersedes}', an envelope no fixture carries`);
        }
      }
      for (const l of A.scoringLogsFixture.rows('default')) {
        if (l.envelope_id != null && !envelopeIds.has(l.envelope_id)) {
          out.push(`assessment-scoring-logs ${l.team_id}@${l.stamp}: names envelope '${l.envelope_id}', which no fixture carries`);
        }
      }
      const runIds = new Set(A.runsFixture.rows('default').map((r) => r.id));
      for (const l of A.scoringLogsFixture.rows('default')) {
        if (l.run_id != null && !runIds.has(l.run_id)) {
          out.push(`assessment-scoring-logs ${l.team_id}@${l.stamp}: names run '${l.run_id}', which the Activity ledger does not carry`);
        }
      }

      // The knowledge tree: every non-directory node must resolve to a doc, and
      // every version list must belong to a doc. This is the join the
      // `enterprise` / `enterprise_context` bug broke at the section level.
      const docIds = new Set(A.knowledgeDocsFixture.rows('default').map((d) => d.id));
      const nodeIds = new Set<string>();
      for (const s of A.knowledgeSectionsFixture.rows('default')) {
        for (const n of s.nodes) nodeIds.add(n.id);
      }
      for (const s of A.knowledgeSectionsFixture.rows('default')) {
        for (const n of s.nodes) {
          if (n.parent_id != null && !nodeIds.has(n.parent_id)) {
            out.push(`assessment-knowledge-sections ${s.key}: node '${n.id}' hangs off parent '${n.parent_id}', which no section carries`);
          }
          // A synced section mirrors a remote provider, so its leaves carry a
          // page_id rather than a local document.
          if (!n.is_dir && s.kind === 'local' && !docIds.has(n.id)) {
            out.push(`assessment-knowledge-sections ${s.key}: leaf '${n.id}' opens a document no fixture carries`);
          }
        }
      }
      for (const v of A.knowledgeVersionsFixture.rows('default')) {
        if (!docIds.has(v.doc_id)) {
          out.push(`assessment-knowledge-versions: snapshots for doc '${v.doc_id}', which no fixture carries`);
        }
      }

      if (teamIds.size < 7 || dimensionIds.size < 17 || docIds.size < 10 || resolved < 200) {
        out.push(
          `near-vacuous: ${teamIds.size} teams, ${dimensionIds.size} rubric dimensions, ${docIds.size} docs, ` +
          `${resolved} references resolved — the seeded corpus is 7 / 17 / 18 and resolves hundreds, so this rule ` +
          `is not actually exercising the joins it claims to check`,
        );
      }
      return out;
    },
  },
  {
    name: 'a team is scored against the rubric it names',
    replaces: 'new — the other end of the `assessment_teams.rubric_version` / `assessment_rubric_dimensions` DEFECT pair',
    lesson:
      'A stored level is a number with no question attached unless the row names the rubric it was taken under, which is why `assessment_rubric_dimensions` is keyed on `(rubric_version, id)` and every team carries a `rubric_version`. The reference has to resolve BOTH ways: a team naming a rubric nothing carries scores against nothing, and a dimension id that is not in THAT team\'s rubric is a level recorded against a question the team was never asked. Both read as ordinary rows today because there is exactly one rubric — the day a second is added they are the failures nobody would be looking for.',
    async check() {
      const A = await import('../../assessment.js');
      const out: string[] = [];
      const versions = Object.keys(A.RUBRICS);

      // Each rubric's rows agree with the key they are filed under, and the
      // composite primary key really is unique within a version.
      for (const version of versions) {
        const seen = new Set<string>();
        for (const d of A.rubricDimensions(version)) {
          if (d.rubric_version !== version) {
            out.push(`RUBRICS['${version}'] holds dimension '${d.id}' whose own rubric_version says '${d.rubric_version}'`);
          }
          if (seen.has(d.id)) {
            out.push(`RUBRICS['${version}'] carries dimension '${d.id}' twice — PRIMARY KEY (rubric_version, id) would refuse the second`);
          }
          seen.add(d.id);
        }
      }

      // Every team names a rubric that exists, and scores only dimensions that
      // rubric has. Per team, not against DIMENSION_IDS: the default rubric is
      // the right answer only for a team that happens to be on the default.
      let resolved = 0;
      for (const t of A.teamsFixture.rows('default')) {
        const dims = A.rubricDimensions(t.rubric_version);
        if (dims.length === 0) {
          out.push(
            `assessment-teams ${t.id}: rubric_version '${t.rubric_version}' names a rubric the mock does not carry ` +
            `(RUBRICS has ${versions.map((v) => `'${v}'`).join(', ')})`,
          );
          continue;
        }
        const ids = new Set(dims.map((d) => d.id));
        const score = A.scoresFixture.rows('default').find((s) => s.team_id === t.id);
        for (const dimensionId of Object.keys(score?.dimensions ?? {})) {
          resolved += 1;
          if (!ids.has(dimensionId)) {
            out.push(
              `assessment-scores ${t.id}: scores dimension '${dimensionId}', which rubric ` +
              `'${t.rubric_version}' does not define`,
            );
          }
        }
        for (const e of t.exceptions) {
          resolved += 1;
          if (!ids.has(e.dimension_id)) {
            out.push(`assessment-teams ${t.id}: N/A exception on dimension '${e.dimension_id}', which rubric '${t.rubric_version}' does not define`);
          }
        }
      }

      if (versions.length < 1 || resolved < 100) {
        out.push(
          `near-vacuous: ${versions.length} rubric(s), ${resolved} (team, dimension) references resolved — ` +
          `the seeded corpus is 7 teams on a 17-dimension rubric, so this rule is not exercising the reference it claims to check`,
        );
      }
      return out;
    },
  },
];
