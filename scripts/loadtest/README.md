# Realtime signalling load test

`realtime-calls.mjs` drives the middleware's realtime gateway (`/ws`) with
about 1,000 sockets and 100 simultaneous calls, locally and without AWS. It
measures signalling only (see "What this does not prove").

The script is plain Node ESM. It loads `ws` and `jose` from
`middleware/node_modules`, so run `npm install` in `middleware/` once and
nothing else is needed. Every frame it sends or parses is copied from the
realtime-modules dist the portal ships, not typed from memory: `useConversationCall`
for call frames, `useChat` for chat, `usePresence`/`presenceEntry` for presence,
and the server's `CallService`/`ChatService`/`PresenceService` envelopes.

The current gateway checks directory identity, source role/epoch, and policy
on every action and channel delivery. Unprovisioned synthetic subjects are
denied. Use `--identity-manifest` with users already present in the target's
directory. The manifest is an array of `{userId, displayName, role, epoch,
tenants}`; `role` is the user's actual Social source role and `tenants` lists
their current grants. It supplies token claims and never grants authority.
Duplicate subjects, missing epochs, invalid roles and too few users fail
before opening sockets. Renewal preserves those claims, so a later directory
revocation still denies the renewed connection's actions. Each result records
the manifest's normalized SHA-256 and number of users.

For a bounded local check, the existing mocked directory contains twelve
Social users apart from the operator. Export its current identities rather
than adding a load-test bypass to the gateway:

```bash
cd middleware
env MOCK_AURORA=true node --import tsx --input-type=module -e '
  import { listUsers } from "./src/providers/identity.ts";
  import { writeFileSync } from "node:fs";
  const identities = (await listUsers({ authoritative: true }))
    .filter(user => user.id !== "u-operator" && user.grants.social?.length)
    .map(user => ({ userId: user.id, displayName: user.displayName,
      role: user.grants.social[0], epoch: user.epoch,
      tenants: Object.keys(user.grants) }));
  writeFileSync("/tmp/orgiq-directory-identities.json", JSON.stringify(identities));
'
cd ..
node scripts/loadtest/realtime-calls.mjs --identity-manifest /tmp/orgiq-directory-identities.json \
  --url ws://127.0.0.1:13061/ws --secret orgiq-soak-local-only \
  --sockets 12 --calls 4 --scenario soak --soak-seconds 60 --token-ttl-seconds 30
```

This exercises current checks against the mocked directory and Cedar policy;
it does not measure Aurora capacity. A thousand-user current-authority run
requires a separately provisioned test directory and its matching manifest.
The earlier synthetic 1,000-socket results predate this authority boundary.

Background chat starts evenly over its configured interval (`--chat-every`,
30 seconds by default), then each sender repeats at that cadence. For short
smoke runs, the startup window is at most half the requested hold, so the
unchanged paired-sender coverage check can still observe every sender.
`--chat-startup burst` preserves the previous synchronized startup send plus
the randomized periodic sends. That workload is a separate stress check;
its failed results remain recorded and do not become steady acceptance.

For two independent gateway owners, repeat `--peer-url` for each additional
`/ws` endpoint. Connections, including replacement sockets and intentional
second tabs, rotate across the targets. The result records the socket count
per endpoint and each peer's health and process memory separately; the same
health and memory thresholds apply to every sampled node. For container
sampling, provide `--sample-container` for the primary and one
`--peer-container` per peer URL. Every name, published loopback port and
container identity is checked before sampling. Named restart operations
still support a single target. Docker drivers may address multiple sampled
gateways only on their inspected shared network, with the driver's exact
running identity and default hostname checked for every target.

The guarded `middleware/test-support/bff-cluster-capacity.mjs` provisions 1,000
users only in the inspected `orgiq-bff-cluster-postgres` fixture, derives their
manifest from SQL and drives the two owned BFFs on 3063/3064. It loads their
signing key from a private runtime profile without putting it in command-line
arguments or result files. Run `pilot` before its declared `steady`,
`ring-storm`, `double-accept`, `churn` or `soak` profiles:

