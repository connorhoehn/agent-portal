# Reboot resume acceptance — 2026-10-03

The canonical DM attachment follow-up is accepted on 2026-10-04; see [its record](../2026-10-04/dm-page-reference-acceptance.md). The counts and load evidence below remain historical for the October 3 source.

Work resumed on the user's “keep going” instruction. This record supersedes the active tasks in the [pause checkpoint](session-pause-checkpoint.md); that file remains historical. Local acceptance now covers embedded Social, explicit To-person delivery, current-authority channel/call checks, and usable default collaboration-panel placement. The full integration remains in progress, approximately 60% by engineering estimate.

## Implemented behavior

- The embedded Social snapshot preserves the source tenant/role and resolves eligible people and existing canonical DMs. Sending to a person uses the protected DM receipt, then waits for the stored WebSocket acknowledgement and matching message. It does not write the item's Discussion or change the source page, call, or acknowledged shared page.
- The shell owns Social workspace presence. Contacts and the full chat workspace reuse that roster; navigating between them no longer unsubscribes the shell. Online people are deduplicated across tabs and filtered through the eligible directory.
- A cold DM's first send survives the transition from joining to ready. Delayed receipts cannot clear a draft after its destination or draft generation changes. Unknown receipts retain the draft and advise checking history before retrying.
- Embedded chat-only conversations do not acquire pins state. Direct messages remain text-only until the canonical page-reference contract below is implemented.
- Default Social and huddle panels use the measured collaboration-footer height. At 1440×900 and 1280×720, the real Social panel clears the call dock by at least 12 pixels. Leave works directly while Social remains open; the conversation stays open after leaving. Full responsive and visual acceptance remains outstanding.
- Channel operations and recipient fan-out await current directory, source-role/epoch, masquerade-actor, policy, and membership checks. Calls use current-principal preflight, including call-ID-only actions. Supplying another lobby cannot bypass the stored call's authority.
- Social and document call registration, restoration, invalidation, and removal avoid the OrgIQ-only huddle reconciler. Late removal after terminal cleanup is a benign no-op. Namespace admission still denies these calls access to OrgIQ huddle chat.

## Exact upstream dependency

