# Defects found — branding journeys (orgiq × assessment × light × dark)

First measured 2026-09-05 in Chrome at 1552px against `dev:mock`, as Theo
Chang / Mia Singh (Org) and Asha Nair (Assessment); re-audited 2026-09-06
00:05–00:13 EDT and again 2026-09-06 08:16–08:22 EDT in the same browser,
same width, same cast, after the fixes below landed. Numbers are computed
styles and `getBoundingClientRect()` values from the live page; each item
names the log that carries the measurement.

## Open

None open. (7, `/iq/promotions` title 8px under the trail, closed 2026-10-08: `PromotionsPage` no longer hangs the Agent library link in the trail band, which is what put the title at the hung band's 8px; it now measures 16px like the other distillation tabs. The same hang still puts the Knowledge tab's title at 8px; `SectionContent`'s band is in `components/shell/`, outside this lane.)

### 2. Primary buttons fail WCAG AA in three of four tenant x theme cells

Measured 2026-09-18 on live primary buttons at 12px/400, where AA requires
4.5:1 for normal text:

| tenant | theme | brand | white on brand |
|---|---|---|---|
| orgiq | light | `#6366f1` | 4.47 |
| orgiq | dark | `#8b91ff` | **2.77** |
| assessment | light | `#0d9488` | 3.74 → **fixed, now 6.76** |
| assessment | dark | `#2dd4bf` | **1.86** |

Cause: the library's `Button` primary variant is `bg-primary text-white` with
the foreground hardcoded. A dark theme lightens its brand so the colour still
reads as an accent on a dark ground, which makes white-on-brand worse rather
than better — which is why both dark cells are the worst two numbers here.

**Fixed:** assessment light. It now carries the SDLC brand `#0B6666` from the
accelerator this tenant is a portal for, which is 6.76:1 and was the right
brand regardless — what was there was stock Tailwind teal-600.

**Open, and NOT fixable consumer-side:** the two dark cells.
`--color-primary` is one token doing two jobs — the button fill (wants dark,
for white text) and the nav's active edge (wants light, to read on the dark
ground). Darkening it to rescue the button costs the accent, and there is no
prop to give the button a dark foreground. Queued in
docs/ui-components-queue.md.

**Open, deliberately not touched:** orgiq light at 4.47 misses by 0.03. Real,
but fixing it means restyling a brand nobody asked to change; it belongs with
the library fix rather than as a unilateral repaint.

### 1. `PageHeader` breaks the vertical rhythm by 6px — Reports is the only surface using it

Measured 2026-09-17 23:05 at 1600px, in BOTH themes (which is what rules out a
theme cause): the breadcrumb-to-title gap is **16px on every surface in both
tenants except `/assessment/reports`, which is 22px**. The branding contract
allows a 2px spread; this is 6px.

Cause, from the live DOM: Reports is the only page in either tenant that
composes its title with the library's `PageHeader`. Everything else uses
`PageSection`. `PageHeader` lays its title row out as
`items-center justify-between gap-4`, so the 25px `h1` is vertically centred
against the 36px "Publish report" actions block and its top drops ~5.5px.
`PageSection` does not centre, which is why every other surface with an action
— the Assessor's desk with "+ New team", for instance — still measures 16px.

Not fixable from here: `className` reaches `PageHeader`'s root, not that inner
flex row, and the repo does not edit ui-components. Queued in
docs/ui-components-queue.md. The in-repo alternative is to move ReportsPage
onto `PageSection`, which is a structural change (PageSection takes `children`
and Reports currently renders its body as siblings) and is not worth doing
before the library decides which of its two title components is the standard.

Excluded from the `rhythm:` line in all four journey logs, named in each one.

 Every item below was re-observed closed on 2026-09-06 08:16–08:22
EDT; the four logs carry `verdict: pass`.

## Observed, needs a decision (2026-10-01 walk)

- **Assessment's Enterprise explorer sits outside the rhythm.** /assessment/enterprise
  (lands on `?doc=ec:standards/ci-cd-standards.md`) collapses the shell trail
  to 0×0 like Org does, and its first `<h1>` is the open document's title
  "CI/CD Standards" at 20px/700, 24px under the document's own crumb band —
  against 16px and 20px/600 on the seven page-header surfaces. Not counted in
  the assessment logs' rhythm line because it is a document title, not a page
  header; if explorer pages are meant to follow the page rhythm, it is a defect.
