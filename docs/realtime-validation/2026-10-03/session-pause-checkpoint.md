# Session pause for computer restart

**Historical checkpoint:** the user resumed work with “keep going.” The [resume acceptance record](session-resume-acceptance.md) supersedes the active tasks, dependency pins, test counts and runtime status below. Preserve this file as the pre-reboot record; its pause instruction is no longer active.

The user explicitly paused work on 2026-10-03 to restart the computer. Do not resume feature work until the user asks. Completion estimate remains **55%** for the full frontend-to-backend integration; this is an engineering estimate, not a measured percentage.

## Workspace and authorization

- Workspace: `/Users/connorhoehn/Projects/aws-agentcore`, branch `main`, HEAD `86925d4d41b3957c747228d28eda5fba3c8f40f2`.
- 534 changed paths were present at checkpoint time. Preserve existing edits; do not reset, clean, stash everything, or create a broad commit.
- The user authorized feature implementation with subagents, on-disk realtime integration, local Tilt/container resilience and scale tests, and CDP. Features precede visual polish. Mockups are directional.
- A shared huddle page stays selected until explicitly changed, even while navigating.
- Read applicable local instructions before resuming. No AGENTS.md was found by the earlier pruned scan. CLAUDE.md owns ports 3001/5183; this session uses 3061/5261 and CDP 19361. Keep the single-gateway safeguard; Redis state alone is not distributed routing.
- Scoped sibling-library fixes are authorized under CLAUDE.md's upstream exception. No main merge, release, cloud deployment, or broad root commit has occurred.

## Accepted work

- Persistent shell huddle chat, explicit Discussion/Huddle composer destinations, canonical page references, explicit pinned page sharing, and durable replay with private call incarnation and admission floors.
- Real BFF/WebSocket CDP huddle suite: 7/7; shell/page CDP: 17/17; prior fixture checks: 20/20. These use inert media receipts and do not prove WebRTC/SFU media.
- Backend focused acceptance: 124 tests across 10 suites plus final receipt checks (19). Durable Dynamo/Redis suite: original four checks plus an opt-in storage-container restart check.
- Storage restart: 12 persisted messages survive both owned containers restarting, exact immutable duplicate handling, then a new message; exactly 13 durable rows and sequence 13. This is bounded continuity, not a high-concurrency Dynamo soak.
- Previous portal baseline: 1,291 tests, typecheck/build. Later embedded edits need final acceptance.
- Previous fresh wire capture: 614 routes; quick mock floor, route coverage budget, component discipline passed. New embedded endpoint makes capture stale; recapture only after final source freeze.
- Historical single-gateway synthetic signaling soak: 1,000 sockets / 100 calls / five minutes with token renewal and gateway restart passed defined thresholds. It predates the new live-directory authorization, uses memory chat and inert media, and cannot prove current authority-policy capacity or real media. Evidence under this directory and `docs/realtime-capacity-100-calls-2026-10-01.md`.

## Active integration slices at pause

### Upstream realtime candidate

- Agent: `/root/mockup_library_plan`; paused, no tests running.
- Candidate clone: `/tmp/orgiq-realtime-restart-candidate`, branch `fix/async-channel-delivery`, base `373182242a7ee115ef1d787a61b25054105c5a14`, version `0.100.3`, uncommitted/unpublished.
- Detailed candidate checkpoint: `PAUSE-CHECKPOINT.md` in clone. A reboot-safe archive is saved outside `/tmp` at `/Users/connorhoehn/.codex/session-checkpoints/aws-agentcore/realtime-candidate-2026-10-03.tar.gz` (excludes node_modules).
- Async fail-closed channel authorization; per-recipient fanout checks; subscription-generation and captured-context fences; final sensitive Chat/Presence read checks and tightened history-floor filtering; async call preflight; durable-first chat/system-message sends; consistent Dynamo membership reads. Actor-replacement and delayed store/read races are covered.
- Final frozen-source verification: **170 passed suites, 2 skipped; 1,978 passed tests, 14 skipped**. Build, 31 public exports, typecheck, contract and diff checks pass.
- On resume: review final diff/checkpoint, scoped commit, publish scoped branch, then normal consumer installs. No main merge. Both consumers still pin version 0.100.2 / SHA 3731822.
- DM sends still lack generic idempotency. Unknown ack timeouts must retain draft and advise checking history before retry. Cross-store atomic rollback, external/multi-node membership invalidation and distributed routing remain separate limitations.

### Backend live principal and embedded Social

- Agent: `/root/mockup_shell_plan`; paused. See `pause-backend.md` beside this file.
- New authoritative live-principal checks, current source role/epoch/actor checks, no positive-rights cache, final proof fences, stale membership hydrate protection and pure async call preflight are on disk.
- New `GET /api/social/embedded` preserves source tenant/role; returns current actor, eligible people, DM previews, `canSend`, source provenance and authority key. Existing protected DM create/read endpoints retain their canonical receipts. Bounded roster metadata and priority for existing DM peers are implemented.
- Latest five suites / 63 tests and middleware typecheck pass. Earlier live-principal subset: six suites / 64 tests; call helper: 33 tests.
- Generic gateway/call callback wiring awaits candidate installation. Replace captured-token lobby guard with current async preflight; do not wire a Promise into the old synchronous API.
- New directory checks add database work per recipient; historical synthetic load is not proof of current capacity.

