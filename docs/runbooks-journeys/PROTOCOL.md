# Journey protocol — runbooks (the `runbooks` family)

One log per mapped step of the runbook loop under
`docs/runbooks-journeys/<role>/<name>.md`, written by
`node scripts/journeys/run-maps.mjs walk runbooks [--role author|reviewer|consumer|box]`
from the maps in `docs/journeys/maps/runbooks/<role>/<name>.ts`. The goal is
`docs/distillation-runbooks-goal.md` (R6); the loop is in
`docs/distillation-runbooks-design.md`.

Three roles walk the seeded Auth Migration runbooks
(`middleware/src/mock/runbooks.seed.ts`):

- **author** — suggests an edit (`propose`) or reads what a run proposed
  (`from-run`);
- **reviewer** — decides a proposal: `accept` (the runbook gains a version),
  `reject-merge` (a reject needs a note; a merge re-aims a proposal), `stale-base`
  (an accept against an older version is refused with 409 and writes nothing);
- **consumer** — reads a runbook (`read`), previews the brief a work item would
  get (`brief-preview`) and opens a run's frozen brief (`run-brief`).

`box/brief` is the API map: the routes a box calls, seen from a person's seat,
because a walk cannot present a box's signed envelope.

Log fields (the `journey` kind in `scripts/journeys/maps.mjs`): surface, role,
user, url, map, pages, audited, session, screenshot, verdict, console errors,
layout, shows, gating, dom-audit, notes.

- **shows** — what the page or route states is on screen (a title, a diff, a
  version, a sentence), and none of the leaks a reader would notice is.
- **gating** — what the role may or may not do there: a refused call answers
  4xx and writes nothing, a control a role does not hold is disabled or absent.

A log counts only with `verdict: pass`, `shows: pass` and `gating: pass`. Maps
that write (`accept`, `reject-merge`) run in a request-scoped copy of the default
world (`scenario: { scope: 'default' }`), so the shared mock is untouched. Walk as
clones (`openAsClone`), never as the seed personas and never in the user's Chrome.

Known, owned findings (the diff viewer's duplicate-key warning, the layout
findings in `docs/journeys/audit-burndown.tsv`) are named in the maps and the
ledger rather than hidden.
