# User search intents — catalog, probe results, gaps, plan

Status: **design for review, 2026-10-15. Nothing in the product changed.** The
goal draft that follows from this is `docs/user-search-goal.md`.

The question behind this document: which questions do people in each tenant
actually ask, can they get an answer today, and what has to change so they can?
It is answered by an executable catalog and a headless probe, not by reading
the code.

- **Catalog:** `portal/e2e/user-search-catalog.ts` — 87 intents across the five
  tenants and all 17 tenant × role pairs, 3–4 natural phrasings each, the answer
  the `dev:mock` seed holds for each, and the entry points worth trying.
- **Probe:** `portal/e2e/user-search-probe.spec.ts` — signs in as a fresh clone of
  each role's seed persona (`openAsClone`, its own mock scope), types every
  phrasing into every entry point, and records what came back.
- **Results:** `docs/user-search-probe-results.json` — 704 probes (695 graded, 9
  API evidence rows), per-persona drift/HTTP-error/blocked-write logs.
- **Report:** `node scripts/user-search-report.mjs [--markdown|--json|--check t=f,…]`
  re-grades the evidence with the current rules and prints the matrix below.

## How the probe works and what a verdict means

Entry points tried (only where the tenant has one):

| surface | what the probe does | tenants |
|---|---|---|
| **search** | `/iq/search?q=…&tab=results`; reads the `/api/search` response and the rendered `[data-record-key]` rows | orgiq only (`/api/search` is `requireTenant('orgiq')`, `middleware/src/routes/search.ts:7`) |
| **answer** | types into the search composer and sends; reads the AG-UI stream from `POST /api/agents/orgiq-supervisor/invoke` | orgiq only |
| **palette** | ⌘K on the tenant's landing page, types the phrasing, reads the cmdk options | all five |
| **composer** | the list page's `CollectionCommandHost` (or the runs ledger); natural phrasings, then the bounded command a person who read the help would type (marked `g:`) | all five, ~20 pages |
| **list-search** | the list page's own search box; natural phrasings, then the bare keyword (`g:`) | assessment, social, pipelines, access |
| api | a GET to the endpoint that holds the answer, as evidence for root causes; never counted | — |

Verdicts per probe:

- **supported** — the expected record is in the top 3 (search), the answer names
  it and was computed from the question (answer), a record option names it
  (palette), or it is among the rows after the query narrowed the list
  (composer, list-search). All 100 supported probes reach the record in ≤ 2 clicks.
- **partial** — reachable but not answered: rank > 3, a page or `/iq/search`
  hand-off only, the row visible without the query narrowing anything, the box
  returning the same rows for every phrasing, or the intent only answered by
  the bounded command and not by any natural phrasing.
- **wrong** — something came back and it is not the answer (unrelated rows or
  options, or an answer that asserts something false; every dev:mock
  keyword-routed canned reply counts as wrong, whatever it happens to name).
- **unsupported** — rejected, empty, no such box, no such surface.

An intent's verdict is its best surface; a surface's verdict is its best
natural phrasing (grammar-only success caps at partial). "Phrasings answered" is
the share of natural phrasings that some surface supported.

