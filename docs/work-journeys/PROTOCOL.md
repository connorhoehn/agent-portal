# Journey protocol — the Work tenant (the `work` family)

The Work tenant (`orgiq`: `/iq/*`, `/settings` and the `/admin/*` pages its
roles reach) walked per role by executable maps. The goal and the catalog are
`docs/work-journeys-goal.md`; the judge is `scripts/validate-work-journeys.sh`.

- Maps: `docs/journeys/maps/work/<role>/<journey>.ts`, steps shared per
  surface in `docs/journeys/maps/work/_shared.ts` (parameterised by role, so
  the roles' maps differ only where their grants do).
- Logs: `docs/work-journeys/<role>/<journey>.md` plus a screenshot, written by
  `node scripts/journeys/run-maps.mjs walk work --role <role>`, sealed by the
  runner (`scripts/journeys/seal.sh docs/work-journeys/<role>`) only when every
  log in the role's directory passed.
- Roles and personas: member `u-theo` (Theo Chang), sme `u-nora` (Nora
  DaSilva), program-owner `u-mia` (Mia Singh), org-leader `u-vera` (Vera
  Green, owner of Auth Migration) and `u-release` (Sienna Garcia, the release
  manager) where the journey is the release manager's, hr-admin `u-rachel`
  (Rachel Kowalski). Always as clones (`openAsClone`), headless, never in the
  user's Chrome and never two runs as one persona.

## Log kinds and their fields

`surface` — one surface (a page and its tabs, panes and dialogs) as one role.
Fields: surface, role, user, url, map, pages, audited, session, screenshot,
verdict, console errors, layout, **keyboard**, **empty-state**,
**role-gating**, **story-facts**, **tab-stability**, dom-audit, notes.

- **keyboard** — a tab-walk reaches the page's controls, and the keys the page
  promises work: Enter opens a row, Escape closes a dialog or popover and
  returns focus, ControlOrMeta+K opens the palette, the composer's 1-5 and
  Enter pick and run a prompt.
- **empty-state** — the page's own sentence for filtered-empty, empty, error
  and not-found, under a mock scope (`scope` steps: `empty`, `error`,
  `long-text`, `many`, `loading`), never by damaging the shared mock.
- **role-gating** — what this role may and may not do here: a control it does
  not hold is absent (or disabled with its reason), an API it may not call
  answers 403.
- **story-facts** — the content is the story the seed tells: names instead of
  ids (a `noText` leak list on every fact step), and numbers that agree
  (`expect.numbers`: a tab badge equals its rows, a header count equals the
  table).
- **tab-stability** — every tab on the page is clicked with
  `stable: [header, tab strip, pane]`; none of their boxes may move or resize,
  so no underline, background or badge pushes content.

`refusals` — the role's rail, palette and quick switch, and every gated `/iq`
and `/admin` route it cannot reach (each a deep link that lands elsewhere),
plus API refusals. Fields: … **rail-items**, **hidden-surfaces-direct-route**,
**palette-entries**, **quick-switch**, **api-refused** … (the fields the old
`RAIL.md` carried; `validate-orgiq-audit.sh` reads them here).

`frames` — the role's core pages at 1440 and 900 wide, light and dark.
Fields: … **widths**, **themes**, **story-facts** ….

## Depth rules (the judge enforces them)

1. The DOM audit runs at every step (no `audit: false` in a work map); a
   finding fails the step unless `docs/journeys/audit-burndown.tsv` owns it
   with an owner and a reason.
2. Every step that changes the UI (click, press, fill, reload, back, a scope
   switch) asserts the state it produced; every navigate asserts what it shows.
3. A write runs only inside a scope (`scenario: { scope: 'default' }`), and the
   map reloads and reads the write back.
4. Each surface journey shows the states its catalog row lists; each tab the
   row lists is clicked with a stability check; each check the row lists
   (numbers, dialog, composer, palette, write, reload) is present.
5. Surface maps walk at 1440×900; the frames map covers 900 and dark.

Failing walks are never sealed. A defect a walk finds is fixed in the page (or
upstream in ui-components first, then the pin moved), or owned in the
burn-down — never asserted around.
