// Local compute — a developer's own machine as a fleet participant, offline.
//
// Two halves of one feature live here, because they are one world and their
// node ids have to agree:
//
//   * THE DURABLE HALF — `compute_nodes` and `compute_pairing_codes`
//     (schema/local_compute_schema.sql), mirrored for `config.mock.aurora`.
//     These were three module-level `Map`s in providers/local-compute.ts
//     (`mockNodes`, `mockTokenIndex`, `mockCodes`) that registered no fixture,
//     so `POST /api/__mock/reset` could not put back a claimed node, a spent
//     pairing code or a renamed label — which is why six write routes are
//     refused as `unresettable` by mock/core/wire/write-policy.ts.
//
//   * THE PRESENCE HALF — the live sessions announced on a node, which
//     lib/local-compute-fleet.ts held in a module `Map` of its own.
//
// WHY PRESENCE MOVED, GIVEN IT IS EPHEMERAL BY DESIGN. The fleet module's
// header makes a good argument: a session is presence, not a record, and the
// plugin re-announces within one heartbeat after a restart, so persisting
// sessions would only produce rows that lie about liveness. That argument is
// about DURABILITY and it still holds — nothing here is written to Aurora, and
// the store is still process memory that dies with the process. It is not an
// argument for being UNRESETTABLE. An auditor who announces a session, ends
// it, and heartbeats a node back from stale has changed the world for whoever
// looks next, and before this module the only way back was restarting the
// middleware. A fixture is in-memory too; it costs nothing at run time and it
// gives that auditor `POST /api/__mock/reset`.
//
// WHAT DELIBERATELY DID NOT MOVE. `subscribers` in lib/local-compute-fleet.ts
// stays a module-level `Set`. It holds live SSE callbacks, not data: those are
// open HTTP responses, and clearing them from a route an auditor can curl
// would silently detach every open `/api/local-compute/stream` with no
// reconnect and no error. Data is resettable; connections are not data.
//
// THE SEEDED PRESENCE IS GATED, THE SEEDED NODES ARE NOT. `presenceOf` is
// production code — the same function serves a real laptop — so the demo cast
// below must not exist in a real deployment, where a node called
// `node-demo-macbook` would be a fabricated "connected" badge. The nodes
// fixture needs no such gate: providers/local-compute.ts reads it only inside
// `if (config.mock.aurora)`, so it is unreachable in production by
// construction.

import { createHash } from 'node:crypto';
import { clock, defineFixture } from './core/index.js';
import { loadDevPairings, saveDevPairing } from './dev-pairings.js';
import type { ComputeNode } from '../providers/local-compute.js';
import type { LocalSession, NodeMetricsSnapshot } from '../lib/local-compute-fleet.js';

// Type-only imports above: this module is imported for its VALUES by both
// providers/local-compute.ts and lib/local-compute-fleet.ts, so importing
// either of them back for a value would close a runtime cycle. `import type`
// is erased, and there is none.

/**
 * `dev:mock`'s switch, read from the environment rather than `config.ts` for
 * the reason routes/local-compute.ts states: `config.ts` uses
 * `import.meta.url` and will not import under the CJS jest config, and this
 * module is read by lib/local-compute-fleet.ts, which is production code with
 * production tests. Read per call, never captured, so a reset re-evaluates it.
 */
const mockWorld = (): boolean => process.env['MOCK_AURORA'] === 'true';

/**
 * sha256, the same digest providers/local-compute.ts stores as
 * `compute_nodes.token_hash`. Deliberately a second one-line copy rather than
 * a value import from the provider, which would close the cycle the note above
 * avoids; `local-compute-fixtures.test.ts` proves the two agree by resolving
 * MOCK_NODE_TOKEN through the provider's own `getNodeByToken`.
 */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * The one pre-paired machine's token. A fixed dev-only string: meaningless
 * outside mock mode, where every real token is 24 random bytes and only its
 * hash is ever stored. The `lcn_` prefix is load-bearing — `getNodeByToken`
 * rejects anything else before it hashes.
 */
export const MOCK_NODE_TOKEN = 'lcn_mock-local-node-token';

