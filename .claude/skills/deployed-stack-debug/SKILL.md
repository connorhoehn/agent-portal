---
name: deployed-stack-debug
description: Debug the DEPLOYED OrgIQ stack in AWS (account 647757222309) when something works locally but fails or is slow in the cloud — calls, the realtime gateway, call-binding/seat proofs, documents/canvas, or any route that answers a generic 503. Probes the live gateway as a seeded user, runs middleware provider code against the real Aurora, runs this tree locally with the deployed task's config while timing every AWS SDK call, compares local vs deployed call-state stores, maps minified portal stack traces to source and finds duplicate module instances in the bundle, and runs the two cloud smoke specs.
---

# Debugging the deployed stack

Local dev runs on mocks (`dev:mock`, in-memory directory, in-memory call
state, Vite's deduped dev graph). The deployed stack runs on the Aurora Data
API, ElastiCache Redis, real Cognito and a production Rollup bundle. Most
cloud-only bugs live in that gap, and a route's generic 503 hides them. Use
these tools to get the real error from the real system before reasoning
about it.

Prerequisites: `aws sts get-caller-identity` prints **647757222309**
(`aws-azure-login` otherwise; never use account 264161986065).
`middleware/.env.aws` is current (`./schema/dump-stack-outputs.sh`). Scripts
run from any directory with `npx --prefix <repo>/middleware tsx <script>` or
from `middleware/` with `npx tsx`. No script prints a secret value.

## 1. Is it the system or the test? Run the cloud smoke specs

```bash
F=~/.orgiq-aws-test/logins.txt     # "<email> <password>" lines, mode 600, never in the repo
A=$(grep farah $F | tr ' ' ':'); B=$(grep mira $F | tr ' ' ':')
cd portal
CLOUD_PORTAL_URL=https://d1hrudaahzp0ro.cloudfront.net CLOUD_LOGIN_A="$B" CLOUD_LOGIN_B="$A" \
  npx playwright test e2e/cloud-call-smoke.spec.ts --project=chromium
CLOUD_PORTAL_URL=https://d1hrudaahzp0ro.cloudfront.net CLOUD_LOGIN_DOC="$A" \
  npx playwright test e2e/cloud-documents-smoke.spec.ts --project=chromium
```

- `CLOUD_TIMELINE=1` prints the call path's request/frame timeline (find slow hops).
- `CLOUD_DEBUG_SEAT=1` replays each refused `call-binding` against
  `/api/realtime/call-seat` and prints the middleware's own answer.
- Sign-in lands on the user's first tenant; switch tenant only from
  `about:blank` (`cloudUseTenant` in `e2e/cloudSession.ts`): a live page whose
  tenant switches underneath it treats the session as revoked.
- A fresh Cognito user gets the pre-join device dialog; "Start a huddle" is the
  first caller, "Join the huddle" walks into a live call.

## 2. Talk to the live gateway: `scripts/gateway-probe.mts`

```bash
npx tsx .claude/skills/deployed-stack-debug/scripts/gateway-probe.mts \
  --portal https://d1hrudaahzp0ro.cloudfront.net --user u-farah --tenant social \
  --send '{"service":"call","action":"watch","lobbyName":"social:room:cloud-call-smoke"}' --seconds 8
```

Signs a realtime token with the deployed `orgiq-realtime-jwt-secret` using the
middleware's own `signRealtimeToken`, with the user's **real** grants and
session epoch from Aurora (a made-up tenant or a stale epoch is a 401: the
gateway revalidates the principal). Use it to see what the server sends
(`lobby-occupancy`, call events) independent of the portal's UI. Run it while a
browser holds a call to watch registration timing.

## 3. Get the real Data API error: `scripts/run-provider.mts`

```bash
npx tsx .claude/skills/deployed-stack-debug/scripts/run-provider.mts \
  --module src/providers/identity.ts --export getUser --args '["u-mira",{"authoritative":true}]'
npx tsx .claude/skills/deployed-stack-debug/scripts/run-provider.mts \
  --module src/providers/document-drafts.ts --export createDocumentDraft \
  --args '[{"title":"x","sectionKey":"workspace_drafts"}]' --session u-farah:assessment:lead-assessor
```

Runs one exported provider function locally against the deployed Aurora
(`MOCK_AURORA=false`). When a route answers a generic 503 and logs nothing,
this prints the `DatabaseErrorException` (how the uuid-bound-as-text bug was
found). **Writes are real** — prefer read functions unless the write is the
thing under test.

## 4. Local vs deployed state stores: `scripts/call-store-parity.mts`

```bash
npx tsx .claude/skills/deployed-stack-debug/scripts/call-store-parity.mts
```

Starts a throwaway Redis container, runs the same call-state operations on
`InMemoryCallStateStore` (local dev) and `RedisCallStateStore` over the
middleware's Redis wrapper (deployed), prints `≠` where they differ, removes
the container. Extend the `steps` list for the operation under suspicion.

## 5. A crash only the deployed portal shows: `scripts/bundle-inspect.mjs`

```bash
node .claude/skills/deployed-stack-debug/scripts/bundle-inspect.mjs --frames 275:26432,272:17154
```

Rebuilds the portal with source maps into `.scratch/portal-sourcemap`, reports
CommonJS modules in the bundle and any package bundled as both ESM and CJS
(two module instances: classes fail each other's `instanceof`), and maps
`line:column` frames from a deployed stack trace to source. Check one frame's
code matches the published asset first (same commit and lockfile give the same
positions). Get frames from the browser console: an error boundary swallows
`pageerror`, so capture `console` messages with their full text.

## 6. Slow only in AWS: this tree, the task's config — `task-env.py`, `sdk-timing.mjs`, `seat-latency.mts`

When the deployed path is slow or wrong and no log says why, run this
checkout locally with the deployed task's exact environment and count what it
does. Local timings run ~2× AWS's (laptop → Data API), so compare shapes and
counts, not milliseconds.

```bash
S=.claude/skills/deployed-stack-debug/scripts
python3 $S/task-env.py --out .scratch/mw-cloud.env          # mode 600, secrets resolved, never printed
docker run -d --rm --name claude-mw-redis -p 127.0.0.1:26400:6379 redis:7-alpine
cd middleware && source ../.scratch/mw-cloud.env && \
  NODE_OPTIONS="--import $PWD/../$S/sdk-timing.mjs" npx tsx src/index.ts > ../.scratch/mw-cloud.log 2>&1 &
npx tsx ../$S/gateway-probe.mts --portal http://127.0.0.1:3031 --user u-farah --tenant social --send '…'
npx tsx ../$S/seat-latency.mts            # join → /api/realtime/call-seat allowed, in ms
grep '^\[sdk' ../.scratch/mw-cloud.log   # every SDK call with its duration; [sdk-stack] = who asked
```

- **The boot is real.** It runs the Cedar seeder against the deployed policy
  store and the recovery sweeps against the deployed Aurora, as a task start
  does. Port 3031 keeps it clear of Tilt's servers.
- Directory reads are batched through `setImmediate`
  (`providers/identity.ts` `queuedAuthoritativeUser`), which cuts the async
  stack: `[sdk-stack]` shows only the provider. To name the caller, log
  `new Error().stack` at the queue's entry point temporarily, then revert.
- Afterwards stop the server, `docker rm -f claude-mw-redis`, and delete
  `.scratch/mw-cloud.env`.

How it was used (2026-10-28): a join drove ~100 serial directory reads, which
is the ~10 s before a call seat is accepted (open item 1). Boot logs from the
same run showed the seeder duplicating Cedar policies on every start.

## Ruled out already (2026-10-27)

- Call discovery and the lobby watch work on the deployed gateway.
- Redis and in-memory call stores agree on register/lookup/accept.
- `HUDDLE_CHAT_TENANTS` includes `social`.
- The parallel-call split is fixed in AWS (0.140.0), and the ~10 s before a
  seat was accepted is now 2.2–3.0 s (`9c45e80f`; item 1 of
  `docs/aws-deploy-open-items-2026-10-27.md`). `call-chat-join-cost.test.ts`
  pins the directory-read count of one registration.
- **Media not flowing (WHEP 425 while WHIP returns 201)** is the client's IP
  outside `sfuAllowCidr` before it is anything in code: compare
  `curl -s https://checkip.amazonaws.com` with the SFU security group.
- The gateway's own admission is fast (~0.2–0.7 s even from a laptop); Redis
  logs no timeouts; the event loop p99 is ~11 ms.

## Afterwards

Leave nothing behind: no `*.tmp.*` files in the repo, no probe containers
(`docker ps | grep claude-`), no `.scratch/mw-cloud.env`, and record new cloud-only failure classes in
`docs/aws-deploy-open-items-*.md` or `docs/deployment-enhancements-*.md`.
