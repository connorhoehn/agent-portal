# Backend pause checkpoint

Paused at the user's request before computer restart. All edits are saved. No server was restarted, no cloud deployment was made, and this lane has no running tests.

## Completed protected huddle work

- `middleware/src/lib/call-access.ts`, `call-chat-state.ts`, `call-chat.ts`, `middleware/src/routes/call-chat.ts`, their tests, and call-page lifecycle/gateway/index integration implement participant-authorized huddle history/send, immutable delivery acknowledgements, canonical page references, membership history floors, and generic REST/WS namespace denial.
- Public routes are GET `/api/calls/:callId/chat` and POST `/api/calls/:callId/chat/messages`. Public channel remains `orgiq:huddle:<callId>`; private durable partitions include an atomic Redis/memory incarnation, preventing expired/reused call IDs from replaying old Dynamo messages.
- Monotonic ordered immutable IDs, explicit new-admission floor reset, repeat live registration/reconnect floor preservation, and stale asynchronous reconciliation regressions are covered. Page sharing behavior and installed public call recovery methods remain intact.
- Earlier focused huddle/page/gateway/store suites passed (10 suites, 124 tests); final huddle handler suite passed (19 tests); middleware typecheck passed. Library agent's genuine Redis16479/Dynamo18061 acceptance passed all four durable tests after the final floor/incarnation fixes, including 120 exact deliveries/newest50 and expiry privacy. Root's genuine owned-container restart acceptance also passed.

## New authoritative principal and embedded Social work

- New `middleware/src/lib/live-principal.ts` and tests refresh current directory grants, exact source role/tenant, effective-user epoch, and masquerade actor epoch/current admin authority. No settled positive cache; only simultaneous authoritative user lookups coalesce. Directory/policy outages fail closed. Local narrowed demo personas retain their narrowing and never gain Social/Pipelines.
- Pure async `authorizeLiveGatewayChannel` enforces actual Social ViewSocial/PostMessage plus current membership and existing resource guards. Pure async `authorizeLiveGatewayCall` enforces fresh source authority, StartCall for Social lobbies, public call-lobby lookup, membership, and invite caller identity. Neither is wired into the installed gateway yet.
- `middleware/src/lib/social-chat.ts` adds bounded in-flight membership mutation observers and rejects delayed hydrate snapshots crossed by a newer completed local mutation. It does not claim external/multi-node invalidation.
- `middleware/src/providers/identity.ts` adds authoritative `listUsers` reads without production seed fallback; existing ordinary fallback remains.
- `middleware/src/routes/social.ts` adds GET `/api/social/embedded`, upgrades embedded DM-open authority, and exposes source-scoped DM-read. Source session is preserved, response is no-store, canonical source/actor epochs plus authorityKey fence frontend state, and previews retain pending membership proofs through final authority reads.
- Existing route helper behavior is reused; test fixtures now model actual declared directory grants rather than accepting stronger cookie roles.

## Latest roster/read-proof changes are complete and validated

- Additive embedded fields are `peopleTotal`, `peopleHasMore`, and `conversationsHasMore`. People remains bounded at500; returned current Social-granted DM peers receive priority before alphabetical fill. Incomplete snapshots are not revocation proof.
- Frontend agent acknowledged the exact additive contract and will preserve a selected known canonical DM/peer when bounded omissions occur. No pagination UI is claimed.
- DM-read retains its membership proof across final current-source lookup and refuses receipt advancement after a crossed local removal. GET filters removed DM previews at final response.
- New tests cover an alphabetical-outside-cap legitimate peer, explicit truncation metadata, DM preview removal during final identity lookup, and no receipt write after removal during final identity lookup.
- Latest run: five suites /63 tests passed (`social-embedded`, `social-bindings`, `social-channels`, `live-principal`, `social-membership-fence`). Middleware `npm run typecheck` passed afterward. No roster/read-proof edits remain unfinished.

## Resume next

1. Wait for root/library to finish, pin, and install the isolated realtime-modules0.100.3 candidate. Installed baseline was0.100.2 at pause. A boolean-only ChannelAuthorize coerces Promise truthiness and MUST NOT receive the async host function.
2. Once candidate passes/installs, wire new async channel authority and async CallConfig.authorize in `middleware/src/lib/realtime-gateway.ts`. Remove the captured-context synchronous calls lobbyGuard wrapper and perform fresh lobby/resource checks inside the async call preflight. Record invites only after authorization succeeds.
3. Update gateway test identities to coherent current directory/source-role fixtures; run actual HTTP/WS read/write/recipient revocation, denied calls, huddle/page regression, and typecheck. Root owns process restarts, package pins, Docker/Tilt, and validation docs.
4. Library candidate adds awaited fail-closed async ChannelAuthorize/CallConfig.authorize, per-recipient channel fanout authorization, direct chat/presence response fences, durable-first generic send, and strong Dynamo base-table membership get/list reads. Coordinate exact installed contracts before host edits.
5. Preserve explicit limitations: direct call recipient/ring routing and notification replay do not yet reauthorize each recipient; stale source presence cleanup is ordinary disconnect/TTL; external team/channel membership invalidation and multi-node fanout remain separate. Existing synthetic1000-socket result is not current-directory-policy capacity evidence. New load acceptance must measure authoritative lookup/query cost.

Other agents: root owns orchestration/pins/composer integration; `persistent_call_feature` owns embedded frontend; `mockup_library_plan` owns isolated upstream candidate and real-store tests. All agents share the large uncommitted workspace; do not reset or overwrite unrelated edits.