### Frontend embedded Social and explicit person destination

- Agent: `/root/persistent_call_feature`; paused, no tests running. Checkpoint saved at `pause-frontend.md` beside this file.
- Embedded provider/panel, quiet Social entry, sole shell workspace presence ownership, Search Message seam, controlled SocialConversation/public runtime seams and token-renewal handling are on disk.
- Model acceptance latest: 16 authority/destination/draft contracts plus 6 prior ack contracts passed; a 17th bounded-omission contract is written but unrun. New inert browser suite 5/5; typecheck passes. Actual embedded HTTP/WebSocket CDP acceptance remains pending new backend/pin/restart.
- Root changed `InitiativeComposer.tsx` to add explicit `person:<userId>` targets through `useEmbeddedSocial().sendToPerson`, with unavailable recipient retention and captured-target/draft ack guards. Chat-to-person is text-only and hides the page context chip. Portal typecheck passes.
- Resume review item: ContactsPage and SocialChatWorkspace still subscribe to `social:lobby`; their cleanup can unsubscribe the shell-owned roster because public subscriptions lack reference counting. Agent proposed reading shared shell context instead; extension was deferred during pause.
- Review first-slice SocialConversation `declaredViews=Chat` behavior for unnecessary pins/documents/calls reads.

## Runtime before reboot

All process IDs below will become stale after reboot. Restart by configuration, not by killing a recorded PID.

- Main BFF: port 3061, prior process session 46560, accepted huddle backend loaded before new embedded/gateway changes.
- Portal: port 5261, prior process session 44849; API proxy and Vite gateway URL target http://localhost:3061.
- Headless CDP Chrome: 19361, prior session 37765; use `portal/e2e/cdpTest.ts` isolated contexts. Tests disconnect, never close shared Chrome.
- Owned durable stores: Docker Compose project `orgiq-chat-test`; `orgiq-chat-redis` bound loopback 16479, `orgiq-chat-dynamodb` loopback 18061. Named volumes persist. Do not delete volumes or touch other stacks.
- Docker endpoint: `unix:///tmp/orgiq-soak-docker.sock`, SSH forward through Lima/Colima; may need restoring after reboot.
- Owned Tilt: `scripts/loadtest/Tiltfile`, UI port 10361; historical soak gateway port 13061 / Redis 16379. Do not confuse it with the app BFF or durable chat stores.
- Setup and durable test commands: `scripts/loadtest/README.md`. App startup configuration below.

```sh
# cwd: middleware
env PORT=3061 REDIS_URL=redis://127.0.0.1:16479 SWEEP_INTERVAL_MIN=0 DEV_OFFLINE=true MOCK_AURORA=true MOCK_AGENTCORE=true MOCK_GUARDRAILS=true MOCK_CLOUDWATCH=true MOCK_QUEUE=true POLICY_STORE_ID= SESSION_SIGNING_SECRET_ARN= COGNITO_USER_POOL_ID= COGNITO_CLIENT_ID= COGNITO_CLIENT_SECRET= COGNITO_DOMAIN= COGNITO_CALLBACK_URL= SOCIAL_PLATFORM_INTERNAL_URL= DOCUMENT_PLATFORM_INTERNAL_URL= PLATFORM_API_URL= SOCIAL_CHAT_STORE=dynamo SOCIAL_CHAT_DYNAMODB_ENDPOINT=http://127.0.0.1:18061 SOCIAL_CHAT_TABLE_PREFIX=orgiq-chat- AWS_EC2_METADATA_DISABLED=true REALTIME_GATEWAY=on REALTIME_GATEWAY_URL=http://localhost:3061 NODE_ENV=development AUTH_DEMO_MODE=true node --import tsx src/index.ts
```

Portal startup uses `API_PROXY_TARGET=http://localhost:3061`, `VITE_GATEWAY_URL=http://localhost:3061`, host `127.0.0.1`, strict port `5261`. User app URL is http://localhost:5261.

## Next acceptance sequence after explicit resume

1. Restore candidate from the persistent archive if `/tmp` was cleared, review and publish only its scoped branch. Install exact new SHA normally in portal/middleware; rebuild prepared Docker library manifest. No node_modules patching.
2. Backend agent wires async current-principal gateway/call checks against installed public APIs; freeze and verify HTTP/WebSocket authorization/revocation cases.
3. Finish frontend presence ownership and relevant fixture checks. Freeze production source; restart BFF with the same durable-store configuration.
4. Actual CDP: two source actors, canonical DM receipt, live persisted replay, explicit To-person without Discussion write or hidden page attachment, source URL/huddle/media instance preserved, Search opens embedded DM, stale actor/destination/draft guards, unavailable authority recovery, unique presence.
5. Run affected huddle/shell regression checks, portal validation and fresh isolated wire capture (port 3062), component discipline/mock floor/route coverage. Preserve existing budgets.
6. Update evidence and completion estimate only after accepted integration. Remaining full scope: canonical DM page-reference seam, work/document associations, actual SFU/media, new current-authority scale/soak evidence, tenant cloud deployment acceptance, distributed routing and final UI polish.

The existing Colima live-streaming SFU pods were unhealthy during read-only inspection. They are owner resources; do not disturb them or claim inert media tests as media acceptance. Prepare an isolated media profile later.
