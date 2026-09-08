# Distillation — the fleet's shared memory, and how it reaches the Library

`/iq/distillation` is where the org's agents' learnings become knowledge a
person can use. Every lab session writes what it learned; distillation
compacts those writes upward into stable artifacts, links each artifact to
the runbook or skill it became in the Library, and keeps the lineage so any
distilled fact can be traced back to the evidence it rests on.

## The three tiers

| tier | what lives there | who writes it | what a person does with it |
|---|---|---|---|
| **L0 — observations** | one row per learning a session wrote (`lab_experiences`: worked / failed / gotcha / decision / convention, with the repo and initiative it is about) | many concurrent sessions; duplicates expected | browse per repo or initiative; open an observation to see its session and box |
| **L1 — clusters** | deduped, merged groups of observations that say the same thing, with a confidence | the L0 → L1 compaction | the tier humans sample: agree or disagree with a cluster's summary against its members |
| **L2 — artifacts** | stable distilled artifacts — runbooks, insights, conventions, decisions — each carrying its facts and the clusters it was distilled from | the L1 → L2 compaction | read it, open the Library item it was published as, open its lineage |

Artifacts move through `draft → published → retired`. A published artifact
has a `library_item_id`: that is the runbook or skill in **Library** that
people and agents actually use. Library items show "Distilled from" so the
link runs both ways.

## What a compaction does

A compaction is a job (`Compactions` page) that reads one tier and writes the
next: L0 → L1 merges observations into clusters and reports what it deduped
and reclaimed; L1 → L2 distils clusters into artifacts and their facts. Each
job records `produced` — the cluster and artifact ids it created — so a job
row opens what it made. The machine runs unattended; the Overview's health
banners say when a tier is behind or stalled, and `Compact L0 → L1` /
`Compact L1 → L2` (ManageBots) trigger one by hand.

In the mock, L0 keeps filling at the ingest rate the Overview shows
(`observationsPerHour`): every read of levels, items or ingest mints the
observations that "landed" since the last minute tick, so a demo can run
the ladder more than once instead of finding L0 empty after one pass.

## The human sample

Clusters and artifacts drawn for review are put in front of a person on the
`Review sample` page: the target, its evidence, and Agree / Disagree with a
note. The agreement rate over the last 30 days is the calibration verdict —
enough disagreement to prove the sample finds real problems, not so much that
the unreviewed rest should be trusted less.

Every number on that banner is **counted from the queue underneath it**, the
sample rate included: "% of L1 sampled" is how many L1 clusters a reviewer has
actually been handed, over how many exist. It is not a dial set in code, which
is what it used to be — a constant `4` that never moved when a sample was
decided, so the headline could and did contradict the cards below it. Because
it is counted, it drops on its own the moment a compaction pass mints clusters
nobody has reviewed, and the seeded demo corpus reads 100% because every
cluster in it really has been sampled.

## Reading lineage

`Lineage` draws one artifact, cluster, or fact as a graph, columns by kind:

```
session ──written_by──▶ observation ──merged_into──▶ cluster ──distilled_into──▶ artifact ──published_as──▶ library item
                                                                                     │
                                                                          fact ◀──supports── observation
```

Click any node for its record and "Focus here" to re-centre the graph on
it. `?focus=<id>` is a deep link; Artifacts and Library both open it.

## Where things live

- Middleware: `routes/distillation.ts`, `providers/distillation.ts`,
  `mock/distillation.ts` (the mock is the contract; the shapes are in
  `docs/distillation-goal.md`), `schema/distillation_schema.sql`.
- Portal: `pages/distillation/` — `DistillationLayout` (nested rail:
  Memory / Knowledge / Operations) and one page per rail item;
  `LineageFrame.tsx` hosts the `@xyflow/react` graph.
- Validator: `scripts/validate-distillation.sh` is the definition of done.