/**
 * The whole seeded cast's tokens, keyed by node id.
 *
 * Named rather than left inline as arguments to `hashToken` because they ARE
 * usable credentials in mock mode — an audit announces and heartbeats as a
 * seeded machine to exercise the stale→connected transition — and a credential
 * that exists only as a string literal in a factory is one nobody knows is
 * there. Fixed dev-only values: outside mock mode every token is 24 random
 * bytes and only its hash is ever stored.
 */
export const MOCK_NODE_TOKENS: Record<string, string> = {
  'node-demo-macbook': MOCK_NODE_TOKEN,
  'node-operator-thinkpad': 'lcn_mock-operator-thinkpad-token',
  'node-operator-mini': 'lcn_mock-operator-mini-token',
};

/** Mirrors `PAIRING_TTL_MS` in providers/local-compute.ts. */
const PAIRING_TTL_MS = 10 * 60_000;

// ─── Row shapes ──────────────────────────────────────────────────────────────

/**
 * A `compute_nodes` row. `ComputeNode` is the projection the wire carries;
 * the row additionally holds the column the wire must never carry.
 */
export interface ComputeNodeRow extends ComputeNode {
  /** `compute_nodes.token_hash` — sha256(nodeToken), hex. Never projected. */
  tokenHash: string;
}

/** A `compute_pairing_codes` row. `claimed_at` NULL means unspent. */
export interface PairingCodeRow {
  code: string;
  ownerId: string;
  expiresAt: string;
  claimedAt: string | null;
  /** The node the claim minted (or re-keyed) — what a browser polling the
   *  code's status needs in order to watch that machine come online. */
  claimedNodeId: string | null;
}

/**
 * A node's live presence. `sessions` is a nested collection, not an aggregate
 * — the session COUNT the fleet route renders is a selector over this array,
 * never a stored field.
 */
export interface NodePresenceRow {
  nodeId: string;
  /**
   * The last announce or heartbeat. This is the ONLY input to the
   * connected/stale/offline derivation in lib/local-compute-fleet.ts, which is
   * why every seeded value below is an age rather than a status.
   */
  lastSeenAt: string;
  sessions: LocalSession[];
  /** Last-reported machine health, or null/absent when nothing ever reported
   *  one. Only the re-announced demo machine below carries one — see
   *  `demoMetrics()`. */
  metrics?: NodeMetricsSnapshot | null;
}

// ─── The seeded cast ─────────────────────────────────────────────────────────
//
// Three machines, chosen so each arm of `statusOfNode` is reachable from the
// seed rather than only from a test that announces first:
//
//   node-demo-macbook     ≤ 90s     connected
//   node-operator-thinkpad  3 min   stale
//   node-operator-mini     20 min   offline  (and its sessions are HIDDEN,
//                                             which is a rule worth seeing)
//
// Ownership is split on purpose. `demo-user` is the identity a cookie-less
// request gets in dev (lib/session.ts DEMO_SUB) and owns the pre-paired
// machine, as it did before this module existed. `u-operator` is a seeded
// app_user (schema/identity_schema.sql) and the identity the wire sweep signs
// in as, so `GET /api/local-compute/nodes` renders for a signed-in persona and
// `PATCH /nodes/:id` has a row it actually owns to rename.

const DEMO_OWNER = 'demo-user';
const OPERATOR_OWNER = 'u-operator';

/** The pre-paired demo machine — the node MOCK_NODE_TOKEN authenticates. */
export const DEMO_NODE_ID = 'node-demo-macbook';

/**
 * Minutes before now, through the one clock.
 *
 * NOT clamped with `keepWithinToday`: what a presence row claims is an AGE
 * measured against the 90-second and 5-minute horizons, not a day bucket. The
 * clamp would pin a 20-minute-old heartbeat to UTC midnight just after
 * midnight and revive an offline machine as `connected` — the clamp is right
 * for "linked today", wrong for "last seen".
 */
const minutesAgo = (minutes: number): string => clock.hoursAgo(minutes / 60);

