# AWS deploy: open items (2026-10-27)

Handoff for the agent that fixes what the 2026-10-26/27 cloud deploy left
open. Everything below was observed against the deployed stack in account
647757222309 (us-east-1); nothing here is reasoned-only unless it says so.

## Where things stand

The whole platform runs in AWS, nothing forwarded from a laptop:

- 22 `OrgIQ-*` stacks `*_COMPLETE` (including `OrgIQ-SocialImages`,
  `-SocialMedia`, `-Social`, `-Portal`; `OrgIQ-Devbox` is phase 1 only).
- ECS cluster `orgiq-middleware`: middleware, platform-api and the five
  document-workspace services (gateway, platform, catalog, mq, redis), 1/1 each.
- 8 AgentCore runtimes READY; 4/4 ALB targets healthy.
- Portal: https://d1hrudaahzp0ro.cloudfront.net (`/api`, `/ws` and
  `/document-realtime` route to the middleware ALB). Platform-api and SFU
  signalling have their own distributions (`PlatformApiPublicUrl`,
  `SfuPublicUrl` on `OrgIQ-Portal`).
- Realtime gateway on (`REALTIME_GATEWAY=on`), call state in the Social Redis.
- Document workspace deployed behind CloudFront (no domain or certificate);
  its context is in SSM `/orgiq/documents/workspace-config`, written by
  `scripts/docker/document-workspace-push.mjs`. `deploy.sh` reads it back.

Verification lives in two specs that run only against the deployed portal:

```bash
F=~/.orgiq-aws-test/logins.txt   # "<email> <password>" per line, mode 600, not in the repo
A=$(grep farah $F | tr ' ' ':'); B=$(grep mira $F | tr ' ' ':')
cd portal
CLOUD_PORTAL_URL=https://d1hrudaahzp0ro.cloudfront.net CLOUD_LOGIN_A="$B" CLOUD_LOGIN_B="$A" \
  npx playwright test e2e/cloud-call-smoke.spec.ts --project=chromium      # real 2-user call, seat binding
CLOUD_PORTAL_URL=https://d1hrudaahzp0ro.cloudfront.net CLOUD_LOGIN_DOC="$A" \
  npx playwright test e2e/cloud-documents-smoke.spec.ts --project=chromium # canvas loads, edit persists
```

Both passed at `ad97de16`. The Cognito users `farah.osei@assessment.example`
and `mira.okafor@social.example` were given permanent passwords for this; the
other seeded Cognito users are still `FORCE_CHANGE_PASSWORD`.

## Open items

### 1. Calls: a second joiner within ~9 s starts a parallel call

**Update (2026-10-27, later, local only).** The split is a gateway race,
reproduced locally and fixed in realtime-modules 0.140.0 (pinned in portal and
middleware): two first joins of a lobby's page huddle with their own minted
ids both passed the live-call check before either registered. An atomic
per-lobby claim now gives both one call; the loser adopts the winner's id
(`realtime-gateway-page-huddles.test.ts` "same moment" through the BFF
router). Data API latency widens the window but is not the cause, so the
cache/direct-connection options below are no longer needed for this symptom.
Not yet proven in AWS: rebuild and roll the middleware image, then run
`cloud-call-smoke` with `CLOUD_SEAT_SETTLE_MS=0`.

**Symptom.** The first person to Join a hangout room is registered as the
lobby's live call by the gateway ~9 s after they click (owner's call id minted
17:18:43.75, gateway `lobby-occupancy active:true` at 17:18:53.1). Anyone who
joins inside that window does not see the live call, so `useSocialCall`
`start()`s a second call in the same lobby (the client mints a new
`call-<ms>-<rand>` id). Media still flows (both legs share one SFU session),
but neither call ever holds two seats, so neither is accepted, and
platform-api's `POST /api/video/sessions/:id/call-binding` answers 403
"Accepted call seat required" for both legs. Once the second person joins
after the window, both bind 200 (the cloud call spec waits 15 s,
`CLOUD_SEAT_SETTLE_MS`, to prove that).

**What was checked.** Lobby watch works (`{service:'call',action:'watch'}` gets
`lobby-occupancy` frames), the Redis and in-memory call stores behave the same
(`registerParticipant` / `registerLobbyCall` / `getCallIdsByLobby` against a
throwaway Redis), and `HUDDLE_CHAT_TENANTS` includes `social`. Each
`GET /api/calls/:id/chat` takes ~3.3 s on AWS (`CLOUD_TIMELINE=1` on the
call spec prints the timeline).

**Likely cause (not instrumented inside the task).** The call path re-reads
the principal before and after every step (`currentLiveSession` →
`getUser(…, { authoritative: true })` → one Aurora Data API round trip each,
roughly 200–300 ms; `call-media-proof.ts` alone does three rounds). Locally
the directory is in memory, so the window does not exist there. First step for
the fixer: time `queuedAuthoritativeUser` / `readCurrentUsers` in the deployed
task to confirm before changing anything.

**Fix options (a user decision; the security trade differs):**
- a short-TTL authoritative cache in `providers/identity.ts`
  (`queuedAuthoritativeUser`), cleared on any write through its `exec`; bounds
  revocation lag to the TTL on other replicas (the gateway is pinned to one
  task anyway);
