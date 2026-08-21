# SDLC capture & delivery model — decision record

**Status:** IMPLEMENTED (commit-per-capture), proven live. A run's captured
change is now scoped to its own work — verified end-to-end: two sequential runs
produced `change1=['docs/AAA.md']` and `change2=['docs/BBB.md']` (was
`['AAA','BBB']` before), each committed with its own SHA. Delivery pushes the
captured commit (delivery-script tests cover both the commit path and the legacy
working-tree fallback). Legacy changes with a null `commit_sha` still deliver
via the working tree, so in-flight work is unaffected.
**Scope:** `middleware/src/lib/sdlc-pipeline.ts` (captureAndGate),
`change-delivery.ts`, `providers/sdlc.ts`, `schema/agent_sdlc_schema.sql`,
`project-runner.ts`.

## The problem: cumulative diffs

A governed run edits a codebase **in a live workspace and leaves the changes
uncommitted**. `captureDiff` records the *whole dirty working tree*, and
`deliverChange` ships the *whole working tree* (`git add -A && commit`). That is
correct for a single change on a fresh clone. It breaks down for sequential
runs on one workspace:

- **Run 2 that "creates B" captures `[A, B]`** because A (from run 1) is still
  uncommitted. The reviewer sees an out-of-scope change and blocks it — a *false*
  rejection. Observed live: `docs/ALPHA.md` leaked into a `docs/BETA.md` change
  and got the change blocked.
- **The self-correction (address) loop** compounds the same tree; the staging
  hack (`git add -A` after capture, so a later in-place edit shows as `AM`) is a
  band-aid over this, not a fix.
- **Recorded ≠ delivered** in the general case: the captured diff of the *latest*
  change must equal what delivery ships, which today is only true because
  delivery also ships the whole tree. Any attempt to scope the *record* to a
  run's delta would then diverge from what actually ships.

The `supersede` guard (`hasNewerChangeForProject`) protects *delivery* — only the
latest capture is deliverable — but does nothing for the *review* quality, which
is where the false blocks come from.

## Why status quo is not enough

The one-change-at-a-time workflow (run → review → deliver/address, then next)
avoids it, and that is the intended path today. But governance that only works
if the operator is careful is not governance. For the platform's core promise —
*trustworthy, reviewable agent code* — the reviewer must see exactly one run's
change, and delivery must ship exactly what was reviewed.

## Options considered

1. **Scope capture to the run's delta only** (keep working-tree delivery).
   Rejected: the record would then not match what delivery ships (the whole
   tree). Splits the "reviewed thing" from the "shipped thing" — the exact
   invariant the governance layer exists to hold.
2. **Diff-based delivery** — store the delta diff, re-apply it onto a fresh clone
   at delivery. Decouples delivery from the workspace (the `change-delivery.ts`
   header already muses on this). Viable, but re-applying a stored patch is its
   own failure surface (context drift, fuzz) and still needs delta capture.
3. **Commit-per-capture** (recommended). Make git the source of truth: each
   captured change is a commit, so the tree is clean between changes and every
   capture is naturally scoped.

## Recommended model: commit-per-capture

- **Per-project work branch.** The clone checks out a stable work branch
  (e.g. `orgiq/work`). Runs edit the tree; nothing else touches it.
- **Commit at capture.** After `createChangeRequest`, commit the tree:
  `git add -A && git commit -m "<title>"`. Store the resulting SHA on the change
  row (`commit_sha`). The next run's uncommitted diff is now *only its own*
  changes — cumulative pollution gone, and `captureDiff` needs no `before`
  threading.
- **Reset on reject/block.** This is the sub-problem that made the model look
  intractable: a rejected change's commit would otherwise carry into a later
  change's delivery. Resolve it by rolling the work branch back when a change is
  refused — `git reset --hard <parent_sha>` in `decideChange`/the block path — so
  abandoned work never ships. (Addressed changes are *not* reset; the address run
  commits on top, and the cumulative result is the intended fixed state.)
- **Deliver from the commit.** `deliverChange` creates the PR branch at the
  approved `commit_sha` (`git checkout -B <branch> <sha>`) and pushes — no
  `git add -A`, no working-tree dependency. The "are the changes still here?"
  check becomes "does `<sha>` exist" (`git cat-file -e`), which survives a reaped
  workspace far better than a dirty-tree check.

### What this retires
- The `git add -A` staging hack in `captureAndGate` (the delta is clean without
  it).
- The working-tree "still here" precheck in `deliverChange`.

## Migration

1. Schema: `ALTER TABLE agent_change_requests ADD COLUMN IF NOT EXISTS commit_sha TEXT;`
2. `captureAndGate`: after capture, commit; persist the SHA.
3. `decideChange` + the aggregate block path: on `rejected`/`blocked`, reset the
   work branch to the change's parent SHA.
4. `deliverChange`: branch from `commit_sha`, push, PR; replace the dirty-tree
   precheck with a SHA-exists check.
5. Backfill/compat: existing changes have no `commit_sha`; treat null as
   "legacy, working-tree delivery" so in-flight changes still deliver.

## Risks

- **Destructive:** `git reset --hard` on reject discards workspace state. It is
  scoped to the work branch and only the refused change, but it is irreversible
  within the workspace (the change row + captured diff survive in Aurora).
- **Blast radius:** touches capture, decide, and delivery together — it is an
  atomic change, not incremental (commit-at-capture alone breaks the current
  dirty-tree delivery).
- **One-way-ish door:** the delivery contract changes from "ship the tree" to
  "ship a commit." Consumers (the ChangesPage delivery button, any external
  caller) are unaffected in API shape, but the semantics shift.

## Recommendation

Implement option 3 as a single, well-tested change with live end-to-end
verification (link a repo → two sequential runs → confirm the second change's
diff is scoped → reject one → confirm reset → deliver → confirm the PR contains
only the approved commit). Until then, the one-change-at-a-time workflow remains
the supported path and the `supersede` guard keeps delivery honest.