function seededNodes(): ComputeNodeRow[] {
  return [
    {
      id: DEMO_NODE_ID,
      ownerId: DEMO_OWNER,
      label: 'demo-macbook',
      platform: 'darwin/arm64',
      acceptJobs: false,
      // What tools/local-compute-worker.mjs advertises in its default
      // (anthropic) mode: the Sonnet it pins `claude -p` to on this machine's
      // own login (local compute runs Sonnet or Haiku only — a frontier model
      // on a feature ticket is cost without a better outcome). The local qwen this used to name was retired on
      // 2026-09-14 — the laptop's compute was not worth the watts — so a
      // seed still naming it would be a demo of a machine nobody has.
      localModels: ['claude-sonnet-5'],
      // Advertises nothing and holds one job: the state a machine is in after
      // pairing and before its worker has ever announced capabilities. Paired
      // with acceptJobs false, this is the "presence only" machine.
      jobKinds: [],
      maxConcurrency: 1,
      createdAt: clock.daysAgo(41),
      // A machine that is announcing has a last_seen_at; the route bumps this
      // column and the presence row together on every announce/heartbeat, so
      // seeding one without the other would seed a state no code path produces.
      lastSeenAt: minutesAgo(0.5),
      // Never asked for work: presence only, no worker running.
      lastClaimAt: null,
      revokedAt: null,
      tokenHash: hashToken(MOCK_NODE_TOKENS[DEMO_NODE_ID]!),
    },
    {
      id: 'node-operator-thinkpad',
      ownerId: OPERATOR_OWNER,
      label: 'operator-thinkpad',
      platform: 'linux/x64',
      // The one machine opted in to the job dispatcher, so the accept-jobs
      // control has both states on screen.
      acceptJobs: true,
      localModels: ['llama3.1:8b', 'nomic-embed-text'],
      // The one machine that has actually registered a worker, so the claim
      // path has a node it can legitimately hand work to. Two slots, matching
      // the reference workstation's llama-server (2 slots, kv_unified).
      jobKinds: ['local:distill', 'local:consolidate'],
      maxConcurrency: 2,
      // Paired earlier today — this one IS a day claim, so it takes the clamp
      // that keeps it inside today at 00:05 UTC.
      createdAt: clock.hoursAgo(5, { keepWithinToday: true }),
      lastSeenAt: minutesAgo(3),
      // The only seeded machine that ever registered a worker, so the only one
      // that has ever asked for work. Equal to lastSeenAt on purpose: the
      // claim route sets both columns in one UPDATE, so a claim can never be
      // more recent than the last sighting, and this machine's last contact
      // WAS a claim. Three minutes of silence then reads as what it is —
      // presence stale, work loop stopped — which is the pair of facts this
      // column was added to separate.
      lastClaimAt: minutesAgo(3),
      revokedAt: null,
      tokenHash: hashToken(MOCK_NODE_TOKENS['node-operator-thinkpad']!),
    },
    {
      id: 'node-operator-mini',
      ownerId: OPERATOR_OWNER,
      label: 'retired-mac-mini',
      platform: 'darwin/x64',
      acceptJobs: false,
      localModels: [],
      jobKinds: [],
      maxConcurrency: 1,
      createdAt: clock.daysAgo(96),
      lastSeenAt: minutesAgo(20),
      // Never asked for work: presence only, no worker running.
      lastClaimAt: null,
      revokedAt: null,
      tokenHash: hashToken(MOCK_NODE_TOKENS['node-operator-mini']!),
    },
  ];
}

/**
 * The presence rows for that cast.
 *
 * The demo machine's session mirrors the one routes/local-compute.ts announces
 * on a 60-second timer in mock mode — same node, same session id — so the two
 * describe one world instead of fighting over it. Two of its fields are
 * corrected here and NOT there: that announcer names `projectId: 'p-realtime'`
 * and `repo: 'realtime-platform'`, neither of which any seed creates
 * (`schema/seed_program.sql` has `p-realtime-analytics` and
 * `connorhoehnslalom/orgiq-stream-analytics`). Invented wire strings are the
 * floor's rule 2; the route file is not this slice's to edit, so the
 * divergence is reported rather than silently mirrored.
 */