```bash
ORGIQ_BFF_CAPACITY_ACCEPTANCE=1 \
ORGIQ_BFF_RUNTIME_ENV_FILE=/tmp/orgiq-owned-bff-runtime-env.json \
node middleware/test-support/bff-cluster-capacity.mjs pilot
```

This fixture exercises actual provider SQL through the test-only SDK transport
adapter, local Redis, DynamoDB Local and native WebSockets. Its directly minted
load credentials still pass the current directory and policy checks; it does
not establish Cognito, Aurora/IAM, cloud resource limits or SFU media capacity.

`bff-cluster-containers.py` launches the current compiled Node 22 image on
3065/3066, with one CPU and 1,024 MiB per BFF. It uses the explicit non-production
Docker host PostgreSQL fixture and a read-only mount of the test transport.
`bff-cluster-container-load.py` runs the load inside the inspected Docker
network and samples both actual containers. Host SSH forwarding cannot carry
the 1,000-socket workload reliably. The stopped driver and named results volume
are retained; its result is copied before any driver removal. A synthetic
identity manifest is readable by that restricted driver; the signing profile
and gateway environment files stay private.

## 1. Start a target

Ports 3001, 5183, 3021 and 5191 belong to other stacks. Use 3031, and run
**without** `tsx watch` so a file save elsewhere cannot restart the server
mid-run:

```bash
cd middleware
PORT=3031 SWEEP_INTERVAL_MIN=0 MOCK_PERSIST_PAIRINGS=1 DEV_OFFLINE=true \
MOCK_AURORA=true MOCK_AGENTCORE=true MOCK_GUARDRAILS=true MOCK_CLOUDWATCH=true MOCK_QUEUE=true \
POLICY_STORE_ID= SESSION_SIGNING_SECRET_ARN= COGNITO_USER_POOL_ID= COGNITO_CLIENT_ID= \
COGNITO_CLIENT_SECRET= COGNITO_DOMAIN= COGNITO_CALLBACK_URL= \
NODE_ENV=development AUTH_DEMO_MODE=true node_modules/.bin/tsx src/index.ts
```

To exercise `RedisCallStateStore`, add `REDIS_URL=redis://127.0.0.1:6379` and
point it at a throwaway Redis. The script does not change. `GET /api/health`
reports `"realtime":{"gateway":"on","store":"memory"|"redis"}`, so check it
before trusting a run.

`tsx` runs the server in a child process. The pid to sample is the one
listening on the port (`lsof -nP -iTCP:3031 -sTCP:LISTEN -t`). The script
finds it on its own for a loopback URL; pass `--server-pid` otherwise.

## 2. Run

```bash
# Every scenario, both call shapes (about 21 minutes at --hold-seconds 60)
node scripts/loadtest/realtime-calls.mjs --scenario all --group-size 2,4 --hold-seconds 60 --json /tmp/rt.json

# One scenario
node scripts/loadtest/realtime-calls.mjs --scenario ring-storm --group-size 4

# Quick smoke check (about 2 minutes)
node scripts/loadtest/realtime-calls.mjs --sockets 40 --calls 5 --group-size 2 --hold-seconds 5 --spread-seconds 2 --scenario all

# Bounded five-minute hold after all 100 calls establish
node scripts/loadtest/realtime-calls.mjs --scenario soak --soak-seconds 300 --json /tmp/orgiq-soak.json

# Isolated containers: restart the gateway while Redis stays up
node scripts/loadtest/realtime-calls.mjs \
  --url ws://127.0.0.1:13061/ws --secret orgiq-soak-local-only \
  --scenario restart --sockets 1000 --calls 100 \
  --group-size 2 --soak-seconds 300 --restart-after-seconds 150 \
  --restart-container orgiq-soak-gateway --redis-container orgiq-soak-redis \
  --json /tmp/orgiq-restart.json

# Thirty-minute authenticated soak, with token renewal
node scripts/loadtest/realtime-calls.mjs \
  --url ws://127.0.0.1:13061/ws --secret orgiq-soak-local-only \
  --scenario soak --soak-seconds 1800 \
  --sample-container orgiq-soak-gateway --json /tmp/orgiq-soak-30m.json

# Driver contracts: no Docker mutations or AWS
node --test scripts/loadtest/realtime-calls.test.mjs

# Keep the socket load inside the isolated Docker network
# Rebuild gateway and driver between runs, then wait for gateway health.
docker compose -f scripts/loadtest/compose.yaml --profile driver build load-driver
docker compose -f scripts/loadtest/compose.yaml --profile driver run \
  --name orgiq-soak-driver load-driver \
  --driver-container orgiq-soak-driver --sample-container orgiq-soak-gateway \
  --url ws://gateway:3001/ws --secret orgiq-soak-local-only \
  --scenario soak --sockets 1000 --calls 100 --group-size 2 \
  --soak-seconds 300 --json /results/orgiq-soak.json

# Retain the stopped driver until the result has been copied successfully.
docker cp orgiq-soak-driver:/results/orgiq-soak.json /tmp/orgiq-soak.json

# Optional: after copying results, remove the stopped driver before reusing its name.
docker rm orgiq-soak-driver
```