Both `portal` and `middleware` package manifests and locks install realtime-modules **0.100.3**, full SHA **`5aa384065b2b53e8e662c88a8a2fe1d87ed847a7`**. The reviewed change is published only on [`fix/async-channel-delivery`](https://github.com/connorhoehn/realtime-modules/commit/5aa384065b2b53e8e662c88a8a2fe1d87ed847a7). The sibling main was not merged or released. Consumers were installed normally; installed package files were not patched.

The source preserves both final Presence authorization fences, one before and one after constructing the snapshot. Those checks guard different delayed-read windows. The complete upstream suite passes **170 suites / 1,978 tests**, with **2 suites / 14 tests skipped**. Typecheck, build, the 31 public-export contracts, and focused delayed-delivery regressions pass. Prepared Docker libraries include the same full SHA.

## Final local verification

| Check | Result | Scope and limits |
| --- | --- | --- |
| Portal tests | **1,310 passed**, zero skipped | Full existing portal suite; typecheck and production build also pass. The build retains its chunk-size warning. |
| Backend acceptance | **16 suites / 184 tests passed**, 2 skipped | Final production source: current-principal HTTP/WS gates, tenant/DM isolation, call chat/pages, Redis Lua and actual Redis/Dynamo chat checks. The opt-in storage restart is skipped in this run; its prior passed evidence remains in the pause checkpoint. |
| Real browser contracts | **12 passed** | Embedded Social 3, huddle chat 7, shared page 2. Real BFF, cookies/JWTs, canonical DM route, raw WebSocket and durable stores. Unavailable media-session receipts are substituted. |
| Fixture browser contracts | **26 passed** | Embedded Social 6, huddle panel 5, persistent shell 15. Final fixtures use the same footer structure as the application. |
| Load-driver contracts | **13 passed** | Includes strict manifest rejection and preserving actual source role/epoch/tenants through token renewal. |
| Component discipline, navigation parity, route coverage | **Passed** | 615 routes, 1 without a matching request test, existing budget 1. No budgets were raised. |
| Quick mock-floor judge | **Passed** | Middleware typecheck, floor suites and ratchets, live router table, fresh GET/write source digests. |

The browser total is **38 distinct relevant contracts**, not 38 real-media checks. A broad middleware run earlier in the session had 383 passed suites, 4 failed suites and 3 skipped; its 9 failed tests used stale invented role fixtures or the CJS-incompatible role registry. Those fixtures were corrected and all four affected suites pass in the final targeted run. The complete broad suite was not rerun afterward, so this record does not claim a single fully green broad middleware run.

The final wire capture was taken from a fresh isolated BFF on port 3062. It enumerates **615 routes**, represents **332 GET routes** (266 responses captured; explicit reasons retained for the rest), and **283 write routes**. GET and write snapshots both record handler SHA **`e4ecb40115783d043e8dedb9de961d5396e8e2a26814c5c838e0885aa8d342be`**, which the final mock-floor judge matches to disk.

Relevant browser commands, from `portal`, used `CDP_ENDPOINT=http://127.0.0.1:19361`, `PARITY_BASE_URL=http://localhost:5261`, `--project=chromium --workers=1`:

```sh
node node_modules/@playwright/test/cli.js test e2e/embedded-social-real.spec.ts e2e/huddle-chat-real.spec.ts e2e/huddle-page-sharing.spec.ts --project=chromium --workers=1
node node_modules/@playwright/test/cli.js test e2e/huddle-chat-panel.spec.ts e2e/persistent-call-shell.spec.ts e2e/embedded-social-panel.spec.ts --project=chromium --workers=1
```

Backend acceptance used `CALL_CHAT_TEST_DYNAMODB_ENDPOINT=http://127.0.0.1:18061`, `CALL_CHAT_TEST_REDIS_URL=redis://127.0.0.1:16479` and `AWS_EC2_METADATA_DISABLED=true`, with Jest `--runInBand` matching realtime-gateway, live-principal, call-chat and call-pages suites. The load driver uses `node --test scripts/loadtest/realtime-calls.test.mjs`.

## Current-authority container evidence

The driver now accepts [directory identities](current-authority-identities.json) with exact source roles, session epochs and tenant grants. These are the 12 existing mock-directory actors apart from the operator. No authorization bypass or synthetic directory provisioning was added. The normalized identity SHA is **`64255c59e04049a4e602bb95da5838e9f42ad49f0d1c57e57d9a9ccc012bfa96`**. This exercises current-authority checks against the mock directory/policy, not Aurora throughput.

The isolated Tilt gateway has a **0.5 CPU / 768 MiB** limit, Redis-backed call/page state, memory generic chat, mocked non-realtime providers and no SFU. Owner containers, ports and volumes were preserved.

| Retained evidence | Result |
| --- | --- |
| [150-second restart run](current-authority-restart-accepted.json) | 12 sockets, 4 two-person calls; two token renewals and one gateway restart recover 12/12 sockets, 8/8 original call statuses/participant routes, and 4/4 background chat/presence clients. Restart recovery 5 seconds; 121.2 MiB peak working set; health p99 4.8 ms; 140/140 observed chat deliveries. All predefined signaling thresholds pass. |
| [Final 60-second cleanup run](current-authority-cleanup.json) | Final terminal-cleanup source; 12 sockets, 4 calls, two complete token renewals; 65/65 observed chat deliveries; 115.7 MiB peak working set; health p99 7.7 ms. All thresholds pass. The [captured gateway log](current-authority-cleanup-gateway.log) contains zero feature-reconciliation/Call-not-found errors through hang-up and subsequent idle samples. |

The restart run precedes the final benign terminal-removal refinement and logged four cleanup `Call not found` warnings. The final short run verifies their absence but does not repeat a gateway restart. Earlier [baseline](current-authority-restart-baseline.json) and [registration-only](current-authority-restart-registration-only.json) results remain available; their protocol thresholds passed while server logs exposed the lifecycle scope/cleanup defects subsequently fixed. The final gateway log still includes unrelated mock devbox-reaper warnings; zero reconciliation errors is not a claim of zero warnings everywhere.

The earlier [1,000-socket / 100-call result](orgiq-restart-1000.json) predates current directory/policy recipient checks. It remains historical single-gateway signaling evidence and is not current-authority, Aurora, media, durable-chat capacity or distributed-routing acceptance. No larger current-authority run is claimed.

## Remaining implementation and acceptance

1. **Canonical DM page references.** Generic chat metadata is client-provided; forwarding a resolved title/link would create an untrusted reference and could expose OrgIQ details to Social-only recipients. The next seam must store an allowlisted kind/ID, validate sender access at submission, and resolve display metadata under each reader's current OrgIQ access. Deleted/inaccessible resources need an unavailable state after live delivery and reload. Preserve captured recipient/reference and acknowledgement behavior; do not silently attach the huddle's shared page. The installed `ChatPanel.renderMessageReferences` is the renderer seam.
2. **Persisted work/document context relations.** Add an authorized canonical relation and resolver across schema/provider/API before displaying an architecture document link. Existing decision and PR relations remain usable.
3. **Actual SFU/media.** Build an isolated profile; verify audio/video, device denial, autoplay recovery, shell navigation, and one continuous playback/runtime. Existing owner SFU pods were unhealthy on read-only inspection and were not changed. Inert browser receipts prove no media behavior.
4. **Provisioned current-directory scale and tenant cloud acceptance.** Repeat load/soak against actual directory/policy and durable stores; synth/local API evidence does not establish a deployed tenant. No AWS deployment was performed.
5. **Distributed routing and invalidation.** Preserve the single-gateway safeguard until shared user/connection routing, direct/channel delivery, cross-node call departure and membership invalidation are implemented. Direct ring recipients and notification replay still lack the same per-recipient current-authority recheck as channel fan-out.
6. **Final layout and journey walks.** Complete the focused Work rail, typography/insets and responsive footer/panel behavior; user-dragged floating panels can still overlap controls. Rewalk affected role/surface journeys after functional completion.

Generic DM sends still lack idempotency, so a lost acknowledgement can follow a persisted send; never automatically resend. There is no cross-store rollback or external membership invalidation claim. The shared huddle page continues to change only through explicit sharing.

## Workspace and runtime

The application remains available at **http://localhost:5261**, with BFF 3061, headless Chrome CDP 19361 and isolated Tilt UI 10361. Durable chat stores use loopback Redis 16479 and DynamoDB Local 18061. The capture BFF uses 3062; the container gateway/Redis use 13061/16379. Restart from the configurations in the [pause checkpoint](session-pause-checkpoint.md) and [load-test README](../../../scripts/loadtest/README.md), checking current process ownership first; session IDs and PIDs are not reboot-safe.

The root workspace remains on `main` at `86925d4d41b3957c747228d28eda5fba3c8f40f2` with its accumulated unrelated changes intact. No broad root commit, sibling-main merge, release or cloud deployment was performed. Evidence completed after midnight UTC still falls on 2026-10-03 in the workspace's America/New_York timezone.
