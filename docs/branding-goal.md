# Goal: a branding colour system the portal can actually be seen through

`scripts/validate-branding.sh` is the only judge. Run it after every slice
and treat each failing line as the next task. No `npm install` (offline).
No hand-rolled HTML in pages — colour is applied through tokens on
ui-components composites, never through a page's own palette.

## Why

Every region of the portal — the page ground, the nav rail, the header,
every card, every panel — paints in the same near-white (`#ffffff`,
`#fafbfc`, `#f8fafc`). With no tonal difference between a surface and the
ground it sits on, nothing reads as a layer: the shell, the content and the
cards compress into one sheet and the eye has nothing to hold on to. The
user's words: "everything has the same background color which makes it
visually all compressed." There is also no brand: the accent is an
unowned Vite indigo, the assessment tenant inherits it, and dark mode is
whatever the component library happens to define.

## The design (see `docs/branding.md` for the palette)

Four **surface layers**, each a distinct value in both themes, declared in
`portal/src/app.css` `@theme` so they generate Tailwind utilities:

| token | role | light | dark |
|---|---|---|---|
| `--color-bg` | the page ground everything sits on | cool slate tint | near-black slate |
| `--color-surface-panel` | shell rail, context rails, side panels | brand-tinted panel | slate 900 |
| `--color-surface` | cards, tables, the header | white | slate 800 |
| `--color-surface-inset` | wells inside a card (code, empty states) | off-white | slate 900 |

One **brand family** per tenant, set on `[data-tenant]`: `--color-brand`
(the accent — buttons, active nav, links), `--color-brand-ink` (a deep
shade for the tenant mark and emphasis), `--color-brand-soft` (a tinted
fill for selected rows and active nav) and `--background-image-brand-gradient` (the
header's hairline and the tenant mark). `--color-primary` aliases
`--color-brand` so every existing consumer picks it up. Org is indigo;
Assessment is teal — a session in one tenant is visibly not the other.

The **shell** applies the layers: the nav rail paints `surface-panel` with
the brand active item; the header paints `surface` under a brand-gradient
hairline; the content column paints `bg`; cards lift off it with
`shadow-sm`. Pages do not choose colours — they use the tokens' utilities
(`bg-surface`, `bg-surface-panel`, `text-brand`, …) on composites.

## Definition of done (what the validator checks)

1. **Tokens**: `@theme` in `app.css` declares `--color-bg`,
   `--color-surface-panel`, `--color-surface`, `--color-surface-inset` with
   four DISTINCT values; `--color-brand`, `--color-brand-ink`,
   `--color-brand-soft`, `--background-image-brand-gradient` exist; `--color-primary`
   defaults to `var(--color-brand)` AND every tenant block (light and dark)
   restates `--color-primary` as its own brand — a `var()` in a custom property
   resolves at the declaring element, so the alias alone never follows the tenant.
2. **Dark**: a `[data-theme="dark"]` block in `app.css` redefines every
   colour token `@theme` declares (no light-only token), with four distinct
   surface layers of its own.
3. **Tenants**: `[data-tenant="orgiq"]` and `[data-tenant="assessment"]`
   each set the brand family, with different `--color-brand` values.
4. **Shell**: `Layout.tsx` marks the nav host (`data-shell-nav`) and the
   header (`shell-header`), and `app.css` paints them from the layer
   tokens; `body` paints `--color-bg`.
5. **No raw palette in pages**: zero `bg-white|black|slate|gray|red|…-N`
   classes in `portal/src/pages`; hex literals in `portal/src/pages` ≤
   `scripts/branding-hex-budget.txt` (starts at 109, only goes down, done
   at 0 — chart series read `var(--color-…)`).
6. **Header rhythm**: titles, subtitles and breadcrumbs come from one
   composite each with one spacing rule — zero page-level title typography
   (`text-[2Npx] font-bold` on a `T`/`Inline`), zero `PageSection`/
   `PageHeader` carrying its own margin or padding, breadcrumbs rendered
   once by the shell; and the journeys record a `rhythm:` line — title
   top minus breadcrumb bottom on ≥ 6 surfaces (one of them a detail
   page), all within 2px, one title size.
7. **Builds**: portal `tsc` and `vite build`.
8. **Journeys**: `docs/branding-journeys/{orgiq,assessment}-{light,dark}.md`
   + screenshot each, audited as a real user in the browser, with measured
   `layers:` (computed `background-color` of `body`, the nav `aside`, the
   header, a `Card`, and a panel — ground, panel and surface each their
   own tone),
   `contrast:` (text-primary on `bg` and on `surface` ≥ 4.5:1, computed),
   `brand:` (the tenant's accent hex observed on the active nav item),
   `rhythm:` (see 6),
   `console errors: 0`, `verdict: pass`, newer than `app.css` and
   `Layout.tsx`.
9. **Docs**: `docs/branding.md` — the palette, the layers, how a page
   uses them, how to add a tenant.

## Backlog, in order

0. Baseline: run the validator.
1. Tokens + dark + tenants in `app.css`; shell hooks in `Layout.tsx`.
2. Pages: replace raw palette classes and hex literals with tokens
   (directory by directory, ratchet the budget).
3. Browser journeys, both tenants, both themes — one browser agent at a
   time (the orgiq audit sweeps share the browser).
4. Docs, final validator run.

## Rules that do not bend

- The validator is the judge; report real numbers from real runs.
- Never widen the hex budget. Never mark a journey pass to make it green.
- The library's composites are the only place colour lands; if a
  composite has no token hook, scope a CSS rule to a `data-*` marker on
  the shell — never restyle a page by hand.
