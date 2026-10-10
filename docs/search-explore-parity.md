# Search workspace vs. the old Explore page (4f478ef0^:portal/src/pages/ExplorePage.tsx)

Old line numbers are from `git show 4f478ef0^:portal/src/pages/ExplorePage.tsx`. Search lines are `portal/src/pages/search/SearchPage.tsx` (`PeopleConnections`).

| Old feature | Old line | In Search now? | Restore plan / status |
|---|---|---|---|
| Click person -> select, narrow to neighbours, view re-fits | `toggleSelect` ~430, filter ~330 | yes (worked; fit drifted) | `focusOrgPeople` + `OrgGraph focusIds`; the fit centres on the clicked person only (`fitFocusIds`) at the library's readable floor `ORG_FIT_MIN_ZOOM` (0.9) while exploring, 0.4 only for the whole-org overview — the 0.4 floor under every pick sank the view to 40% (DEFECTS #23, 2026-10-06). The all-types `RecordGraph` takes mouse clicks again from ui-components 2.418.0 (`0126b753`: its node button inherited xyflow's `pointer-events: none`). Judge: `portal/e2e/explore-graph-mouse.spec.ts` |
| Repeated clicks union the selection | ~430 | yes | `onToggleMultiSelect` |
| URL state `?selected=` `?detail=` | ~290 | partial -> restored | `selection` already; `detail` now in URL (single batched write, `setPeople(ids, detail)`) |
| `?focus=` / `?selected=` / `?entities=` / `?layout=` links | ~300 | yes | `searchMigration` (`searchModel.ts`); `entities=hierarchy|skills` now map to the People view |
| Layout Force / Radial | ~600 | yes | segmented control |
| GraphSearchBox person / skill | ~610 | yes | unchanged |
| Counts "N / M people", capped label, tooltip | ~700-730 | partial -> restored | `search-people-count` adds "(capped)" + title |
| Show full graph | ~735 | yes | "Show whole org" |
| Top-K and Min-strength sliders | ~740 | yes | unchanged; min-strength ignored under a lens like the old page |
| Presence filter menu | ~790 | missing -> restored | `DropdownMenu` + `OrgGraph presenceFilter` |
| Department chips + Rare skills + insight strip | ~840 | yes | unchanged |
| Connection path strip + pinned corridor | ~400, ~890 | partial -> restored | `pinnedPath` keeps the strip after "Show path" |
| Person detail card, focus neighbour, ask | ~930 | yes | `PersonDetailCard` |
| Hierarchy lens (mentors/reports_to) + empty state | ~340, ~1030 | missing -> restored | relationship lens control, `LENS_EDGES`, `search-lens-empty` |
| Skills lens (expert_in_common edges) | ~340 | partial | people-over-shared-expertise only |
| Skills / Projects entity graphs (`MultiEntityGraph`), status chips | ~880-960 | missing | library gap, queue row added; not hand-rolled |
| Embedded chat, session resume, auto-select people from answers | ~480-560 | partial | Search's own composer/answer; citations select records. Regex name auto-select not restored |
| Ask about selection / Open in Ask | ~640 | yes | "Ask about selection" |
| Error banner with retry, loading state | ~690 | yes | unchanged |
| Keyboard / screen reader: nodes are buttons with labels | library | yes | verified by the spec |

Counts: 22 features: 14 yes, 4 restored (partial), 3 restored (missing), 1 missing (library gap), plus 2 partial.