- **Today's FollowModeBar colour change was not observable.** The assessment
  canvas (/assessment/workspace?doc=page:100002) gets 503 from
  /api/assessment/knowledge/canvas on a plain dev:mock stack (no document
  backend), so no participants render; it needs the social/document profile.

## Closed

### 3. Org page titles share one size and offset — Closed 2026-10-01

Closed by a fresh headless walk at 2026-10-01 13:39 local: nine Org surfaces in light
and dark render 20px/600 titles, eight at 16px under the visible trail and
initiative detail at 17px (spread 1px). Initiatives now composes
`InitiativeHeaderFrame`; the shared layouts and Inbox header hold the same
rule. Member, org-leader and hr-admin checks also confirmed the family at
1680px, and org-leader at 1440px. Evidence: orgiq-light.md and orgiq-dark.md.

Original finding:

Measured headless (Playwright, 1680×940, dev:mock) as Theo Chang. On every Org
surface walked the shell's own trail (`nav.shell-breadcrumbs`, the content
slot's first child) is collapsed to 0×0 and the page draws its own breadcrumb
band; the first `<h1>` under that band then lands at a different distance and
in a different type size per page:

| surface | url | title | size / weight | title top − trail bottom |
|---|---|---|---|---|
| initiatives | /iq/projects | My initiatives | 22px / 600 | 114 − 102 = 12px |
| library | /iq/library | Agent library | 22px / 600 | 108 − 102 = 6px |
| designs | /iq/designs | Designs | 20px / 600 | 122 − 98 = 24px |
| work | /iq/work | Inbox | 28px / 700 | 102 − 98 = 4px |
| work-queue | /iq/work/queue | Runs | 20px / 600 | 102 − 98 = 4px |
| session-config | /iq/local-compute/configuration | Session settings | 20px / 600 | 4px |
| local-compute | /iq/local-compute | Local compute | 20px / 600 | 4px |
| initiative-detail | /iq/projects/p-design-system-api | Design System API | 28px / 700 | 122 − 106 = 16px |
| job-detail | /iq/work/job-inf-maint-1 | inference-canary-nightly | 28px / 700 | 128 − 98 = 30px |

Identical in light and dark. The protocol asks for one title size and offsets
within 2px; this is three sizes and a 26px spread. Assessment, by contrast,
keeps the shell trail on its pages and holds 16px / 20px 600 on all seven
rhythm surfaces. Repro: sign in as u-theo, open the URLs above, read
`getComputedStyle(h1)` and the visible `nav[aria-label="Breadcrumb"]` bottom.
Suspects: the pages' own header composites (ScopeHeader / EditorShell /
PageHeader sizes) now that the shell trail is collapsed on these routes — I
did not trace which change introduced it or what collapses the shell trail.


1. **`--color-primary` did not follow the tenant brand.** Closed
   2026-09-06 00:11–00:13: on `[data-tenant="assessment"]` `--color-brand`
   resolves #0d9488 (light) / #2dd4bf (dark) and `--color-primary`,
   `--color-primary-hover`, `--color-primary-soft` on the same element
   resolve #0d9488 / #0f766e / #ccfbf1 (light) and #2dd4bf / #5eead4 /
   #134e4a (dark); "+ New team" computes rgb(13,148,136) light /
   rgb(45,212,191) dark, as do "+ Add evidence", "Save note", "Add
   submissions →" and the Activity "Run" buttons — the same values as the
   active nav edge. Org's "+ New sprint" is rgb(99,102,241) / rgb(139,145,255)
   = its `--color-brand`. Logs: all four.

2. **Nested-rail Org pages sat the title 24px lower.** Closed 2026-09-06
   00:05–00:09: Library, Automate and Budgets titles are at y=85, the same
   as Initiatives / Promotions / Designs; their x is 468 (224 + the 220px
   nested rail + its 24px left gap), which is the rail's width, not a
   second padding. Logs: orgiq-light.md, orgiq-dark.md.

3. **Assessment dashboard title was page-styled 30px 700, 25px low.**
   Closed 2026-09-06 00:11: the dashboard heading is a `PageHeader` h1,
   20px 600, 0px from the slot top. Logs: assessment-light.md,
   assessment-dark.md.

