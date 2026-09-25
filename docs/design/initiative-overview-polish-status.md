# Initiatives Overview pixel-match — status (2026-09-25)

Target `initiative-overview-v2-mockup.png`; build `initiative-v2-build-overview.png`
(headless Chromium 1642×958, dev:mock after reset, u-theo, ui-components 2.398.0).
Both PNGs are 1642×958, so every number below is a direct row-scan of the two
images (same y axis), not a scaled estimate. "Before" is the previous build
shot (2.393.1); "after" is the committed one.

| Gap | Status | Before → after | How |
|---|---|---|---|
| Selected-tab bar | closed | 1px indigo (a 2px underline half painted over by the pane body) → 3px `rgb(99,102,241)` bar at y 290–293, fully drawn; mockup 3px at 284–288 | Library: `ScopeHeader tabSize="md"` now passes `Tabs indicator="bar" indicatorWeight={3}` (2.396.0). No page change needed beyond dropping the host rule below. |
| Inset tab rule | closed | full-bleed rule from the pane edge (x 464) → rule starts at the content edge (x 488, gutter clean); mockup x 487 | `tabsRule="inset"` on the ScopeHeader and the host `className="border-b border-border"` removed (`ProjectDetailPage.tsx`). |
| Blocked tag | closed | 13px red text, 1px `rgb(248,113,113)` border on a near-white fill → 14px `rgb(220,38,38)` text on a `rgb(254,242,242)` fill, same border, 6px corners, 30px tall (mockup ~14px pale-red tag) | `<Chip tone="danger" size="lg" outline="soft">` (`InitiativeOverview.tsx`). |
| Count pill | closed | grey neutral chip → pale indigo `rgb(238,240,255)` pill with `rgb(79,85,255)` 13px numerals | `PageSection countTone="primary"` on "Needs attention". |
| Tabs → stats | closed | tab-label bottom → stats top 35px (mockup 42) → 44px | Came with the 2.396.0 tab height (tabs 10px taller below the label); the page's `pt-5` stays. 2px looser than the mockup; the whole block below the tabs sits 3–4px lower than the mockup because the tab row itself is 3px lower (library type metrics), so no page offset was added. |
| Attention row → Up next | closed | 30px (mockup 38, measured row-bottom → "Up next" cap top) → 38px | `className="mt-2"` on the "Up next" PageSection over the stack's `xl` (24px) gap — the library story's `mt-8` against `mt-6`. Also "View all 11" now carries the story's 20px arrow with an 8px gap (was 16px / 4px). |
| Rail group offset | **open — library** | "IN PROGRESS" caps top y 290 vs mockup 302 (12px high); nav "Sprints" text bottom → group caps top 34px vs mockup 41px | Not page-level. `ExplorerLayout` wraps the `railHeader` slot in `shrink-0 py-3 px-5 pt-0` (12px under the nav list) and `GroupedList groupHeading="label"` gives the group toggle `py-2` (8px above its 11px caps); the mockup wants ~20–22px between the nav list and the group row. The library's own "Initiative overview v2" story composes the rail exactly as the portal does, so the story has the same gap. Fix belongs in ui-components (either `pb-5`/`pb-6` on that wrapper or a top inset on the label heading); queued rather than hacked with a page class so the story and the portal stay one composition. |

Also observed, not chased (library, outside the five gaps): the tinted
attention row is 48px tall against the mockup's ~52; rail rows are 36px at
2.398.0 against the mockup's ~40–42 pitch and its 15px nav text is ~7% larger
than our 13px (the 2.398.0 "one step smaller" scale is a deliberate choice).

Verification: 0 console errors, no horizontal scroll (1642 = 1642), portal
tsc/tests/vite build green; validate-orgiq-audit (sealed after re-walking the
five `initiative-detail` logs), validate-branding, validate-component-discipline,
validate-nav-parity and validate-honest-numbers all pass.
