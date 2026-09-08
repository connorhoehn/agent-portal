# Defects found — branding journeys (orgiq × assessment × light × dark)

First measured 2026-09-05 in Chrome at 1552px against `dev:mock`, as Theo
Chang / Mia Singh (Org) and Asha Nair (Assessment); re-audited 2026-09-06
00:05–00:13 EDT and again 2026-09-06 08:16–08:22 EDT in the same browser,
same width, same cast, after the fixes below landed. Numbers are computed
styles and `getBoundingClientRect()` values from the live page; each item
names the log that carries the measurement.

## Open

None. Every item below was re-observed closed on 2026-09-06 08:16–08:22
EDT; the four logs carry `verdict: pass`.

## Closed

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