Read-only: every non-GET the page made was refused with a 403 except the read
agent's invoke. Three writes were attempted and refused — the assessment
workspace's `POST /api/assessment/knowledge/canvas` and `…/presence` on page
load, and `POST /api/social/dms` when the contacts composer ran "message Lena"
(the grammar's `message X` opens a DM, which creates one).

Caveats: social `teams`, `rooms`, `calls` and `recordings` answered 502 throughout
(the local platform-api was not serving), so those intents were probed through
the palette only. The BFF restarted three times mid-run (other sessions' edits);
the probe detected the lapsed session (`drift` in the results), re-opened a
clone and retried infrastructure misses once. The latencies for palette and list
surfaces include fixed settle waits; only search (median 73 ms) and answer
(median 0.98 s) latencies are meaningful.

## Results

### Pass rate per tenant

| tenant | intents | supported | partial | wrong | unsupported | pass rate | reach rate | phrasings answered |
|---|---|---|---|---|---|---|---|---|
| orgiq | 20 | 15 | 2 | 3 | 0 | 75% | 85% | 59% |
| assessment | 18 | 6 | 4 | 4 | 4 | 33% | 56% | 11% |
| social | 17 | 1 | 0 | 10 | 6 | 6% | 6% | 2% |
| pipelines | 16 | 4 | 5 | 2 | 5 | 25% | 56% | 13% |
| access | 12 | 3 | 3 | 1 | 5 | 25% | 50% | 8% |

"Pass rate" = intents supported on some surface. "Reach rate" = supported or
partial. Access excludes four requester intents marked **clone-blind**: access
requests are "mine" by `session.sub` (`isParty`, `middleware/src/lib/access/rules.ts`
via `routes/access.ts:292`), so a clone of `u-rhea` owns none of Rhea's
requests. That is itself gap G7 below; the seed persona would see them.
(Update 2026-10-16: a clone now stands in for its persona, the marker is removed and
the four intents count; see the goal's S5 section.)

How to read orgiq's 75%: it is almost all **direct record lookup** on the
Results tab (a named initiative, a decision title, a skill that is a literal
word in a person's skills). The **Answer** tab supported 24 of 61 phrasings, and
every one of those came from a *local answer* (owners, budget, status, sprints —
14 of 14 local answers were right). Of the other 47 answers, 46 were dev:mock
canned replies, 34 of them the Observability work list triggered because the
attached search records mention "Observability". Phrasing robustness is the
better number: 59% for orgiq, 2–17% elsewhere.

### Gap matrix (cells: verdict, natural phrasings supported / tried, `g:` the bounded command)

S supported · P partial · W wrong · U unsupported · — surface not offered.


#### orgiq

| intent | role | search | answer | palette | composer | list-search | verdict | phrasings |
|---|---|---|---|---|---|---|---|---|
| `o-expert-kubernetes` Find people who know a skill (Kubernetes) | member | S 3/4 | W 0/4 | P 0/4 | — | — | **supported** | 3/4 |
| `o-expert-terraform` Find people who know a skill (Terraform) | hr-admin | S 2/3 | W 0/3 | P 0/3 | — | — | **supported** | 2/3 |
| `o-expert-rag` Rank the strongest people for a skill (RAG) | org-leader | S 1/3 | W 0/3 | P 0/3 | — | — | **supported** | 1/3 |
| `o-owner-initiative` Who owns an initiative | member | S 3/3 | S 2/3 | P 0/3 | — | — | **supported** | 3/3 |
| `o-smes-initiative` Who are the SMEs on an initiative | member | S 1/3 | S 1/3 | P 0/3 | — | — | **supported** | 2/3 |
| `o-team-members` Who is on a team / department | member | P 0/3 | W 0/3 | W 0/3 | — | — | **partial** | 0/3 |
| `o-collaborators` People who worked with someone | org-leader | W 0/3 | W 0/3 | W 0/3 | — | — | **wrong** | 0/3 |
| `o-adr` Find a decision / ADR | member | S 3/3 | W 0/3 | P 0/3 | — | — | **supported** | 3/3 |
| `o-who-decided` Who made a decision | member | S 2/3 | W 0/3 | P 0/3 | — | — | **supported** | 2/3 |
| `o-open-decisions` Which decisions are still open / escalated | program-owner | W 0/3 | W 0/3 | W 0/3 | — | — | **wrong** | 0/3 |
| `o-over-budget` What is over budget | org-leader | W 0/3 | S 2/3 | W 0/3 | — | — | **supported** | 2/3 |
| `o-unbudgeted` Which initiatives have spend with no budget | org-leader | W 0/3 | S 3/3 | W 0/3 | — | — | **supported** | 3/3 |
| `o-blocked` What's blocked | program-owner | S 1/3 | S 3/3 | P 0/3 | — | — | **supported** | 3/3 |
| `o-behind-sprints` Which sprints are behind | program-owner | W 0/3 | S 3/3 | W 0/3 | — | — | **supported** | 3/3 |
| `o-what-changed` What changed on an initiative recently | program-owner | S 3/3 | W 0/3 | P 0/3 | — | — | **supported** | 3/3 |
| `o-initiative-status` Status of a named initiative | org-leader | S 3/3 | W 0/3 | P 0/3 | — | — | **supported** | 3/3 |
| `o-failed-runs` Which agent runs failed this week | sme | W 0/3 | W 0/3 | W 0/3 | S 1/3 | — | **supported** | 1/3 |
| `o-my-work` My open work | sme | W 0/3 | W 0/3 | W 0/3 | U 0/3 (g:U) | — | **wrong** | 0/3 |
| `o-knowledge` Find a how-to in the knowledge base | member | S 2/3 | W 0/3 | P 0/3 | — | — | **supported** | 2/3 |
| `o-single-threaded` Where are we single-threaded (bus factor) | org-leader | W 0/3 | W 0/3 | W 0/3 | P 0/3 (g:S) | — | **partial** | 0/3 |

#### assessment

| intent | role | search | answer | palette | composer | list-search | verdict | phrasings |
|---|---|---|---|---|---|---|---|---|
| `a-team-lookup` Find a team by name or id | assessor | — | — | W 0/3 | P 0/3 (g:S) | S 1/3 (g:S) | **supported** | 1/3 |
| `a-my-teams` My teams | assessor | — | — | W 0/3 | U 0/3 (g:U) | — | **wrong** | 0/3 |
| `a-team-lead` Who leads a team | assessor | — | — | U 0/3 | P 0/3 (g:S) | P 0/3 (g:S) | **partial** | 0/3 |
| `a-unassigned` Teams without a lead | program-lead | — | — | W 0/3 | U 0/3 (g:U) | — | **wrong** | 0/3 |
| `a-white-glove` Teams in a motion | program-lead | — | — | — | S 1/3 | U 0/3 (g:U) | **supported** | 1/3 |
| `a-below-target` Teams below the target level | lead-assessor | — | — | U 0/3 | U 0/3 (g:U) | P 0/3 (g:P) | **partial** | 0/3 |
| `a-overclaim` Where self-claims exceed the score | program-lead | — | — | U 0/3 | P 0/3 (g:U) | — | **partial** | 0/3 |
| `a-failed-runs` Which runs failed | lead-assessor | — | — | W 0/3 | S 1/3 | — | **supported** | 1/3 |
| `a-running` What's running now | assessor | — | — | W 0/3 | S 1/3 | — | **supported** | 1/3 |
| `a-open-exceptions` Open exception reviews | lead-assessor | — | — | — | P 0/3 (g:P) | U 0/3 (g:U) | **partial** | 0/3 |
| `a-who-approved-exception` Who approved an exception | program-lead | — | — | U 0/3 | U 0/3 (g:W) | — | **unsupported** | 0/3 |
| `a-answered` Find an answered question | lead-assessor | — | — | — | U 0/3 (g:W) | U 0/3 (g:U) | **unsupported** | 0/3 |
| `a-staged` Submissions not yet committed | lead-assessor | — | — | — | U 0/3 | U 0/3 (g:U) | **unsupported** | 0/3 |
| `a-submission-by` A person's submission | assessor | — | — | — | P 0/3 (g:S) | S 1/3 (g:S) | **supported** | 1/3 |
| `a-dimension-evidence` Evidence for a dimension on a team | assessor | — | — | W 0/3 | U 0/3 (g:W) | — | **wrong** | 0/3 |
| `a-standard-doc` Find a standards document | assessor | — | — | W 0/3 | — | U 0/3 (g:U) | **wrong** | 0/3 |
| `a-recording` Find a recorded huddle | lead-assessor | — | — | U 0/3 | — | — | **unsupported** | 0/3 |
| `a-skill-team` Ambiguous term that names a team (Kubernetes) | assessor | — | — | W 0/3 | — | S 1/3 | **supported** | 1/3 |

#### social

| intent | role | search | answer | palette | composer | list-search | verdict | phrasings |
|---|---|---|---|---|---|---|---|---|
| `s-find-channel` Find a channel | participant | — | — | W 0/3 | — | U 0/3 | **wrong** | 0/3 |
| `s-find-person` Find a person | participant | — | — | W 0/3 | P 0/3 (g:S) | S 1/3 (g:S) | **supported** | 1/3 |
| `s-presence` Who's around right now | participant | — | — | W 0/3 | U 0/3 (g:U) | — | **wrong** | 0/3 |
| `s-message-community-call` Find a message by what it said | participant | — | — | U 0/3 | — | U 0/3 (g:U) | **unsupported** | 0/3 |
| `s-release-train` Find an announcement | participant | — | — | W 0/3 | — | U 0/3 | **wrong** | 0/3 |
| `s-incident-cause` Why did an incident happen | moderator | — | — | U 0/3 | — | U 0/3 (g:U) | **unsupported** | 0/3 |
| `s-pinned` What's pinned in a channel | moderator | — | — | W 0/3 | — | — | **wrong** | 0/3 |
| `s-cutover-window` Find a pinned plan | moderator | — | — | U 0/3 | — | U 0/3 (g:U) | **unsupported** | 0/3 |
| `s-channel-members` Who is in a channel | community-admin | — | — | U 0/3 | — | U 0/3 (g:U) | **unsupported** | 0/3 |
| `s-channel-owner` Who owns a channel | moderator | — | — | U 0/3 | — | U 0/3 (g:U) | **unsupported** | 0/3 |
| `s-team-members` Who is on a team | moderator | — | — | W 0/3 | — | — | **wrong** | 0/3 |
| `s-dm` Find a direct conversation | community-admin | — | — | W 0/3 | — | U 0/3 (g:U) | **wrong** | 0/3 |
| `s-missed-calls` Missed calls | participant | — | — | W 0/3 | — | — | **wrong** | 0/3 |
| `s-live-huddle` Is anyone in a huddle | participant | — | — | W 0/3 | — | — | **wrong** | 0/3 |
| `s-recording-decision` What was decided in a recorded call | participant | — | — | U 0/3 | — | — | **unsupported** | 0/3 |
| `s-room` Find a room | participant | — | — | W 0/3 | — | — | **wrong** | 0/3 |
| `s-mod-guidelines` Find the moderation guidelines | moderator | — | — | W 0/3 | — | U 0/3 (g:U) | **wrong** | 0/3 |

#### pipelines

| intent | role | search | answer | palette | composer | list-search | verdict | phrasings |
|---|---|---|---|---|---|---|---|---|
| `p-failed-runs` Which runs failed this week | operator | — | — | W 0/3 | P 0/3 (g:S) | W 0/3 (g:W) | **partial** | 0/3 |
| `p-running` What's running now | operator | — | — | W 0/3 | P 0/3 (g:S) | — | **partial** | 0/3 |
| `p-run-error` Why did a run fail | operator | — | — | U 0/3 | U 0/3 (g:U) | U 0/3 (g:U) | **unsupported** | 0/3 |
| `p-pending-approvals` What is waiting for my approval | operator | — | — | W 0/3 | P 0/3 (g:S) | P 0/3 (g:S) | **partial** | 0/3 |
| `p-who-approved` Who approved a change | operator | — | — | U 0/3 | — | U 0/3 (g:W) | **unsupported** | 0/3 |
| `p-find-definition` Find a definition | author | — | — | W 0/3 | S 1/3 (g:S) | S 1/3 (g:S) | **supported** | 2/3 |
| `p-def-owner` Who owns a definition | author | — | — | W 0/3 | — | W 0/3 | **wrong** | 0/3 |
| `p-paused-bots` Which bots are paused | pipeline-admin | — | — | U 0/3 | U 0/3 | — | **unsupported** | 0/3 |
| `p-bot-last-run` When did a bot last run | pipeline-admin | — | — | U 0/3 | U 0/3 (g:U) | S 1/3 (g:S) | **supported** | 1/3 |
| `p-runbook` Find a runbook | author | — | — | U 0/3 | P 0/3 (g:S) | P 0/3 (g:S) | **partial** | 0/3 |
| `p-needs-dry-run` Runbooks that still need a dry run | author | — | — | — | S 1/3 | — | **supported** | 1/3 |
| `p-dead-letter` Dead-letter queue | operator | — | — | P 0/3 | S 1/3 | S 1/3 (g:U) | **supported** | 2/3 |
| `p-run-failure-reason` Why did the token-verifier run fail | operator | — | — | U 0/3 | U 0/3 (g:W) | — | **unsupported** | 0/3 |
| `p-assessment-runs` Runs from another workspace | operator | — | — | W 0/3 | U 0/3 | — | **wrong** | 0/3 |
| `p-transcript-artifacts` Artifacts of a kind | author | — | — | W 0/3 | P 0/3 | — | **partial** | 0/3 |
| `p-run-cost` Most expensive runs | pipeline-admin | — | — | U 0/3 | U 0/3 (g:U) | — | **unsupported** | 0/3 |

#### access

| intent | role | search | answer | palette | composer | list-search | verdict | phrasings |
|---|---|---|---|---|---|---|---|---|
| `x-my-pending` My pending access requests | requester | — | — | U 0/3 | U 0/3 (g:U) | U 0/3 (g:U) | **clone-blind** | 0/3 |
| `x-request-status` Status of a specific request | requester | — | — | U 0/3 | U 0/3 (g:W) | U 0/3 | **clone-blind** | 0/3 |
| `x-why-rejected` Why was my request rejected | requester | — | — | U 0/3 | U 0/3 | U 0/3 (g:U) | **clone-blind** | 0/3 |
| `x-withdrawn` Withdrawn requests | requester | — | — | — | U 0/3 (g:U) | U 0/3 (g:U) | **clone-blind** | 0/3 |
| `x-find-entitlement` How do I get access to X | requester | — | — | U 0/3 | P 0/3 (g:S) | S 1/3 (g:S) | **supported** | 1/3 |
| `x-join-initiative` Access to an initiative | requester | — | — | U 0/3 | P 0/3 (g:S) | P 0/3 (g:S) | **partial** | 0/3 |
| `x-sensitive` Which roles are sensitive | requester | — | — | — | U 0/3 | U 0/3 (g:U) | **unsupported** | 0/3 |
| `x-waiting-on-me` What is waiting on me | approver | — | — | W 0/3 | P 0/3 (g:S) | P 0/3 (g:S) | **partial** | 0/3 |
| `x-reports-requests` My reports' requests | approver | — | — | — | U 0/3 (g:U) | U 0/3 (g:U) | **unsupported** | 0/3 |
| `x-delegation` Who covers my approvals | approver | — | — | U 0/3 | — | — | **unsupported** | 0/3 |
| `x-who-approved` Who approved a request | access-admin | — | — | U 0/3 | P 0/3 (g:S) | P 0/3 (g:S) | **partial** | 0/3 |
| `x-person-access` What access does a person have | access-admin | — | — | U 0/3 | U 0/3 (g:U) | U 0/3 (g:U) | **unsupported** | 0/3 |
| `x-sod` Separation-of-duties conflicts | access-admin | — | — | W 0/3 | S 1/3 | — | **supported** | 1/3 |
| `x-review-undecided` Who still needs a review decision | access-admin | — | — | W 0/3 | S 1/3 (g:S) | — | **supported** | 1/3 |
| `x-temporary` Time-bound grants | access-admin | — | — | W 0/3 | U 0/3 (g:U) | — | **wrong** | 0/3 |
| `x-overrides` Override events in the audit log | access-admin | — | — | U 0/3 | U 0/3 (g:U) | — | **unsupported** | 0/3 |

### Evidence worth reading (from the results JSON)

- **"who knows Kubernetes" (orgiq member).** Results: `decision:d-k8s` first, then
  Henry Hassan, Hugo Lee, Marcus Müller, Marcus Shah — right people, rank 2–5.
  Answer: "Based on the knowledge graph analysis, **Theo Chang** … top Kubernetes
  expert with an influence score of 89/100" — Theo has no Kubernetes skill
  (`middleware/src/mock/people.ts:39`); the canned row is
  `middleware/src/mock/responses.ts:41`. "find someone who can help with k8s"
  returns three unrelated knowledge notes: `k8s` is not a synonym and "someone",
  "help" are query terms. `/api/graph/help?q=kubernetes` (the "who knows X"
  reader, `lib/help-search.ts:78`) has the right answer and the search page
  never calls it (only `InvokePage.tsx:688`).
- **"people who worked with Nora" (org-leader).** Results: Nora Chang, Nora DaSilva,
  Nora Foster — the people *named* Nora. Her collaborators (Caleb Turner 0.94,
  Marcus O'Brien 0.74 …) are in `/api/graph/people/p-004` and absent from search.
- **"which decisions are still open" (program-owner).** Results: OpenSearch notes
  ("open" matched "OpenSearch"); status is not a searchable field, so
  `d-cognito-cutover` (escalated) and `d-eval-judge-model` (open) never appear.
- **"show failed runs" (orgiq sme).** Search has no run type: 13 knowledge notes.
  The runs composer supports exactly "show failed runs"; "failed runs" and
  "which runs failed this week" are rejected.
- **"what am I working on" (orgiq sme).** "my", "me", "I" are stopwords
  (`providers/search.ts:57`), so the principal disappears; results are random
  work items. No surface binds "me" to the signed-in person.
- **"which runs failed this week" (pipelines operator).** Composer: rejected
  (runs grammar requires a leading verb and rejects leftover words like "this
  week", `components/runs/runCommands.ts`). Palette: "No results". List box:
  matches titles, not status. Bounded "show failed runs": supported.
- **"req-0002" (access requester).** Palette placeholder says "Jump to a request
  (req-0001)…"; typing `req-0002` gives "No results." — no resolver exists
  (`portal/src/components/shell/portalCommands.ts:459-516`).
- **"Northstar Payments" (assessment assessor).** Palette: "No results". Teams
  composer: "Command not recognized" (a bare name is not a command); "open
  Northstar Payments" opens TEAM-001. The list box finds it.
- **"incidents" (social participant).** Palette offers the Channels *page* only.
  `/social/channels` renders the conversation rail with **no search input at
  all** (`ConversationRail` receives `search={{ placeholder: 'Find a chat' }}`,
  `pages/social/SocialChatWorkspace.tsx:509`, but the page has zero `<input>`s at
  rest). Message text is not searchable anywhere (`matchesRailFilter` matches
  names only, `pages/social/socialChat.ts:218`).
- **"what's over budget" (orgiq org-leader).** Answer (local): "No initiative is
  over its October allocation; the closest is RAG Knowledge Search [1] at $0.36
  of $5.00 (7%)" — right. "budget overruns this month" missed the local intent
  and fell to the canned Observability reply.

## Root causes, grouped

Each group names the intents it blocks (ids from the catalog).

### R1 — No entity type for the thing being asked about
Search indexes person, initiative, work, decision, knowledge, asset, recording
(`providers/search.ts:14`), for orgiq only. Missing: **team** (orgiq departments
are a string on the person; social and assessment teams), **run** (orgiq and
pipelines), **channel / message / pin / room / recording segment** (social),
**definition / approval / runbook / queue / bot** (pipelines), **access request /
catalog item / policy / review item / audit event / delegation** (access),
**submission / feedback task / exception / story / standards doc** (assessment),
**sprint** and **finding** (orgiq).
Blocks: o-team-members, o-failed-runs, o-single-threaded, all of social, most
of pipelines/access/assessment beyond their one list page.

### R2 — Missing index field or facet
Status is not searchable (open/escalated decisions, failed/running runs,
pending approvals, staged submissions, sensitive catalog items, withdrawn
requests); time is not searchable ("this week", "today", "last run"); skills
have no synonyms (`k8s`); people have no `updatedAt`; list boxes filter only the
rows already loaded in the browser (access sends no `q=` although
`routes/access.ts:275,337` accept it; assessment runs accept `status=` server-side
and the page sends nothing).
Blocks: o-open-decisions, o-failed-runs, p-failed-runs (natural), a-staged,
x-sensitive, x-withdrawn, x-temporary, p-run-cost, p-bot-last-run.

### R3 — Ranking and query parsing
Term scoring counts question scaffolding as terms ("knows", "experts", "people",
"members", "someone", "best") and drops pronouns that carry meaning ("my", "me"
— stopwords, `providers/search.ts:57`); no person-intent detection ("who …" should
boost people); title bonuses lift docs whose title merely contains a word
("open" → OpenSearch). Blocks: o-expert-rag phrasings, o-expert-terraform
("best person for terraform modules"), o-collaborators, o-open-decisions,
o-my-work.

### R4 — The palette cannot reach records
0 of 235 palette probes produced a record option. 130 produced "No results."
because cmdk matches characters in order over page labels, so any multi-word
question fails ("my open requests" finds nothing although "Open requests" is a
page). orgiq only offers "Search workspace: …" (61 hand-offs). The tenant
placeholders promise records it cannot open: "find a team (TEAM-0NN)", "a
person", "a request (req-0001)" (`components/shell/Layout.tsx:103-109`).
Blocks: every "find X by name/id" intent outside orgiq search.

### R5 — Composers cannot express the question
129 of 147 natural phrasings were rejected ("Command not recognized … No changes
were made"). The bounded command worked for 15 of 36 canonical phrases; the
rest are not in the grammar ("show below target", "show unassigned teams",
"show mine", "show sensitive", "show capped", "show failed compaction runs",
"show assessment runs", "show paused bots"). There is no time range, no "mine",
no owner/assignee filter, and the pipeline grammar rejects bare "search X"
which the shared grammar accepts. A rejection never suggests the command that
would have worked.
Blocks: most natural phrasings in assessment, pipelines, access.

### R6 — Local answers are missing (and the agent path lies)
Local answers exist for orgiq only (budget, spend, status, work, owners, sprints)
and were right 14 of 14 times. Everything else goes to the agent; offline that is
`selectMockResponse(payload.message)` (`providers/agentcore.ts:1321`) matching
keywords over the **whole message including the `<search_context>` block**
(`lib/search-context.ts:25`), so any attached record mentioning Observability
produces the Observability work list (34 answers), and "Kubernetes" produces a
fabricated leaderboard. Missing local intents: experts by skill, collaborators,
team members, decisions by status / decider, failed runs, my work, knowledge
how-to summaries; phrasing gaps inside existing intents ("budget overruns this
month", "who is running auth migration?"). No tenant other than orgiq has an
answer surface at all.
Blocks: every aggregate question outside orgiq; most orgiq Answer phrasings.

### R7 — Identity: "me" is not a person
No surface binds "my/me/I" to the signed-in person. Access "mine" is keyed on
`session.sub` (`lib/access/rules.ts:32`), not `personId`, so a clone (and any
second login identity for the same person) sees none of its persona's requests;
the access-admin's requests page defaults to "mine" and shows nothing for
cross-person questions (x-person-access, x-temporary).
Blocks: o-my-work, a-my-teams, x-my-pending, x-request-status, x-why-rejected,
x-withdrawn (clone-blind), x-reports-requests.

### R8 — People-graph edges missing from search
The graph has `collaborates` edges (`/api/graph/people/:id`), skill strengths
(`/api/graph/skills-graph`, `/api/scores/by-skill`) and the help reader
(`/api/graph/help`); search uses none of them. Decision participants (decider,
contributor) exist only in `resolveSearchContext`, never as result edges. Team
membership is a department string. In the mock, `/people/:id` returns
`collaborates` only (hierarchy is derived only in `/entities`).
Blocks: o-collaborators, o-who-decided (answer), o-team-members, o-expert-rag
ranking, a-team-lead, s-team-members, s-channel-members.

### R9 — Project relationships missing
No initiative change history (o-what-changed is "supported" only because the
initiative row is reachable and its Activity tab is click two — nothing answers
*what* changed); runs are not linked to initiatives in search; the social
`#auth-migration` ↔ `p-auth-migration` binding (`mock/social-bindings.ts`) and
access `initiative:p-auth-migration` catalog item are not related to the
initiative record; assessment team ↔ people is one row (Asha on TEAM-001).
Blocks: o-what-changed (true answer), x-join-initiative, cross-tenant "everything
about Auth Migration".

## Ranked plan

Ranked by intents unlocked per unit of work, with the storage constraint
(DynamoDB-compatible store, no SQL) applied throughout. The goal draft turns this
into phases S0–S4 and lanes.

1. **Stop wrong answers (R6, small).** Route the dev:mock agent on the user's
   question, not the attached context; never answer with a canned reply whose
   topic the question does not name; fall back to "I can't answer that" plus
   the search results. Add the missing phrasings to existing local intents.
   Removes ~46 wrong answers; zero new storage.
2. **Implicit principal, person-keyed "mine" (R7, small–medium, Opus).** Bind
   my/me/I to `personId` before any query; key access `isParty` on the person.
   Unlocks 7 intents and makes clones honest for the judge.
3. **Search projection behind a storage-agnostic `SearchIndex` (R1, R2, large,
   Opus contract).** One `SearchDoc` shape with facets and edges, memory + KV
   implementations (token postings, facet GSI, adjacency items — Query,
   BatchGet and GSI only). Index the missing types per tenant with status and
   time facets. Unlocks most of social, pipelines, access and assessment.
4. **Palette record group + token matching (R4, medium, ui-components first).**
   An async source in the library palette, token-wise matching, record rows
   from `SearchIndex.query(limit 5)`. Fulfils the placeholders' promises.
5. **Question rewrite + "did you mean" (R3, R5, medium).** One deterministic
   rewrite (scaffolding strip, status/time/mine → facets) shared by search,
   palette and composers; composers offer the supported command on rejection,
   never apply it silently. Targets the 129 rejected phrasings.
6. **Edges in search (R8, medium).** Collaborators, decision participants, team
   membership and skill strength as `neighbours()`; the search page's People
   group uses the help reader's matching.
7. **Local answers per tenant (R6, medium).** failed/running runs, pending on me,
   below target, who approved X, what changed (once R9 has an activity feed);
   same `local_answer` stream; a deterministic answer card where no agent exists.
8. **Relationships and activity (R9, medium).** Initiative activity feed as
   indexed events; cross-tenant links (channel binding, access item, runs) as
   edges.

## Catalog

The canonical catalog is `portal/e2e/user-search-catalog.ts`; this is a readable
copy. Personas are cloned, never signed in directly.

### Work (orgiq) — 20 intents

| id | role (persona) | intent | phrasings | expected answer (seed) | best surface |
|---|---|---|---|---|---|
| `o-expert-kubernetes` | member (u-theo) | Find people who know a skill (Kubernetes) | "who knows Kubernetes" · "Kubernetes experts" · "find someone who can help with k8s" · "people with Kubernetes skills" | Marcus Müller, Marcus Shah, Sarah Singh, Henry Hassan, Sarah Thompson, Hugo Lee (skills list Kubernetes) | search (People group ranked by skill) + answer citing them |
| `o-expert-terraform` | hr-admin (u-hr) | Find people who know a skill (Terraform) | "who knows Terraform" · "Terraform skills" · "best person for terraform modules" | Layla Hassan (SRE Lead), Maria Johnson, Sienna Garcia, Hugo DaSilva, Mia Chen… | search People |
| `o-expert-rag` | org-leader (u-vera) | Rank the strongest people for a skill (RAG) | "who knows RAG best" · "top RAG experts" · "strongest retrieval-augmented generation people" | Nina Rivera, Vera Petrov, Nora DaSilva, Noah Vasquez, Caleb Patel (RAG skill) | answer (ranked by skill strength) + scores |
| `o-owner-initiative` | member (u-theo) | Who owns an initiative | "who owns the auth migration" · "Auth Migration owner" · "who is running auth migration?" | Vera Green (p-002) owns p-auth-migration | answer (local answer: owners) + search initiative row |
| `o-smes-initiative` | member (u-theo) | Who are the SMEs on an initiative | "who are the SMEs on auth migration" · "auth migration experts" · "who can help finish Auth Migration?" | Nora Chang (p-051) and Nora DaSilva (p-004) | answer (owners/SMEs) |
| `o-team-members` | member (u-theo) | Who is on a team / department | "who is on the platform team" · "Platform Engineering people" · "members of team platform" | Platform Engineering department (t-platform): Theo Chang, Vera Green, Nora DaSilva, Marcus Müller, Layla Hassan… | search People filtered by department (team entity) |
| `o-collaborators` | org-leader (u-vera) | People who worked with someone | "people who worked with Nora" · "Nora DaSilva collaborators" · "who works closely with Nora DaSilva" | Caleb Turner (0.94), Marcus O'Brien (0.74), Marcus Shah (0.72), Maria Johnson (0.71) | answer + Connections graph from the person |
| `o-adr` | member (u-theo) | Find a decision / ADR | "find the ADR about Aurora vs Neptune" · "Aurora Neptune decision" · "why did we pick Aurora over Neptune" | d-aurora "Adopt Aurora over Neptune" (cost + latency; decider Caleb Patel) | search Decisions |
| `o-who-decided` | member (u-theo) | Who made a decision | "who decided on self-hosted OTel collectors" · "who made the OpenTelemetry collector decision" · "decider for OTel collectors over vendor agents" | Nora DaSilva decided d-otel-vendor | answer (decision participants as edges) |
| `o-open-decisions` | program-owner (u-mia) | Which decisions are still open / escalated | "which decisions are still open" · "unresolved decisions" · "escalated decisions" | d-cognito-cutover (escalated, Auth Migration) and d-eval-judge-model (open, LLM platform) | search Decisions with a status filter |
| `o-over-budget` | org-leader (u-vera) | What is over budget | "what's over budget" · "which initiatives are over budget" · "budget overruns this month" | Local answer (budget): spend vs allocation per initiative; nothing over, Inference Platform has unbudgeted spend | answer (local answer: budget) |
| `o-unbudgeted` | org-leader (u-vera) | Which initiatives have spend with no budget | "which initiatives have no budget" · "unbudgeted spend" · "initiatives without an allocation" | Inference Platform (p-inference-platform) has no allocation | answer (local answer: budget) |
| `o-blocked` | program-owner (u-mia) | What's blocked | "what's blocked" · "which initiatives are blocked" · "blocked work on Observability" | Observability Platform: wi-obs-e2-b4 "Stop duplicate alerts during a dependency outage" (Eli Garcia) and more | answer (local answer: status/work) |
| `o-behind-sprints` | program-owner (u-mia) | Which sprints are behind | "which sprints are behind" · "sprints at risk" · "are any sprints slipping" | Local answer (sprints): sprints whose points-done share trails elapsed days by >25 points | answer (local answer: sprints) |
| `o-what-changed` | program-owner (u-mia) | What changed on an initiative recently | "what changed on Observability Platform" · "recent activity on observability" · "Observability updates this week" | Recent work/decisions on p-observability (no change-history endpoint exists; lastActivityAt only) | answer over an initiative activity feed |
| `o-initiative-status` | org-leader (u-vera) | Status of a named initiative | "status of LLM Application Platform" · "how is the LLM platform going" · "LLM platform progress" | p-llm-platform (owner Nina Rivera, priority high) | search initiative row + answer |
| `o-failed-runs` | sme (u-nora) | Which agent runs failed this week | "which runs failed this week" · "failed runs" · "show failed runs" | project run "Migrate the token verifier off the deprecated JWKS client" — npm test failed (2 days ago) | composer on /iq/runs ("show failed runs") |
| `o-my-work` | sme (u-nora) | My open work | "what am I working on" · "my open work items" · "work assigned to me" | Nora DaSilva's items, e.g. wi-auth-e1-s1 "BFF authorization-code + PKCE flow" and wi-obs-e3 "Cost-aware telemetry" | search with an implicit "me" (assignee = signed-in person) or /iq/work composer |
| `o-knowledge` | member (u-theo) | Find a how-to in the knowledge base | "how do I warm the Aurora Data API after idle" · "Aurora cold start" · "first Data API call fails" | runbook rb-aurora-cold-start-retry "Wake a cold Aurora Data API and retry the first call" | search Knowledge (runbooks) |
| `o-single-threaded` | org-leader (u-vera) | Where are we single-threaded (bus factor) | "where are we single-threaded" · "bus factor risks" · "knowledge held by only one person" | Open bus_factor findings (/iq/work/findings?sweep=bus_factor) | answer over findings + palette to /iq/work/findings |

### Assessment — 18 intents

| id | role (persona) | intent | phrasings | expected answer (seed) | best surface |
|---|---|---|---|---|---|
| `a-team-lookup` | assessor (u-asha) | Find a team by name or id | "Northstar Payments" · "find team TEAM-001" · "open Northstar" | TEAM-001 Northstar Payments (white glove, lead Priya Natarajan) | palette record jump + teams list |
| `a-my-teams` | assessor (u-asha) | My teams | "my teams" · "teams I'm on" · "which teams am I assigned to" | TEAM-001 Northstar Payments (Asha is a contributor) | teams list "mine" filter |
| `a-team-lead` | assessor (u-asha) | Who leads a team | "who leads Data Platform" · "Data Platform lead" · "team lead for TEAM-004" | Elena Marsh leads TEAM-004 Data Platform | teams list row (lead column) |
| `a-unassigned` | program-lead (u-farah) | Teams without a lead | "teams without a lead" · "unassigned teams" · "which teams have no lead" | TEAM-006 Fraud Detection ML and TEAM-007 Internal Tools | teams composer filter |
| `a-white-glove` | program-lead (u-farah) | Teams in a motion | "white glove teams" · "show white glove teams" · "which teams are white-glove" | TEAM-001 Northstar Payments and TEAM-004 Data Platform | teams composer filter |
| `a-below-target` | lead-assessor (u-jonas) | Teams below the target level | "which teams are below target" · "teams under level 3" · "lowest scoring teams" | TEAM-005 Notifications Service (level 1) and TEAM-003 Checkout Experience (level 2) | reports composer ("show below target") |
| `a-overclaim` | program-lead (u-farah) | Where self-claims exceed the score | "teams that over-claimed" · "self-claimed vs scored gaps" · "where was the cap applied" | TEAM-002 Kubernetes Operator (claims 5, capped to 3); TEAM-001 dimension 1 (claim 5, scored 2) | reports composer filter |
| `a-failed-runs` | lead-assessor (u-jonas) | Which runs failed | "which runs failed this week" · "failed runs" · "show failed runs" | suggest-confluence-content on Data Platform (ENG-DATA not linked); process-self-assessment on Notifications Service (row 9 team_id) | runs composer ("show failed runs") |
| `a-running` | assessor (u-asha) | What's running now | "what's running now" · "in-progress runs" · "show running runs" | score-dimensions on TEAM-003 Checkout Experience | runs composer |
| `a-open-exceptions` | lead-assessor (u-jonas) | Open exception reviews | "open exception reviews" · "pending N/A exceptions" · "which exceptions need approval" | fb-f66662469029: TEAM-001 dimension 7 (Performance & Reliability Testing) N/A requested | feedback composer ("show open") |
| `a-who-approved-exception` | program-lead (u-farah) | Who approved an exception | "who approved the security testing exception for Northstar" · "who approved the TEAM-001 N/A" · "approver of Northstar dimension 6 exception" | lead-assessor:priya approved TEAM-001 dimension 6 (internal-tooling-no-deploy) | team record (exceptions tab) reachable from search |
| `a-answered` | lead-assessor (u-jonas) | Find an answered question | "rolling deploys" · "what did Sam Okafor confirm" · "answered questions about deploys" | fb-498e9969570b TEAM-003 dimension 2: "Rolling deploys, confirmed via interview with Sam Okafor." | feedback list search (answer text) |
| `a-staged` | lead-assessor (u-jonas) | Submissions not yet committed | "staged submissions" · "submissions not committed" · "show staged submissions" | TEAM-003 form12 from Sam Okafor (staged) | submissions composer |
| `a-submission-by` | assessor (u-asha) | A person's submission | "Jordan Lee's submission" · "submission from jordan lee" · "jordan-lee" | TEAM-002 sub-20260810T091500Z-form5-jordan-lee-r3 (committed) | submissions list search |
| `a-dimension-evidence` | assessor (u-asha) | Evidence for a dimension on a team | "CI evidence for Northstar" · "continuous integration score Northstar" · "Northstar CI claim" | TEAM-001 dimension 1 (CI): self-claimed 5, scored 2; story "Close the open CI claim…" | a tenant search across teams × dimensions × stories |
| `a-standard-doc` | assessor (u-asha) | Find a standards document | "N/A exception policy" · "what counts as evidence" · "CI/CD standards" | Knowledge docs "N/A Exception Policy", "What Counts as Evidence", "CI/CD Standards" | workspace document search |
| `a-recording` | lead-assessor (u-jonas) | Find a recorded huddle | "huddle about Northstar" · "recordings mentioning CI" · "Northstar call recording" | Team huddle on assessment:team:TEAM-001 (Asha + Jonas, 22 min, 4h ago) | recording content search |
| `a-skill-team` | assessor (u-asha) | Ambiguous term that names a team (Kubernetes) | "Kubernetes" · "kubernetes team" · "the operator team" | TEAM-002 Kubernetes Operator | palette record jump |

### Social — 17 intents

| id | role (persona) | intent | phrasings | expected answer (seed) | best surface |
|---|---|---|---|---|---|
| `s-find-channel` | participant (u-sana) | Find a channel | "incidents channel" · "#incidents" · "incidents" | #incidents (owner Rachel Kowalski) | palette record jump |
| `s-find-person` | participant (u-sana) | Find a person | "Lena Brandt" · "find Lena" · "message Lena" | u-lena Lena Brandt (moderator) | palette person jump + contacts |
| `s-presence` | participant (u-sana) | Who's around right now | "who's online now" · "who is here" · "show away contacts" | Contacts by presence (here/away/offline) | contacts composer ("show away") |
| `s-message-community-call` | participant (u-sana) | Find a message by what it said | "when is the community call" · "community call time" · "community call Thursday" | #general g01 (Mira): "community call moves to Thursdays at 3pm" | message search (tenant search over chat history) |
| `s-release-train` | participant (u-sana) | Find an announcement | "when does the release train leave" · "release train" · "sign-off deadline" | #general g10 (Sienna): release train leaves Friday, sign-offs by Thursday noon | message search |
| `s-incident-cause` | moderator (u-lena) | Why did an incident happen | "why were transcripts delayed" · "transcript delay incident" · "root cause sev 3" | #incidents i08/i09: a queue sized for 30-minute calls | message search + summarize |
| `s-pinned` | moderator (u-lena) | What's pinned in a channel | "pinned messages in incidents" · "what's pinned" · "pins" | #incidents i01 (stale search health check) and 5 more pins | channel pins panel reachable from palette |
| `s-cutover-window` | moderator (u-lena) | Find a pinned plan | "when is the cutover window" · "auth migration cutover" · "cutover Thursday" | #auth-migration pin a07: cutover window Thursday 6am | message/pin search |
| `s-channel-members` | community-admin (u-mira) | Who is in a channel | "who is in #events" · "events channel members" · "members of events" | Mira, Lena, Sana, Farah, Asha, Jonas | channel header member list via palette |
| `s-channel-owner` | moderator (u-lena) | Who owns a channel | "who owns #design-reviews" · "design-reviews owner" · "design reviews channel" | Lena Brandt owns #design-reviews | palette channel jump |
| `s-team-members` | moderator (u-lena) | Who is on a team | "who is on the Community team" · "Community team members" · "Community team" | Community: Mira (owner), Lena, Sana | teams page reachable from palette |
| `s-dm` | community-admin (u-mira) | Find a direct conversation | "my DM with Theo" · "conversation with Theo" · "Theo Chang" | mira/theo DM (last: "Approved.") | palette DM jump + chat rail filter |
| `s-missed-calls` | participant (u-sana) | Missed calls | "missed calls" · "who called me" · "call history" | Mira → Sana missed, 2h ago | palette to /social/calls |
| `s-live-huddle` | participant (u-sana) | Is anyone in a huddle | "is anyone in a huddle" · "live calls now" · "join the huddle" | Live huddle in #general (Mira, Lena) | palette |
| `s-recording-decision` | participant (u-sana) | What was decided in a recorded call | "what was decided at the town hall" · "town hall recording" · "event calendar owner" | mock-rec-town-hall-1: event calendar goes live Friday with Sana as owner | recording transcript search |
| `s-room` | participant (u-sana) | Find a room | "Design crit room" · "town hall room" · "rooms" | Rooms "Design crit", "Town hall" | palette record jump |
| `s-mod-guidelines` | moderator (u-lena) | Find the moderation guidelines | "moderation guidelines" · "moderators channel" · "escalation steps" | #moderators pin m01 (moderation guidelines) | palette channel jump |

### Pipelines — 16 intents

| id | role (persona) | intent | phrasings | expected answer (seed) | best surface |
|---|---|---|---|---|---|
| `p-failed-runs` | operator (u-kofi) | Which runs failed this week | "which runs failed this week" · "failed runs" · "runs that failed" | JWKS token-verifier project run (2d), comp-104 compaction (7h), two assessment runs | runs composer ("show failed runs") |
| `p-running` | operator (u-kofi) | What's running now | "what's running" · "running runs" · "in-flight runs" | p99 latency panel project run, score-dimensions, two marketplace runs | runs composer |
| `p-run-error` | operator (u-kofi) | Why did a run fail | "why did the token verifier run fail" · "verify.test.ts failure" · "JWKS run error" | "npm test failed in auth/verify.test.ts (3 failing)" | runs title search → run record |
| `p-pending-approvals` | operator (u-kofi) | What is waiting for my approval | "what is waiting for my approval" · "pending approvals" · "approvals I need to decide" | change:9f2c… "Suppress downstream pages during a cluster-wide outage" and consult con-mock-1 | approvals page via palette + composer |
| `p-who-approved` | operator (u-kofi) | Who approved a change | "who approved RED dashboards" · "who decided the alert dedup change" · "RED dashboards approval" | "RED dashboards" delivered; "Alert dedup" changes requested (decider not surfaced) | approvals history with decider |
| `p-find-definition` | author (u-ines) | Find a definition | "score-dimensions" · "find the score dimensions command" · "open score-dimensions" | assessment:score-dimensions (owner orgiq-assessment-scorer) | palette record jump |
| `p-def-owner` | author (u-ines) | Who owns a definition | "who owns draw-diagram" · "owner of the draw-diagram command" · "draw-diagram" | orgiq-assessment-drafter owns assessment:draw-diagram | definitions list row (owner column) |
| `p-paused-bots` | pipeline-admin (u-dara) | Which bots are paused | "which bots are paused" · "disabled bots" · "show paused bots" | All 12 bots (obs-nightly-maintenance … api-contract-watch) are disabled, awaiting repo provisioning | bots composer filter |
| `p-bot-last-run` | pipeline-admin (u-dara) | When did a bot last run | "when did finops-daily-sweep last run" · "finops sweep last run" · "finops-daily-sweep" | finops-daily-sweep last ran ~26 hours ago, 0 runs today | runs ledger filtered by bot |
| `p-runbook` | author (u-ines) | Find a runbook | "security group runbook" · "custodian runbook" · "allow-list for security groups" | runbook:promo-custodian-sg-drift "Custodian revokes open security-group ingress…" | runbooks search |
| `p-needs-dry-run` | author (u-ines) | Runbooks that still need a dry run | "runbooks needing a dry run" · "never dry-run" · "show needs dry-run runbooks" | promo-custodian-sg-drift (candidate, no dry runs) | runbooks composer filter |
| `p-dead-letter` | operator (u-kofi) | Dead-letter queue | "dead letter queue" · "failed distillation deliveries" · "show dead-letter queues" | Compaction DLQ "Failed distillation deliveries" | queues composer filter |
| `p-run-failure-reason` | operator (u-kofi) | Why did the token-verifier run fail | "why did the token verifier run fail" · "token verifier failure" · "JWKS rotation test failure" | the token-verifier project run failed: 3 tests still expect the signing key from before the last JWKS rotation | run record with its error, reachable from palette |
| `p-assessment-runs` | operator (u-kofi) | Runs from another workspace | "assessment runs" · "show assessment runs" · "runs from the assessment workspace" | assessment command runs (score-dimensions running; two failed) | runs composer (workspace filter) |
| `p-transcript-artifacts` | author (u-ines) | Artifacts of a kind | "transcript artifacts" · "show transcript artifacts" · "transcripts" | Artifacts with kind transcript | artifacts composer filter |
| `p-run-cost` | pipeline-admin (u-dara) | Most expensive runs | "most expensive runs" · "run cost this week" · "what did runs cost today" | JWKS run $0.81; obs-nightly-maintenance $0.16 + $0.10 today | runs ledger sort by cost |

### Access — 16 intents

| id | role (persona) | intent | phrasings | expected answer (seed) | best surface |
|---|---|---|---|---|---|
| `x-my-pending` | requester (u-rhea) | My pending access requests | "my pending access requests" · "my open requests" · "what am I waiting on" | req-0001 (SME in Work, waiting on Omar) and req-0002 (Member of Auth Migration, steward step) | requests composer ("show open requests") |
| `x-request-status` | requester (u-rhea) | Status of a specific request | "status of req-0002" · "req-0002" · "where is my auth migration request" | req-0002 pending — manager approved, steward step current | palette record jump (req-NNNN) |
| `x-why-rejected` | requester (u-rhea) | Why was my request rejected | "why was my org leader request rejected" · "rejected requests" · "show closed requests" | req-0005 rejected by Omar: "The review does not need leaderboard access…" | requests composer filter + record |
| `x-withdrawn` | requester (u-rhea) | Withdrawn requests | "withdrawn requests" · "requests I withdrew" · "my moderator request" | req-0006 Moderator in Social, withdrawn 9 days ago | requests composer filter |
| `x-find-entitlement` | requester (u-rhea) | How do I get access to X | "budget visibility" · "how do I get budget access" · "request budget access" | capability:orgiq:budgets-read "Budget visibility in Work" | catalog search |
| `x-join-initiative` | requester (u-rhea) | Access to an initiative | "access to auth migration" · "join Auth Migration" · "Auth Migration membership" | initiative:p-auth-migration in the catalog; req-0002 already pending | catalog search |
| `x-sensitive` | requester (u-rhea) | Which roles are sensitive | "sensitive roles" · "which roles need extra approval" · "show sensitive" | role:orgiq:org-leader and role:assessment:lead-assessor are sensitive | catalog composer filter |
| `x-waiting-on-me` | approver (u-omar) | What is waiting on me | "what's waiting on me" · "approvals pending" · "requests I need to approve" | req-0001 (Rhea → SME in Work), manager step | approvals page via palette |
| `x-reports-requests` | approver (u-omar) | My reports' requests | "Rhea's requests" · "requests from my reports" · "what has Rhea asked for" | req-0001, req-0002, req-0005, req-0006 | requests search by requester |
| `x-delegation` | approver (u-omar) | Who covers my approvals | "who covers my approvals while I'm away" · "delegations" · "my delegate" | dlg-0001 Omar → Priya (expired) | palette to delegations |
| `x-who-approved` | access-admin (u-priya) | Who approved a request | "who approved req-0003" · "who approved Omar's operator access" · "req-0003 approval" | Priya approved both steps of req-0003 (4 and 3 days ago) | audit search |
| `x-person-access` | access-admin (u-priya) | What access does a person have | "what access does Nora have" · "Nora's grants" · "Nora DaSilva access" | req-0004: Nora holds SME in Work (active, standing grant) | person access view (no entity today) |
| `x-sod` | access-admin (u-priya) | Separation-of-duties conflicts | "separation of duties conflicts" · "blocking policies" · "show blocking policies" | sod-001 "Spend and allocate", sod-002 "Write and approve a pipeline" (block) | policies composer filter |
| `x-review-undecided` | access-admin (u-priya) | Who still needs a review decision | "undecided review items" · "who still needs a decision in the SME certification" · "open reviews" | rev-0001 Q4 SME certification: Layla and Caleb undecided | reviews composer + review record |
| `x-temporary` | access-admin (u-priya) | Time-bound grants | "temporary access expiring" · "time-bound grants" · "access that lapses" | req-0003 Operator in Pipelines for 7 days | requests filter by duration |
| `x-overrides` | access-admin (u-priya) | Override events in the audit log | "overrides in the audit log" · "show override events" · "policy overrides" | Audit events of kind override (evt-00NN) | audit composer filter |

