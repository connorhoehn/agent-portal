# Initiatives — three page variants (targets)

**Open all three PNGs in this folder with the Read tool first** — they are the
targets (user, 2026-09-24). This file is a checklist; the images win.

- `initiative-overview-mockup.png` — `/iq/projects/p-observability` (Overview)
- `initiative-work-mockup.png` — the same initiative, Work tab, a work item open
- `initiative-mine-empty-mockup.png` — `/iq/projects` Mine view, nothing linked

## Shared frame (all three)
Org shell + org rail unchanged. Explorer column (~330px): header
**"Initiatives 11"** with ⋯ and collapse «; tabs **Initiatives | Sprints**;
segmented **Everyone | Mine**; search "Find an initiative…"; groups
("In progress 9", collapsed "Planning 2") of rows: title + "Owner · N agents"
or "· Idle"; selected row = fill + left bar; footer "11 initiatives".
Bottom of the main column: a LIGHT composer — "Agent ▾" pill, a context chip
with a dot + name + × ("Observability Platform" / "This work item" /
"Initiatives"), multi-line input, toolbar B I code link attach · Workflow ▾ ·
"/ commands", Send (disabled look when empty).

## 1. Overview
Header: **Observability Platform** + "In progress" pill; right "Repository ↗"
+ ⋯. Subtitle "Collect telemetry, reduce alert noise, and control retention
costs." then "Nora DaSilva · Owner   Layla Hassan, Eli Garcia · SMEs".
Tabs: Overview · Work 11 · Decisions 2 · Agents · Contributors 3.
Stat strip (3 cells, dividers): "18 / 52 points delivered" + progress bar ·
"2 agents running" · "$1.73 spent of $95 allocated".
**What needs attention** — amber callout with left bar: title "Stop duplicate
alerts during a dependency outage", body "One failing dependency can trigger
forty pages. Eli needs the dependency map before this bug can be planned.",
meta "Blocked · Eli Garcia · 2 points", action "Open work →".
**Plan next** — 3 rows (title, one-line description, right "Owner · N
points", chevron); link "See all 11 work items →".
**How to move this forward** — one sentence. Composer prefilled "Help me
prioritize the next changes and explain the tradeoffs."

## 2. Work tab (work item open)
Explorer becomes the work list: "‹ Initiatives" back link, **"Work 11"** +
initiative switcher select ("Observability Platform ▾"), search "Find work…"
+ filter button, "By priority ▾" grouping menu, groups Next up 5 / In progress
2 (collapsed) / In review 1 / Done 3 (collapsed); rows title + "Type · owner ·
N points" and a "Blocked" tag; selected row fill + left bar.
Main: initiative header condensed — title + pill, "18 / 52 points delivered ·
$1.73 spent", Repository ↗ ⋯, tabs with **Work 11** selected.
Work item: crumb "› SLOs and error budgets / Bug · wi-obs-e2-b4", title
**"Stop duplicate alerts during a dependency outage"**, meta row "● Open ·
Blocked · (EG) Eli Garcia · 2 points · High priority". Tabs **Brief** ·
Discussion · Activity.
Brief: **Why this matters** paragraph; amber **Next step** callout "Confirm
the dependency map with Eli Garcia." + "The team needs this before choosing
how to group duplicate alerts." + "Open discussion →"; **Complete the brief**
"Add enough detail for an engineer or agent to know what success looks like."
with a 3-row table: Acceptance criteria — Not defined yet — Draft with agent ·
Dependencies and decisions — No links added — Add context · Planning notes —
No notes added — Add a note; collapsed **› Run setup** "SME or release manager
required to dispatch". Composer chip "This work item", prefilled "Help me
define acceptance criteria and identify what Eli needs before this work can
start."

## 3. Mine, empty
Explorer: Mine selected; "Nothing linked yet / Try Everyone to browse the
workspace. / Show everyone →"; footer "Personal view".
Main: **My initiatives** / "Initiatives where you are an owner or
contributor."; **No initiatives are linked to you yet.** + two lines, buttons
**Browse all initiatives** (primary) + **Check profile**; divider; **How this
view works** three lines; link "Refresh this view". Composer chip
"Initiatives", placeholder "Ask about the team's initiatives or how to get
involved…".

## Rules (user, non-negotiable)
No hand-rolled UI — ui-components composites only (gaps added to the library
first, released, pinned); hooks from realtime-modules; realtime-examples as the
usage reference. Copy that reads as data (why-this-matters, next step, plan-next
descriptions, attention reason) comes from the server/fixtures under the
mock-floor contract, not portal literals. No shortcuts.
