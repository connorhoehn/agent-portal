# Gateway routing after the main-branch consolidation

The middleware retains the newer native `RedisRealtimeRouter` with leased
ownership, fresh session authority and recipient filtering. It does not attach
the older application `DistributedRealtimeRouter`.

- `REALTIME_GATEWAY_ROUTER=local|redis` is the canonical setting.
- With no canonical setting, legacy `REALTIME_FANOUT=redis` selects the same
  native leased router for both `/ws` and `/realtime`. Legacy `off`, `local` or
  an unset value keeps local routing. An explicit canonical setting wins.
- `REDIS_URL` by itself selects shared stores, not peer routing. Invalid router
  values and an explicit Redis opt-in without Redis fail startup. Synchronous
  attach functions refuse peer routing; the host must await the native start
  functions before listening.
- CDK keeps the one-task cloud safeguard and refuses gateway autoscaling. A
  Redis endpoint does not establish full application/service-state scale-out
  readiness, and this merge does not deploy or activate distributed routing.

The inherited fan-out test now uses native leased routers over a dedicated
opt-in `GATEWAY_FANOUT_REDIS_URL`. It exercises two real WebSocket servers,
exactly-once cross-node delivery, cross-tenant denial and recipient grant
revocation. Directory/policy authority is an explicit test fixture, not a
provisioned tenant acceptance. Without that dedicated Redis URL, only the local
default case runs; cluster cases are reported as skipped.

Run the focused middleware compatibility checks from `middleware`:

```sh
node node_modules/.bin/jest --runInBand --runTestsByPath \
  src/lib/__tests__/realtime-gateway-routing.test.ts \
  src/lib/__tests__/realtime-gateway-fanout.test.ts \
  src/lib/__tests__/redis-lite.test.ts
```

Existing dated validation receipts retain their historical source and claims.
The lock/pubsub ports added on main remain in `RedisLite`; the gateway uses its
newer bounded, separated Redis ports and native leased peer router.
