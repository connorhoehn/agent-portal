# Goal: audit and fix every orgiq surface as the real users

`scripts/validate-orgiq-audit.sh` is the only judge. Work the backlog in
order, run the script after every slice, treat each failing line as the
next task. No `npm install` (offline). No hand-rolled HTML in pages —
ui-components composites; a missing primitive is composed ONCE in a local
`*Frame.tsx` queued in `docs/ui-components-queue.md` ("Composed locally in
`<file>`"). Build to the middleware's shapes; guard on shape, not presence.
One owner per shared file (`App.tsx`, `Layout.tsx`, `portalCommands.ts`).

## Why

The assessment and distillation tenants were audited surface by surface as
real users, and each pass found defects that green builds did not: dead
keyboard paths, links to nowhere, tables below a stack of status cards,
counts that didn't match lists. The org tenant — the original product, ~20
surfaces — has never had that pass, and its pages carry **1,114 raw styled
HTML elements** (the assessment tenant is at 0 outside three composed
frames). The user's standing rule from the distillation review applies
everywhere: a list page's list is the page; cards are for content, not
decoration; the first data row sits above the fold.

## The matrix

`docs/orgiq-journeys/MATRIX.txt` — 23 surfaces × the roles that can see
each (member, sme, program-owner, org-leader, hr-admin), 79 role×surface
logs in total, plus one `RAIL.md` per role proving the rail, the palette
and direct routes hide what the role must not see.

## Definition of done (what the validator checks)

1. **Builds**: portal `tsc`, `node --test`, `vite build`; middleware `tsc`.
2. **Component discipline, repo-wide**: raw styled elements across ALL of
   `portal/src/pages` ≤ the budget in `scripts/orgiq-raw-budget.txt`
   (starts at 1114, may only be lowered, must reach ≤ 60 — the assessment
   tenant's reference count — before the goal is done); zero JSX `style=`
   props (inline object or hoisted const — same hand-rolled CSS), zero
   native `<select>/<input>/<textarea>` and zero raw `<button>` in pages;
   queued composites ≤ 12 raw elements.
   The validator prints the worst files so the next slice is obvious.
3. **Journey logs**: `docs/orgiq-journeys/<role>/<surface>.md` + screenshot
   for every cell of the matrix, protocol fields (`verdict: pass`, `console
   errors: 0`, `layout: pass` with numbers, `keyboard: pass`, `empty-state:
   pass|n/a`, `role-gating:`), `first-row-top: <n>px` ≤ 640 on `L` surfaces,
   a `pages:` line naming the page directories the surface renders from —
   freshness is per surface: the log must be newer than the newest `.tsx`
   in those directories.
4. **Rail isolation per role**: `docs/orgiq-journeys/<role>/RAIL.md` with
   `rail-items:` (verbatim), `hidden-surfaces-direct-route:` (each surface
   the role must not see → redirect|403|not-found), `palette-entries:`
   count, `verdict: pass`.
5. **Defects**: every `DEFECTS.md` item is either Closed with what was
   observed after the fix, or filed as a follow-up with a reason.
6. **Docs**: `docs/orgiq-audit.md` — what changed, the density rule, the
   budget history.

## Backlog, in order

0. **Baseline**: run the validator; record the raw-element top offenders.
1. **Audit round 1** — one browser pass per role, in this order: member
   (the widest open set), hr-admin (sees everything), org-leader, sme,
   program-owner. Sign in via /select → Sign in as → the real card (u-theo,
   u-rachel, u-vera, u-nora, u-mia). Judge as a UX persona: an experienced
   engineer new to this org who wants the answer the page exists for.
2. **Fix round 1** — group the defects by page directory and fix each
   directory in one slice (worst raw-element count first: work, bots, iq,
   admin, root pages, capabilities, project-detail, library, knowledge,
   budgets, designs …), lowering the budget file after each. Density: one
   selector/filter row, tables above the fold, stat strips instead of
   card stacks, one-line descriptions.
3. **Re-audit** every surface whose directory changed (per-surface
   freshness tells you which), both by the role that found the defect and
   by one other role that can see it.
4. **Repeat** 2–3 until every log passes and the budget is ≤ 60.
5. **Docs** and the final full validator run.

## Rules that do not bend

- The validator is the judge; report real numbers from real runs.
- Audit as the REAL seed users, never Demo User.
- Never widen the budget. Never mark a log pass to make the script green.