function seededPresence(): NodePresenceRow[] {
  return [
    {
      nodeId: DEMO_NODE_ID,
      lastSeenAt: minutesAgo(0.5),
      sessions: [
        {
          sessionId: 'demo-local-session-0000000000000000000',
          harness: 'claude-code',
          projectId: 'p-realtime-analytics',
          repo: 'connorhoehnslalom/orgiq-stream-analytics',
          branch: 'feat/presence-mesh',
          intent: 'wire the presence mesh into the gateway',
          // The shape tools/local-compute-plugin/orgiq-presence.mjs announces
          // for a plain Claude Code session: `anthropic` unless
          // CLAUDE_CODE_USE_BEDROCK is set, model from the hook event.
          modelProvider: 'anthropic',
          model: 'claude-sonnet-5',
          contextUsed: 0.31,
          memory: { mode: 'pending', pendingOps: 7 },
          startedAt: Date.parse(minutesAgo(52)),
          lastSeenAt: minutesAgo(0.5),
        },
      ],
    },
    {
      nodeId: 'node-operator-thinkpad',
      lastSeenAt: minutesAgo(3),
      sessions: [
        {
          sessionId: 'local-session-thinkpad-00000000000000',
          harness: 'claude-code',
          projectId: 'p-observability',
          repo: 'connorhoehnslalom/orgiq-observability',
          branch: 'fix/span-projector-lag',
          worktree: '~/src/orgiq-observability',
          intent: 'chase the span projector lag to its source',
          touching: [
            'infra/lambda/span-projector/handler.py',
            'schema/observability_schema.sql',
          ],
          modelProvider: 'bedrock',
          model: 'amazon.nova-pro-v1:0',
          contextUsed: 0.62,
          memory: { mode: 'synced', lastPushAt: Date.parse(minutesAgo(4)), pullCursorAgeS: 41 },
          startedAt: Date.parse(minutesAgo(96)),
          lastSeenAt: minutesAgo(3),
        },
      ],
    },
    {
      // Beyond the five-minute horizon. It keeps a session on purpose: an
      // offline node must report NO sessions, and that rule deserves seeded
      // data to hide rather than only a test that announces first.
      nodeId: 'node-operator-mini',
      lastSeenAt: minutesAgo(20),
      sessions: [
        {
          sessionId: 'local-session-mini-000000000000000000',
          harness: 'cursor',
          projectId: 'p-design-v3',
          repo: 'connorhoehnslalom/orgiq-design-system',
          branch: 'chore/token-audit',
          intent: 'audit the colour tokens against the light/dark pairs',
          modelProvider: 'bedrock',
          model: 'amazon.nova-lite-v1:0',
          memory: { mode: 'offline', pendingOps: 3 },
          startedAt: Date.parse(minutesAgo(240)),
          lastSeenAt: minutesAgo(20),
        },
      ],
    },
  ];
}

/**
 * One live, unclaimed pairing code, so `POST /api/local-compute/pair/claim`
 * has something to claim in a world that was just reset. Without it a claim
 * can only ever be exercised after a `pair/start` in the same breath, and the
 * wire sweep resets between writes — so the only shape it could ever pin would
 * be the 404.
 *
 * It expires ten minutes after the fixture materializes, exactly as a minted
 * one does. That is deliberate: a seeded code that never expired would be
 * lying about a TTL the route enforces, and `reset` mints a fresh one.
 */
function seededPairingCodes(): PairingCodeRow[] {
  return [
    {
      // Eight characters from the same unambiguous alphabet
      // `createPairingCode` mints from — no I, L, O, 0 or 1.
      code: 'MKPAD234',
      ownerId: OPERATOR_OWNER,
      expiresAt: new Date(clock.now().getTime() + PAIRING_TTL_MS).toISOString(),
      claimedAt: null,
      claimedNodeId: null,
    },
  ];
}

// ─── The `large` fleet ───────────────────────────────────────────────────────
//
// A density world for the fleet page: enough machines that the list has to
// paginate or scroll, with the status ladder spread across them rather than
// all connected. Ids are generated, so they cannot collide with the seeded
// cast and cannot be mistaken for something a seed file creates.

