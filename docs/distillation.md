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
step it stopped on), or `abandoned` — and the Overview counts those rows
into a verdict per procedure:

- **proven** — it succeeded recently and nothing has moved since.
- **drifting** — since it last succeeded, a run failed, or a new `failed` /
  `gotcha` cluster was minted in the same repo, or the last success is older
  than two weeks. Drift is measured at L1 rather than L0 so one noisy
  session cannot flip every procedure amber.
- **unproven** — published, never run to completion.

The artifact drawer shows the steps toned by the latest run (proven up to
the step it failed on, blamed there, unknown after) and the run ledger
those tones come from.

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
                                                                                     │  │
                                                                          fact ◀──supports── observation
                                                                                        └──applied_in──▶ application (a run: succeeded / failed at step n / abandoned)
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
