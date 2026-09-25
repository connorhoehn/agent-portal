# Distillation — the fleet's shared memory, and how it reaches the Library

`/iq/distillation` is where the org's agents' learnings become knowledge a
person can use. Every lab session writes what it learned; distillation
compacts those writes upward into stable artifacts, links each artifact to
the runbook or skill it became in the Library, and keeps the lineage so any
distilled fact can be traced back to the evidence it rests on.

## Where to look: Knowledge, Review, Activity

The module is one frame (`DistillationModule.tsx`): a vertical `SubNavLayout`
rail beside the content, and over the content a `ScopeHeader` naming the
current destination, with the repository selector and "Open Library ↗". The
rail's groups are the destinations and its entries are their views (model in
`moduleNavModel.ts`). The
three destinations answer three different questions
(`docs/distillation-redesign-spec.md` §1 is the contract):

| tab | question | route | surface |
|---|---|---|---|
| **Knowledge** | What did the agents learn that I can use? | `/iq/distillation/knowledge?view=guides\|patterns\|notes&item=&panel=sources&sourceView=list\|graph&repo&initiative&q&kind&lifecycle` | explorer (pane title, scope row with the tier count, search scoped to the view with the filter popover beside it, cursor Load more with "N of M loaded" — no view selector: the rail picks the view) · a crumb band (trail, repository selector, Open Library) · the record (Content \| History, + Runs for a procedure; Sources N on the tab row) · Sources inspector (List \| Graph) only while `panel=sources` |
| **Review** | Does this finding match the evidence? | `/iq/distillation/review?tab=pending\|decided&sample=&panel=sources` | queue (Pending N / Reviewed, rows titled by the resolved target) · the claim with Agree / Disagree (ManageBots; read-only notice otherwise) · Sources |
| **Activity** | Is new work being turned into useful knowledge? | `/iq/distillation/activity?view=runs\|graph&run=&repo&level&status` | tier-flow strip + health status line · Runs or Tier graph · run inspector |

The rail carries live counts — each Knowledge view's tier size, Pending and
Reviewed — and tints Activity → Runs amber or red when the server reports a
tier behind or stalled. Each entry's one-line description is its tooltip. Every old link still works:
`/overview` and the bare root land on Knowledge; `/tiers?level=` maps to the
matching Knowledge view; `/artifacts?open=X` and `/lineage?focus=X` open that
record (the latter with Sources → Graph); `/compactions` lands on Activity
(`distillationRoutes.migrateDistillationUrl`, tested).

The views are the tiers below under reader-facing names: **Run notes** = L0,
**Patterns** = L1, **Guides & findings** = L2. The level codes stay visible
in the tier graph and in each record's Technical details.

Live data: the pages read a REST snapshot and patch it from the middleware's
realtime channels (`distill:levels`, `distill:jobs`, `distill:review`) through
`hooks/useDistillationChannel.ts`; with no gateway they poll. To get live
frames locally set `VITE_GATEWAY_URL=ws://localhost:3001/realtime` in
`portal/.env.local` and restart Vite.

## The three tiers

| tier | what lives there | who writes it | what a person does with it |
|---|---|---|---|
| **L0 — observations** | one row per learning a session wrote (`lab_experiences`: worked / failed / gotcha / decision / convention, with the repo and initiative it is about) | many concurrent sessions; duplicates expected | browse per repo or initiative; open an observation to see its session and box |
| **L1 — clusters** | deduped, merged groups of observations that say the same thing, with a confidence | the L0 → L1 compaction | the tier humans sample: agree or disagree with a cluster's summary against its members |
| **L2 — artifacts** | stable distilled artifacts — runbooks, insights, conventions, decisions, and **procedures** (ordered steps the fleet has actually run) — each carrying its facts and the clusters it was distilled from | the L1 → L2 compaction | read it, open the Library item it was published as, open its lineage; for a procedure, see whether it still works |

Artifacts move through `draft → published → retired`. A published artifact
has a `library_item_id`: that is the runbook or skill in **Library** that
people and agents actually use. Library items show "Distilled from" so the
link runs both ways.

## Procedures and proof

A runbook is prose the next agent may or may not follow. A **procedure** is
the fleet's procedural memory: the same L2 artifact, but its facts are
ordered — each step is a fact with an `ordinal`, backed by the observation
that taught it — so it can be replayed step by step and blamed step by step.
The L1 → L2 pass mints one when the chunk of clusters it is distilling pairs
a trigger (a `failed` or `gotcha` observation: something bit) with an
outcome (a `worked` or `decision`: something resolved it) and has at least
two action-shaped members to order into steps. A chunk with no trigger is a
decision or convention; a failure with no resolution is an insight.

What makes procedural memory different from the rest of the store is that
it is judged at reuse, not at extraction. Every time a session runs a
procedure it records an **application** — `succeeded`, `failed` (and the
step it stopped on), or `abandoned` — and the middleware counts those rows
into a verdict per procedure:

- **proven** — it succeeded recently and nothing has moved since.
- **drifting** — since it last succeeded, a run failed, or a new `failed` /
  `gotcha` cluster was minted in the same repo, or the last success is older
  than two weeks. Drift is measured at L1 rather than L0, so it moves when
  a compaction lands a new failed or gotcha cluster in that repo, not on
  every raw write.
