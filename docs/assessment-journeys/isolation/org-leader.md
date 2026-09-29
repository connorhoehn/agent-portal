role: org-leader
user: u-vera
pages: portal/src/App.tsx,portal/src/components/shell/Layout.tsx,portal/src/pages/SelectContextPage.tsx
audited: audited: 2026-09-29 09:12–09:25 local, Chromium 1642×958 (Playwright headless), middleware dev:mock:social on :3001 (restarted 09:06 with the gateway channel guard), Vite :5183
assessment-tile-visible: no        # /select: 2 role row(s), all Org (Enter Org as Member; Enter Org as Org Leader (current workspace)); 'assessment' nowhere in the page text
assessment-nav-visible: no         # rail on /iq/projects: 19 anchors, 0 toward /assessment; the word appears 0 times in the page
direct-route-result: redirect      # /assessment/teams, /assessment/workspace?doc=page%3A100002 and /assessment/prompts all → /iq/projects (h1 "All initiatives")
api-status: 403                    # /api/assessment/teams 403, /api/assessment/knowledge/tree 403, POST /api/assessment/knowledge/canvas 403, POST /api/session/tenant {assessment} 403 (session unchanged afterwards)
screenshot: org-leader.jpg
verdict: pass — the four REST/route facts hold. This role's realtime token reaches nothing in the assessment tenant: chat join, history, members and send on an assessment document are refused with `AUTHZ_CHANNEL_DENIED`, and a presence subscribe or `set` on an assessment source gets no roster and reaches no one (isolation/DEFECTS.md, closed 2026-09-29 10:11).
notes: grants in /me are {orgiq:[org-leader, member]}. The release-manager role is the most privileged orgiq role that is still tenant-bound; nothing in the wider rail opens toward the assessment product.
re-verified 2026-09-05 04:05: all four facts hold — Workspaces tab shows only Org (1 tile, 2 roles: Member, Org Leader; no "Assessment" tile); rail as org-leader has zero `<a href>` containing "assessment"; `/assessment/teams` redirected to `/select`; `fetch('/api/assessment/teams')` returned 403.
re-verified 2026-09-05 08:33: all four facts still hold — Workspaces tab shows only Org (2 roles); as org-leader, rail has 0 assessment anchors; /assessment/teams redirected away (landed on /select); fetch('/api/assessment/teams') returned 403.
re-verified 2026-09-07 22:12 (local-compute presence merge, Layout.tsx): signed in from /select → "Sign in as" → Vera Green, then the Org tile's Org Leader row (`/api/session/me` = sub u-vera, tenant orgiq, role org-leader, grants {orgiq:[org-leader, member]}, availableTenants ["orgiq"]). Workspaces tab: one tile, Org (orgiq · 2 roles — Member, Org Leader); no "assessment" string anywhere in the picker text. Rail with every group expanded: Initiatives, Budgets, Library, Promotions, Designs, Knowledge, Automate, Distillation, Session config, Health, Architecture, Capabilities, Ask, Explore, Scores, Settings — 16 items, 0 anchors in `[data-shell-nav]` matching /assessment (the nested Automate rail is clean too). fetch('/api/assessment/teams') → 403; POST /api/session/tenant {assessment} → 403, session unchanged. /assessment/teams redirected to /iq/projects. Console errors: 0.
two numbers changed and both are recorded above: the rail is 16 entries (Computer Lab is gone for this role) and the direct-route landing is /iq/projects rather than /select. The new `LocalComputeBadge` is invisible to this session (`/api/local-compute/nodes` → 200 `{"nodes":[]}`), `.shell-header` stays 61px, no new control in the header, no horizontal scroll at 1552px.
re-verified 2026-09-07 23:50 (home-resolution fix, App.tsx + lib/tenantHome.ts): all four facts hold as u-vera. /select Workspaces shows ONE tile — Org (orgiq · 2 roles: Member, Org Leader) — no Assessment tile. Entering Org · Org Leader landed on /iq/projects, not /iq/work: the tenant switch reads the same `TENANT_HOME` that `/` does now, which also settles the friction org-leader/RAIL.md noted. Rail: 30 anchors (16 nav items + 14 repo shortcuts), 0 matching /assessment. /assessment/teams redirected to /iq/projects (h1 "Initiatives", 3240 chars). fetch('/api/assessment/teams') → 403; /api/local-compute/nodes → 200 (orgiq). `.shell-header` 61px, innerWidth 1552 = scrollWidth 1552, console errors 0.

