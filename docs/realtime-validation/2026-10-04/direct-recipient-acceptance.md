# Current direct-recipient acceptance — 2026-10-04

Call signalling and notification delivery now recheck each receiving connection against current authority. This extends the [work/document slice](work-document-association-acceptance.md) and [DM page-reference slice](dm-page-reference-acceptance.md). The full integration remains in progress at approximately **75%**, an engineering estimate rather than a test-derived percentage.

## Behavior and authority

- Direct call frames require a current source role, exact directory epoch, current tenant grants, valid masquerade actor, resource access and Social membership. Social recipients require current `ViewSocial`; originating call actions retain their existing `StartCall` and ownership requirements. Directory or policy outages suppress delivery.
- CallId-only actions retain the resolved lobby in their outgoing envelope, including terminal actions that delete call state before sending. The recipient can authorize the resource after teardown. Unscoped call data refuses. A `forgotten` acknowledgement contains only the requesting user's receipt and still requires a current principal.
- Live notification delivery, explicit history and reconnect replay filter each stored item by current tenant grants, resource/channel scope, current `ViewSocial` where applicable, and current `ApproveTransaction` for OrgIQ approvals. Social membership proofs remain held across the entire batch; current identity and retained roles are checked again before delivery. Filtering copies a batch and leaves stored inbox rows intact, so regained access can recover them.
- Notification links must stay within their payload tenant after URL normalization. Conflicting channel fields, cross-tenant links, encoded parent traversal, backslashes and control characters refuse. Missed-call notifications use the captured call lobby; older OrgIQ initiative origins remain supported.
- Inbound history and read-state actions require a current source connection before store work. Client-provided user IDs cannot redirect inbox mutations. `notifyUser().delivered` counts successful connection writes and excludes suppressed recipients.
- The library's public `ClientMessageFilter` covers direct/local sends, broadcast and channel fanout. Async results are discarded after disconnect, auth-context or handle replacement. Channel subscription generations remain fenced through the awaited filter, including unsubscribe/resubscribe. Throws and rejections suppress delivery; a slow recipient does not block a permitted peer's broadcast delivery.
- Unrelated service frames retain their existing synchronous send boundary and service authority checks. Custom routers must supply equivalent transport filtering themselves.

## Exact dependency and artifact

Both consumers normally install realtime-modules **0.101.0** at [`6fcb05171634767653b8a75be3a66ab442d12838`](https://github.com/connorhoehn/realtime-modules/commit/6fcb05171634767653b8a75be3a66ab442d12838), pushed on `fix/current-direct-recipients`. The owning sibling main remains clean at `94bf705e9a4be312d1b54aac83b374b227a2ca4e`; no main merge or registry release occurred. The portal UI pin remains **2.408.0 / `69d0283d1e6e0cf6d9a3684eaa78dcbf465b3901`**, with its owning main also clean and untouched.

The production gateway image is **`sha256:46eafb4672e87121ecb76f10bbef89c4ed26935c80dac92eaf10c9955299db9e`**. Its compiled host filter, normalized-link guard, installed realtime version, channel-generation fence and call envelope were inspected in an ephemeral container with networking disabled. This rebuilt validation image was not substituted into the existing soak container, which retains image `sha256:b91932ad4a0ef45ba477cc2e506ef142b3db3ea028340e86dbf1b60ebec44f87`.

## Verification on the final source and pin

| Check | Result | Evidence |
| --- | --- | --- |
| Owning realtime library | 171 suites / 1,991 tests passed; 2 suites / 14 tests skipped; typecheck, public contract and 31 export build checks passed | [Suite](direct-recipient-upstream-full.log), [types](direct-recipient-upstream-typecheck.log), [contract](direct-recipient-upstream-contract.log), [build](direct-recipient-upstream-build.log) |
| Backend | 24 suites / 364 tests passed, 2 skipped; typecheck passed | [Suite](direct-recipient-backend.log), [types](direct-recipient-backend-typecheck.log) |
| Portal | 1,318 tests passed; typecheck and production build passed | [Tests](direct-recipient-portal-tests.log), [types](direct-recipient-portal-typecheck.log), [build](direct-recipient-portal-build.log) |
| Browser | 17 real-BFF checks passed against the final pin | [Run](direct-recipient-browser.log) |
| API snapshot/floor | Fresh 621-route capture; all quick judge checks passed | [Capture](direct-recipient-wire.log), [judge](direct-recipient-floor.log) |
| Architecture | Component discipline, navigation parity and route coverage passed, budgets unchanged | [Components](direct-recipient-components.log), [navigation](direct-recipient-nav.log), [routes](direct-recipient-route-coverage.log) |
| Production image | Locked-library build and compiled artifact checks passed | [Build](direct-recipient-gateway-build.log), [artifact](direct-recipient-gateway-artifact.json), [locked libraries](direct-recipient-libraries.json) |

The backend run includes real WebSocket checks for revoked recipient grants, epochs, source roles and directory outages; filtered reconnect/history with later regrant; denied old-source read mutations; different current-source connections for the same user; successful-write counts; and a terminal callId-only envelope after deletion. Pure contracts additionally cover policy/actor/membership denial, delayed batch fences, unsafe links, unrelated synchronous services and forgotten receipts. Existing real Redis Lua and DynamoDB Local durable-chat contracts remain included. The two backend skips are the opt-in storage-restart test and legacy Social test requiring unprefixed tables.

The current browser run comprises five embedded Social, seven huddle-chat, two shared-page and three work/document checks. The prior phase's 26 component fixtures were not rerun for this backend/dependency slice and are not added to this total. Browser media-session receipts remain substituted; these tests do not establish actual WebRTC acceptance.

The capture enumerates **336 GET routes** (268 responses captured) and **285 writes** (109 responses captured), with explicit reasons for uncaptured operations. Both response snapshots identify final handler SHA **`9ffe4b1532b233b648a522eaaf7c3f0f28c6528953fd582f4d2f2161fe0ed91c`**. The [manifest](direct-recipient-manifest.json) records final source and evidence hashes, dependency pins, image identity and package metadata. Prior manifests retain their historical source hashes and pins.

## Remaining full scope

Apply and verify the additive work/document relation migration on Aurora; verify actual SFU/audio/video; measure the provisioned current-authority directory/Aurora path; complete tenant cloud acceptance; implement distributed gateway routing; and finish the Work rail/layout and role journey walks. Per-delivery authority adds policy/directory cost, so the earlier synthetic capacity results do not measure this final implementation. Preserve the single-gateway safeguard. No cloud deployment, root commit, running-image capacity acceptance or media acceptance occurred in this slice.

The local application remains available at **http://localhost:5261**, with BFF 3061 and isolated capture BFF 3062. Owner ports 3001/5183 and unrelated uncommitted work were preserved.
