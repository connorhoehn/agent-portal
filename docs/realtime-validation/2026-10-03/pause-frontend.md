# Frontend pause checkpoint — 2026-10-03

Work stopped at the user's explicit request to restart the computer. All edits remain on disk; no commit or deployment. No owned browser tests are running.

## Accepted durable huddle checks

`portal/e2e/huddle-chat-real.spec.ts`: **7/7 passed in 57s** against portal `http://localhost:5261`, real BFF/WS `3061`, Redis `16479` and DynamoDB Local `18061` (`orgiq-chat-`). Authentication, membership, chat persistence, canonical pages and WS delivery were real. Only missing platform media metadata/receipts were inert; this does not validate WebRTC/SFU media.

Coverage: canonical work-item receipt/live peer/replay, unjoined/outsider403, persisted duplicate receipt409 conflict/forgery400, To Discussion/Huddle isolation, shared pin independence, held real persisted receipt with locked rich-editor draft/recipient change, panel next-draft preservation, and ended explicitly selected huddle retention. Test-owned signed cookies are reused within the worker to avoid the real15/min login throttle; `/me` actor is verified each case and owned contexts close on setup failure.

Root also accepted its **17/17** existing shell/page CDP regressions before the embedded Social lane. Earlier huddle model and fixture checks remain documented in the parent checkpoint.

## Embedded Social work now on disk

- New `portal/src/lib/embeddedSocial.ts` and `src/lib/__tests__/embeddedSocial.test.ts`: protected snapshot/DM clients; exact source actor/tenant/role/epoch/masquerade validation; public bearer-token/source comparison; per-DM rich drafts; immutable peer send waiting for actual join and persisted gateway acknowledgement; selection/authority/read generations; failed authority refresh disables writes but retains same-actor local state; bounded snapshot omission preserves at most the selected known DM/peer.
- New `portal/src/components/shell/EmbeddedSocial.tsx`: persistent provider, installed FloatingPanel/ConversationRail/NewConversationPanel/SocialConversation composition, quiet Social entry and unique online count. One eligible shell presence child announces `social:lobby`. Its controlled conversation hook remains mounted while the panel is closed. Token mismatch forces a fresh shared token and public reconnect with bounded retries.
- `portal/src/components/OptionalGatewayProvider.ts`: approved small TokenRenewer extension also consumes cached token while `connecting`; same-token setter remains a no-op. Installed `authToken` is the bearer; `sessionToken` is an opaque gateway session handle.
- `portal/src/components/shell/Layout.tsx`: provider/entry wiring, preserving one existing shell call/media owner.
- `portal/src/pages/social/SocialLayout.tsx`: removed its workspace presence announcement.
- `portal/src/pages/social/SocialConversation.tsx`: optional controlled draft/runtime/send/render seams; existing callers retain their behavior. Installed chat/presence hooks stay outside the floating wrapper; exact persisted acknowledgement still governs successful sends.
- `portal/src/pages/search/peopleMessage.tsx`: eligible shell opens embedded DM without entering Social or changing source route/tenant; existing standalone full-Social fallback remains. Existing linked-person availability mapping retained; late source identity completions are fenced.
- New `portal/e2e/fixtures/embedded-social.tsx` and `portal/e2e/embedded-social-panel.spec.ts`.

Public `useEmbeddedSocial()` context: `available`, `actorId`, validated `me/people/conversations`, `authorityVerified`, `canMessagePeople`, `canSend`, `unavailableReason`, `selected`, `onlineCount`, `state/controller`, `openMessage()`, `openDm(userId):Promise<boolean>`, `sendToPerson(userId,text):Promise<boolean>`. Availability is permission/connection-level and does not require an already joined selected DM. Panel and page composer drafts are independent.

Root owns and has separately changed `InitiativeComposer.tsx`: explicit `person:<userId>` recipients call this seam; DM text has no page context chip, while Agent/Huddle/Discussion retain context. Do not overwrite that file.

## Completed embedded validation

- Portal typecheck passed after initial provider/SocialConversation/Search integration; the final bounded-omission model patch has not had a fresh typecheck.
- **16 embedded model/client/token contracts +6 existing Social acknowledgement contracts passed (22 total)**. The additional bounded-omission contract was then added but has not been executed; current file contains17 embedded contracts.
- **5/5 inert browser contracts passed in5.4s**: close/reopen/navigation preserves one DM join and local draft, presence deduplicates online actor IDs, read outage/recovery, changed epoch clears private state and refreshes bearer without tenant navigation, and exact external peer delivery leaves panel draft independent. These explicitly stub HTTP and gateway/media; they are not real BFF/WS acceptance.
- The initial presence assertion counted two legitimate cumulative installed `presence/set` updates (workspace then DM) as duplicate joins. Corrected assertion verifies one workspace subscription and one initial workspace-only announcement; all five passed.

## Pending on resume

1. **Do not silently apply the proposed presence-reader extension.** Root was informed but approval was still pending when pause arrived. `SocialChatWorkspace.tsx` and `ContactsPage.tsx` each still call `usePresence(SOCIAL_PRESENCE_CHANNEL)` as readers. Their cleanup can unsubscribe the persistent shell roster because installed subscriptions are not reference-counted. Proposed fix: expose shared shell presence people/online IDs from the embedding context, have these two consumers read that context, remove their duplicate lobby hooks, and update stale presence comments. No extension edits were made during pause.
2. Run the additional bounded-omission model test and current portal typecheck; add provider regression proving no duplicate workspace unsubscribe when leaving full Social routes after the approved reader fix.
3. Wait for root's **upstream asynchronous current-recipient Social grant guard candidate pin + BFF restart/freeze** before real embedded browser acceptance. Backend REST is on disk and its six suites64 tests/typecheck passed per backend agent. Latest additive GET snapshot fields are consistently `peopleTotal`, `peopleHasMore`, `conversationsHasMore`; bounded roster/history omission is not revocation. No pagination UI is claimed.
4. Add actual browser tests for To-person persisted/live/replay delivery from source OrgIQ, unchanged source tenant/URL, separate work Discussion/huddle/shared pin, pending target switch and panel draft independence; Search Message during an active huddle must keep one call/media owner and source navigation. None of these real embedded cases has been written or run yet.
5. Rerun relevant persistent call/page/huddle regressions after this production embedding lane. Token renewal currently has model source/epoch/act checks and inert browser epoch evidence; actual same-actor fresh bearer with persistent call/media remains to verify.
6. Keep DM page attachments as a visible remaining gap until a canonical server validation seam exists. Do not add arbitrary metadata or generic huddle publish. Live media, multi-replica/distributed acceptance, cloud deployment remain outside completed checks.

## Runtime restart details

Previously used Chrome CDP `http://127.0.0.1:19361`, portal `5261`, BFF/WS `3061`, Redis `16479`, Dynamo Local `18061`. The computer restart will stop or invalidate these processes; root should inspect/restart the dedicated stack before running tests. Avoid owner ports and application fixture resets. Approved command prefixes for the real huddle and embedded fixture CDP runs are already saved.

The user's pause applies to all feature/test work until explicitly resumed.
