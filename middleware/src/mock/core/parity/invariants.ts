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
          if (p.lastActivityAt !== b.lastAgentActivityAt) {
            out.push(`${b.orgProjectId}: card lastActivityAt ${p.lastActivityAt} disagrees with the ledger's ${b.lastAgentActivityAt}`);
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
        if (new Set(budgets.map((b) => b.lastAgentActivityAt)).size !== budgets.length) {
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
      const dims: Record<string, unknown> = {
        '1': { dimension_id: '1', history: [{ changed_at: scoredAt }] },
        '2': { dimension_id: '2', history: [{ changed_at: scoredAt }] },
      };
      const hints = ['1', '2'].map((dimension_id) => ({ dimension_id }));
      const out: string[] = [];
      // Ingested BEFORE the scoring pass — genuinely processed.
      const older = { status: 'committed', dimension_hints: hints, ingested_at: '2026-07-01T00:00:00.000Z' };
      if (!M.isSubmissionProcessed(older as never, dims as never)) {
        out.push('an envelope scored after it arrived does not read as processed — the "Processed" filter is unreachable again');
      }
      // Ingested AFTER it — a resubmission nobody has looked at yet.
      const fresh = { status: 'committed', dimension_hints: hints, ingested_at: '2026-09-01T00:00:00.000Z' };
      if (M.isSubmissionProcessed(fresh as never, dims as never)) {
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
];
