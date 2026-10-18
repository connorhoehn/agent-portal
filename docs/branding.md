# Branding and surface layers

The portal paints from tokens in `portal/src/app.css`. Pages never choose a
colour; they use a token's utility (`bg-surface-panel`, `text-brand`,
`border-border`) on a ui-components composite, and the composites read the
same tokens through `var(--color-…)`.

## The four surface layers

| token | utility | what sits on it | light | dark |
|---|---|---|---|---|
| `--color-bg` | `bg-bg` | the page ground under everything | `#eef1f6` | `#0b1220` |
| `--color-surface-panel` | `bg-surface-panel` | the nav rail, context rails, side panels | `#f4f6fa` | `#111a2e` |
| `--color-surface` | `bg-surface` | cards, tables, the header | `#ffffff` | `#172033` |
| `--color-surface-inset` | `bg-surface-inset` | a well inside a card: code, empty states | `#f8fafc` | `#0f172a` |

`--color-surface-hover` is the row-hover tone one step off `surface`. The
four layers are distinct on purpose: a card on the ground, a rail beside a
card and a well inside a card each read as their own plane. Before this
sheet the ground, the rail and every card were three near-whites within
`#f8fafc`–`#ffffff` and the whole screen compressed into one sheet.

## The brand family

Set per tenant on `[data-tenant]`; `--color-primary` aliases
`--color-brand` so every existing consumer follows it.

| token | utility | use |
|---|---|---|
| `--color-brand` | `bg-brand` / `text-brand` / `border-brand` | the accent: primary buttons, links, the active nav item's edge |
| `--color-brand-hover` | `bg-brand-hover` | pressed / hover accent |
| `--color-brand-ink` | `text-brand-ink` | a deep shade for the tenant mark and emphasis |
| `--color-brand-soft` | `bg-brand-soft` | tinted fill: selected rows, the active nav item |
| `--background-image-brand-gradient` | `bg-brand-gradient` | the header hairline and the tenant mark |

| tenant | brand | gradient |
|---|---|---|
| Org (`orgiq`) | indigo `#4f46e5` | indigo → violet → pink |
| Assessment (`assessment`) | teal `#0d9488` | teal → cyan → blue |

## Where the shell applies them

`components/shell/Layout.tsx` marks its regions and `app.css` paints them,
because the library's `SubNavLayout` and `ChannelHeader` take no colour
props:

- the nav host carries `data-shell-nav`; its `<aside>` paints
  `surface-panel`, and the active item is a `brand` left edge on a
  `brand-soft` fill;
- the header carries `className="shell-header"`: `surface` with a 3px
  `brand-gradient` hairline along its top;
- the content column paints `bg`; every `Card` lifts off it in `surface`.

A page's own context rail (a nested section rail such as Automate's) is a
`surface-panel` panel, so it reads as chrome beside the `surface` cards.

**Flush workspace pages.** A page that brings its own header and panes marks
its root `data-shell-flush`; `app.css` then drops the shell's 24px content
padding and hides the shell's breadcrumb row for it, because the page's
header prints the same trail (`useShellBreadcrumbItems`) as a
`ScopeHeader variant="crumbs"` band.

**The title rule (2026-10-01).** Every Org page has exactly one `h1`: the
20px/600 `PageHeader`/`PageSection` heading, its top 16px under the bottom
of the trail above it — the shell's trail on a padded page, the crumbs band
on a flush one. List and detail pages alike. The flush layouts carry the
spacing, not the pages: `BuildSectionLayout` (Automate, Local compute,
Bots, Changes) and `StackedCatalogLayout` (Designs, Agent library, their
records) start their body `UNDER_CRUMBS_BAND`
(`components/shell/headerRhythm.ts`), and the catalog overview's title is
the layout's own `PageSection`; Distillation, whose band also carries the
repository select, uses `UNDER_CRUMBS_BAND_WITH_CONTROLS`, and each of its
destinations draws its own `h1` (the module draws none, or Review and
Activity had two). Between 2026-09-28 (`9e4f5fe7`, the stacked Build
navigation) and this rule each flush layout picked its own gap, so the
titles landed 4–32px under the trail at three sizes.

Initiatives (All, My, Sprints and detail) use `InitiativeHeaderFrame` with
the same heading and spacing. The installed `ScopeHeader` only offers 22px
and 28px titles, so the frame composes its status, controls, people and tabs
from the library's primitives until the queued 20px option ships.

Workspaces whose header is a designed band, and so keep their own rhythm
(each consistent within itself; the journeys' `rhythm:` line judges the
pages above, not these):

- **Search** — one inline header row, the title as the trail's last segment
  (`docs/search-workspace-goal.md` decision 9).
- **Record headlines on `EditorShell`** — a distillation record, a review
  claim, a work item: the record's headline under its own crumb line
  (`docs/distillation-guide-record-spec.md`).
- **Canvases** — Architecture and Computer Lab carry a visually hidden `h1`;
  the diagram and the lab are their frame.

Mark a page flush only when it is a full workspace; a list or record page
keeps the shell's padding and title rhythm.

## Dark

`html[data-theme="dark"]` redefines every colour token `@theme` declares
(`scripts/validate-branding.sh` fails on a light-only token). The theme
attribute is set by `lib/preferences.ts` from the user's device pref.

## Adding a tenant

Add `[data-tenant="<id>"]` and `html[data-theme="dark"] [data-tenant="<id>"]`
blocks with the five brand tokens. Nothing else: the layers are shared.

## Rules

- No raw Tailwind palette classes (`bg-slate-500`, `bg-red-500`) in pages —
  the validator counts them.
- No hex literals in pages: chart series take `var(--color-…)`; the budget
  in `scripts/branding-hex-budget.txt` only goes down.

The Org light theme uses indigo `#4f46e5` for links and primary controls, slate `#5b6b82` for tertiary labels, and danger foreground `#b91c1c`. These retain at least 4.5:1 contrast on the soft surfaces exercised by the meeting audit; the decorative gradient keeps its lighter indigo.
