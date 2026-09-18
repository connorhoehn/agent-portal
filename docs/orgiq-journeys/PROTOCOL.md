# Orgiq journey audit protocol

One log per (role × surface) under `docs/orgiq-journeys/<role>/<surface>.md`,
with its screenshot beside it, for every cell of `MATRIX.txt`; plus one
`RAIL.md` per role. `scripts/validate-orgiq-audit.sh` reads these; the field
names and values below are what it greps for. The words TODO, unverified
and placeholder anywhere in a log make it not count.

## The clipped-text sweep (run it before eyeballing anything)

Most "padding looks off / this is cut" reports are one defect: a fixed-width
box cutting its own text mid-word, usually a `StatStripItem` `hint` — that
shape has no `title`, so the rest is unreachable (see the StatStrip and
Button rows in docs/ui-components-queue.md). Measuring beats looking, and
this finds every instance on a page at once. Paste into the console on each
route:

```js
(()=>{const m=document.querySelector('main');if(!m)return'no-main';
let c=0,s=[],mo=0,t=0;
m.querySelectorAll('*').forEach(e=>{if(e.children.length)return;
 const x=(e.textContent||'').trim();if(!x)return;t++;
 const cs=getComputedStyle(e);
 if(/mono/i.test(cs.fontFamily))mo++;
 // ONLY a clip when the overflow is actually hidden. With `overflow:visible`
 // the text spills outside its box and stays fully readable.
 const hides=/hidden|clip|auto|scroll/.test(cs.overflowX);
 if(hides&&e.scrollWidth>e.clientWidth+1&&e.clientWidth>0){c++;
  if(s.length<3)s.push({t:x.slice(0,30),avail:e.clientWidth,needs:e.scrollWidth,title:!!e.getAttribute('title')})}});
const f=[];if(c)f.push('clipped:'+c+JSON.stringify(s));
if(document.documentElement.scrollWidth>innerWidth+1)f.push('h-scroll');
if(!m.querySelector('h1'))f.push('no-h1');
if(t>6&&mo/t>.5)f.push('mono:'+Math.round(100*mo/t)+'%');
return location.pathname+' => '+(f.join(' ; ')||'clean')})()
```

**Two filters, both needed, or the sweep cries wolf.**

1. **`overflow` must actually hide.** `scrollWidth > clientWidth` on its own
   proves nothing: with `overflow: visible` the text simply paints outside its
   box and every character is readable. Measured on `/iq/agents`, the
   "Calls (24h)" StatStrip *label* reports 68px needed in a 43px box and is
   fully legible on screen — a false positive. The *hints* on the same
   component are `overflow: hidden` + `text-overflow: ellipsis` and really are
   cut. Same component, two different answers, so check the property.
2. **`title` must be absent.** A long identifier cut with its full value on
   hover is deliberate and working — `/admin/budgets` shows
   `us.amazon.nova-lite-v1:0` that way and it is correct.

Size the replacement copy from the measurement, not by eye —
`avail / needs x length` is roughly how many characters fit. Found this way on
2026-09-17, all three genuinely hidden: budgets (196px into 165px), the
Automate queue pulse (221 into 209), the observability summary (175 into 150).

## Persona

An experienced engineer who is new to this org and opens each page to get
the answer it exists for. Be hard to please: a page passes only if that
answer is visible without scrolling, every control does what its label says,
and nothing on it is decoration.

## Sign in (once per role)

`http://localhost:5183/select` → **Sign in as** → the user's card → **Sign
in** → the **Org** tile's role row. Confirm with `fetch('/api/session/me')`
(`sub`, `tenant: 'orgiq'`, `role`). Never audit as Demo User. Users:
member = `u-theo`, sme = `u-nora`, program-owner = `u-mia`,
org-leader = `u-vera`, hr-admin = `u-rachel` (Rachel Kowalski — the
`u-hr` account is not on the picker's roster).

## Per surface (the cells of MATRIX.txt for your role)

1. Navigate to the matrix URL; wait for data. `read_console_messages`
   `onlyErrors: true, clear: true` before the surface and after every
   interaction on it. Count errors only. A Vite HMR overlay from another
   agent's in-flight edit is not the page's — wait and reload.
2. Screenshot the full window with `save_to_disk: true`; copy it to
   `docs/orgiq-journeys/<role>/<surface>.jpg`.
3. Layout, measured with `javascript_tool`, numbers in the `layout:` line:
   - `document.documentElement.scrollWidth <= innerWidth` (no horizontal
     scroll); the content column's left and width (the shell `<main>`'s
     content box: `main.getBoundingClientRect().left + paddingLeft`).
   - **Density** (surfaces flagged `L` in the matrix): `first-row-top` = top
     of the first data row (`tbody tr`, or the first list/card row when the
     page has no table) at your width; ≤ 640px or the layout verdict is
     `fail — table below the fold (<n>px)`. Above the table, the budget is
     one selector/filter row and a one-line description; a stack of status
     or summary cards above a table is a fail even under 640px — name it.
   - Any nested rail (`SubNavLayout`) flush with the content box (≤ 8px).
