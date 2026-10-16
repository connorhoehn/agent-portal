# Goal: deep, executable Work-tenant journeys for every role

`scripts/validate-work-journeys.sh` is the only judge (`--quick` for the static
checks, `--walk` to walk first). The protocol is
[docs/work-journeys/PROTOCOL.md](work-journeys/PROTOCOL.md); the runner and the
map format are [docs/journeys.md](journeys.md) "Journey maps".

## Why

The user: "I want more depth in the UX journeys in the existing work tenant so
they are more complete and tested."

On 2026-10-15 the Work tenant (`orgiq`: `/iq/*`, `/settings` and the `/admin/*`
pages its roles reach) was walked by maps only in passing: **18 of its 82
inventoried routes** were visited by an orgiq-role map, **4 of 5 roles**
(hr-admin never), in **25 route × role cells, every one of them `default`** — a
landing, not a journey. sme, program-owner, org-leader and hr-admin never
walked anything of their own. The 92 hand-walked logs under
`docs/orgiq-journeys/` were all stale (their routes' rendered contracts moved),
still named deleted surfaces (promotions, distillation), and a hand walk
proves nothing the next change cannot undo. `docs/journeys/coverage.md` still
listed distillation.

## What "done" means

Every role walks what it really does (docs/program-operating-model.md, the
Cedar files in `middleware/seeds/roles/orgiq/`), as an executable map that is
walked, passing, sealed and fresh:

- find and read work: initiatives, the initiative page with every tab and the
  side pane, work items and their tabs;
- change work (create, edit status and owner, comment) inside a scoped world,
  read back after a reload, for the roles that hold DispatchAgentRun;
- dispatch an agent through the prepare-job card: the gates (sprint grant), the
  soft brakes (over the run cap, the allocation, an envelope) and the refusals,
  with the composer's 1-5, Enter and Escape;
- review what agents produced (Automate, the run record, graph changes) where
  ManageDevbox allows, and see why where it does not;
- sprints and budgets: the release manager's allocations and envelope grants;
- decisions, people and the expertise graph, documents and the page thread,
  designs, the library, runbooks, runs and the run record;
- the bell, search and the palette, the Social bottom bar, the chat pane
  enabled and disabled, settings and profile;
- the admin pages org-leader and hr-admin reach;
- and the refusal of every gated `/iq` and `/admin` route each role cannot reach.

## Depth (what makes a journey more than a landing)

1. Every step that changes the UI asserts the resulting state; every navigate
   asserts what it shows.
2. Writes run inside a scoped scenario (`scenario: { scope: 'default' }`) and
   are read back after a reload.
3. List and record pages are shown in their default, filtered, filtered-empty
   and row-open states and in the scoped data states (`scope` steps: `empty`,
   `error`, `long-text`, `many`, `loading`) where the fixture declares them.
4. Every tab on a page is clicked with a tab-stability check (`stable:
   [header, tab strip, pane]`): no box may move or resize, so no underline,
   background or badge pushes content.
5. Dialogs open and close with Escape (focus returns); the palette
   (ControlOrMeta+K), the composer's 1-5 and Enter keys.
6. Two widths (1440 and 900) and both themes for the core pages (each role's
   `frames` journey).
7. The DOM audit measures every step (no `audit: false`); findings are fixed or
   owned in `docs/journeys/audit-burndown.tsv` with an owner and a reason.
8. Story facts: names show instead of ids (a `noText` leak list on every fact
   step) and numbers are consistent (`expect.numbers`: a count equals its rows).

The runner gained what these need (2026-10-15): `reload`, `viewport`, `theme`
and `scope` steps, `stable:` boxes, `noSettle` (to catch a loading state) and
`expect.numbers`; `run-maps.mjs walk --video <dir>` records a slowed walk.

## The judge's checks

1. **Documents**: this goal, the protocol, `MATRIX.txt`, the shared map
   fragments, the floors file; the CLAUDE.md docs map has this row and the
   `(N validators)` count matches `scripts/`.
2. **Maps**: `run-maps.mjs check --family work` is clean; the catalog below, the
   maps and `docs/work-journeys/MATRIX.txt` agree (every catalog journey has a
   map, every map is in the catalog, every MATRIX cell is a surface journey).
3. **Depth**: rules 1-8 above, per map, against its catalog row's states, tabs
   and checks (`scripts/journeys/work-journeys.mjs depth`).
4. **Refusals**: every role × gated `/iq` and `/admin` route it cannot reach
   (App.tsx `RequireRole`, read live) has a refused deep link in that role's
   maps, and each such role probes at least one API refusal (403).
5. **Coverage floors**: route × role × state cells recorded in
   `scripts/work-journeys-floors.tsv`; the maps meet every floor and the file
   only ratchets up against HEAD. `docs/journeys/coverage.md` is current, lists
   no deleted surface, and every orgiq role is walked.
6. **Logs**: every map's log in `docs/work-journeys/<role>/` exists, passes
   every field of its kind, has its screenshot, and is fresh and sealed under
   the rendered-contract rule.
7. **DOM audit**: zero gating findings in any work log; every burn-down row on
   a Work route names an owner and a reason.
8. **The old hand logs are retired**: `docs/orgiq-journeys/` holds no
   hand-walked logs, and `validate-orgiq-audit.sh` judges the map logs (its
   MATRIX cells and its RAIL fields now come from `docs/work-journeys/`, with the
   same field checks and the same freshness rule) and stays green.
9. Full mode: the runner's own tests pass and `validate-orgiq-audit.sh --quick`
   passes.

## Personas

member `u-theo` (Theo Chang); sme `u-nora` (Nora DaSilva, an active sprint grant
on Auth Migration only); program-owner `u-mia` (Mia Singh); org-leader `u-vera`
(Vera Green, owner of Auth Migration) and `u-release` (Sienna Garcia, the
release manager) for the release manager's journeys; hr-admin `u-rachel`
(Rachel Kowalski). Always clones (`openAsClone`), headless; never two runs as
one persona; never the user's Chrome.

## Phases

1. **This document, the protocol, the judge, the runner's new steps.**
2. **Maps and walks, one role at a time** (member first: it writes the shared
   fragments in `docs/journeys/maps/work/_shared.ts`, parameterised by role),
   then sme and hr-admin, then program-owner and org-leader. Each walk's
   page-owned defects are fixed in the page; library-owned ones go to
   ui-components first, released and pinned, then the walk is repeated.
3. **Retire the hand logs**, point `validate-orgiq-audit.sh` at the map logs,
   write the floors, regenerate `coverage.md`.
4. **Videos**: `node scripts/journeys/run-maps.mjs walk work --video
   .scratch/videos-work`, converted per role plus one reel under
   `.scratch/demo-videos/work/`.

## The catalog

One row per journey; the journey is the map's log (`docs/journeys/maps/work/<journey>.ts`
writes `docs/work-journeys/<journey>.md`). `states` are the UI states the map
must show; `tabs` are the tabs it must click with a stability check; `checks`
are the extra depth it must carry (`numbers`, `dialog`, `composer`,
`palette`, `write`, `reload`). Routes with `:param` are walked with a seeded id.