| Flag | Default | Meaning |
|---|---|---|
| `--url` | `ws://127.0.0.1:3031/ws` | Gateway URL |
| `--peer-url` | none | Additional distinct `/ws` endpoint; repeat to distribute sockets across owners and sample each peer. |
| `--peer-container` | none | Exact container for the matching peer URL; requires primary container sampling and a distinct name for every peer. |
| `--sockets` | 1000 | Total sockets. Calls use `calls × group-size`; the rest pair into DM channels for chat and presence. |
| `--calls` | 100 | Simultaneous calls |
| `--group-size` | 2 | `2` = 1:1 calls, `4` = 4-way calls; `2,4` runs both |
| `--hold-seconds` | 60 | How long each call holds before the scripted hang-up |
| `--scenario` | steady | `steady`, `ring-storm`, `glare`, `double-accept`, `churn`, `soak`, `restart` or `all`. `all` runs only the five original scenarios. |
| `--secret` | `$REALTIME_JWT_SECRET`, else `orgiq-dev-realtime` | HS256 secret for the synthetic tokens |
| `--json` | none | Write every run's full results to this file |
| `--server-pid` | auto on loopback | Sample this process's RSS and CPU once a second |
| `--health-url` | `<url host>/api/health` | Polled every 500 ms as the event-loop proxy |
| `--origin` | none | Send an `Origin` header (needed only for a target that requires one) |
| `--ramp-per-sec`, `--spread-seconds`, `--chat-every` | 50, 60, 30 | Socket ramp, steady call spread, chat interval |
| `--chat-startup` | spread | Background cadence, or the preserved synchronized `burst` stress workload. Short runs spread first sends over at most half the hold. |
| `--soak-seconds` | 300 | Simultaneous hold for `soak`/`restart`, starting after the last call establishes; total runtime also includes ramp, call spread and cleanup. |
| `--restart-after-seconds` | 150 | Restart offset within the simultaneous hold |
| `--recovery-timeout-seconds` | 60 | Total deadline for readiness, socket ramp and protocol recovery |
| `--restart-container`, `--redis-container` | none | Required exact running container names for `restart`; only the gateway is restarted. Host runs require its port published on loopback; Docker drivers require a shared network. |
| `--sample-container` | none | Docker working-set memory/CPU every 5 seconds; defaults to the restart container. Avoid sampling the host port-forward as if it were the BFF. |
| `--driver-container` | none | This exact running Docker container. Allows the named gateway's DNS alias and exposed internal port only on their shared Docker network, with the driver's default container hostname verified. Requires gateway container stats. |
| `--token-ttl-seconds` | 600 | Synthetic token TTL, 10–600 seconds. Shorter values let small smoke tests reach renewal quickly. |
| `--identity-manifest` | none | JSON directory identities with exact Social roles/epochs; requires enough unique users for all sockets except intentional second tabs. No authorization bypass. |

The exit code is 0 when every run passes every threshold, 1 when any fails,
and 2 when the script itself errors.

## What each run does