- a direct in-VPC Postgres connection for authoritative reads instead of the
  Data API (infra + a second DB path);
- fewer re-reads on the call path (`call-media-proof.ts`, call chat, lobby
  join), keeping the read-before-reply guarantee only where it matters.

Independently, the client could close the window: Join could wait for the
lobby's first occupancy answer before choosing `start()` over `rejoin()`
(`portal/src/pages/social/useSocialCall.ts`).

### 2. realtime-modules ships its canvas client and TipTap adapters as CommonJS

The production bundle resolved realtime-modules' `require()`s through the
`require` condition and carried a second, CJS instance of the editor stack
(y-tiptap, `@tiptap/*`, `prosemirror-*`), so every canvas crashed on mount
(`reading 'localsInner'`). Worked around in `portal/vite.config.ts`
(`editorStackAsEsm` resolves the editor stack's requires as imports). The real
fix is upstream in `connorhoehn/realtime-modules`: ship `client/useCanvasDocument`
and `adapters/tiptap/*` as ESM (or dual), then move the pin and keep or drop
the plugin. Check a build with `vite build --sourcemap` and look for any
`prosemirror-*/dist/index.cjs` in the `.map` sources.

### 3. The page-thread data migration has not run

The three additive schemas are applied to Aurora (`assessment_team_members`,
`work_item_comment_migrations`, `work_item_documents`, `people.avatar_url`
verified 2026-10-27). The migration itself (dry-run, migrate, then deploy the
BFF; see CLAUDE.md) was deliberately not run: it needs the user's sign-off.

### 4. Local Tilt media forwards point at another user's home directory

`Tiltfile` `platform-api-forward` and `social-docs-forward` use
`-i /Users/connorhoehn/.colima/_lima/_config/user -p 50697`. On this machine
the home is `/Users/connor.hoehn`, so both resources error. Derive the key path
and SSH port from `colima ssh-config` (or `limactl show-ssh`) instead of
hard-coding them.

### 5. Allowlists follow the operator's IP by hand

`albAllowCidr` and `sfuAllowCidr` are literal CIDRs. The operator IP changed
overnight (50.81.226.50 → 9.179.13.10) and both were re-passed by hand; the
SFU admits media only from `9.179.13.10/32`, so any other participant needs
their IP added. `deploy.sh`'s sticky inference re-supplies the *old* values.
Decide whether the deploy should add the caller's current IP automatically
(`curl https://checkip.amazonaws.com`) and how participants are admitted
(TURN, `deployTurn=true`, is built but off).

### 6. Test data left on the deployed stack

- Hangout rooms named `Cloud call smoke` and `Cloud call smoke <hex>` (seven;
  rooms have no delete route). The call spec now reuses `Cloud call smoke`.
- Two assessment drafts titled `Cloud document smoke` in `workspace_drafts`;
  the document spec reuses them.

### 7. Teardown has resources CloudFormation does not own

Run `PURGE_RETAINED=true ./infra/scripts/destroy.sh`, then verify against the
API, not the log (memory: destroy.sh has reported success through expired
credentials). Created outside CloudFormation and covered by `PURGE_RETAINED`:
the `orgiq-documents-{gateway,platform,catalog,mq,redis}` ECR repos, secrets
`orgiq-document-grant-{private,public}-key`, SSM
`/orgiq/documents/workspace-config`. RETAINed and covered:
`orgiq-assessment-documents-*` tables, the `DocumentUploads` EFS, the
`orgiq-social-*` tables, `orgiq-middleware` and the three Social ECR repos.

## Fixed during this deploy (for context, all on `main`)

| Symptom | Root cause | Fix |
|---|---|---|
| platform-api tasks AccessDenied on `orgiq-realtime-jwt-secret` | Secrets Manager reads the last `-xxxxxx` of a partial ARN as the random suffix (`-secret`) | complete ARNs published to SSM, read by name (`lib/social-stack.ts`) |
| Gateway-on deploy rolled back | AZ rebalancing rejects maximumPercent ≤ 100 | rebalancing off where pinned |
| call-binding 503 | no `LOBBY_AUTHORITY_URL` in the cloud | defaults to the middleware through CloudFront |
| Document workspace needed a domain | cert requirement | runs behind the portal CloudFront, origin-verify header on the rule |
| First document deploy stranded 54 tables + EFS, retry "already exists" | `--no-rollback` refused a replacement; Retain survived the rollback | `deploy.sh` diffs first; `RetainExceptOnCreate` |
| Namespace `ConflictingDomainExists` | Cloud Map finished a namespace CFN had cancelled | `deploy.sh` sweeps an unowned, service-less namespace |
| Doc gateway "Failed to resolve fs-….efs…" | service created alongside mount targets | depends on `mountTargetsAvailable` |
| Every draft creation 503 | uuid `document_id` bound as text | `CAST(:document AS uuid)` + guard test |
| Canvas crashed on mount | two editor stacks in the bundle | `editorStackAsEsm` (item 2 is the upstream fix) |