const LARGE_FLEET = 24;

const fleetId = (n: number): string => `node-fleet-${String(n).padStart(2, '0')}`;

/** Minutes since the machine was last heard from, cycling through all three
 *  horizons so the large world is not a wall of identical green badges. */
const fleetAgeMinutes = (n: number): number => [0.4, 2, 12][n % 3]!;

function largeNodes(): ComputeNodeRow[] {
  return Array.from({ length: LARGE_FLEET }, (_, i) => {
    const n = i + 1;
    return {
      id: fleetId(n),
      ownerId: OPERATOR_OWNER,
      label: `fleet-box-${String(n).padStart(2, '0')}`,
      platform: n % 3 === 0 ? 'linux/x64' : 'darwin/arm64',
      acceptJobs: n % 4 === 0,
      localModels: n % 4 === 0 ? ['llama3.1:8b'] : [],
      jobKinds: n % 4 === 0 ? ['local:distill'] : [],
      maxConcurrency: n % 4 === 0 ? 2 : 1,
      createdAt: clock.daysAgo(LARGE_FLEET - i),
      lastSeenAt: minutesAgo(fleetAgeMinutes(n)),
      // Never asked for work: presence only, no worker running.
      lastClaimAt: null,
      revokedAt: null,
      tokenHash: hashToken(`lcn_mock-fleet-${n}`),
    };
  });
}

function largePresence(): NodePresenceRow[] {
  return Array.from({ length: LARGE_FLEET }, (_, i) => {
    const n = i + 1;
    const seen = minutesAgo(fleetAgeMinutes(n));
    return {
      nodeId: fleetId(n),
      lastSeenAt: seen,
      sessions: Array.from({ length: (n % 3) + 1 }, (_, j) => ({
        sessionId: `local-session-fleet-${String(n).padStart(2, '0')}-${j}`,
        harness: 'claude-code',
        modelProvider: n % 4 === 0 ? 'ollama' : 'bedrock',
        model: n % 4 === 0 ? 'llama3.1:8b' : 'amazon.nova-pro-v1:0',
        lastSeenAt: seen,
      })),
    };
  });
}

// ─── The fixtures ────────────────────────────────────────────────────────────

/**
 * Paired machines — `compute_nodes`.
 *
 * `empty` — nobody has paired a machine, which is the state the "pair your
 *           first machine" copy is for. Declared explicitly: an undeclared
 *           scenario falls back to `default`, so an unwritten `empty` is not
 *           empty.
 * `fresh` — the machines exist and none has ever announced. `last_seen_at` is
 *           NULL, which is a real column state (it is the state a node is in
 *           between claiming a code and its first announce) and the one that
 *           makes every badge in the fleet read `offline`.
 * `large` — 24 machines for density and pagination.
 */
export const computeNodes = defineFixture<ComputeNodeRow>({
  key: 'compute-nodes',
  scenarios: {
    // `default` re-adopts machines paired by hand in this dev session — see
    // mock/dev-pairings.ts for why, and for the env gate that keeps the wire
    // capture and the test suites seeing the seeded world untouched. The other
    // scenarios do NOT: each is a specific world someone asked for, and a real
    // laptop appearing inside `empty` would be the opposite of the request.
    default: () => [...seededNodes(), ...loadDevPairings<ComputeNodeRow>()],
    empty: () => [],
    fresh: () => seededNodes().map((n) => ({ ...n, lastSeenAt: null })),
    large: () => largeNodes(),
  },
});

/**
 * Outstanding pairing codes — `compute_pairing_codes`.
 *
 * `empty` — no code has been minted. This is also what a spent world looks
 *           like after a claim, so it is worth being able to ask for.
 */
export const pairingCodes = defineFixture<PairingCodeRow>({
  key: 'compute-pairing-codes',
  scenarios: {
    default: () => seededPairingCodes(),
    empty: () => [],
  },
});