1. Mints an HS256 token per manifest user, or per synthetic subject when no
   manifest is provided (`lt<tag>-0001`…). Synthetic subjects must also be
   provisioned in a current target directory. The default token lifetime is
   ten minutes. The
   claims match `realtimeClaims()`: `org: 'social'`, `tenants: ['social']`,
   `tokenKind: 'orgiq-hs256'`, `iss: 'orgiq-middleware'`, `aud: 'realtime'`.
   Manifest users carry their actual Social role, epoch and tenant claims.
   Each run uses a fresh 4-hex tag, so runs cannot interfere with each other.
2. Opens the sockets at 50/s with `Sec-WebSocket-Protocol: bearer-token-v1, <jwt>`.
3. Every call is in a `social:dm:<sorted members>` lobby (`dmLobbyName`
   with prefix `social:`). The gateway's `lobbyGuard` admits it because the
   caller is one of the ids. Each call socket sends `status` for its lobby,
   as the hook does on mount.
4. The remaining sockets pair into `social:dm:<a>:<b>` channels. Each one
   joins chat, subscribes to presence, sets presence, sends a presence
   heartbeat every 30 s and sends one chat message every 30 s.
5. The caller sends `invite` to the other members. Each callee waits
   100-500 ms, then sends `accepted` and `participant-state`. Every member
   re-announces `participant-state` every 20 s.
6. After the hold, every member hangs up with `user-status left` and an
   `ended` targeted at itself, exactly as `hangUp()` does.

| Scenario | # | What changes |
|---|---|---|
| `steady` | 1 | 100 calls started evenly over 60 s |
| `ring-storm` | 2 | 100 invites within 1 s |
| `glare` | 3 | 20 calls whose first two members ring each other within 10 ms. The lower id gives way as `accept()` does: it cancels its own ring, then accepts the other. The remaining 80 calls start over 10 s. |
| `double-accept` | 4 | In 10 calls, one callee has two sockets, and both accept at the same instant |
| `churn` | 5 | 10 s after the last call is up, one member of each of the first 10% of call sockets is dropped (alternating caller and callee). The member reconnects 2 s later with a new socket and does what the hook does on reconnect: `status`, then `participant-state`. The hang-up is held until at least 45 s after the drop, past the server's 30 s rejoin grace. |
| `soak` | Bounded extension | Holds all calls together and renews every socket's authenticated connection at 75% of token TTL. One member per call and one half of each DM renew at a time. |
| `restart` | 6 | Same bounded soak, plus one `docker restart --time 1 <exact name>` at the specified offset. Verifies container identity, target port/network, Redis PING and BFF Redis-store health first. |

Recovery follows the public client's `status` → `participant-state` order,
preserving each original call ID. It never sends a replacement invite. Each
new socket must receive the original complete active-call roster; each call
member's participant state must reach every peer. Every background DM sender
must reach its rejoined peer, and each presence client must receive its own
`set` receipt and reach its DM peer. JSON reports these counts separately.
Sockets resuming while call membership is lost fail recovery.

Restart uses `execFile` with an argument array, never a shell. Host runs require a
loopback URL and explicitly named gateway/Redis containers, refusing options,
selectors and shell text. The optional Docker driver verifies its own inspected
container ID against its Linux runtime hostname, an exact gateway DNS alias and
exposed TCP port on a shared Docker network, and Redis on that same network.
The health URL must address the same gateway host and port. `all` never restarts anything. Redis stays running;
PING is checked before and after restart. Planned-outage health errors are
reported separately; errors outside that window fail the run. Token renewal
waits for new members' registration receipts before the next wave. A long
soak cannot pass merely by retaining sockets authenticated with expired tokens.

## Thresholds

