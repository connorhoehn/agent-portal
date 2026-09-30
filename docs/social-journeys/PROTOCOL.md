# Journey audit protocol — social tenant

One log per (role × surface) under `docs/social-journeys/<role>/<surface>.md`,
with its screenshot beside it, plus the isolation logs under
`docs/social-journeys/isolation/`. `scripts/validate-social-tenant.sh` reads
these; the field names and values below are what it greps for. The goal and
its phases are in `docs/social-tenant-goal.md`. Adapted from
`docs/assessment-journeys/PROTOCOL.md`; where the two agree, that file's
history (the measuring traps at the end) applies here too.

## Sign in (once per role)

Open `http://localhost:5183/select` → **Sign in as** tab → the user's card →
**Sign in** → back on the Workspaces tab click the **Social** tile's role
row. Confirm with `fetch('/api/session/me')` that `sub`, `tenant: 'social'`
and `role` are what you expect before auditing anything. Never audit a role
log as Demo User. Users: participant = `u-sana`, moderator = `u-lena`,
community-admin = `u-mira`, admin = `u-operator` (enter the Social workspace
as admin).

Two contexts are needed wherever a surface is realtime (channels, dms,
calls, rooms, activity): the second user is `u-sana` when auditing as
anyone else, `u-mira` when auditing as `u-sana`. A walker with the Chrome
tab shares the user's cookies — use a second Playwright context or a curl
jar for the second user, and restore the user's persona afterwards.

## Surfaces and URLs

| surface | url | phase | what "the surface" includes |
|---|---|---|---|
| activity | the header bell, opened on `/social/channels` | N | the bell and its unread count; an item arriving from the second context without a reload; the popover (category, title, body, age); clicking an item lands inside the item's tenant and marks it read; Mark all read; Clear; Escape closes and focus returns to the bell; a reload replays the unread set |
| channels | `/social/channels` | S1 | the chat workspace's rail (`ConversationRail`, flush at x=200 — `docs/rail-parity-goal.md` decision 6), a channel opened with its header (Chat / Documents / Pinned / Calls, the call actions, ⋯ Leave), a message posted and seen in the second context without a reload, history after a reload, create channel for a role that may |
| dms | `/social/dms` | S1 | the DM list, a DM opened with the second user, a round trip, the unread mark on the list |
| calls | `/social/calls` | S2 | the chat workspace with the shelf's Calls open: the call log, a call started from a DM or a room, the missed-call item it leaves when unanswered |
| rooms | `/social/rooms` | S2 | the chat workspace's Rooms section, the room opened in the pane, a room created (role that may), joined, its lobby `social:room:<slug>` |
| contacts | `/social/contacts` | S2 | the roster with presence, a person opened, "Message" into a DM |
| teams | `/social/teams` | S2 | the team tree (`TeamChannelTree`, in the chat rail), a team channel opened, membership edit for a role that may |
| recordings | `/social/recordings` | S2 | the chat workspace with the shelf's Recordings open: the list, a recording played, share/delete for a role that may |
| configuration | `/social/configuration` | S2 | community-admin only; other roles: what they see instead |

## Per surface

1. Navigate, wait for data. Read console errors (errors only, not warnings)
   BEFORE the surface and again after every interaction on it. Vite HMR
   overlay errors from another agent's in-flight edit are not the page's —
   wait and reload.
2. Screenshot at the full window (≥1440px wide), saved to
   `docs/social-journeys/<role>/<surface>.jpg`.
3. Measure the layout and write the numbers: no horizontal scroll
   (`document.documentElement.scrollWidth <= innerWidth`); the content column
   left edge and width (`main` left + its padding-left); for a page with a
   second rail, the rail's left minus the content column's left ≤ 8px and the
   rail-parity family (≈220px, 13px/500 rows, 11px caps caption); a chat
   panel's composer stays in view without the page body scrolling.
4. Keyboard: Tab from the page's first control until focus has visited
   every interactive control (count them against the visible
   `a,button,input,select,textarea,[tabindex]`); Enter/Space on a row or tab
   acts; Escape closes any popover, drawer, modal or palette you opened.
5. Realtime: for a realtime surface, the second context's action appears in
   the first without a reload, within 2s — write the measured delay
   (`realtime: pass — 0.4s`). A surface with nothing live writes
   `realtime: n/a`.
6. Empty / error state: ask the mock for it (`POST /api/__mock/scenario
   {"scenario":"empty","fixture":"<key>"}`) rather than damaging shared
   state, and restore it afterwards; or use an unknown id
   (`/social/channels/no-such-channel`). Write what rendered.