/**
 * Live presence — the sessions running on those machines.
 *
 * `default` is the demo cast in `dev:mock` and NOTHING anywhere else, for the
 * reason in this module's header: lib/local-compute-fleet.ts is production
 * code, and a fabricated `connected` badge on a real deployment would be worse
 * than a blank one.
 *
 * `fresh`  — the machines are paired and nothing has announced yet, the state
 *            the fleet is genuinely in one second after a middleware restart.
 * `empty`  — the same rows-wise, kept separate because an auditor asking for
 *            `empty` is asking about the page's empty state, not about a
 *            restart.
 */
export const localPresence = defineFixture<NodePresenceRow>({
  key: 'local-presence',
  scenarios: {
    default: () => (mockWorld() ? seededPresence() : []),
    empty: () => [],
    fresh: () => [],
    large: () => (mockWorld() ? largePresence() : []),
  },
});

/**
 * The demo machine's seeded sessions, for the re-announcer in
 * routes/local-compute.ts.
 *
 * It exists because that route used to carry its OWN copy of this session,
 * with `projectId: 'p-realtime'` and `repo: 'realtime-platform'` — two strings
 * no seed creates. The announcer overwrites this node every 60 seconds, so the
 * invented ids won in a live `dev:mock` and the fixture's real ones were never
 * seen. That is floor rule 2 (no invented wire strings) with a timer on it.
 * One cast, defined here, read there.
 */
export function demoPresenceSessions(): LocalSession[] {
  const row = seededPresence().find((p) => p.nodeId === DEMO_NODE_ID);
  return row ? row.sessions.map((s) => ({ ...s })) : [];
}

/**
 * The demo machine's fixed hardware.
 *
 * Core count and installed memory are properties of the LAPTOP, not of a
 * health snapshot — a reading taken a minute later reports the same two
 * numbers. Keeping them here rather than inline in `demoMetrics` says that,
 * lets the load figure scale off the real core count instead of a second
 * hard-coded number that could drift away from it, and keeps rule 1's
 * aggregate heuristic from reading `cpuCount: 10` as a count of fixture rows
 * — it is a leaf fact about the machine, and there is nothing in the repo to
 * derive it from.
 */
const DEMO_HARDWARE = { cpuCores: 10, memTotalMb: 32_768 } as const;

/**
 * The demo machine's health, for the same 60-second re-announcer.
 *
 * Every field is DERIVED from the clock rather than a frozen literal — the
 * mock floor's rule 3 (no import-time timestamps) applied to a metric: a
 * fixed `loadAvg1: 0.8` baked at module load would never move, and "moving"
 * is exactly what this contract promises a real worker's numbers do. A slow
 * sine keeps consecutive 60s re-announces visibly different without needing
 * a stored, mutated value anywhere.
 */
export function demoMetrics(): NodeMetricsSnapshot {
  const seconds = clock.now().getTime() / 1000;
  const wave = (Math.sin(seconds / 240) + 1) / 2; // 0..1, ~8min cycle
  return {
    loadAvg1: Number((0.3 + wave * DEMO_HARDWARE.cpuCores * 0.17).toFixed(2)),
    cpuCount: DEMO_HARDWARE.cpuCores,
    memTotalMb: DEMO_HARDWARE.memTotalMb,
    memFreeMb: Math.round(DEMO_HARDWARE.memTotalMb * (0.3 + (1 - wave) * 0.35)),
    uptimeS: Math.round(seconds % 604_800), // within a week, still moving
    workerVersion: '1.0.0',
    activeJobs: wave > 0.85 ? 1 : 0,
    at: clock.nowIso(),
  };
}

// ─── Selectors and mock writes: the durable half ─────────────────────────────

/** A defensive copy — a caller must not be able to edit the fixture by
 *  reference, and must never receive `tokenHash`. */
function toNode(row: ComputeNodeRow): ComputeNode {
  return {
    id: row.id,
    ownerId: row.ownerId,
    label: row.label,
    platform: row.platform,
    acceptJobs: row.acceptJobs,
    localModels: [...row.localModels],
    jobKinds: [...row.jobKinds],
    maxConcurrency: row.maxConcurrency,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    lastClaimAt: row.lastClaimAt ?? null,
    revokedAt: row.revokedAt,
  };
}