| Check | Pass | Meaning |
|---|---|---|
| sockets connect | 100% | Every upgrade got the `session` frame |
| calls established | all | The caller saw `accepted` from every callee |
| invite→incoming p95 / p99 | < 250 ms / < 1 s | Caller sends `invite` → callee receives it |
| accept→accepted p95 | < 250 ms | Callee sends `accepted` → caller receives it |
| chat delivery p95 | < 300 ms | `send` → the other DM member receives the `message` |
| cross-call/channel deliveries | 0 | **The collision detector.** A call frame whose `callId` or `lobbyName` belongs to a lobby this socket is not in, a chat message on a channel it did not join, or a presence update for a channel it did not subscribe to. |
| answered-elsewhere | 0 outside `double-accept` | |
| double accept: exactly one winner | all 10 | Exactly one `ended reason:answered-elsewhere` per doubled user, and the caller sees one `accepted` |
| ended before scripted hang-up | 0 | Any `ended` for a live call that the script did not cause |
| AUTHZ_CHANNEL_DENIED | 0 | Every name used is one the guards admit, so any denial is a defect |
| event-loop proxy | `/api/health` p99 < 50 ms | Upper bound on the server's event-loop delay (it includes HTTP time) |
| server RSS peak | < 700 MB | Sampled with `ps` |
| unplanned socket disconnects | 0 | Excludes scripted churn, renewal, planned restart and cleanup |
| health errors outside planned outage | 0 | Startup blackout is separately measured and bounded by recovery timeout |
| soak recovery | 100% | Fresh authenticated sockets, complete original call membership, peer state, DM delivery and presence within the deadline |
| expired sockets at reauthentication | 0 | Renewal that overruns a socket's token lifetime fails |
| container memory | < 700 MiB | Docker working set; samples must succeed |

Latencies are measured on the driver's own clock, and the driver is one Node
process holding every socket, so its own event-loop delay is included. The
summary prints the driver's loop p99 (`client loop`) so you can tell when the
driver, not the server, is the slow side.

The installed library now re-registers returning roster members, and the
100-call two-person churn regression passed in the capacity review. Full
gateway restart is a separate contract: Redis state survival alone does not
guarantee discovery or roster recovery. This harness reports the installed
pin's actual behavior rather than assuming restart works.

## What this does not prove

- **Media.** No WHIP/WHEP, no SFU, no platform-api session. Calls here are
  signalling records only. SFU capacity, ICE reachability and the "one call →
  two SFU sessions" defect need a run against a deployed stack.
- **Pinned pages.** Load users are synthetic Social actors. Call-page sharing
  requires an OrgIQ session, matching registered live socket and current
  directory authority. Run its HTTP/browser contracts and real-Redis Lua/CAS
  tests separately.
- **More than one gateway task.** The router is in-process. Every frame here
  is one process talking to itself. Two tasks would break rings regardless of
  these numbers (capacity doc §2).
- **The deployed CPU budget.** A laptop core is not half a Fargate vCPU. To
  approximate one, run the target under `taskset -c 0` on Linux or in a
  container with `--cpus=1` (or `0.5`).
- **Real users' notifications.** The synthetic users hold no social grant in
  the directory, so `notify()` drops missed-call and DM notices for them.
  The glare scenario's predicted stray "missed call" notice cannot appear here.
- **Login and token minting.** Tokens are signed locally. The HTTP path
  (`GET /api/session/realtime-token`, limited to 15 logins/min/IP) is not
  exercised.

For the first isolated profile, constrain the BFF to 0.5 CPU and 768 MiB,
leave Redis in its own container, and freeze live updates during the run.
The `scripts/loadtest/Tiltfile` gateway resource uses manual triggers: rebuild
and wait for healthy **between** runs. Do not trigger it during a soak; a
source-watch rebuild is an unplanned outage and invalidates that result.
This is one gateway with Redis persistence. It does not test distributed
socket routing, Redis failure recovery or durable chat history. Preserve
JSON results, container stats/logs, package SHAs and resource limits together.

On Colima/Lima, a thousand host sockets through SSH forwarding can exhaust the
forwarding transport before the gateway reaches capacity. The `driver` Compose
profile puts the driver beside the gateway instead. Give each run the explicit
`--name orgiq-soak-driver` shown above, leave its default Docker hostname intact,
and rebuild its image after driver changes. To exercise restart, replace
`--scenario soak` with `--scenario restart --restart-after-seconds 150
--restart-container orgiq-soak-gateway --redis-container orgiq-soak-redis`.
The mounted Docker socket is local test orchestration access for inspect/stats
and that explicit restart; it stays outside application images. The driver has
one CPU and 512 MiB; the gateway remains constrained separately to 0.5 CPU and
768 MiB. Results are written to the named `driver-results` volume mounted at
`/results`. Keep the named driver container until `docker cp` has copied its
JSON to the host, even if the run fails a threshold. Removing that stopped
container afterward leaves the results volume intact. A named volume avoids
the ambiguous host-versus-VM `/tmp` paths under Colima.

