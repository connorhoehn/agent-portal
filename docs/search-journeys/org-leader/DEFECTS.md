# Search workspace — org-leader (u-vera) defects, 2026-09-29 20:49 walk

All five surfaces were walked as Vera Green (org-leader) against dev:mock on ui-components 2.407.31, portal at 1bb6bf78 (the people view passes `pruneToFocus={false}` with `focusIds`). All five pass. 0 console errors and 0 HTTP responses ≥ 400 on every surface and every interaction. No call was placed.

## Open

None.

## Fixed at this walk

- **People view drew fewer people than its counter and the person card promise** (20:24 walk, item 1) — fixed by 1bb6bf78 / ui-components 2.407.31 (`OrgGraph pruneToFocus={false}`). Counter against drawn: Sarah Singh "11 / 56 people" draws 11 (was 8); Sarah + Nora Chang 17 of 17 (was 14); Sarah + Sienna Garcia 15 of 15 (was 10). The drawn set equals the page's own set (selection plus direct neighbours over every relationship) in all three. Every "Strongest connections" name on the card is drawn and inside the canvas: Sarah 8 of 8 (Layla Hassan now drawn), Sienna alone 8 of 8, Nora Chang alone 4 of 4. Top-K and Min strength now change lines only (Sarah stays at 11 drawn at 43 edges and at 0 edges).
- **The clip fix holds with the drawn set kept**: `selection=person:p-014,person:p-051` opened 24 times, six samples each from 1s to 12s: 0 of 24 clipped at settle, 0 of 144 samples, 90% every time and never moving, smallest selected inset 29px (Nora Chang; it was 40px on 14 drawn people and 7px before `focusIds`). The whole drawing needs 81%, so the selection-centred fallback applies; Fit to view shows 17 of 17 at 81%. Radial 105%, both whole.

## Observed, not defects

- Focused people views draw every unselected person at 0.30 opacity (selected at 1.00), so the ten people the counter and the card name are faint on the canvas (people-focus.png). No acceptance rule covers contrast; if it should read stronger, the dimming is OrgGraph's spotlight treatment (ui-components) driven by the page's `spotlightIds` (portal `SearchPage.tsx`). I did not check whether this predates 2.407.31.
- With no people selected (or only an initiative) the Start call row is absent rather than disabled. The call contract (docs/social-calls-plan.md step 6) offers it only with people selected or attached. With only the caller selected the button is present and disabled, and a disabled button is not focusable, so a keyboard user does not reach its reason.
- People focus view: three fresh loads of selection=person:p-014 settle at 95%, 91% and 94%, not one fixed zoom; every run keeps Sarah whole and all 11 drawn people inside.
- The mock corpus keeps growing: the answer card reads 83 records · 135 connections (77 · 129 at 20:05) and fits everything at 21–29% with no selection, which the Readability rule allows; Results reads 68 (59–62 at 20:02).
- The answer resize walk's first run stopped at its final step when the header query returned null once (a harness read during a re-render; no console error, no failed request). The re-run with a retry never saw the header absent and completed on both URLs.

## History

- 20:24 walk (2.407.29, 5475429b): people failed — with `focusIds` the library re-narrowed the drawn set (8 of 11, 14 of 17, 10 of 15); the two-person clip was fixed (0 of 24, inset 40px). Results, answer, connections and scoped passed.
- 19:56 walk (2.407.29, a93f2d0e): connections and people re-walked; connections item 1 (Force 62% expanded) fixed at 73%; people passed with 0 of 20 two-person clips, smallest inset 7px.

- 19:33 walk (2.407.28): connections failed on item 1 (Force 62% expanded; a placement search showed 73% feasible). The people view named Sarah Singh by name in the Start call title (a5e29328), closing the 19:06 walk's item 2.

- 19:06 walk (2.407.23): the header fixes held. Item 1 (Force 62% expanded) reopened. The people view named Sarah Singh "p-014" in the Start call title (fixed at the 19:33 walk). The only-yourself-selected reason and the 28px 12px/500 Start call type landed (845add3a).