const byId = (id: string): ComputeNodeRow | undefined =>
  computeNodes.rows().find((n) => n.id === id);

/**
 * `SELECT * FROM compute_nodes WHERE token_hash = :hash AND revoked_at IS NULL`.
 *
 * A selector over the rows, not a second index. The old provider kept a
 * `mockTokenIndex` Map beside `mockNodes`; two structures holding one fact is
 * how a claimed node ends up authenticating after its row is gone.
 */
export function mockNodeByTokenHash(tokenHash: string): ComputeNode | null {
  const row = computeNodes.rows().find((n) => n.tokenHash === tokenHash && !n.revokedAt);
  return row ? toNode(row) : null;
}

/** `... WHERE owner_id = :owner AND revoked_at IS NULL ORDER BY created_at`. */
export function mockListNodesByOwner(ownerId: string): ComputeNode[] {
  return computeNodes
    .rows()
    .filter((n) => n.ownerId === ownerId && !n.revokedAt)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .map(toNode);
}

/** `... WHERE revoked_at IS NULL ORDER BY created_at LIMIT 200`. The limit is
 *  not decoration: the Aurora read has one, so a mock without it would render
 *  a page the live path cannot. */
export function mockListAllNodes(): ComputeNode[] {
  return computeNodes
    .rows()
    .filter((n) => !n.revokedAt)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .slice(0, 200)
    .map(toNode);
}

/** `SELECT * FROM compute_nodes WHERE id = :id` — revoked rows included, the
 *  same as the SQL, because the row survives a revoke for audit. */
export function mockGetNode(id: string): ComputeNode | null {
  const row = byId(id);
  return row ? toNode(row) : null;
}

/** `UPDATE compute_nodes SET last_seen_at = NOW() WHERE id = :id`. */
export function mockTouchNode(id: string): void {
  const row = byId(id);
  if (row) row.lastSeenAt = clock.nowIso();
}

/** `UPDATE ... SET last_seen_at = NOW(), last_claim_at = NOW()` — the claim
 *  path bumps both, because asking for work is also being seen. */
export function mockTouchNodeClaim(id: string): void {
  const row = byId(id);
  if (!row) return;
  row.lastSeenAt = clock.nowIso();
  row.lastClaimAt = clock.nowIso();
}

/** `UPDATE ... SET label = :label WHERE id = :id AND owner_id = :owner
 *  RETURNING *` — null means no such row for that owner, not "failed". */
export function mockRenameNode(id: string, ownerId: string, label: string): ComputeNode | null {
  const row = byId(id);
  if (!row || row.ownerId !== ownerId) return null;
  row.label = label;
  return toNode(row);
}

/**
 * `UPDATE compute_nodes SET local_models, job_kinds, max_concurrency,
 *  last_seen_at = NOW() WHERE id = :id AND revoked_at IS NULL RETURNING *`.
 *
 * Note what it does NOT set: `accept_jobs`. That is the owner's switch, and a
 * worker process announcing itself must not be able to opt its owner's machine
 * into the queue. Matching the SQL exactly matters here — the mock is the only
 * place most people will ever exercise this path.
 */
export function mockSetCapabilities(id: string, caps: {
  localModels: string[];
  jobKinds: string[];
  maxConcurrency: number;
}): ComputeNode | null {
  const row = byId(id);
  if (!row || row.revokedAt) return null;
  row.localModels = [...caps.localModels];
  row.jobKinds = [...caps.jobKinds];
  row.maxConcurrency = caps.maxConcurrency;
  row.lastSeenAt = clock.nowIso();
  return toNode(row);
}

/** `UPDATE ... SET accept_jobs = :accept WHERE id = :id AND owner_id = :owner`. */
export function mockSetAcceptJobs(
  id: string,
  ownerId: string,
  acceptJobs: boolean,
): ComputeNode | null {
  const row = byId(id);
  if (!row || row.ownerId !== ownerId) return null;
  row.acceptJobs = acceptJobs;
  return toNode(row);
}

