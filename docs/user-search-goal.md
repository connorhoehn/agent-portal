# Goal: user search that answers what each tenant's people ask

Status: **S0 and S1 built, 2026-10-15** (see "Built" at the end); S2–S4 not
started. The intent
catalog, the probe results and the gap analysis this goal is written against
are in `docs/user-search-intents.md`. The probe is
`portal/e2e/user-search-probe.spec.ts` over the catalog
`portal/e2e/user-search-catalog.ts`; its last results are
`docs/user-search-probe-results.json`; `scripts/user-search-report.mjs` turns
them into the gap matrix and is the seed of the judge below.

## Baseline (probe of 2026-10-15, 704 probes)

| tenant | pass | reach | phrasings answered |
|---|---|---|---|
| orgiq | 75% (15/20) | 85% | 59% |
| assessment | 33% (6/18) | 56% | 11% |
| social | 6% (1/17) | 6% | 2% |
| pipelines | 25% (4/16) | 56% | 13% |
| access | 25% (3/12, 4 clone-blind excluded) | 50% | 8% |

## What "done" means

A person in any of the five tenants can ask the questions their role actually
asks (the catalog: 87 intents, 17 tenant × role pairs, 3–4 phrasings each) and
reach the right record in at most two clicks, from the entry point they would
naturally use. Concretely, at the end of phase S4:

- every catalog intent is **supported** on its "best surface" for at least
  two of its natural phrasings, and **partial or better** on every other
  surface the catalog lists for it;
- no surface returns a **wrong** answer: a confidently wrong reply is worse
  than "I can't answer that" (the mock agent's canned Kubernetes table is the
  type specimen);
- every bounded composer that rejects a phrasing says which phrasing would
  work (the rejected question is echoed as a suggested command), instead of
  only "Command not recognized";