--- freshness re-observation, 2026-09-08 (the LocalComputeBadge tenant gate) ---
Why: `portal/src/components/shell/Layout.tsx` changed — `LocalComputeBadge` is
now mounted as `{session?.tenant === 'orgiq' && <LocalComputeBadge />}`, the fix
for DEFECTS.md #2 — and that file is part of this log's `pages:` digest. Every
field above was re-taken rather than carried forward. `npm run dev:mock` on
127.0.0.1:3011, portal on a Vite proxy pinned to it (:5186, then :5183 after this
box SIGTERMed the first dev server mid-pass), Chrome innerWidth 1552.
Method, stated because it is not the picker: except where noted, the identity was
established with `POST /api/session/login` (+ `POST /api/session/role` where the
persona holds more than one) — the same call the "Sign in as" card makes — and,
for an identity with more than one context, `sessionStorage['orgiq.contextChosen']`
was set to the sub, which is exactly what the chooser's `markContextChosen()`
does. That second step matters and is worth writing down: without it
`resolveHome` correctly routes a multi-context identity to /select, and a pass
that skipped it would have recorded a chooser stop as if it were the product's
answer to a cross-tenant URL. It is not.
Measured this pass:
  - identity: sub u-vera, tenant orgiq, role org-leader, grants
    {orgiq:[org-leader, member]}.
  - assessment-tile-visible: **no** — no "assessment" in /select's text.
  - assessment-nav-visible: **no** — 30 anchors on /iq/projects: the 16
    top-level entries the log records (Initiatives, Budgets, Library,
    Promotions, Designs, Knowledge, Automate, Distillation, Session config,
    Health, Architecture, Capabilities, Ask, Explore, Scores, Settings) plus 14
    repo shortcuts; **0** matching /assessment. Still 16, still no Computer Lab.
  - direct-route-result: **redirect** — /assessment/teams → /iq/projects, h1
    "Initiatives", 2562 chars of main.
  - api-status: **403** — /api/assessment/teams; POST /api/session/tenant
    {assessment} 403.
  - the badge: header 61px, no machine chip; /api/local-compute/nodes **200**,
    correct for an orgiq session.
Console errors: 0 across every navigation in this pass.

