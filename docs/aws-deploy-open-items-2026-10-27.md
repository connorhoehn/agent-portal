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
- Portal: https://d25ntr6vvgp7ia.cloudfront.net (`/api`, `/ws` and
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
CLOUD_PORTAL_URL=https://d25ntr6vvgp7ia.cloudfront.net CLOUD_LOGIN_A="$B" CLOUD_LOGIN_B="$A" \
  npx playwright test e2e/cloud-call-smoke.spec.ts --project=chromium      # real 2-user call, seat binding
CLOUD_PORTAL_URL=https://d25ntr6vvgp7ia.cloudfront.net CLOUD_LOGIN_DOC="$A" \
  npx playwright test e2e/cloud-documents-smoke.spec.ts --project=chromium # canvas loads, edit persists
```

Both passed at `ad97de16`. The `deployed-stack-debug` skill
(`.claude/skills/deployed-stack-debug/`) holds these commands plus probes for
the live gateway, provider code against the real Aurora, local-vs-Redis call
state, and the production bundle; start there for any cloud-only failure. The Cognito users `farah.osei@assessment.example`
and `mira.okafor@social.example` were given permanent passwords for this; the
other seeded Cognito users are still `FORCE_CHANGE_PASSWORD`.

## 2026-11-03: rebuilt after the lab account's aws-nuke

On 2026-11-01 ~03:00 an account-wide aws-nuke (`AWSNuke-Session`, role
`AWSNukeCrossAccountRole`) deleted Aurora, Cognito, every secret and Lambda,
the VPC, ECS, the ALB, ElastiCache, the SFU host, the portal bucket and all
three CloudFront distributions, leaving 22 hollow `UPDATE_COMPLETE` stacks
(and the runtimes, DynamoDB tables and ECR repos). It may recur monthly; ask
the lab admins about an exemption tag before relying on the stack.

Rebuilt from scratch on 2026-11-03: `PURGE_RETAINED=true destroy.sh`, then
`scripts/deploy/orchestrate.mjs apply`, then the data layer (migrations,
`schema/apply_all_seed.py`, `schema.synth load` + KB ingestion 157/157,
Cognito passwords for the two cloud-test users, `prompt-pointers.ts
bootstrap --yes`, the page-thread migrator: 19 comments). New portal:
**https://d25ntr6vvgp7ia.cloudfront.net**. Verified: 22 stacks, 7/7 ECS,
8 runtimes READY, both cloud specs pass. What broke on the way, all fixed in
code: the KB Data API readiness (`a7d3018f`, `079da805`), prompt-pointers'
per-page CLI output (`0aac89aa`), and the fresh-account ordering cycles
between the middleware, Social and Portal stacks (`03df3e4b`). Still manual
(DE-24): the data-layer steps above.

## Open items

### 1. Calls: a second joiner within ~9 s starts a parallel call — RESOLVED 2026-10-29

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

**Update (2026-10-28, AWS).** Proven: with the 0.140.0 image deployed,
`cloud-call-smoke` with `CLOUD_SEAT_SETTLE_MS=0` passes 4/4; both joiners
end in one call. What remains is a **~10 s wait before any seat is accepted**,
the first joiner's included: `call-binding` answers 403 "Accepted call seat
required" (and `/api/realtime/call-seat` `{"allowed":false}`) until then, so
media starts ~10 s after Join. Measured locally against the deployed Aurora/AVP
(this tree, the task's env, a local Redis): join → seat allowed **11.1 s**;
one join drives **~100 serial directory reads** (`readCurrentUsers`, ~30–65 ms
each). Cause: `lib/call-pages.ts` wraps the call store, and its
`registerParticipant` / `claimAcceptedSeat` await the huddle chat's
`registered()` reconciliation (`lib/call-chat.ts` `participant()` ×3 per seat,
each re-reading the principal and its grants twice) before returning, and the
library's join awaits that write before `markAccepted`. The other ~46 reads
are the authority engine's load + recheck per channel decision.
Moving the chat reconciliation off the seat path (queued per call, history
floor stamped with the seat time) was tried and **reverted**: 11
`routes/__tests__/call-chat.test.ts` cases fail, one of them security-relevant
("a delayed membership reconciliation cannot restore a departed seat" got 200,
not 409). The options left need a decision: (a) make the chat reconciliation
cheaper while keeping its order (one principal read per `participant()` step
instead of per sub-check); (b) a bounded directory memo (e.g. ≤1 s, dropped on
epoch bump; the BFF is the single writer while the single-gateway safeguard
holds), which relaxes the "every decision starts a new read" rule in
`providers/identity.ts`; (c) accept media starting ~10 s after Join.

**Resolved (2026-10-29, AWS, `9c45e80f`).** Option (a), every check kept:
the claim right after a first registration no longer reconciles again; each
seat is checked once right before its own join, all seats together; the roster
broadcast leaves the recipient check to `filterFrame` and no longer holds the
seat; a directory read is handed to the policy engine's next load in the same
event-loop turn only (`handOffLiveSession`); the call-seat proof drops the
`currentLiveSession` reads that preceded an identical fresh read. Pinned by
`lib/__tests__/call-chat-join-cost.test.ts`. Measured: locally join → seat
11.1 s → ~1.6 s; in AWS, `cloud-call-smoke` with `CLOUD_SEAT_SETTLE_MS=0`,
ws join → first accepted `call-binding` **~10–12 s → 2.2–3.0 s** per user,
0–2 refused retries (was 4–6), 4/4 passes.

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
| Agents deploy would refuse to drop six exports (2026-10-28 rollout of `fa782230`) | Gateway stopped taking the roles as objects; the deployed Gateway still imported the auto exports | `exportValue` keeps them in `lib/agents-stack.ts` |
| Middleware image build `ENOENT …message-queue-0.4.0.tgz` | lockfile resolves `file:vendor/…`, deps stage never copied `vendor/` | `COPY vendor ./vendor` in `middleware/Dockerfile` |
| deploy.sh's gate: page-thread migrator "Refusing to migrate into a process-local memory store" | the manifest left the chat-store env to the operator's shell | manifest entries carry `env` (outside the checksum) |
| `PolicySupervisorFullAccess` NotStabilized "Target … does not exist" | Cedar actions used `<target>__<tool>`; the gateway names tools `<target>___<tool>` | `___` in `lib/agentcore-gateway-stack.ts` |
| Every BFF boot added ~25–50 Cedar policies (244 in the store, ~9 copies per seed statement) | `seedPoliciesIfMissing` read only `ListPolicies`' first page; only the copy it saw was ever updated, so stale copies kept their old permits | `lib/avp-policies.ts` paginates and keeps one copy per seed description (the latest-updated); the seeder's client retries adaptively under AVP's throttle. Store cleaned to 40 policies on 2026-10-28 |
| `./deploy.sh OrgIQ-SocialMedia` left OrgIQ-MiddlewareService UPDATE_FAILED and printed "all 1 expected stack(s) healthy" | a named stack deploys its dependencies, but the diff, the --no-rollback recovery and the reconciliation covered only the name | named stacks expand to their dependency closure (`cdk ls --show-dependencies`) for all three; `-e` keeps the old meaning |
| Every `POST /api/video/sessions` 504 after an SFU-only deploy | the SFU host was replaced; OrgIQ-Social bakes its private IP (VIDEO_API_URL) and instance id (video ALB target) from SSM at deploy time | `READS_BY_NAME` in `deploy.sh`: deploying OrgIQ-SocialMedia also deploys OrgIQ-Social |
| A CIDR-only deploy replaced the SFU (and would the TURN host) | `latestAmazonLinux2023()` resolved AWS's 2026-10-28 image; a new image replaces the instance | `hostImage`: `sfuAmiId` / `turnAmiId` pin it, carried forward from `SfuAmiId` / `TurnAmiId`; `latest` rolls it on purpose |
| Media never flowed (WHEP 425) though WHIP succeeded | the tester's public IP changed overnight; the SFU admits only `sfuAllowCidr` | operational: redeploy OrgIQ-SocialMedia with `--context sfuAllowCidr=<new ip>/32` (the inference keeps the old one) |
| Every plan and diff showed OrgIQ-Foundation pending; lab.json said Social and documents were off | the environment record was template Metadata, which CloudFormation never applies alone; lab.json's features disagreed with DE-17 and the account | SSM `/orgiq/environment`; lab.json corrected (the orchestrator's phases read it); `DEPLOY_PLAN_ONLY=true` added to see a deploy without making it |
| OrgIQ-PromptCanary rolled back (`2c352c95`) | the promotion machine's catcher listed `States.ALL` beside another error; Step Functions requires it alone and last | two catchers; a test walks every state machine for the rule |
| `/api/session/me` 401 SESSION_INVALID right after a Cognito sign-in (lenient routes still 200) | the SSO callback minted the cookie without the directory epoch; any user who had ever switched tenant read as epoch 0 | `routes/auth.ts` passes `user.epoch`; regression test |

The 2026-10-28 rollout also applied the schema ledger baseline and the
page-thread data migration (19 comments, 0 failures; `2026-09-05-drop-newsroom`
is still pending and not gated). The middleware still pulls `:latest`, so a
push needs `aws ecs update-service --force-new-deployment` (DE-18).
