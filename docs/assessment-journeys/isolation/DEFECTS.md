# Defects found — tenant-isolation re-audit

Found on 2026-09-07 22:05–22:25 EDT re-observing the ten isolation logs that
the content-hash freshness check flagged after the local-compute presence merge
(`e59de29`). Chrome at 1552px, `middleware dev:mock` on :3011, portal on :5183.
Audited as the real picker personas — u-theo, u-nora, u-mia, u-vera, u-rachel,
u-asha, u-jonas, u-farah — never Demo User.

## Open

_None._

## Closed

1. **An assessment role typing an orgiq URL lands on a blank page inside the
   orgiq URL space, not on their own home.** — **Closed 2026-09-07 23:44 EDT.**

   The cause was a guard whose fallback pointed *inside the tree it guarded*:
   `App.tsx` wrapped `/iq` and `/admin` in
   `<RequireTenant tenant="orgiq" fallback={<Navigate to="/iq/projects">}>`, so
   for an assessment session the guard denied, the fallback re-entered, the
   guard denied again, and the URL never moved — leaving an empty content
   column under the orgiq breadcrumb "Plan › Initiatives".

   The fix does not just repoint that one arrow. `portal/src/lib/tenantHome.ts`
   is now the **only** place that answers "where does this identity belong":
   `resolveHome(session)` — chooser when there is no session, no usable
   workspace, or an unmade multi-workspace choice; otherwise the front door of
   the tenant the session is standing in (a cross-tenant `admin` is not
   special — `session.tenant` is the workspace they entered, and that
   workspace's home is the right answer). `App.tsx` has one `<HomeRedirect />`
   built on it, used both for `/` and as the fallback of all 23 guards, and it
   renders **not-found** rather than navigating when the home it resolves is
   the page already on screen — so a fallback can never dead-end again, whoever
   writes the next guard. Three drifted copies of the answer were folded in:
   `RootRedirect`'s `/iq/projects`, `auth.tsx`'s `TENANT_HOME` (`/iq/work`,
   used by the tenant switch) and `NotFoundPage`'s "back to home" link
   (`/iq/work`). Pinned by `portal/src/lib/__tests__/tenantHome.test.ts`
   (9 tests), including "an assessment identity is never sent into the orgiq
   tree" and "the tenant switch and `/` agree".

   Evidence, re-observed as the three seeded personas at 1552px on the stock
   mock floor, console errors 0 throughout:

   | user | /iq/projects | /iq/scores | /admin/observability | / |
   |---|---|---|---|---|
   | u-asha (assessor) | → /assessment/teams, 1068 chars | → /assessment/teams | → /assessment/teams | → /assessment/teams |
   | u-jonas (lead-assessor) | → /assessment/teams, 1068 chars | → /assessment/teams | → /assessment/teams | → /assessment/teams |
   | u-farah (program-lead) | → /assessment/teams, 1068 chars | → /assessment/teams | → /assessment/teams | → /assessment/teams |

   `/admin/devbox` and `/admin/identity/users` land the same way, and a path
   that matches no route at all still reads as not-found rather than as a
   redirect (`/iq/nope-does-not-exist` renders "Page not found — Nothing lives
   at /iq/nope-does-not-exist"). The data boundary is unchanged and still
   holds: `/api/graph/people`, `/api/scores/leaderboard`, `/api/work/queue` and
   `POST /api/session/tenant {orgiq}` are 403 for all three. Logs and
   screenshots: `assessor-outbound.md`, `lead-assessor-outbound.md`,
   `program-lead-outbound.md`, all now `verdict: pass`.

   One thing found while closing this, fixed in the same pass: the chooser's
   `markContextChosen()` was dead code. `SelectContextPage.choose()` marks the
   pick, then `enterContext` calls `clearTenantScopedCaches()`, which wipes the
   sessionStorage that marker lives in — so a two-context user (u-jonas,
   u-farah) who had just picked a workspace was sent straight back to /select
   by the very next home resolution. `enterContext` now re-marks the same
   `sub` after the scrub. A different identity still re-drives through the
   chooser: `login`/`logout` call `clearContextChosen()` outright.

2. **`LocalComputeBadge` mounts in every tenant's shell, so orgiq Computer Lab
   chrome appears in the assessment header.** — **Closed 2026-09-07 23:57 EDT**
   (fixed by another agent; verified here).

   Both halves are in place. Client: `Layout.tsx:304` now reads
   `{session?.tenant === 'orgiq' && <LocalComputeBadge />}`, matching its two
   neighbours. Server: `middleware/src/routes/local-compute.ts` applies
   `requireTenant('orgiq')` **per route** to the browser half (`/nodes`,
   `/nodes/all`, `/stream`) and deliberately not at the mount, so the
   session-less machine callbacks (`/announce`, `/heartbeat`,
   `/sessions/:id/end`, `/pair/claim`) still work.

   Verified on the identity that reproduced it — demo-user, who owns
   `node-demo-macbook`. In Assessment · Program Lead the header reads
   `Assessment | Mock: … | ⌘K Search | Demo User | Assessment · program-lead`
   with no `⌂ demo-macbook` anywhere in the document, and
   `GET /api/local-compute/nodes` answers **403**
   `{"error":"Forbidden","requiredTenant":"orgiq","tenant":"assessment"}`
   (it answered 200 with `node-demo-macbook` on 2026-09-07 22:23). Switching
   the same identity to Org · SME brings the badge back — `⌂ demo-macbook · 1`
   — and the endpoint back to 200, which is the point: the badge was scoped to
   the tenant, not removed. It is 403 for u-asha, u-jonas and u-farah too, so
   the "any dual-grant user reaches it the moment they register a machine"
   exposure is closed at the API, not just hidden in the shell.
   Screenshots: `local-compute-badge-in-assessment.jpg` (the pre-fix leak,
   kept as the before-state) and `local-compute-badge-gated.jpg` (after).

   The follow-up this entry raised is now **done (2026-09-08)**.
   `scripts/validate-assessment-tenant.sh` used to grep for `DevboxQuickSwitch`
   and `ComputeDock` by name, so the ratchet could not have caught this defect
   and would not have caught the next such component. That check now names what
   it means instead of enumerating two things: it collects every component
   `Layout.tsx` mounts whose name carries the Computer-Lab vocabulary
   (`Devbox|Compute|Machine`) and requires each one to be gated on
   `session?.tenant === 'orgiq'`, with a floor of three so a rename OUT of that
   vocabulary fails loudly rather than emptying the check. Proved both ways
   before it was accepted: with `LocalComputeBadge` temporarily un-gated the
   script fails naming it (`✗ Computer-Lab chrome mounts in every tenant's shell
   — gate on session?.tenant === 'orgiq': LocalComputeBadge`), and with the gate
   restored it passes naming all three (`✓ every Computer-Lab component the
   shell mounts is gated on the orgiq tenant (3: ComputeDock DevboxQuickSwitch
   LocalComputeBadge)`).

   Re-verified 2026-09-08 on the identity that reproduced the defect, through
   the real chooser rather than an API login, with both halves of the gate
   watched on one session: as **demo-user in Assessment · Program Lead** the
   header reads "Assessment | Mock: … | ⌘K Search | Demo User | Assessment ·
   program-lead", the string "macbook" occurs nowhere in the document, and
   `GET /api/local-compute/nodes` answers 403
   `{"error":"Forbidden","requiredTenant":"orgiq","tenant":"assessment"}`;
   switching the same identity to **Org · SME** brings back both the chip
   (`⌂ demo-macbook · 1`) and the 200. Scoped to the tenant, not removed —
   which is the distinction this defect was about. `.shell-header` is 61px in
   both. The endpoint is also 403 for u-asha and u-farah, so the exposure is
   closed at the API and not merely hidden in the shell.

<details>
<summary>Original reports (2026-09-07 22:05–22:25 EDT)</summary>

### The two reports as filed


1. **An assessment role typing an orgiq URL lands on a blank page inside the
   orgiq URL space, not on their own home.** `portal/src/App.tsx:256` (the
   `/iq` tree) and `:373` (the `/admin` tree) both guard with
   `<RequireTenant tenant="orgiq" fallback={<Navigate to="/iq/projects" replace />}>`
   — a fallback that points *inside the tree it is guarding*. So for a session
   whose tenant is `assessment`:
   - `/iq/projects` → the guard denies, renders `<Navigate to="/iq/projects">`,
     the guard denies again. The URL never moves. `[data-shell-nav] main`
     contains one breadcrumb — the orgiq trail **"Plan › Initiatives"** — and an
     empty content div. Verified DOM:
     `<div class="h-full flex flex-col bg-bg"><nav aria-label="Breadcrumb">…Plan › Initiatives…</nav><div class="flex-1 min-h-0 overflow-auto"></div></div>`
   - `/iq/scores` → `/iq/projects`, same blank page.
   - `/admin/observability` → `/iq/projects`, same blank page.
   - `/` → `/assessment/teams` correctly, so the app *knows* the right home; only
     these two fallbacks don't use it.

   Reproduced identically as all three assessment personas: u-asha (assessor),
   u-jonas (lead-assessor), u-farah (program-lead). Screenshots:
   `assessor-outbound.jpg`, `lead-assessor-outbound.jpg`,
   `program-lead-outbound.jpg`.

   Why it matters rather than being cosmetic: the tenant *data* boundary holds
   (rail carries 0 anchors matching `^/(iq|admin|newsroom)`, and
   `/api/graph/people`, `/api/scores/leaderboard`, `/api/work/queue` and
   `POST /api/session/tenant {orgiq}` all return 403). But the *route* boundary
   now reads as an outage: a person who follows a stale link is parked at
   `/iq/projects` under the other product's breadcrumb with nothing on the page
   and no way back except the rail. `docs/orgiq-journeys/PROTOCOL.md` §5 is
   explicit that a blocked route must read as not-found, not as an outage. The
   comment directly above the guard states the intent — "an assessor who types
   /iq/projects must land on their own home" — which is exactly what does not
   happen.

   Fix hint: the `/assessment` tree at `App.tsx:227` gets this right because its
   fallback names the *other* tenant's home. The two orgiq trees should fall
   back to `<Navigate to="/" replace />` (Home already resolves per tenant) or to
   `/assessment/teams`, not to a route they themselves guard.

   Consequence for the logs: `assessor-outbound.md`, `lead-assessor-outbound.md`
   and `program-lead-outbound.md` now carry
   `orgiq-route-result: dead-end` and `verdict: fail`. The five inbound logs
   (member, sme, program-owner, org-leader, hr-admin) are unaffected — the
   assessment tree's fallback sends an orgiq user to `/iq/projects`, which for
   them is a real, populated page.

2. **`LocalComputeBadge` mounts in every tenant's shell, so orgiq Computer Lab
   chrome appears in the assessment header — reproducible on the stock mock
   floor, no instrumentation.** `portal/src/components/shell/Layout.tsx:298`
   renders `<LocalComputeBadge />` unconditionally, unlike `<DevboxQuickSwitch>`
   and `<ComputeDock>` on the lines around it, which are both gated on
   `session?.tenant === 'orgiq'` (and which
   `scripts/validate-assessment-tenant.sh` checks for by name). Server side,
   `middleware/src/routes/local-compute.ts:229` gates `GET /nodes` with
   `requireSession('ViewLocalCompute')` — an authentication floor, no tenant
   scope — and the handler filters by owner only
   (`listNodesByOwner(session.sub)`, `providers/local-compute.ts:199`), never by
   tenant.

   Repro, exactly as observed at 22:23 EDT:
   1. `/select` → Sign out (the cookie-less Demo User identity).
   2. Workspaces → **Assessment → Assessor**. `/api/session/me` narrows to
      `{assessment:["assessor"]}`, tenant `assessment`, and the app lands on
      `/assessment/teams`.
   3. The assessment header now reads
      `Assessment | … | ⌘K Search | ⌂ demo-macbook · 1 | Demo User | Assessment · assessor`.
      `GET /api/local-compute/nodes` returns **200** with
      `node-demo-macbook` (`ownerId: "demo-user"`), because the mock floor seeds
      that node for the demo identity.
   4. Opening the badge shows, inside the assessment product:
      `DEMO-MACBOOK · darwin/arm64 · CONNECTED · p-realtime · feat/presence-mesh ·
      ollama · qwen2.5-coder:14b · "wire the presence mesh into the gateway" ·
      ctx 31% · 7 pending` — an orgiq initiative id, an orgiq branch and an
      orgiq work intent — plus an **"Open Computer Lab"** action.
   5. Clicking it navigates to `/admin/devbox`, which hits defect 1 and dead-ends
      on a blank `/iq/projects`.

   Screenshot: `local-compute-badge-in-assessment.jpg` (step 4, unstubbed).
   The seeded personas do not have a node, so `nodes` is `[]` for u-asha, u-jonas
   and u-farah and the badge renders null for them today — but their API call
   still returns 200, not 403, so the only thing between them and the same
   header is whether a machine is registered against their `sub`. Any dual-grant
   user (the `admin` persona u-operator, or a future one) reaches it the moment
   they register a machine.

   Fix hint: gate the mount the way its two neighbours are gated
   (`session?.tenant === 'orgiq' && <LocalComputeBadge />`), and/or scope
   `GET /api/local-compute/nodes` to the caller's tenant. The validator's
   "Computer Lab chrome gated on the orgiq tenant" check should grow to name
   `LocalComputeBadge` too, otherwise the next such component ships ungated
   again.

</details>

## Not filed

- The header badge did **not** change layout or density anywhere, in either
  tenant, with or without a machine present. Measured on /iq/projects at 1552px
  as u-nora and u-theo (badge absent) and on /assessment/teams as Demo User
  (badge present, "⌂ demo-macbook · 1"): `.shell-header` is 61px in every case,
  `first-row-top` on /iq/projects is 369px, and
  `document.documentElement.scrollWidth <= innerWidth` holds. The badge adds one
  focusable button to the header, between Search and the user menu, in document
  order; its popover opens on click and closes on Escape. Console errors were 0
  on every surface visited in this pass. The badge's *placement* is fine; only
  its *tenant scope* (defect 2) is wrong.

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
