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
| 4 | Call join window (open item 1) | two people joining one lobby at once end in one call | done locally: realtime-modules 0.140.0 (`v0.140.0`, both remotes), portal + middleware pinned; cloud proof pending a middleware image |
| 5 | realtime-modules ships canvas client + TipTap adapters as ESM (open item 2) | upstream release, portal pin moved, `vite build --sourcemap` has no `prosemirror-*/dist/index.cjs` | needs a decision (below); the portal plugin stays |
| 6 | Tiltfile media forwards (open item 4) | key path and SSH port come from Colima, not literals | done; the port had already moved (50697 → 58155) on this machine too |

Out of scope here (need AWS or a user decision): identity-read timing in the
deployed task, the authoritative-read cache option, allowlists/TURN, the
page-thread migration, teardown, test data cleanup.

## Findings

**Item 4.** The split is a gateway race, reproduced locally: two first joins
of a page huddle with their own minted ids both pass `handleLobbyJoin`'s
live-call check before either registers, so each registers a one-seat call
and neither seat is accepted, which is the deployed 403 on both legs. The
Data API latency the open-items doc suspects widens the window (the client
sends `join` only after `enter()`'s two platform-api round trips) but is not
the cause. realtime-modules 0.140.0 adds an atomic per-lobby claim; the loser
adopts the winner's id through the existing `active-call` path. The client is
unchanged: sending `join` before `enter()` would abort media whenever the id
is adopted mid-enter. The cache option in the open-items doc is no longer
needed for this symptom. Cloud proof: `cloud-call-smoke` with
`CLOUD_SEAT_SETTLE_MS=0` after the gateway image carries 0.140.0.

**Item 5.** Not a packaging switch. `useCanvasDocument` loads the optional
`@tiptap/y-tiptap` peer with a lazy synchronous `require` so `./client` works
without it. An ESM build must either import it statically (breaking `./client`
for consumers without the peer) or make `canvasToDocModel`/materialize async,
or move them to a new `./client/canvas` ESM subpath. That is an API decision
for the library owner; `editorStackAsEsm` in `portal/vite.config.ts` stays.