| journey | kind | route(s) | states | tabs | checks | what the person does |
|---|---|---|---|---|---|---|
| `member/initiatives` | surface | `/iq/projects` | default, filtered, filtered-empty, row-open, empty, error, long-text, many, loading | — | numbers, palette | Find an initiative: all and mine, search and status, a search that matches nothing, open one; the list under empty, error, long-text, many and loading worlds |
| `member/initiative` | surface | `/iq/projects/p-auth-migration` | default, row-open, not-found, dialog-open, long-text | Overview, Work, Docs, Decisions, Agents, Contributors, Activity, Discussion, Details | numbers, dialog | Read one initiative: every tab and the side pane held still, the header menu and Escape, owner and SMEs by name, a missing initiative |
| `member/work-items` | surface | `/iq/projects/p-auth-migration?tab=work` | default, filtered, filtered-empty, row-open, empty, many, long-text | Brief, Docs, Activity | numbers | Find and read work: search and facets, a filter that matches nothing, open an item and every item tab, the list empty and crowded; edit controls absent or explained by role |
| `member/prepare-job` | surface | `/iq/projects/p-auth-migration?item=wi-auth-e1-s1` | default, row-open, dialog-open | — | composer | The prepare-job card: what a job would run with, the composer keys 1-5 and Enter, Escape; who may dispatch and the sentence that says who can when this role cannot |
| `member/sprints` | surface | `/iq/projects?lens=sprints` | default, filtered, filtered-empty, row-open, empty | Work, Money | numbers | Sprints: whose and which window, a search that matches nothing, open a sprint and its tabs, no sprints at all |
| `member/automate` | surface | `/iq/work`, `/iq/work/queue`, `/iq/work/findings`, `/iq/work/changes` | default, filtered, filtered-empty, row-open, empty, error | — | numbers | Automate: the inbox, runs, findings and graph changes; filter each, open a run, the empty and error worlds; review and requeue gated by ManageDevbox |
| `member/job` | surface | `/iq/work/:jobId` | default, not-found | Summary, Activity, Outputs, Changes | — | One agent run: every tab held still, what it changed and produced, a missing run |
| `member/decisions` | surface | `/iq/decisions`, `/iq/decisions/:id` | default, filtered, filtered-empty, row-open, not-found, empty | — | numbers | Decisions: by status, search, open a record that names who decides, a missing record, no decisions at all |
| `member/search` | surface | `/iq/search` | default, filtered, filtered-empty, row-open | Results, Answer, Connections | palette | Search and the palette: find a person, an initiative and a decision; the connections graph; a query that finds nothing; ControlOrMeta+K jumps to a page |
| `member/documents` | surface | `/iq/documents/:documentId` | default, not-found | — | — | Read a document from its initiative and its record page; the page thread beside it; a missing document |
| `member/designs` | surface | `/iq/designs`, `/iq/designs/:id` | default, filtered, filtered-empty, row-open, not-found, empty, error | — | numbers | Design reviews: by status, search, open a thread signed off by people, a missing design, the empty and error worlds |
| `member/library` | surface | `/iq/library`, `/iq/library/:assetId` | default, filtered, filtered-empty, row-open, not-found | — | — | The agent library: kind, tier and status filters, search, open an asset, a missing asset; New asset only for org-leader and hr-admin |
| `member/runbooks` | surface | `/iq/runbooks`, `/iq/runbooks/proposals`, `/iq/runbooks/briefs` | default, filtered-empty, row-open, not-found | Read, History, Runs, Suggest an edit | — | Runbooks: the library, proposals and briefs; a runbook’s tabs held still; review controls only for ReviewRunbook roles |
| `member/social` | surface | `/iq/communication`, `/iq/projects/p-auth-migration` | default, dialog-open, empty | — | dialog | The bell, the Social bottom bar and its dialog, the chat pane enabled for a poster and disabled with its sentence for a reader, the communication page, no notifications |
| `member/settings` | surface | `/settings` | default | — | reload | Settings and profile: the session card, the theme switch read back after a reload |
| `member/local-compute` | surface | `/iq/local-compute`, `/iq/local-compute/configuration` | default, empty, error | Skills, Hooks, Settings | — | Local compute: machines, pairing gated by ConnectLocalCompute, the configuration tabs held still, no machines, an error |
| `member/refusals` | refusals | `/iq/projects` | refused | — | — | The rail and palette as this role sees them, ⌘I quick switch, every gated /iq and /admin route it cannot reach (a deep link that lands on /iq/projects) and the APIs that answer 403 |
| `member/frames` | frames | `/iq/projects`, `/iq/projects/p-auth-migration`, `/iq/decisions`, `/iq/work`, `/iq/search`, `/settings` | default | — | — | The core pages at 1440 and 900 wide, light and dark: nothing clipped, no horizontal scroll, the audit clean in both themes |
| `sme/initiatives` | surface | `/iq/projects` | default, filtered, filtered-empty, row-open, empty, error, long-text, many, loading | — | numbers, palette | Find an initiative: all and mine, search and status, a search that matches nothing, open one; the list under empty, error, long-text, many and loading worlds |
| `sme/initiative` | surface | `/iq/projects/p-auth-migration` | default, row-open, not-found, dialog-open, long-text | Overview, Work, Docs, Decisions, Agents, Contributors, Activity, Discussion, Details | numbers, dialog | Read one initiative: every tab and the side pane held still, the header menu and Escape, owner and SMEs by name, a missing initiative |
| `sme/work-items` | surface | `/iq/projects/p-auth-migration?tab=work` | default, filtered, filtered-empty, row-open, empty, many, long-text | Brief, Docs, Activity | numbers | Find and read work: search and facets, a filter that matches nothing, open an item and every item tab, the list empty and crowded; edit controls absent or explained by role |
| `sme/prepare-job` | surface | `/iq/projects/p-auth-migration?item=wi-auth-e1-s1` | default, row-open, dialog-open, refused | — | composer, write | Dispatch inside a sprint grant: the composer keys pick Dispatch, the over-envelope brake asks and Back to the job keeps nothing; on an initiative with no grant the dispatch is refused with its sentence (scoped) |
| `sme/sprints` | surface | `/iq/projects?lens=sprints` | default, filtered, filtered-empty, row-open, empty, dialog-open | Work, Money | numbers, dialog | Sprints and my envelope: open a sprint, the envelope drawer names my grant, New sprint asks first and Escape closes it; no sprints at all |
| `sme/automate` | surface | `/iq/work`, `/iq/work/queue`, `/iq/work/findings`, `/iq/work/changes` | default, filtered, filtered-empty, row-open, empty, error | — | numbers | Automate: the inbox, runs, findings and graph changes; filter each, open a run, the empty and error worlds; review and requeue gated by ManageDevbox |
| `sme/job` | surface | `/iq/work/:jobId` | default, not-found, dialog-open | Summary, Activity, Outputs, Changes | dialog | One agent run: every tab held still, what it changed and produced, a missing run |
| `sme/decisions` | surface | `/iq/decisions`, `/iq/decisions/:id` | default, filtered, filtered-empty, row-open, not-found, empty | — | numbers | Decisions: by status, search, open a record that names who decides, a missing record, no decisions at all |
| `sme/search` | surface | `/iq/search` | default, filtered, filtered-empty, row-open | Results, Answer, Connections | palette | Search and the palette: find a person, an initiative and a decision; the connections graph; a query that finds nothing; ControlOrMeta+K jumps to a page |
| `sme/documents` | surface | `/iq/documents/:documentId` | default, not-found | — | — | Read a document from its initiative and its record page; the page thread beside it; a missing document |
| `sme/designs` | surface | `/iq/designs`, `/iq/designs/:id` | default, filtered, filtered-empty, row-open, not-found, empty, error | — | numbers | Design reviews: by status, search, open a thread signed off by people, a missing design, the empty and error worlds |
| `sme/library` | surface | `/iq/library`, `/iq/library/:assetId` | default, filtered, filtered-empty, row-open, not-found | — | — | The agent library: kind, tier and status filters, search, open an asset, a missing asset; New asset only for org-leader and hr-admin |
| `sme/runbooks` | surface | `/iq/runbooks`, `/iq/runbooks/proposals`, `/iq/runbooks/briefs` | default, filtered-empty, row-open, not-found | Read, History, Runs, Suggest an edit | — | Runbooks: the library, proposals and briefs; a runbook’s tabs held still; review controls only for ReviewRunbook roles |
| `sme/social` | surface | `/iq/communication`, `/iq/projects/p-auth-migration` | default, dialog-open, empty | — | dialog | The bell, the Social bottom bar and its dialog, the chat pane enabled for a poster and disabled with its sentence for a reader, the communication page, no notifications |
| `sme/settings` | surface | `/settings` | default | — | reload | Settings and profile: the session card, the theme switch read back after a reload |
| `sme/local-compute` | surface | `/iq/local-compute`, `/iq/local-compute/configuration` | default, empty, error | Skills, Hooks, Settings | — | Local compute: machines, pairing gated by ConnectLocalCompute, the configuration tabs held still, no machines, an error |
| `sme/work-write` | surface | `/iq/projects/p-auth-migration?tab=work` | default, dialog-open, row-open | — | write, dialog, reload | Change work: create a story, move its status, assign an owner, add a planning note, each read back after a reload, inside a scoped world |
| `sme/runs` | surface | `/iq/runs`, `/iq/runs/:id` | default, filtered, filtered-empty, row-open, not-found, empty, error | Run, Brief | numbers | Agent runs: status and kind, search, open the run record and its brief, a missing run, the empty and error worlds |
| `sme/bots` | surface | `/admin/bots`, `/admin/bots/:id` | default, filtered-empty, row-open, empty, error | Mission, Guardrails | — | Bots: the fleet, search, open a bot and its tabs held still (Live activity appears only while a run is in flight, so its absence is asserted), New bot gated by ManageBots, empty and error |
| `sme/devbox` | surface | `/admin/devbox` | default, filtered-empty | — | — | The computer lab: the fleet, drive controls gated by ManageDevbox with the sentence for a viewer, a filter that finds nothing (the fleet is an in-memory registry no scope forks, so no empty or error world) |
| `sme/refusals` | refusals | `/iq/projects` | refused | — | — | The rail and palette as this role sees them, ⌘I quick switch, every gated /iq and /admin route it cannot reach (a deep link that lands on /iq/projects) and the APIs that answer 403 |
| `sme/frames` | frames | `/iq/projects`, `/iq/projects/p-auth-migration`, `/iq/decisions`, `/iq/work`, `/iq/search`, `/settings` | default | — | — | The core pages at 1440 and 900 wide, light and dark: nothing clipped, no horizontal scroll, the audit clean in both themes |
| `program-owner/initiatives` | surface | `/iq/projects` | default, filtered, filtered-empty, row-open, empty, error, long-text, many, loading | — | numbers, palette | Find an initiative: all and mine, search and status, a search that matches nothing, open one; the list under empty, error, long-text, many and loading worlds |
| `program-owner/initiative` | surface | `/iq/projects/p-auth-migration` | default, row-open, not-found, dialog-open, long-text | Overview, Work, Docs, Decisions, Agents, Contributors, Activity, Discussion, Details | numbers, dialog | Read one initiative: every tab and the side pane held still, the header menu and Escape, owner and SMEs by name, a missing initiative |
| `program-owner/work-items` | surface | `/iq/projects/p-auth-migration?tab=work` | default, filtered, filtered-empty, row-open, empty, many, long-text | Brief, Docs, Activity | numbers | Find and read work: search and facets, a filter that matches nothing, open an item and every item tab, the list empty and crowded; edit controls absent or explained by role |
| `program-owner/prepare-job` | surface | `/iq/projects/p-auth-migration?item=wi-auth-e1-s1` | default, row-open, dialog-open | — | composer, write | Dispatch as a release manager or program owner: the composer keys pick Dispatch, a soft brake asks (over the run cap, the allocation or an envelope) and Dispatch anyway sends it; the run reads back after a reload (scoped) |
| `program-owner/sprints` | surface | `/iq/projects?lens=sprints` | default, filtered, filtered-empty, row-open, empty, dialog-open | Work, Money, Envelopes | numbers, dialog, write | Sprints and envelopes: open a sprint and its tabs, New sprint asks first, grant an SME an envelope and revoke it, each read back after a reload (scoped); no sprints at all |
| `program-owner/automate` | surface | `/iq/work`, `/iq/work/queue`, `/iq/work/findings`, `/iq/work/changes` | default, filtered, filtered-empty, row-open, empty, error | — | numbers | Automate: the inbox, runs, findings and graph changes; filter each, open a run, the empty and error worlds; review and requeue gated by ManageDevbox |
| `program-owner/job` | surface | `/iq/work/:jobId` | default, not-found | Summary, Activity, Outputs, Changes | — | One agent run: every tab held still, what it changed and produced, a missing run |
| `program-owner/decisions` | surface | `/iq/decisions`, `/iq/decisions/:id` | default, filtered, filtered-empty, row-open, not-found, empty | — | numbers | Decisions: by status, search, open a record that names who decides, a missing record, no decisions at all |
| `program-owner/search` | surface | `/iq/search` | default, filtered, filtered-empty, row-open | Results, Answer, Connections | palette | Search and the palette: find a person, an initiative and a decision; the connections graph; a query that finds nothing; ControlOrMeta+K jumps to a page |
| `program-owner/documents` | surface | `/iq/documents/:documentId` | default, not-found | — | — | Read a document from its initiative and its record page; the page thread beside it; a missing document |
| `program-owner/designs` | surface | `/iq/designs`, `/iq/designs/:id` | default, filtered, filtered-empty, row-open, not-found, empty, error | — | numbers | Design reviews: by status, search, open a thread signed off by people, a missing design, the empty and error worlds |
| `program-owner/library` | surface | `/iq/library`, `/iq/library/:assetId` | default, filtered, filtered-empty, row-open, not-found | — | — | The agent library: kind, tier and status filters, search, open an asset, a missing asset; New asset only for org-leader and hr-admin |
| `program-owner/runbooks` | surface | `/iq/runbooks`, `/iq/runbooks/proposals`, `/iq/runbooks/briefs` | default, filtered-empty, row-open, not-found | Read, History, Runs, Suggest an edit | — | Runbooks: the library, proposals and briefs; a runbook’s tabs held still; review controls only for ReviewRunbook roles |
| `program-owner/social` | surface | `/iq/communication`, `/iq/projects/p-auth-migration` | default, dialog-open, empty | — | dialog | The bell, the Social bottom bar and its dialog, the chat pane enabled for a poster and disabled with its sentence for a reader, the communication page, no notifications |
| `program-owner/settings` | surface | `/settings` | default | — | reload | Settings and profile: the session card, the theme switch read back after a reload |
| `program-owner/local-compute` | surface | `/iq/local-compute`, `/iq/local-compute/configuration` | default, empty, error | Skills, Hooks, Settings | — | Local compute: machines, pairing gated by ConnectLocalCompute, the configuration tabs held still, no machines, an error |
| `program-owner/work-write` | surface | `/iq/projects/p-auth-migration?tab=work` | default, dialog-open, row-open | — | write, dialog, reload | Change work: create a story, move its status, assign an owner, add a planning note, each read back after a reload, inside a scoped world |
| `program-owner/runs` | surface | `/iq/runs`, `/iq/runs/:id` | default, filtered, filtered-empty, row-open, not-found, empty, error | Run, Brief | numbers | Agent runs: status and kind, search, open the run record and its brief, a missing run, the empty and error worlds |
| `program-owner/bots` | surface | `/admin/bots`, `/admin/bots/:id` | default, filtered-empty, row-open, empty, error | Mission, Guardrails | — | Bots: the fleet, search, open a bot and its tabs held still (Live activity appears only while a run is in flight, so its absence is asserted), New bot gated by ManageBots, empty and error |
| `program-owner/devbox` | surface | `/admin/devbox` | default, filtered-empty | — | — | The computer lab: the fleet, drive controls gated by ManageDevbox with the sentence for a viewer, a filter that finds nothing (the fleet is an in-memory registry no scope forks, so no empty or error world) |
| `program-owner/budgets` | surface | `/admin/budgets` | default, filtered, filtered-empty, empty, error, dialog-open | — | numbers, dialog, write | Budgets: allocations and sprint envelopes, search, set an allocation read back after a reload, Remove allocation asks first and Escape keeps it, empty and error |
| `program-owner/changes-review` | surface | `/admin/changes` | default | Review queue | — | Code review as a program owner: App.tsx lets the role open the page, but `GET /api/sdlc/changes` needs ManageDevbox, which program-owner lacks — the map proves the page says so (one tab, the denial sentence, the 403); an open decision below |
| `program-owner/refusals` | refusals | `/iq/projects` | refused | — | — | The rail and palette as this role sees them, ⌘I quick switch, every gated /iq and /admin route it cannot reach (a deep link that lands on /iq/projects) and the APIs that answer 403 |
| `program-owner/frames` | frames | `/iq/projects`, `/iq/projects/p-auth-migration`, `/iq/decisions`, `/iq/work`, `/iq/search`, `/settings` | default | — | — | The core pages at 1440 and 900 wide, light and dark: nothing clipped, no horizontal scroll, the audit clean in both themes |
| `org-leader/initiatives` | surface | `/iq/projects` | default, filtered, filtered-empty, row-open, empty, error, long-text, many, loading | — | numbers, palette | Find an initiative: all and mine, search and status, a search that matches nothing, open one; the list under empty, error, long-text, many and loading worlds |
| `org-leader/initiative` | surface | `/iq/projects/p-auth-migration` | default, row-open, not-found, dialog-open, long-text | Overview, Work, Docs, Decisions, Agents, Contributors, Activity, Discussion, Details | numbers, dialog | Read one initiative: every tab and the side pane held still, the header menu and Escape, owner and SMEs by name, a missing initiative |
| `org-leader/work-items` | surface | `/iq/projects/p-auth-migration?tab=work` | default, filtered, filtered-empty, row-open, empty, many, long-text | Brief, Docs, Activity | numbers | Find and read work: search and facets, a filter that matches nothing, open an item and every item tab, the list empty and crowded; edit controls absent or explained by role |
| `org-leader/prepare-job` | surface | `/iq/projects/p-auth-migration?item=wi-auth-e1-s1` | default, row-open, dialog-open | — | composer, write | Dispatch as a release manager or program owner: the composer keys pick Dispatch, a soft brake asks (over the run cap, the allocation or an envelope) and Dispatch anyway sends it; the run reads back after a reload (scoped) |
| `org-leader/sprints` | surface | `/iq/projects?lens=sprints` | default, filtered, filtered-empty, row-open, empty, dialog-open | Work, Money, Envelopes | numbers, dialog, write | Sprints and envelopes: open a sprint and its tabs, New sprint asks first, grant an SME an envelope and revoke it, each read back after a reload (scoped); no sprints at all |
| `org-leader/automate` | surface | `/iq/work`, `/iq/work/queue`, `/iq/work/findings`, `/iq/work/changes` | default, filtered, filtered-empty, row-open, empty, error | — | numbers | Automate: the inbox, runs, findings and graph changes; filter each, open a run, the empty and error worlds; review and requeue gated by ManageDevbox |
| `org-leader/job` | surface | `/iq/work/:jobId` | default, not-found | Summary, Activity, Outputs, Changes | — | One agent run: every tab held still, what it changed and produced, a missing run |
| `org-leader/decisions` | surface | `/iq/decisions`, `/iq/decisions/:id` | default, filtered, filtered-empty, row-open, not-found, empty | — | numbers | Decisions: by status, search, open a record that names who decides, a missing record, no decisions at all |
| `org-leader/search` | surface | `/iq/search` | default, filtered, filtered-empty, row-open | Results, Answer, Connections | palette | Search and the palette: find a person, an initiative and a decision; the connections graph; a query that finds nothing; ControlOrMeta+K jumps to a page |
| `org-leader/documents` | surface | `/iq/documents/:documentId` | default, not-found | — | — | Read a document from its initiative and its record page; the page thread beside it; a missing document |
| `org-leader/designs` | surface | `/iq/designs`, `/iq/designs/:id` | default, filtered, filtered-empty, row-open, not-found, empty, error | — | numbers | Design reviews: by status, search, open a thread signed off by people, a missing design, the empty and error worlds |
| `org-leader/library` | surface | `/iq/library`, `/iq/library/:assetId` | default, filtered, filtered-empty, row-open, not-found, dialog-open | — | dialog | The agent library: kind, tier and status filters, search, open an asset, a missing asset; New asset only for org-leader and hr-admin |
| `org-leader/runbooks` | surface | `/iq/runbooks`, `/iq/runbooks/proposals`, `/iq/runbooks/briefs` | default, filtered-empty, row-open, not-found | Read, History, Runs, Suggest an edit | — | Runbooks: the library, proposals and briefs; a runbook’s tabs held still; review controls only for ReviewRunbook roles |
| `org-leader/social` | surface | `/iq/communication`, `/iq/projects/p-auth-migration` | default, dialog-open, empty | — | dialog | The bell, the Social bottom bar and its dialog, the chat pane enabled for a poster and disabled with its sentence for a reader, the communication page, no notifications |
| `org-leader/settings` | surface | `/settings` | default | — | reload | Settings and profile: the session card, the theme switch read back after a reload |
| `org-leader/local-compute` | surface | `/iq/local-compute`, `/iq/local-compute/configuration` | default, empty, error | Skills, Hooks, Settings | — | Local compute: machines, pairing gated by ConnectLocalCompute, the configuration tabs held still, no machines, an error |
| `org-leader/work-write` | surface | `/iq/projects/p-auth-migration?tab=work` | default, dialog-open, row-open | — | write, dialog, reload | Change work: create a story, move its status, assign an owner, add a planning note, each read back after a reload, inside a scoped world |
| `org-leader/runs` | surface | `/iq/runs`, `/iq/runs/:id` | default, filtered, filtered-empty, row-open, not-found, empty, error | Run, Brief | numbers | Agent runs: status and kind, search, open the run record and its brief, a missing run, the empty and error worlds |
| `org-leader/bots` | surface | `/admin/bots`, `/admin/bots/:id` | default, filtered-empty, row-open, empty, error | Mission, Guardrails | — | Bots: the fleet, search, open a bot and its tabs held still (Live activity appears only while a run is in flight, so its absence is asserted), New bot gated by ManageBots, empty and error |
| `org-leader/devbox` | surface | `/admin/devbox` | default, filtered-empty | — | — | The computer lab: the fleet, drive controls gated by ManageDevbox with the sentence for a viewer, a filter that finds nothing (the fleet is an in-memory registry no scope forks, so no empty or error world) |
| `org-leader/budgets` | surface | `/admin/budgets` | default, filtered, filtered-empty, empty, error, dialog-open | — | numbers, dialog, write | Budgets: allocations and sprint envelopes, search, set an allocation read back after a reload, Remove allocation asks first and Escape keeps it, empty and error |
| `org-leader/scores` | surface | `/iq/scores`, `/iq/scores/cohorts`, `/iq/scores/compare` | default, row-open, empty, error | — | numbers | Expertise scores: people by score, cohorts, compare two people by name, no scores, an error |
| `org-leader/observability` | surface | `/admin/observability/summary`, `/admin/observability/invocations`, `/admin/observability/tools` | default, filtered-empty, row-open | — | — | Observability: health, invocations and tool calls, a search that finds nothing, open an invocation |
| `org-leader/knowledge` | surface | `/admin/knowledge` | default, row-open | — | — | Knowledge bases: the registry against live Bedrock, open a knowledge base |
| `org-leader/capabilities` | surface | `/admin/capabilities/guardrails`, `/admin/capabilities/code-interpreter`, `/admin/capabilities/browser` | default | — | — | Capabilities: guardrails, code interpreter and browser; editing gated by EditGuardrail and ManageDevbox |
| `org-leader/prompts` | surface | `/iq/prompts`, `/iq/agents`, `/iq/evaluations` | default, row-open | — | — | Prompt studio, the agent architecture and evaluations: open a prompt and an agent by name |
| `org-leader/refusals` | refusals | `/iq/projects` | refused | — | — | The rail and palette as this role sees them, ⌘I quick switch, every gated /iq and /admin route it cannot reach (a deep link that lands on /iq/projects) and the APIs that answer 403 |
| `org-leader/frames` | frames | `/iq/projects`, `/iq/projects/p-auth-migration`, `/iq/decisions`, `/iq/work`, `/iq/search`, `/settings` | default | — | — | The core pages at 1440 and 900 wide, light and dark: nothing clipped, no horizontal scroll, the audit clean in both themes |
| `hr-admin/initiatives` | surface | `/iq/projects` | default, filtered, filtered-empty, row-open, empty, error, long-text, many, loading | — | numbers, palette | Find an initiative: all and mine, search and status, a search that matches nothing, open one; the list under empty, error, long-text, many and loading worlds |
| `hr-admin/initiative` | surface | `/iq/projects/p-auth-migration` | default, row-open, not-found, dialog-open, long-text | Overview, Work, Docs, Decisions, Agents, Contributors, Activity, Discussion, Details | numbers, dialog | Read one initiative: every tab and the side pane held still, the header menu and Escape, owner and SMEs by name, a missing initiative |
| `hr-admin/work-items` | surface | `/iq/projects/p-auth-migration?tab=work` | default, filtered, filtered-empty, row-open, empty, many, long-text | Brief, Docs, Activity | numbers | Find and read work: search and facets, a filter that matches nothing, open an item and every item tab, the list empty and crowded; edit controls absent or explained by role |
| `hr-admin/prepare-job` | surface | `/iq/projects/p-auth-migration?item=wi-auth-e1-s1` | default, row-open, dialog-open | — | composer | The prepare-job card: what a job would run with, the composer keys 1-5 and Enter, Escape; who may dispatch and the sentence that says who can when this role cannot |
| `hr-admin/sprints` | surface | `/iq/projects?lens=sprints` | default, filtered, filtered-empty, row-open, empty | Work, Money, Envelopes | numbers | Sprints: whose and which window, a search that matches nothing, open a sprint and its tabs, no sprints at all |
| `hr-admin/automate` | surface | `/iq/work`, `/iq/work/queue`, `/iq/work/findings`, `/iq/work/changes` | default, filtered, filtered-empty, row-open, empty, error | — | numbers | Automate: the inbox, runs, findings and graph changes; filter each, open a run, the empty and error worlds; review and requeue gated by ManageDevbox |
| `hr-admin/job` | surface | `/iq/work/:jobId` | default, not-found, dialog-open | Summary, Activity, Outputs, Changes | dialog | One agent run: every tab held still, what it changed and produced, a missing run |
| `hr-admin/decisions` | surface | `/iq/decisions`, `/iq/decisions/:id` | default, filtered, filtered-empty, row-open, not-found, empty | — | numbers | Decisions: by status, search, open a record that names who decides, a missing record, no decisions at all |
| `hr-admin/search` | surface | `/iq/search` | default, filtered, filtered-empty, row-open | Results, Answer, Connections | palette | Search and the palette: find a person, an initiative and a decision; the connections graph; a query that finds nothing; ControlOrMeta+K jumps to a page |
| `hr-admin/documents` | surface | `/iq/documents/:documentId` | default, not-found | — | — | Read a document from its initiative and its record page; the page thread beside it; a missing document |
| `hr-admin/designs` | surface | `/iq/designs`, `/iq/designs/:id` | default, filtered, filtered-empty, row-open, not-found, empty, error | — | numbers | Design reviews: by status, search, open a thread signed off by people, a missing design, the empty and error worlds |
| `hr-admin/library` | surface | `/iq/library`, `/iq/library/:assetId` | default, filtered, filtered-empty, row-open, not-found, dialog-open | — | dialog | The agent library: kind, tier and status filters, search, open an asset, a missing asset; New asset only for org-leader and hr-admin |
| `hr-admin/runbooks` | surface | `/iq/runbooks`, `/iq/runbooks/proposals`, `/iq/runbooks/briefs` | default, filtered-empty, row-open, not-found | Read, History, Runs, Suggest an edit | — | Runbooks: the library, proposals and briefs; a runbook’s tabs held still; review controls only for ReviewRunbook roles |
| `hr-admin/social` | surface | `/iq/communication`, `/iq/projects/p-auth-migration` | default, dialog-open, empty | — | dialog | The bell, the Social bottom bar and its dialog, the chat pane enabled for a poster and disabled with its sentence for a reader, the communication page, no notifications |
| `hr-admin/settings` | surface | `/settings` | default | — | reload | Settings and profile: the session card, the theme switch read back after a reload |
| `hr-admin/local-compute` | surface | `/iq/local-compute`, `/iq/local-compute/configuration` | default, empty, error | Skills, Hooks, Settings | — | Local compute: machines, pairing gated by ConnectLocalCompute, the configuration tabs held still, no machines, an error |
| `hr-admin/runs` | surface | `/iq/runs`, `/iq/runs/:id` | default, filtered, filtered-empty, row-open, not-found, empty, error | Run, Brief | numbers | Agent runs: status and kind, search, open the run record and its brief, a missing run, the empty and error worlds |
| `hr-admin/bots` | surface | `/admin/bots`, `/admin/bots/:id` | default, filtered-empty, row-open, empty, error | Mission, Guardrails | — | Bots: the fleet, search, open a bot and its tabs held still (Live activity appears only while a run is in flight, so its absence is asserted), New bot gated by ManageBots, empty and error |
| `hr-admin/devbox` | surface | `/admin/devbox` | default, filtered-empty | — | — | The computer lab: the fleet, drive controls gated by ManageDevbox with the sentence for a viewer, a filter that finds nothing (the fleet is an in-memory registry no scope forks, so no empty or error world) |
| `hr-admin/budgets` | surface | `/admin/budgets` | default, filtered, filtered-empty, empty, error, dialog-open | — | numbers, dialog, write | Budgets: allocations and sprint envelopes, search, set an allocation read back after a reload, Remove allocation asks first and Escape keeps it, empty and error |
| `hr-admin/changes-review` | surface | `/admin/changes` | default, row-open, empty | Review queue, Policies | — | Code review: the queue and policies tabs held still, open a change, an empty queue |
| `hr-admin/scores` | surface | `/iq/scores`, `/iq/scores/cohorts`, `/iq/scores/compare` | default, row-open, empty, error | — | numbers | Expertise scores: people by score, cohorts, compare two people by name, no scores, an error |
| `hr-admin/observability` | surface | `/admin/observability/summary`, `/admin/observability/invocations`, `/admin/observability/tools` | default, filtered-empty, row-open | — | — | Observability: health, invocations and tool calls, a search that finds nothing, open an invocation |
| `hr-admin/knowledge` | surface | `/admin/knowledge` | default, row-open | — | — | Knowledge bases: the registry against live Bedrock, open a knowledge base |
| `hr-admin/capabilities` | surface | `/admin/capabilities/guardrails`, `/admin/capabilities/code-interpreter`, `/admin/capabilities/browser` | default | — | — | Capabilities: guardrails, code interpreter and browser; editing gated by EditGuardrail and ManageDevbox |
| `hr-admin/prompts` | surface | `/iq/prompts`, `/iq/agents`, `/iq/evaluations` | default, row-open | — | — | Prompt studio, the agent architecture and evaluations: open a prompt and an agent by name |
| `hr-admin/identity` | surface | `/admin/identity/users`, `/admin/identity/roles`, `/admin/identity/policies` | default, filtered, filtered-empty, row-open | — | — | Identity: users by name, roles, policies; a search that finds nobody; open a user and their grants |
| `hr-admin/ingest` | surface | `/admin/ingest/crawl`, `/admin/ingest/history`, `/admin/ingest/sources` | default, row-open | — | — | Ingest: crawl targets, history and sources; open a crawl |
| `hr-admin/codebases` | surface | `/admin/projects` | default, row-open | — | — | Codebases: the agent projects and what each delivers |
| `hr-admin/refusals` | refusals | `/iq/projects` | refused | — | — | The rail and palette as this role sees them, ⌘I quick switch, every gated /iq and /admin route it cannot reach (a deep link that lands on /iq/projects) and the APIs that answer 403 |
| `hr-admin/frames` | frames | `/iq/projects`, `/iq/projects/p-auth-migration`, `/iq/decisions`, `/iq/work`, `/iq/search`, `/settings` | default | — | — | The core pages at 1440 and 900 wide, light and dark: nothing clipped, no horizontal scroll, the audit clean in both themes |

## Status

Open decision (found by the program-owner walk, 2026-10-16): `/admin/changes` is
routed to program-owner (App.tsx `RequireRole`, the Automate "Code review"
link) but its API is gated on ManageDevbox, which program-owner does not hold,
so the role reaches a page that can only refuse it. Either grant program-owner
read on the change queue (Cedar) or stop routing the role there.

Phase 1 written 2026-10-15. Coverage before: 18 of 82 Work routes, 4 of 5 roles, 25 route × role cells, 25 states (all `default`).
