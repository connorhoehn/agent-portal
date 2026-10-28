# Local follow-ups to the AWS deploy (2026-10-27)

The items from `docs/aws-deploy-open-items-2026-10-27.md` and
`docs/deployment-enhancements-2026-10-27.md` that can be finished and proven
without AWS access, in order. Cloud proof (the `cloud-*-smoke` specs, timing
inside the deployed task) runs later from the machine holding credentials.

| # | Item | Done when | State |
|---|------|-----------|-------|
| 1 | DE-44: `/internal/devbox/sessions` checks `projectId` | a box is charged to an initiative only when the signed principal owns or contributes to it (or holds an org-wide role); unit tests cover allow, deny and lookup failure | done |
| 2 | DE-51: lab callbacks fail closed | with no `LAB_CALLBACK_SECRET` outside dev, callbacks refuse; tests cover both postures | already true: `requireServiceAuth` 503s in production with no secret (`service-auth-guard.test.ts`); `LAB_API_BASE` waits on DE-52 |
| 3 | Stale records | CLAUDE.md and the 10-26 handoff no longer say nothing is deployed or the schemas are unapplied | done |
| 4 | Call join window, client side (open item 1) | Join waits for the lobby's first occupancy answer before choosing `start()` over `rejoin()`; unit test proves a second joiner inside the window rejoins | open |
| 5 | realtime-modules ships canvas client + TipTap adapters as ESM (open item 2) | upstream release, portal pin moved, `vite build --sourcemap` has no `prosemirror-*/dist/index.cjs` | open |
| 6 | Tiltfile media forwards (open item 4) | key path and SSH port come from Colima, not literals | open |

Out of scope here (need AWS or a user decision): identity-read timing in the
deployed task, the authoritative-read cache option, allowlists/TURN, the
page-thread migration, teardown, test data cleanup.