--- freshness re-observation, 2026-09-15 19:57 (the shell's SkipLink) ---
Why: Layout.tsx changed (the shell's SkipLink) and is in this log's pages: digest. Signed in from /select → Sign in as → Vera Green → Enter Org as Org Leader; /api/session/me = sub u-vera, grants {orgiq:[org-leader, member]}, role org-leader after the choice.
  - assessment-tile-visible: no — the Workspaces tab shows one tile, Org (orgiq · 2 roles: Member, Org Leader); body text has no "assessment".
  - assessment-nav-visible: no — 31 anchors in [data-shell-nav] on /iq/projects (the platform rail with Operate, plus the nested rail), 0 whose href matches /assessment.
  - direct-route-result: redirect — /assessment/teams landed on /iq/projects, h1 "Initiatives".
  - api-status: 403 — /api/assessment/teams; POST /api/session/tenant {assessment} 403 (curl cookie jar as u-vera agrees).
Console errors: 0 across every navigation in this pass.

--- re-verification 2026-09-16 03:58 (Layout.tsx changed: shell chrome pass) ---
Why: `portal/src/components/shell/Layout.tsx` changed — the site header is wrapped in a native
`<header>` landmark, the ⌘I devbox switcher now runs through the same CommandPalette as ⌘K
(a "Devbox" group, scoped while ⌘I is open), and the account menu's panel is the library
InlinePopover (outside-click / Escape / focus return from useDismissableLayer). None of this
touches tenant gating: the rail items, the palette's page list and the tenant guards are the
same code paths as before. Re-checked the API floor with fresh sessions: every orgiq persona
(u-theo, u-nora, u-mia, u-vera, u-rachel) still gets 403 from GET /api/assessment/teams, each
assessment persona (u-asha, u-jonas, u-farah) still gets 403 from GET /api/graph/people, and
the cookie-less demo identity gets 403 from /api/assessment/teams. Console errors 0 on the
shell as Vera Green.

--- re-verification 2026-09-16 05:05 (Layout.tsx changed: ui-components 2.273.0 adoption) ---
Why: the shell's ChannelHeader renders as a real `<header>` (as="header") instead of being
wrapped, and the shell SubNavLayout carries `railLabel` ("Org navigation" / "Assessment
navigation"). Tenant gating is untouched. Re-checked the API floor with fresh sessions: every
orgiq persona (u-theo, u-nora, u-mia, u-vera, u-rachel) still gets 403 from GET
/api/assessment/teams, each assessment persona (u-asha, u-jonas, u-farah) still gets 403 from
GET /api/graph/people, and the cookie-less demo identity gets 403. Console errors 0.

--- freshness re-observation, 2026-09-16 08:20 (the shell rail moved off inline styles) ---
Why: `portal/src/components/shell/Layout.tsx` is in this log's `pages:` digest —
its `renderNavItem` stopped hand-computing an inline `style` object and now
returns ui-components 2.275.1's `activeNavItemClassName`/`inactiveNavItemClassName`.
That changes how a rail item is painted, not which items exist, but this log's
whole claim is about which items exist, so every fact below was re-taken rather
than carried forward.
  Rail, orgiq side (u-theo, member, /iq/projects): 11 anchors, 0 matching
  /assessment, the string "assessment" occurs 0 times in the document, exactly
  one item lit (Initiatives) and 0 anchors carry a `style` attribute.
  Rail, assessment side (u-asha, assessor, /assessment/teams): 8 anchors, 0
  matching /iq/ or /admin/, one lit (Dashboard), 0 inline styles.
  Direct routes: /assessment/teams as u-theo → /iq/projects (h1 "Initiatives"),
  no flash of assessment content; /iq/projects as u-asha → /assessment/teams
  (h1 "Assessor's desk").
  API floor, fresh cookie jars: GET /api/assessment/teams → 403 for u-theo,
  u-nora, u-mia, u-vera and u-rachel; GET /api/graph/people → 403 for u-asha,
  u-jonas and u-farah. Cookie-less: /api/assessment/teams 403, /api/graph/people
  404 (that route is not mounted for an anonymous caller, so no guard runs — it
  is recorded here as measured rather than as the 403 an earlier entry claimed).
Console errors: 0.
addendum, same session: `Layout.tsx` was edited once more after the observation above — the active rail item's fill class was swapped from the library's `bg-surface-hover` to `bg-primary-soft`, restoring the brand tint the branding cells record (see docs/branding-journeys/*.md, 2026-09-16 08:40). That is a `background-color` change on the one already-lit anchor: it adds, removes and re-targets no rail item, so every isolation fact re-taken above stands unchanged.
addendum, 2026-09-16 09:33: `Layout.tsx` changed again — the command palette's prompt text now reflects the scoped (⌘I) dialog instead of always advertising the full tenant search, and the shell rail is otherwise untouched. No rail item was added, removed or re-gated, so every isolation fact re-taken in the 08:20 entry above stands.

re-verified 2026-09-16 15:01 (observability taxonomy rename, Layout.tsx): the Operate rail item recorded above as "Health" now reads "Observability" — one line of NAV_ITEMS, gated `requireRoles: ['org-leader', 'hr-admin']` as before, so this role still reaches it and sees only the new label. Verified live in the hr-admin cell of this same set, on the same session (Rachel Kowalski holds both roles): rail reads Observability in place of Health, 0 /assessment anchors, `/api/assessment/teams` → 403. Reachability and tenant isolation unchanged. Console errors: 0. Re-audit 2026-09-16: the rail's Configuration row now admits assessor and lead-assessor alongside program-lead, matching the palette and the ungated route — the page renders read-only for them, Save stays behind canManage. Tenant isolation is unchanged: the row is still assessment-only and no orgiq surface appears. Console errors 0.
re-observed 2026-09-17: re-walked because Layout.tsx is in this log's freshness digest and it changed twice today — once to swap the library's nav class constants for local strings, once to put them back (see docs/branding-journeys for the measurements). Neither touch went near rail MEMBERSHIP: the whole diff is the two `activeNavItemClassName`/`inactiveNavItemClassName` bindings, i.e. how the active item is painted, not which items exist or who sees them. Confirmed live rather than reasoned: signed in to the assessment tenant as lead-assessor, the rail is exactly /assessment/teams · submissions · reports · feedback · enterprise · workspace · prompts · rules · runs · configuration plus /settings — eleven hrefs, and a filter for `/iq/` or `/admin/` over them returns the empty set. `platformItems` is computed as `onOrgiq ? … : []`, so a non-orgiq session gets no platform rail at all, which is the mechanism this log exists to pin. Everything recorded above still holds. Console errors 0.
re-verified 2026-09-17 20:40 (`SelectContextPage.tsx` — the chooser's role rows): the change is presentational and isolation is unaffected, but every fact was re-taken rather than carried forward. The row wanted a single top rule to separate stacked roles; `border-t` alone could not give it one, because the library's `ghost` Button variant is `bg-transparent … border border-border` — the same border treatment as `secondary`, not a chromeless button — so the row drew a box on all four sides. It is now `border-x-0 border-b-0 border-t`, measured live at 1px/0px/0px/0px (top/right/bottom/left). Re-observed on the isolated stack (middleware :3013 mock, Vite :5199): every one of the eight named identities was signed in in turn and asked for the tenant it does not hold — the five orgiq roles for `/api/assessment/teams`, the three assessment roles for `/api/graph/people` — and **all eight returned 403**, each with grants scoped to its own tenant only. The cookie-less demo-user resolves to tenant orgiq and is also 403 on `/api/assessment/teams`. As u-theo the chooser renders one workspace tile and one role row ("Enter Org as Member (current workspace)"), and the string "assessment" does not occur anywhere in its text; `/assessment/teams` redirected to `/iq/projects` (h1 "Initiatives") with no flash of assessment content.
re-observed 2026-09-18 (Layout.tsx gained an <html> tenant marker): the edit in this log's `pages` list sets `data-tenant` on document.documentElement as well as on the shell <Stack>, mirroring how lib/preferences.ts sets `data-theme`. It exists so a tenant can paint the page ground at all — custom properties inherit downward only, and the <Stack> is a grandchild of <body>, so `body { background: var(--color-bg) }` could never resolve a tenant's value. It is a CSS hook and touches no route guard, no capability and no fetch: the attribute was already in the DOM one level lower, so nothing is exposed that was not. What was re-verified live rather than reasoned about, as Asha Nair (assessment/assessor, her only grant): `/api/session/me` returns tenant assessment, `document.documentElement.dataset.tenant` reads "assessment", and `GET /api/graph/projects` — an orgiq route — answers 403. The attribute was separately read as "orgiq" in a Theo Chang session on /iq/projects, so it resolves per session rather than sticking at whichever tenant loaded first; a tenant switch hard-navigates (the session-epoch path in CLAUDE.md), so the effect re-runs on mount with the new tenant. The isolation fields above are unchanged.
Re-observed 2026-09-25 (ui-components 2.393.1 -> 2.397.4 rail type scale; checkpoint f837bd68 changes): signed in via the sanctioned fetch path (POST /api/session/login u-vera, POST /api/session/role {role:'org-leader'}). All four facts still hold: /select shows no 'Assessment' tile text; the rail on /iq/projects carries 0 anchors toward /assessment; navigating to /assessment/teams redirected to /select rather than rendering; fetch('/api/assessment/teams') returned 403. shell rail: 18 anchors, 0 matching the assessment tenant (still 0); item label 'Initiatives' at 15px/500 on a 40px row (header 65px) — the branch's rail type-scale (was 13px/36px rows, now 15px/500 on 40px rows) applies here too, with no effect on the isolation facts. No horizontal scroll (scrollWidth 1642 = innerWidth 1642). Console errors: 1 unexpected (the one entry captured is the expected 403 on the fetch('/api/assessment/teams') probe itself, which is the isolation check, not a defect). Landed on /select rather than /iq/projects for this pass: this account holds two roles in one tenant, and the fetch-based login (this session's sanctioned sign-in path, no click through the chooser) never sets the picker's own sessionStorage 'contextChosen' marker that lets a multi-role identity skip the chooser — documented already in isolation/lead-assessor-outbound.md for the cross-tenant case. It does not change what this log asserts: the landing is still a redirect away from /assessment/teams, not the surface itself.

Re-observed 2026-09-29 (App.tsx changed with the Search workspace; the assessment document pages were rebuilt on EditorShell): signed in by POST /api/session/login u-vera + /role org-leader; /api/session/me = u-vera · orgiq · org-leader, grants {"orgiq": ["org-leader", "member"]}. Measured: /select offers 2 Org role row(s) and never the word assessment; /iq/projects rail 19 anchors, 0 toward /assessment; /assessment/teams, the new /assessment/workspace?doc=page%3A100002 deep link and /assessment/prompts each redirect to /iq/projects; the new document endpoints refuse this session too (knowledge/tree 403, knowledge/canvas 403); a tenant switch to assessment is 403 and leaves the session where it was. Console: 0 errors other than the 4 expected 403s from these probes; no horizontal scroll (1642 = 1642). Screenshots refreshed: org-leader.jpg (/iq/projects) and org-leader-direct-route.jpg (where the workspace deep link lands).
New leak, not covered by the four fields: GET /api/session/realtime-token answers 200 for this orgiq session, and a WebSocket on ws://localhost:3001/ws with that token joined chat channel assessment:doc:page:100002 — the Rubric Overview document's conversation — and received 5 messages of history by u-asha, u-jonas, u-farah, u-operator, u-theo. Write was proven once, as u-theo (member), rather than posting from every persona. Owner middleware lib/realtime-gateway.ts (chat channels are not tenant-scoped; only call lobbies are). Hence verdict fail.

Re-observed 2026-09-29 09:12–09:20, after the middleware fix (`lib/realtime-gateway.ts` `channelGuard`, chat and presence channels tenant-scoped like call lobbies): signed in by POST /api/session/login u-vera + /role org-leader; /api/session/me = u-vera · orgiq · org-leader, grants {"orgiq": ["org-leader", "member"]}. The four facts, re-measured: /select offers 2 Org role row(s) and never the word assessment; /iq/projects rail 19 anchors, 0 toward /assessment; /assessment/teams, /assessment/workspace?doc=page%3A100002 and /assessment/prompts each redirect to /iq/projects; /api/assessment/teams 403, knowledge/tree 403, knowledge/canvas 403, tenant switch 403 (session unchanged). The leak: GET /api/session/realtime-token still answers 200 (the token is valid for this session's own tenant), but a WebSocket with it that asks to join chat channel assessment:doc:page:100002 gets no `joined` ack and no history (not joined, no history); the middleware logged `[realtime-gateway] refused subscribe on channel 'assessment:doc:page:100002' for user 'u-vera' (org 'orgiq')`; and a `send` on the channel afterwards is answered “You must join the channel before sending messages”, so nothing is written. Console: 0 errors other than the 4 expected 403s from the probes; no horizontal scroll (1642 = 1642). Screenshots refreshed (org-leader.jpg, org-leader-direct-route.jpg). Hence verdict pass.

re-verified 2026-09-29 09:55–09:56 (presence, after the 09:49 middleware restart onto realtime-modules 0.98.5 with the gateway's presence `authorizeChannel`): signed in as u-vera (POST /api/session/login + /role), took `GET /api/session/realtime-token` (token org `orgiq`), and opened `ws://localhost:3001/ws`. The presence subscribe on `assessment:knowledge:confluence-eng` got no roster: the only frame was the connection's own connect-time `set` with `channels: []`, and the middleware logged `refused presence on channel 'assessment:knowledge:confluence-eng'`. The presence `set` on that channel then reached u-jonas, who was subscribed on his own socket, as: u-vera online Vera Green; u-vera offline Vera Green. Seen in the UI once with u-theo: “TC Theo Chang” appeared on Jonas's Engineering Space row next to Farah and Jonas (presence-cross-tenant-rail.jpg). The four REST/route facts above were not re-driven, because App.tsx, Layout.tsx and the routes did not change. Hence verdict fail until the library gates presence `set` (isolation/DEFECTS.md, Open).

re-verified 2026-09-29 10:09–10:11 (both servers restarted at 10:08 (middleware 10:08:27, Vite 10:08:32) onto realtime-modules 0.98.6 (`node -p` reads 0.98.6 in portal/ and middleware/), in which the router is the single channel check): signed in as u-vera (POST /api/session/login + /role), took its realtime token (org `orgiq`), and opened `ws://localhost:3001/ws`. u-jonas was subscribed to `assessment:knowledge:confluence-eng` on his own socket and, with u-farah, had Rubric Overview open.
   - **Presence.** The subscribe on `assessment:knowledge:confluence-eng` got no frame. The `set` naming that channel was acknowledged with `channels: []`, and u-jonas received 0 `update` frames. Both assessment users' Engineering Space rows stayed **FO JL**. The middleware logged `refused presence on channel 'assessment:knowledge:confluence-eng'` for both requests.
   - **Chat.** On `assessment:doc:page:100002`, `history`, `join` and `members` were each answered `AUTHZ_CHANNEL_DENIED` (`kind: "subscribe"`), and `send` was answered `AUTHZ_CHANNEL_DENIED` (`kind: "publish"`). The text appeared in neither assessment panel.
   - **Not re-driven.** The four REST/route facts above, because App.tsx, Layout.tsx and the routes did not change.

Hence verdict pass. The one remaining gap, that a refused presence request is not told `AUTHZ_CHANNEL_DENIED`, is signalling only and is filed separately (isolation/DEFECTS.md, Open, owner middleware).