3b. **A headless session never paints.** The reliable xyflow unstall is
   `resize 1559 → screenshot → resize 1560 → screenshot`, then read every
   flow number in the single JS batch that follows — one screenshot between
   two resizes re-stalled about half the time and silently measured a tab
   order with the nodes still `visibility: hidden`. Physical key events do
   not reach the page at all: dispatch `keydown`/`keyup` on the real target
   and walk the tab order with a document-order `.focus()` sweep, saying so
   in the log. On a machine with no display
   session `document.visibilityState` is permanently `hidden` and
   `requestAnimationFrame` never fires on its own — so every focus hand-back
   scheduled in a rAF (the pattern this app uses to refocus a trigger that
   was unmounted) reads as a false fail. Force a frame — an MCP screenshot
   does it — between the keystroke and reading `document.activeElement`.

4. Keyboard: Tab from the first control until every interactive control
   has had focus (count vs `querySelectorAll('a,button,input,select,
   textarea,[tabindex]')` minus hidden); Enter/Space act on rows, tabs,
   menus; Escape closes what you opened and returns focus. Table rows that
   only work by mouse are a fail.
5. Empty / error state: use a filter or search that yields nothing; a bad
   id in the URL for detail pages (404 must read as not-found, not as an
   outage); a gated action from a role without it (403 must be explained or
   the control absent).
6. Role gating: list what this role CAN do here and what is hidden, and
   confirm hidden controls are absent from the DOM.
7. `pages:` — the page directories AND/OR files the surface renders from
   (comma-separated, e.g. `portal/src/pages/projects,portal/src/pages/project-detail`
   or `portal/src/pages/ExplorePage.tsx,portal/src/pages/Text.tsx`). Name
   the root page's *file* for a root-level page (ProjectsPage, InvokePage,
   ExplorePage, ScoresPage, AgentFlowPage, SettingsPage …) — a bare
   `portal/src/pages` entry means every root page file and goes stale on
   any of them. Freshness is per surface: the validator compares the log's
   mtime with the newest `.tsx` among those entries. Find them with the
   route in `portal/src/App.tsx` and the imports of that page.
8. Write the log. Wrong things → `verdict: fail — <what>` and a numbered
   entry under `## Open` in `docs/orgiq-journeys/<role>/DEFECTS.md` (file
   hints, repro). Do not fix pages during an audit pass.

## Log format

```
surface: initiatives
role: member
user: u-theo
url: /iq/projects
pages: portal/src/pages/projects,portal/src/pages/project-detail
audited: 2026-09-05 17:10 local, Chrome 1552px, middleware dev:mock
screenshot: initiatives.jpg
verdict: pass
console errors: 0
layout: pass — content col left 224px w 1304px; first-row-top: 412px; one filter row above the table; no horizontal scroll
keyboard: pass — 31 controls reachable, Enter opens a row, Escape closes the drawer
empty-state: pass — "No initiatives match" with a clear-filters action
role-gating: can open initiatives and work items; cannot dispatch (no sprint grant banner explains it); Budgets absent from the rail
notes: <what a person would notice: wrapping, truncation, wrong labels, dead links, wasted space>
```

## RAIL.md (one per role)

```
role: member
user: u-theo
audited: <time>
rail-items: Initiatives, Automate, Distillation, Ask, Explore, Library, Promotions, Designs, Session config, Settings
hidden-surfaces-direct-route: /admin/budgets→redirect /iq/projects, /admin/devbox→redirect, /iq/scores→redirect, /admin/observability→redirect, /admin/identity/users→redirect, /admin/projects→redirect
palette-entries: 18
quick-switch: denied — ⌘I opens the Computers switcher with an access-denied message naming the capability (a role WITH Computer Lab: lists computers, or offers Create computer when there are none)
verdict: pass
notes: <anything that leaks — a link, a menu entry, a palette row, a breadcrumb — into a surface this role must not see>
```

## Freshness is about content, not mtime

A log is stale when the code it observed **changed**. mtime is only a proxy,
and on 2026-09-07 it proved a bad one: a bulk operation stamped 134 portal
source files with one identical mtime (14:35:02) while changing none of them
— the Vite dev server logged no HMR update for any of them, and the only
content change that afternoon was a single edit at 14:03. Fifty-four logs
"went stale" against edits that never happened.

So the validator hashes the files each `pages:` line names and keeps the
digest in `docs/orgiq-journeys/.pages-sha`. A later mtime bump carrying the
same digest is not a change; a digest that moves is, whatever the mtimes say.

`--seal` re-records every digest using the validator's own hash function.
It is for an mtime-corruption event like the one above, and using it means
asserting the logs describe the current code — so say why, in writing, when
you do. Never reach for it to clear a genuine re-audit.