- **unproven** — published, never run to completion.

A guide's Knowledge record reads as something to use, plain language first
(`docs/distillation-guide-record-mockup.png`). **When this helps** (the
record's `when_this_helps`), then **Use it in your work** — "Draft a plan for
my project" prefills the docked composer and sends nothing, "Explain this
guide" asks the agent on `/iq/invoke`. For a procedure, a **run-warning
callout** follows when its latest run failed or was abandoned ("Check the
redirect before you use this — The last attempt stopped at step 3 because
sign-in still pointed to the old service", **View run →**); the server derives
it (`guide.run_warning`) from the application rows on each read. Then **The
approach · N steps** in plain words (`fact.plain`, falling back to the
statement) with neutral numbers, **Based on** (the source patterns, each row
opening that pattern), and a collapsed **Technical details**. Run markers
(✓ done, ! failed, ○ not reached) appear **only on the Runs tab**, which leads
with the latest-run callout ("Latest run stopped at step 3 — …"), then the run
history, and — for ManageBots — "Record a run". A record with no
`when_this_helps` (a compaction-minted one, say) shows its summary instead.

## What a compaction does

A compaction is a job (Activity → Runs) that reads one tier and writes the
next: L0 → L1 merges run notes into patterns; L1 → L2 distils patterns into
guides and their facts. Jobs are queued (`queued → running → succeeded |
failed`) and each records its own `input_ids` / `output_ids`, a log, what
changed, duration and cost — the run inspector shows exactly those, and its
Produced list links into Knowledge from the job's own output ids (never a
sample of the tier). The machine runs unattended; Activity's status line
says when a tier is behind or stalled (from the server's health verdict, not
from "last completed"), and `Compact L0 → L1` / `Compact L1 → L2`
(ManageBots) queue one by hand. Activity → Tier graph draws L0 → L1 → L2 →
Library with a job marker on an edge; only a job the server confirms is
running animates.

In the mock, L0 keeps filling at the ingest rate `GET /ingest` reports
(`observationsPerHour`): every read of levels, items or ingest mints the
observations that "landed" since the last minute tick, so a demo can run
the ladder more than once instead of finding L0 empty after one pass.

## The human sample

Clusters and artifacts drawn for review are put in front of a person on the
**Review** tab: the claim, its evidence in the Sources inspector, and Agree /
Disagree with a note ("This records your review; it does not publish the
guide"). After a verdict the next pending sample opens and the decided one
moves to Reviewed; a failed write rolls back. The sampling figures live in the
claim's **Sampling details** disclosure. The agreement rate over the last 30 days is the calibration verdict —
enough disagreement to prove the sample finds real problems, not so much that
the unreviewed rest should be trusted less.

Every sampling figure is **counted from the queue**, the
sample rate included: "% of L1 sampled" is how many L1 clusters a reviewer has
actually been handed, over how many exist. It is not a dial set in code, which
is what it used to be — a constant `4` that never moved when a sample was
decided, so the headline could and did contradict the cards below it. Because
it is counted, it drops on its own the moment a compaction pass mints clusters
nobody has reviewed, and the seeded demo corpus reads 100% because every
cluster in it really has been sampled.

## Reading lineage

A record's **Sources** inspector lists its direct evidence (List) or draws
its actual lineage (Graph, the library's `TypedNodeCanvas` with zoom
controls and a list equivalent), columns by kind:

```
session ──written_by──▶ observation ──merged_into──▶ cluster ──distilled_into──▶ artifact ──published_as──▶ library item
                                                                                     │  │
                                                                          fact ◀──supports── observation
                                                                                        └──applied_in──▶ application (a run: succeeded / failed at step n / abandoned)
```

Opening a source or a graph node opens that record in Knowledge with the
scope and the inspector kept; Back returns. The old `/lineage?focus=<id>`
deep link still resolves (to that record with Sources → Graph), and the
Library's "Distilled from" section links the same way.

## Where things live

- Middleware: `routes/distillation.ts`, `providers/distillation.ts`,
  `mock/distillation.ts` (the mock is the contract; the shapes are in
  `docs/distillation-goal.md`), `schema/distillation_schema.sql`.
- Aurora-backed reads (with `MOCK_AURORA` off): the compaction list and a single
  job (`/compactions`, `/compactions/:id`), `/ingest`, and `/levels`' L0 writer
  count, from `schema/distillation_ops_schema.sql` via
  `providers/distillation-store.ts` (a failed read is a 503); every other read
  (observations, clusters, artifacts, facts, review, procedures) is still mock.
- Portal: `pages/distillation/` — `DistillationModule` (the frame),
  `KnowledgeTab` / `KnowledgeRecord`, `ReviewTab`, `ActivityTab` /
  `RunInspector`, the shared `SourcesPanel` and `ExplainComposer` (the
  docked composer only explains — it prepares a question for Ask), and pure
  models with node:test coverage (`distillationRoutes`, `knowledgeModel`,
  `reviewQueueModel`, `sourcesModel`, `tierFlowModel`, `activityModel`,
  `procedureRunsModel`, `distillationChannel`).
- Validator: `scripts/validate-distillation.sh` is the definition of done.