/** `UPDATE ... SET revoked_at = NOW() WHERE id = :id AND owner_id = :owner
 *  AND revoked_at IS NULL RETURNING id` — so revoking twice is false. */
export function mockRevokeNode(id: string, ownerId: string): boolean {
  const row = byId(id);
  if (!row || row.ownerId !== ownerId || row.revokedAt) return false;
  row.revokedAt = clock.nowIso();
  return true;
}

/** `INSERT INTO compute_pairing_codes (code, owner_id, expires_at)`. */
export function mockCreatePairingCode(code: string, ownerId: string, expiresAt: string): void {
  pairingCodes.rows().push({ code, ownerId, expiresAt, claimedAt: null, claimedNodeId: null });
}

/** Owner-scoped read of a code's state — unknown or someone else's code reads
 *  as null so the route can 404 without saying which. */
export function mockPairingCodeStatus(code: string, ownerId: string): PairingCodeRow | null {
  const row = pairingCodes.rows().find((c) => c.code === code && c.ownerId === ownerId);
  return row ? { ...row } : null;
}

/**
 * The claim, offline — both statements the Aurora path runs, in order.
 *
 *   1. `UPDATE compute_pairing_codes SET claimed_at = NOW()
 *       WHERE code = :code AND claimed_at IS NULL AND expires_at > NOW()`
 *      Single-use and expiry are enforced HERE, not by the caller, so a
 *      second claim of one code returns null exactly as the UPDATE matches
 *      no row.
 *   2. `INSERT INTO compute_nodes ... ON CONFLICT (id) DO UPDATE SET label,
 *       platform, token_hash, revoked_at = NULL`
 *      Re-pairing a machine keeps its id, its `created_at` and its OWNER —
 *      the conflict clause updates neither — and clears a previous revoke.
 *      The Map this replaced overwrote the whole row, so a re-pair silently
 *      moved a machine to whoever held the newest code.
 */
export function mockClaimPairingCode(
  code: string,
  node: { nodeId: string; label: string; platform: string | null; tokenHash: string },
): ComputeNode | null {
  const nowMs = clock.now().getTime();
  const pending = pairingCodes.rows().find((c) => c.code === code);
  if (!pending || pending.claimedAt !== null || Date.parse(pending.expiresAt) <= nowMs) return null;
  pending.claimedAt = clock.nowIso();
  pending.claimedNodeId = node.nodeId;

  const existing = byId(node.nodeId);
  if (existing) {
    existing.label = node.label;
    existing.platform = node.platform;
    existing.tokenHash = node.tokenHash;
    existing.revokedAt = null;
    return toNode(existing);
  }
  const created: ComputeNodeRow = {
    id: node.nodeId,
    ownerId: pending.ownerId,
    label: node.label,
    platform: node.platform,
    acceptJobs: false,
    // Freshly paired: it has announced, it has not yet asked for work. The
    // claim route sets this on the first poll.
    lastClaimAt: null,
    localModels: [],
    jobKinds: [],
    maxConcurrency: 1,
    createdAt: clock.nowIso(),
    lastSeenAt: null,
    revokedAt: null,
    tokenHash: node.tokenHash,
  };
  computeNodes.rows().push(created);
  // So a `tsx watch` restart does not silently unpair the machine someone just
  // walked through pairing. No-op unless MOCK_PERSIST_PAIRINGS=1.
  saveDevPairing(created);
  return toNode(created);
}

// ─── Selectors: the presence half ────────────────────────────────────────────
//
// lib/local-compute-fleet.ts mutates `localPresence.rows()` directly, the way
// providers mutate every other fixture. These two exist because "find the row
// for this node" is the one lookup every caller needs and a duplicated
// `.find()` is how two call sites end up disagreeing about identity.

export function presenceRowFor(nodeId: string): NodePresenceRow | undefined {
  return localPresence.rows().find((r) => r.nodeId === nodeId);
}

export function upsertPresenceRow(row: NodePresenceRow): NodePresenceRow {
  const rows = localPresence.rows();
  const i = rows.findIndex((r) => r.nodeId === row.nodeId);
  if (i < 0) rows.push(row);
  else rows[i] = row;
  return row;
}