- Confirmed at the 19:06 re-walk (2.407.23): the 08:22 header fixes hold — crumbs whole wherever the title still has room at DPR 1 and 2, the collapsed "Filters ▾" carries the triggers' 1px border, and the scoped 1280 end state is the documented last step of the squeeze.
- 18:29 walk (2.407.22): Start call added to the composer dock; its 34px row shortened the expanded canvas from 369px to 335px and exposed item 1; the title named unlinked people by id everywhere (item 2).
- Fixed by ui-components 2.407.19 (08:22 answer re-walk): (1) the crumbs no longer take a share of the shrink. Box against text width (Range), identical at DPR 1 and 2: long prompt "Search" 43.13/43.13 at 1672, 1536 and 1280 (it was 43.03 at 1672 and 42.81 at 1536, rendering "Sear…"); scoped long prompt "Search" 43.13/43.13 and "Auth Migration" 91.08/91.08 at 1672 and 1536 (it was 42.84 and 90.58, "Auth Migrati…"); results page default query "Search" 43.13/43.13 at 1280 (it was 42.97, the case results-header-1280.png recorded; that screenshot predates the fix). Scoped at 1280 the header runs the documented squeeze to its end — controls collapsed, title at its 192px floor, the middle crumb folded to "…", and only then "Auth Migration" truncated to 65.84 of 91.08 ("Auth Mi…", answer-long-title-scoped-1280.png); that is the contract's last resort, not the defect. (2) The collapsed "Filters ▾" toggle is 28px 13px/500 with a 1px solid --color-border border and a 6px radius, the same family as "Workspace ▾" / "+ Filter" / "Relevance ▾".
- Fixed by ui-components 2.407.15 plus the portal's `searchTitle()` change (08:04 walk): (a) the title is no longer capped at half the trail — "Who can help finish Auth Migration?" is whole at 1672 (302 of 302px) on results, answer and connections; (b) a long prompt's whole text is on the h1's `title` attribute (all 170 characters, at every width, scoped and unscoped); (c) the first sentence is no longer cut to 72 characters by the portal, the header truncates it with "…"; (d) the collapsed "Filters ▾" toggle is 28px at 13px/500 (it was 18px at 14px/400); (e) the early collapse is gone — the long-prompt page stays inline at 1672 and 1536 on a fresh load, and the scoped page's collapse at 1536 is now forced by the 192px title floor rather than taken with room to spare.
- Fixed by 2.407.10 (07:35 walk): the header controls are one family of 28px 13px/500 triggers on every surface: "Workspace ▾" / "In: Design System API ▾", "+ Filter" / "Type: Work ▾" / "Type: People ▾", and "Relevance ▾" / "Recent ▾". The crumbs are 13px/500 in secondary ink, the title is 18px/600 and the tabs are 14px/500. The In: menu's first item "Search entire workspace" and the footer link `search-scope-all` both clear the scope.
- Fixed in ui-components 2.407.6 (confirmed 07:35): the inline header's collapse is no longer one-way.
- Fixed in ui-components 2.407.4 (00:04 walk): the record graph's automatic fit shows the whole graph from 0.68, so Hierarchy and Radial open whole on the full canvas with nothing under the legend, the zoom group or Full screen. The inline header's chips no longer wrap; the Filters ▾ dialog is three one-line rows; ⋯ sits inside the row's padding.
- Fixed in ui-components 2.407.3 (23:45 walk): with the conversation expanded, Radial opens selection-centred at 80% (10.4px). The inline header yields its controls into "Filters ▾" at 1280px; the crumbs no longer collapse to 0px.
- Fixed in ui-components 2.407.1 (23:21 walk): the answer card's expanded Radial fits on 1098×270px. `FilterChip` forwards `aria-label`. The visible "Search entire workspace" link moved into the results footer.
- Fixed in ui-components 2.406.3 (22:42 walk): the graph card's sr-only mark labels stay inside the card, so the document stays 941px after an answer. A record graph with no selection opens fitted to everything.
- Decision 9 verified (22:16 walk): the header is one 48px band, and a bare composer message sets `q`, the title and the counts.
- Fixed in ui-components 2.404.1 (21:13 walk): on the shortened canvas, Fit to view shows every record in every layout, and the selection stays clear of the overlays.
- Fixed in ui-components 2.403.8 (20:53 walk): Fit to view no longer alternates, and the selection stays whole at every canvas size.
- Fixed in ui-components 2.403.6/2.403.7 (20:32 walk): the expanded strip no longer covers the canvas, and the legend and zoom controls are hit-testable.
- Fixed in ui-components 2.403.5 (19:54 walk): Force opens canvas-shaped with no record content under the overlays, the stray "*Sources: ," line is gone, and the people Radial layout fits all 56 at open.
- Fixed at the 19:22 walk: the record graph re-fits on resize, edge labels show only on the selection's edges, the strip prints no `s3://` URLs, and the org-graph zoom controls no longer sit on nodes.