4. **Assessment Submissions title sat 6px low.** Closed 2026-09-06 00:11:
   the Submissions h1 is 0px from the slot top beside its small "Add
   submissions →" action, matching Reports / Feedback / Activity /
   Configuration. Logs: assessment-light.md, assessment-dark.md.

5. **Team-detail heading was 18px 400.** Closed 2026-09-06 00:12: "Northstar
   Payments" on /assessment/teams/TEAM-001 is an h1 at 20px 600 — one
   title size across the tenant's seven surfaces. Logs: assessment-light.md,
   assessment-dark.md.

6. **Nested rails painted `surface`, not `surface-panel`.** Closed
   2026-09-06 00:05–00:09: the Budgets rail and the Library/Automate rail
   compute rgb(244,246,250) light / rgb(17,26,46) dark — `surface-panel`,
   the shell rail's tone — beside white / rgb(23,32,51) cards. Logs:
   orgiq-light.md, orgiq-dark.md.

7. **The Assessment explorer rail and Activity column painted nothing.**
   Closed 2026-09-06 00:11–00:13: on /assessment/workspace the tree rail
   computes rgb(244,246,250) / rgb(17,26,46), the document pane
   rgb(255,255,255) / rgb(23,32,51) and the right Activity column
   rgb(244,246,250) / rgb(17,26,46) — nothing in the frame is transparent.
   Logs: assessment-light.md, assessment-dark.md.

8. **The tenant mark was a hashed avatar colour.** Closed 2026-09-06
   00:05–00:13: `.shell-header img` is an SVG data URI whose gradient stops
   are #6366f1 → #ec4899 in Org and #0d9488 → #3b82f6 in Assessment, in
   both themes. Logs: all four.

9. **Zero content padding on every full-bleed route (regression from the
   #2 fix).** Observed 2026-09-05 23:54 in Org light: `[data-shell-nav]
   main { padding: 0 }` zeroed the shell main's padding while `Layout.tsx`
   still stripped its own `p-6` on `/iq`, `/admin` and the four assessment
   explorer routes, so every Org list page and the initiative page sat
   flush against the rail and header — title at x=200, y=61, the StatStrip's
   border touching the rail's. Reported to the coordinator, who replaced the
   rule with `[data-shell-nav] > div > main main { padding: 0 0 0 1.5rem }`
   (`portal/src/app.css`) and dropped the full-bleed list from `Layout.tsx`.
   Closed 2026-09-06 00:05: the shell main pads 24px on every route
   (`getComputedStyle(main).padding` = "24px"), titles at x=224, y=85, and
   the nested section mains keep only their 24px left gap. Logs:
   orgiq-light.md, orgiq-dark.md.

10. **The breadcrumb trail's `mb-4` put a 3-deep title 16px below its
    reference while every list title sat 0px below its own.** The trail
    rendered only at 3+ crumbs, so on the six list surfaces the reference
    was the content slot's top (offset 0px) while on the initiative page
    and the team page it was the trail's bottom (16px / 17px). Fixed by
    rendering the trail on every route with a section and a page
    (`portal/src/components/shell/Breadcrumbs.tsx`: `crumbs.length < 2`
    returns null, not `< 3`). Closed 2026-09-06 08:16–08:22: the trail is
    the slot's first child on all fourteen surfaces measured (Org:
    Initiatives, Library, Promotions, Designs, Budgets, Automate,
    initiative-detail; Assessment: Dashboard, Submissions, Reports,
    Feedback, Activity, Configuration, team-detail), its bottom at y=109
    with the slot top at 85, and every title's top is 16px below it
    (y=125) in both tenants and both themes — spread 0px in Org. The one
    exception is the Assessment team page at 16.5px (rounded 17px): its
    25px h1 is centred by a `flex items-center justify-between gap-4` row
    that the right-hand action makes 26px tall, so the heading sits half a
    pixel lower; spread 1px, inside the 2px tolerance. Titles are h1 20px
    600 everywhere. Logs: all four.

Also re-checked 2026-09-06: the Assessment tenant's `/settings` shows no
Org "Scores · Default composite weighting" card (noted in the first
assessment-dark.md).

Validator note (coordinator, 2026-09-06 00:25): the contrast parser stripped
`:1` with a `\b` BSD sed does not know; it now strips `:1` before a
non-digit or end of line, so the documented `15.8:1` form reads as 15.8 on
macOS.
