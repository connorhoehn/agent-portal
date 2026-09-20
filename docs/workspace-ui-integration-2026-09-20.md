# Assessment workspace UI integration — September 20, 2026

Open http://localhost:5183/assessment/workspace?doc=page%3A100002.

The earlier middleware checkpoints did not replace this frontend. This change adopts the existing document explorer layout from ui-components and its realtime-examples docking pattern on the assessment knowledge routes.

- Portal pins ui-components 2.330.0 at `3b0a7e57fcb91a107b1aeeaa6087b76523c75e55`, including the shared WorkspaceRail-backed ExplorerLayout and its fixed header slot.
- Search stays above the scrolling tree. An All documents view exposes the existing searchable/filterable library. Refresh belongs to the rail header.
- ViewportFillRegion gives the explorer a definite height. The document is a full-height reading surface with PageHeader, not a card nested inside the workspace.
- ContextColumn hosts Outline, Comments and Activity. The document owns its existing data and handlers; React portals dock the outline and durable comment thread into the shared column. The column can widen or collapse, and the navigation rail remembers collapse across reloads.
- Existing capability gates, synced read-only rules, save/version behavior and BFF persistence remain authoritative. Standalone document consumers retain drawers. No replacement realtime backend or fake sharing/review actions were added.
- CanaryPage uses ThinkingDots' current className contract after the dependency update.

## Validation

Portal: 923 tests pass, typecheck passes, production build passes, component-discipline validator passes. Production build still reports large chunks and the existing crypto browser-externalization warning from realtime-modules/proxy-client.

Playwright against the real Vite server and BFF, using a separate demo-assessor browser context:

- Opens the exact Rubric Overview URL.
- Searches for FAQ, selects it, opens the library and returns to Rubric Overview.
- Opens the docked comment composer and navigates through outline headings (focus moves to the rendered heading).
- Collapses the rail and confirms the preference survives reload.
- Opens comments at 1280px without horizontal overflow; the library stacks context below the document at this width.
- No page exceptions during these flows. Comment posting was not needed for this layout check; existing persistence tests remain unchanged.

The UI library update required a full Vite restart with dependency reoptimization. Hot reload alone retained stale modules and caused an invalid-hook error. Port 5183 is now running the updated frontend; middleware was not restarted.

This checkpoint covers the document workspace presentation. It does not claim that the team certification page has been redesigned, nor that the separate platform-api document backend or multi-gateway deployment is fully integrated.

## Broader repository checks

The complete 11-validator sweep is **not green**: five pass (agent eval, component discipline, honest numbers, nav parity, tenant removal). Six report outstanding evidence/coverage work:

- Assessment: 40 journey records have missing or different content digests.
- Branding: four theme journey records have stale content digests after the CSS change.
- Distillation: two overview journeys predate their page.
- Mock floor: handler/route/write snapshots are stale; the corresponding mock tests fail.
- OrgIQ audit: 24 journey logs fail required fields.
- Route coverage: 34 untested routes exceed the budget of 31, including three internal work-graph compute routes.

No journal was sealed without re-observation and no coverage budget was raised. These failures remain separate from the passing portal build, tests and direct workspace browser checks. Dashboard and Reports also opened without page exceptions after the library update. The workspace was additionally visually checked with dark theme after transitions settled.