This session uses a dedicated temporary Docker socket forward. Before running
host Docker/Compose commands against that stack, select it explicitly:

```bash
export DOCKER_HOST=unix:///tmp/orgiq-soak-docker.sock
```

Use the same daemon for build, run, stats and `docker cp`. The socket override
is unnecessary when the normal Docker context already reaches the intended
daemon; the Docker driver itself uses its mounted `/var/run/docker.sock`.

## Durable huddle storage checks

The separate `compose.chat.yaml` profile starts disk-backed DynamoDB Local on
18061, AOF Redis on 16479, and the installed public chat-schema initializer.
It uses its own named volumes and does not rebuild the signalling
gateway or touch owner ports. The already built `orgiq-soak-gateway:local`
image supplies the initializer's Node runtime.

```bash
docker compose -f scripts/loadtest/compose.chat.yaml up -d chat-dynamodb chat-redis chat-init
cd middleware
CALL_CHAT_TEST_DYNAMODB_ENDPOINT=http://127.0.0.1:18061 \
CALL_CHAT_TEST_REDIS_URL=redis://127.0.0.1:16479 \
node node_modules/jest/bin/jest.js --config jest.config.cjs \
src/lib/__tests__/call-chat-durable.integration.test.ts --runInBand
```

Both endpoints are required. Configured but unavailable stores fail the test.
The four normal checks use real Redis Lua and DynamoDB HTTP operations while
controlling identity and socket handles. They verify 120 persisted sends,
exact latest 50 history, cold runtime recovery, immutable retry receipts,
membership boundaries, revocation, terminal denial, and isolation of an older
durable transcript after call-state expiry. Separate CDP tests establish the
actual browser/authentication/BFF/WebSocket path.

A fifth check explicitly restarts both dedicated storage containers. Run it
only between browser/load tests, since the shared local BFF may use these
stores:

```bash
CALL_CHAT_TEST_DYNAMODB_ENDPOINT=http://127.0.0.1:18061 \
CALL_CHAT_TEST_REDIS_URL=redis://127.0.0.1:16479 \
CALL_CHAT_TEST_RESTART_STORES=1 \
CALL_CHAT_TEST_DOCKER_HOST=unix:///tmp/orgiq-soak-docker.sock \
node node_modules/jest/bin/jest.js --config jest.config.cjs \
src/lib/__tests__/call-chat-durable.integration.test.ts --runInBand \
--testNamePattern=storage-container
```

Before restarting, that check validates the exact container names, Compose
project/service labels, loopback port bindings, owned data volumes and inspected
IDs. It deletes only its own test rows/keys afterward. It asserts that all
pre-restart message IDs/timestamps and the private call incarnation survive,
that a retry returns the original receipt, and that a new message adds exactly
one durable row. This establishes bounded storage-container continuity, not a
high-concurrency durable-chat soak or media recovery.

## Pointing it at a deployed gateway

```bash
node scripts/loadtest/realtime-calls.mjs \
  --url wss://<portal or ALB host>/ws \
  --secret "$(aws secretsmanager get-secret-value --secret-id <realtime JWT secret> --query SecretString --output text)" \
  --health-url https://<host>/api/health --scenario steady
```

No `--origin` is needed. The gateway checks the browser Origin allowlist only
when an `Origin` header is present, and the driver sends none by default.

- The token must verify against the deployed `REALTIME_JWT_SECRET`. That
  secret signs real users' sockets too, so handle it like a credential and
  rotate it if it leaves the operator's machine.
- The synthetic users are `org: 'social'` with a `social` grant claim. The
  gateway trusts the token's claims, so no directory rows are needed for
  calls and DM chat. `social:ch:` channels would need membership rows, which
  is why the script avoids them.
- Server RSS and CPU are not sampled remotely. Read ECS
  `CPUUtilization`/`MemoryUtilization` for the window instead.
- The ALB security group must admit the load generator (custodian revokes
  `0.0.0.0/0`; pass its IP in `albAllowCidr`).
- Keep the middleware at one task while testing (see the capacity doc's
  change #2).