- search is **storage-agnostic**: the index is a projection behind a provider
  interface, with an in-memory implementation for `dev:mock` and a
  DynamoDB-compatible one (the user's `managed-nosql-store`), and no surface
  depends on SQL, `pg_trgm`, `tsvector` or pgvector to answer a catalog intent.

Non-goals: arbitrary language-model agents in the composers (they stay bounded
— the handoff's rule), semantic/vector search as a prerequisite (it can come
later as a ranking signal behind the same interface), cloud deployment.

## Design decisions (proposed, for review)

| # | Decision | Why |
|---|---|---|
| U1 | One **search projection** per tenant: `SearchDoc { tenant, type, id, title, text, facets{}, people[], edges[], acl, updatedAt }`, written by the providers that own each record (write-through), plus a rebuild-from-providers path for `dev:mock` and recovery. | Today `/api/search` scans six providers per request and only for orgiq; four tenants have no server search at all. A projection gives every tenant the same reader without a second spelling per tenant. |
| U2 | `SearchIndex` provider interface: `put(doc)`, `remove(key)`, `query({tenant, terms, types, facets, principal, limit, cursor})`, `neighbours(key, edgeTypes)`. Implementations: `memory` (mock and tests) and `kv` (DynamoDB wire protocol). | Storage-agnostic by construction; the user runs a DynamoDB-compatible store, not Aurora. |
| U3 | KV layout (no SQL): docs table `PK = tenant#type#id`; a token table `PK = tenant#tok#<term>`, `SK = <score-bucket>#type#id` (prefix + trigram-free word tokens, stemmed); facet GSI `PK = tenant#facet#<name>=<value>`, `SK = updatedAt`; adjacency items `PK = tenant#node#type#id`, `SK = edge#<label>#type#id`. Query = BatchGet token postings → intersect → BatchGet docs → ACL filter → rank. Streams (supported by managed-nosql-store) can feed the projection later; write-through is enough for phase S1. | Fits Query/BatchGet/GSI only; no scans on the hot path; works the same in DynamoDB proper. |
| U4 | **Entities that are missing become first-class doc types**: team (orgiq department/team, assessment team, social team), channel, message, pin, recording transcript segment, run, definition, approval, access request, catalog item, audit event, review item, delegation. | Most "unsupported" rows in the matrix are a missing type, not a ranking problem. |
| U5 | **Edges become searchable**: decision `decider`/`contributor`, person `collaborates`, team `member`, run `retried-by`, request `approved-by`/`rejected-by`, channel `member`/`owner`. `neighbours()` answers "who worked with X", "who approved Y", "who is on Z". | The people graph has the edges (`/api/graph/people/:id`) but search does not; decision participants never reach search results. |
| U6 | **Implicit principal**: "my", "me", "I", "waiting on me", "assigned to me" bind to the signed-in person (by `personId`, never the session `sub`) before the query runs. | "my open work", "my pending requests" fail today; access keys "mine" on `session.sub`, which also makes clones blind. |
| U7 | **Question → query rewrite is deterministic** (a grammar like `local-answers/match.ts`, per tenant), not an LLM: strip question scaffolding ("who knows", "find the", "which … are"), map status words to facets (failed, open, pending, blocked, staged, paused, sensitive, withdrawn), map time words to ranges (this week, today). | The same rewrite feeds the search page, the palette and the composers' "did you mean". Bounded, testable, offline. |
| U8 | **Palette = record jump + search hand-off in every tenant**: cmdk filtering on pages stays; a dynamic group asks `SearchIndex.query(limit 5)` for the typed text and shows records (people, teams, channels, runs, requests…) with their type. Token-wise matching replaces the in-order character match that makes "my open requests" find nothing. | The palette promises "a person", "TEAM-0NN", "req-0001" in its placeholders and reaches none of them. |
| U9 | **Composers stay bounded but forgiving**: on a rejection, run the U7 rewrite; if it yields a supported command, show it as a one-click suggestion ("Did you mean: show failed runs?") — never apply it silently. | Keeps the handoff's rule (no fake AI input) while closing the phrasing gap. |
| U10 | **The orgiq Answer path never asserts unsupported facts**: the mock agent's keyword table only answers when the question is about its topic and the attached `search_context` does not drive the routing; unknown questions fall through to "I can't answer that here" plus the search results. Local answers grow the intents in the plan. | "who knows Kubernetes" answers Theo Chang (score 89), who has no Kubernetes skill. |

## Phases

Each phase ends with the judge green for that phase. Phases nest.

- **S0 — the judge exists (this draft's probe, hardened).** The catalog and the
  probe run headless against `dev:mock` as clones, read-only; the report
  prints per-tenant pass rates; journey maps exist for the 17 role personas'
  top intents (one map per intent family, `docs/journeys/maps/user-search/`).
  Baseline recorded; floors only ratchet up.
- **S1 — projection + orgiq parity.** `SearchIndex` (memory + kv), the orgiq
  types re-indexed through it, `/api/search` reads the index; team, decision
  participants and collaborator edges indexed (U4, U5 for orgiq); implicit
  principal (U6); mock agent routing fix (U10). Target: orgiq pass ≥ 70%.
- **S2 — every tenant searchable.** Assessment (team, submission, run,
  feedback, exception, story, document), social (channel, message, pin, room,
  recording segment, team, contact), pipelines (run, definition, approval,
  runbook, queue, artifact, bot), access (request, catalog item, policy,
  review item, audit event, delegation) as doc types with their facets; one
  `/api/search` per tenant prefix behind `requireTenant` (`/api/<tenant>/search`),
  ACL by the same Cedar actions the list routes use. Target: each tenant ≥ 60%.
- **S3 — entry points.** Palette record group in every tenant (U8); composer
  "did you mean" (U9); the question rewrite (U7) shared by search, palette and
  composers; list-page search boxes fall back to the server query when the
  loaded window misses (`totalIsLowerBound` honesty). Target: each tenant ≥ 80%,
  phrasing rate ≥ 60%.
- **S4 — answers.** Local answers per tenant for the aggregate intents (failed
  runs this week, pending on me, below target, over budget, who approved X),
  with the same `local_answer` stream shape; the Answer tab available outside
  orgiq where a read agent exists, otherwise a deterministic answer card on the
  search page. Target: each tenant ≥ 90%, zero `wrong`.

## The judge (outline): `scripts/validate-user-search.sh`

Mechanical, like the other validators; `--quick` skips the browser.

1. **Catalog integrity** (`--quick`): every intent has ≥ 3 phrasings, a seed-backed
   expected answer (each `keys` entry resolves through the mock fixtures; each
   `text` pattern matches a fixture row), a best surface, and a persona that
   holds the role; ≥ 15 intents per tenant; every tenant × role has ≥ 3 intents.
2. **Probe freshness**: `docs/user-search-probe-results.json` was produced from
   the current catalog (hash of the catalog in the results) and from a tree no
   older than the last change under `middleware/src/providers/search*`,
   `middleware/src/lib/local-answers/`, `portal/src/pages/search/`,
   `portal/src/components/collections/` or `portal/src/components/shell/portalCommands.ts`.
3. **Pass-rate floors per tenant** (`node scripts/user-search-report.mjs --check
   orgiq=…,assessment=…,…`): floors live in `scripts/user-search-floors.tsv`, one
   row per tenant with a due date, ratchet up only (the burn-down pattern of
   `portal/e2e/type-scale-burndown.tsv`).
4. **Zero wrong on best surfaces**: no intent's best surface may be `wrong` for
   any natural phrasing (wrong answers are worse than none).
5. **Journey maps per intent family**: for each intent marked `map: true` in the
   catalog (the top 5 per tenant), a map under `docs/journeys/maps/user-search/<tenant>/<role>/`
   walks query → result → record open (≤ 2 clicks asserted with `expect.url`),
   read-only `scenario: 'shared'`, `identity: 'clone'`; `run-maps.mjs coverage`
   counts them; the judge fails on a missing or failing map.
6. **Storage-agnostic guard** (`--quick`): no file under
   `middleware/src/providers/search*` or `middleware/src/lib/search-index/`
   imports `rds-data`, `pg`, or contains SQL keywords in string literals; the
   kv implementation's tests run against the in-memory DynamoDB wire stub.
7. **Clone parity**: every intent that is "mine"-scoped returns the same
   answer for the persona and for its clone (person-keyed, not sub-keyed).

## Lanes

| Lane | Model | Scope | Why that model |
|---|---|---|---|
| L1 Index contract | **Opus** | `SearchIndex` interface, `SearchDoc` shape, KV layout, ACL filtering, the rebuild path, the storage-agnostic guard | Authority and data-boundary design; wrong ACL here leaks records across tenants and roles |
| L2 Implicit principal + clone parity | **Opus** | U6: "me" binding by `personId`; access `isParty` by person; the clone contract in `docs/mock-floor.md` | Identity semantics; a security-adjacent change to who sees "mine" |
| L3 Question rewrite grammar | **Opus** (design) → Sonnet (per-tenant tables) | U7 shared parser + per-tenant facet/time tables + tests | Shared grammar is a contract; the tables are mechanical |
| L4 orgiq types and edges | Sonnet | team docs, decision participants, collaborator edges, `neighbours()` in `/api/search`; mock agent routing fix (U10) | Bounded provider work with tests |
| L5 Assessment + social docs | Sonnet | doc writers for the U4 types, tenant search routes, fixtures | Mechanical, follows L1 |
| L6 Pipelines + access docs | Sonnet | same for pipelines/access; access request/audit/review/delegation | Mechanical, follows L1/L2 |
| L7 Palette record group | Sonnet (ui-components first) | U8: the library palette gains an async record group + token matching (ship in `@connorhoehnslalom/ui-components`, then pin) | Component discipline: the primitive lives in the library |
| L8 Composer "did you mean" | Sonnet | U9 on `CollectionCommandHost`, `runCommands.ts`, `pipelineCollectionCommands.ts`, access/assessment adapters | Bounded UI glue with tests |
| L9 Local answers per tenant | Opus (shape) → Sonnet | S4 intents per tenant, same stream shape | New intents must not over-claim; review needed |
| L10 Judge + maps | Sonnet | `validate-user-search.sh`, floors TSV, journey maps per intent family | Mechanical once the outline is agreed |

Serialize: L1 before L4–L6; L2 before L6; L7 needs one ui-components release
(batch it; see the release-cadence note). Live probes run one process per
tenant group at most, as clones only.

## Open questions for review

1. Is write-through into the projection acceptable for S1, or should the
   projection be stream-fed from day one (managed-nosql-store supports streams)?
2. Does the palette's record group belong in ui-components' `CommandPalette`
   (an async `sources` prop) or as a portal adapter over it? The component rule
   says library first.
3. Should the Answer tab exist outside orgiq (assessment and pipelines have read
   agents/commands; social and access do not), or should S4 ship deterministic
   answer cards only?
4. Floors: start each tenant's floor at its measured baseline today, or at the
   S1 target with a due date?

## Decisions taken (user, 2026-10-15)

1. **Indexing:** update on write — every writer updates the index after commit;
   the index interface leaves room for a store change stream later.
2. **Palette records:** a record-results section in the ui-components palette,
   reused by every tenant (library first).
3. **Non-Work tenants:** an Ask tab in every tenant backed by deterministic
   local answers for its intent catalog — no model, always correct, demoable.
4. **Floors:** today's measured pass rates are each tenant's floor and only
   ratchet up.

Identity: "my / me" resolves through `lib/record-owner.ts` (demo-content L0),
so a clone of a persona searches as that persona.

## Built (2026-10-15)

- **S0.** `scripts/validate-user-search.sh` (catalog integrity, probe freshness by
  a source digest, ratcheting floors in `scripts/user-search-floors.tsv`, zero-wrong
  on the best surface as a per-tenant max, the `user-search` journey maps —
  logs in `docs/user-search-journeys/`, because `docs/search-journeys/` is the
  search workspace's audit — the storage-agnostic guard, the update-on-write
  check `scripts/check-search-writers.mjs`, clone parity). Five Work maps walk
  green; the other tenants' twenty are held for S2/S3 with their reason.
- **S1.** `middleware/src/lib/search-index/`: `SearchIndex` (memory; kv over the
  DynamoDB wire — Query/BatchGet/BatchWrite/one GSI), one contract suite over
  both (the kv leg runs against `localhost:8000` when it answers), partitions per
  mock scope and world generation, the orgiq projection (person, team,
  initiative, work, decision with participants, knowledge, asset; collaborator,
  member, decider edges), update on write from every orgiq writer, the
  question rewrite (`question.ts`) shared by `/api/search` and the Answer tab's
  index answers (`answers.ts`), "my / me" through `lib/mine.ts` →
  `lib/record-owner.ts`. The mock agent routes on the question only.
- **Measured** (probe digest 77bb1e79): orgiq pass 96% (22/23; baseline 75%),
  phrasings 93% (59%), wrong on the best surface 0 (26).
- **Open:** team records are not drawn by the portal until the library's
  `RecordResultType` has `team` (`docs/ui-components-queue.md`); the palette
  record group (ui-components 2.457.0 `searchRecords`) is not pinned or wired (S3).

## Built (2026-10-16): S3 pages and S4 answers

- **S3 page work.** The eleven maps held for "the list search does not surface the
  record, or the row has no record route" walk: run, runbook, queue, bot/agent/command,
  policy, catalog-item, team and submitter cells are record links; the assessment run
  list follows the status set in the command box; the submissions list no longer repeats
  the team name; the request form's preview does not send the signed-in user's own id.
  Eight maps that start from the palette stay held (the record group is not wired).
- **S4 answers.** `middleware/src/lib/tenant-answers` answers assessment and access
  aggregate/edge questions as one fixed fact from the reader's SearchIndex projection
  (`GET /api/<tenant>/search/answer`); orgiq's `single-threaded` intent reads the open
  bus-factor findings; Social's contact command answers "who is online" with the roster
  tally. **No tenant but orgiq has an Ask tab**, so the answers surface in the page
  command box (`collection-command-answer`) when no command recognises the phrase; an
  answer card is queued in `docs/ui-components-queue.md`.
- **Measured** (S4 probe, 2026-10-16): orgiq 100%, assessment 78%, social 100%,
  pipelines 100%, access 83%; wrong on the best surface 0 everywhere. The catalog's
  expected answers for a-team-lead, a-unassigned, a-who-approved-exception, p-def-owner
  were stale against the content lane's fixtures and were re-derived; `expected.derived`
  marks facts (a count, an absence, a live tally) that no single seed row carries.


## Built (2026-10-16): S5, every tenant at 100%

- **Why four assessment and two access intents read partial.** Their command-box
  answers were right, but the table under the box did not change, and the report's
  "the box ignored the query" cap (same rows for every phrasing) graded them down.
  The fix is in the product: a fixed-fact answer now also narrows the page's table
  to the records it cites (`portal/src/components/collections/useAnswerScope.ts`;
  `CollectionCommandAdapter.showAnswer`; dismissing the answer, or `reset filters`,
  puts the rows back). Wired on the assessor's desk (teams without a lead),
  question queue (open exceptions; an answered question widens the status),
  submissions (staged), access catalog (sensitive) and requests (a report's
  requests switch the view to the reports'; my requests). The report's cap now
  skips a box whose rows differ from the unfiltered page (`scripts/user-search-report.mjs`),
  because narrowing to the same cited records for every phrasing is the answer, not
  an ignored query.
- **Access requester intents.** The four marked clone-blind (x-my-pending,
  x-request-status, x-why-rejected, x-withdrawn) were stale: a clone has stood in for
  its persona since `b060f172`/`b9a4471e`, and the palette already found Rhea's
  requests. The marker is removed (they count in the rate) and
  `lib/tenant-answers/access.ts` answers them (`access:my-requests`: pending, rejected,
  withdrawn, one request by id or by what it asks for).
- **Measured** (2026-10-16 full probe): orgiq, assessment, social, pipelines, access
  all 100% (18/18, 16/16 for access), wrong on the best surface 0. The best surface
  of a-answered and x-reports-requests is the page's list search, which still does not
  surface them; the command box does.