7. Role-gating: list the controls this role CAN use and the ones hidden for
   it, and confirm the hidden ones are absent from the DOM (not just
   disabled) unless the page deliberately shows them disabled with a reason.
   The Cedar split: participant cannot ManageChannels / ManageTeams /
   ManageRecordings; moderator cannot ManageSocialConfig.
8. Write the log. If something is wrong, `verdict: fail — <what>` and keep
   going; do not fix pages mid-audit (a page edit invalidates the logs that
   name it). Collect defects in `docs/social-journeys/<role>/DEFECTS.md`.

## Log format

```
surface: channels
role: moderator
user: u-lena
url: /social/channels/general
pages: portal/src/pages/social/ChannelsPage.tsx,portal/src/pages/social/channels
audited: 2026-10-02 10:12 local, Chromium 1642×958, middleware dev:mock
screenshot: channels.jpg
verdict: pass
console errors: 0
layout: pass — content col left 200px w 1442px; rail 220px at 200px (0px from content start); no horizontal scroll
keyboard: pass — 31 controls reachable by Tab, Enter opens a channel, Escape closes the member drawer
empty-state: pass — the `empty` scenario renders "No channels yet" with Create channel
realtime: pass — u-sana's message appeared in 0.4s, no reload
role-gating: can create/rename/archive channels; cannot open Configuration (absent from rail and palette)
notes: <what a person would notice: wrapping, truncation, wrong labels, dead links>
```

`verdict`, `console errors`, `layout`, `keyboard`, `empty-state`,
`realtime`, `screenshot` and `pages` are required; the words TODO,
unverified and placeholder anywhere in the file make it not count.

## `pages:` (required) and freshness

Every log carries a `pages:` line naming the files and/or directories its
surface actually renders from, comma-separated. Freshness is judged by
**content digest**, not mtime: the judge hashes the named entries and
compares with the digest recorded in `docs/social-journeys/.pages-sha`; a log
whose sources changed since it was sealed is stale. `--seal` records the
current digests and is run once, after a walk, by whoever wrote the logs —
never to make a red run green without walking. Name FILES (or the
surface's own directory), not `portal/src/pages/social`, and leave shared
children (the layout, a `Text.tsx`, format modules) out — naming them puts
every log under one global rule. The header bell's log names the shell file
that draws it (e.g. `portal/src/components/shell/ActivityBell.tsx`), not
`Layout.tsx`. Find entries from the route in `portal/src/App.tsx` and the
page component's imports. A `pages:` entry that does not exist makes the log
invalid.

## Isolation logs

Phase S0. Walked with a real sign-in per row (the demo row cookie-less).
Every isolation log carries `user:`, `verdict: pass`, `screenshot:` and
`pages:` (typically `portal/src/App.tsx,portal/src/components/shell/Layout.tsx,portal/src/pages/SelectContextPage.tsx`).

**Inbound** — `isolation/<role>.md`, one per outside role, standing in its
own tenant and reaching for Social:

| log | user |
|---|---|
| member | u-theo (a curated participant in social — the tile shows; his orgiq session still cannot reach `/social/*`) |
| sme | u-nora |
| program-owner | u-mia |
| org-leader | u-vera |
| hr-admin | u-hr (no social grant) |
| assessor | u-asha |
| lead-assessor | u-jonas |
| program-lead | u-farah |
| demo-user | the cookie-less identity (must hold no social grant) |

```
social-grant: yes|no              # from /api/session/me grants
social-tile-visible: yes|no       # on /select; must equal social-grant
social-nav-visible: no            # in the session's own tenant shell: 0 anchors to /social
direct-route-result: redirect     # typing /social/channels: redirect | not-found
api-status: 403                   # fetch('/api/social/…') from the session's own tenant
activity-leak: none               # no bell item links outside the tenants the session holds
forged-subscribe: AUTHZ_CHANNEL_DENIED   # phase E, required when social-grant: no —
                                  # a hand-built subscribe to social:ch:general on /ws
```

**Outbound** — `isolation/<role>-outbound.md` for `participant` (u-sana),
`moderator` (u-lena) and `community-admin`
(u-mira), standing in the social tenant and reaching for the others:

```
orgiq-nav-visible: no
orgiq-route-result: redirect      # /iq/projects
orgiq-api-status: 403             # e.g. /api/bots
assessment-nav-visible: no
assessment-route-result: redirect # /assessment/teams
assessment-api-status: 403        # /api/assessment/teams
```

## Measuring traps

The two traps in `docs/assessment-journeys/PROTOCOL.md` ("`offsetParent !==
null` is not visibility"; "`getBoundingClientRect()` inside an
`overflow-x: auto` container reports unclipped positions") apply unchanged.
A chat rail and a message list are both scroll containers — check an
ancestor's `overflowX`/`overflowY` before reporting an overlap.
