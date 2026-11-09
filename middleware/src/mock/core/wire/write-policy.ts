// WHICH WRITES THE CAPTURE IS ALLOWED TO REPLAY, AND WHY.
//
// ── The gap this closes ─────────────────────────────────────────────────────
//
// `capture.ts` GETs the real surface and snapshots what the server actually
// sends, so a fixture can be measured against reality instead of memory. It was
// GET-only, and `allow.ts` said so out loud: one of the three legitimate
// reasons to exempt a fixture was "the string only exists after a POST, and
// capture is GET-only". That left every POST/PUT/PATCH response shape in this
// app unpinned — the create/update/decide/dispatch responses, which are exactly
// the ones a portal page reads straight back into its own state. The
// `enterprise` / `enterprise_context` bug could ship there today and every
// check would stay green.
//
// ── Why a write capture needs a policy at all ───────────────────────────────
//
// A GET is a question. A write is an act: it can spend money, call a real cloud
// API, arm a scheduler, or delete a row the next check reads. So the capture
// does NOT replay "the write routes"; it replays the writes someone has read
// the handler for and written down a reason for. Everything else is REFUSED,
// by a stated rule, and the refusal is part of the output.
//
// That is deliberately an ALLOWLIST. A denylist would mean a route added
// tomorrow is replayed tomorrow, by a harness that has never seen its handler,
// against whatever it happens to reach — and the failure mode of getting that
// wrong is not a red test, it is a bill or a wiped table. An allowlist's
// failure mode is a gap, and a gap is printed.
//
// ── What "safe to replay" means ─────────────────────────────────────────────
//
// A route may be replayed only when ALL of these hold, with the handler read:
//
//   1. It spends nothing. No Bedrock model call, no AgentCore runtime
//      invocation, no AWS SDK call of any kind under the mock providers.
//   2. It reaches nothing real. No outbound fetch, no S3 object, no devbox
//      microVM, no browser or code-interpreter session, no SSM write.
//   3. It is not destructive. It does not remove a row.
//   4. It does not arm or fire anything. No cron registration, no agent job
//      enqueued for the fleet dispatcher, no background timer.
//   5. It leaves no SEEDED row in a state the sweep cannot put back. The sweep
//      calls `POST /api/__mock/reset` before every replay, which restores every
//      REGISTERED fixture — so a route backed by one may change whatever it
//      likes. Against a provider whose rows are a bare module-level array a
//      replay may only APPEND (harmless — the shape is unchanged and nothing
//      seeded moved) or write a value back UNCHANGED (an echo-back patch: it
//      exercises the write path and returns the real response shape while
//      leaving the row byte-identical). It may not flip a seeded row's state:
//      that is the exact damage the control plane exists to prevent —
//      "promo-aurora-cold-start is now Promoted until the middleware restarts",
//      quoted in docs/mock-floor.md.
//
//      WHAT CHANGED. This paragraph used to name eight provider domains (bots,
//      sprints, grants, work-items, promotions, session-bundle, lab,
//      prompt-evals) as holding their rows in arrays that register no fixture.
//      All eight register one now — `bots`/`bot-runs`, `sprints`,
//      `budget-grants`/`initiative-budgets`, `work-items`,
//      `promotion-candidates`, `session-bundles`, `lab-experiences`/
//      `lab-consults`, `prompt-eval-cases`/`prompt-eval-runs` — so reset puts
//      each of them back and the echo-back workaround is no longer needed
//      there. `defineFixture` is what moved those routes onto the allowlist,
//      and the same migration has since emptied the `unresettable` rule's list
//      entirely — the rule stays stated, for a provider that goes back to a
//      bare array. A refusal whose stated reason has stopped being true is
//      worse than no refusal: it reads as a considered decision.
//   6. Its body can be synthesised from the route's OWN validation and from
//      rows the server itself hands back. Never from imagination: an invented
//      body is the same class of fiction this whole harness exists to stop.
//
// ── "It spends" vs "it would spend, but this process intercepts it" ─────────
//
// Rules 1 and 2 say a route may be replayed only when it spends nothing and
// reaches nothing real, and the `spends` refusal below adds the sentence that
// makes that rule honest: a call is harmless on a laptop only because this
// process has no cluster and no credentials, "which is a property of the
// laptop, not of the route, and a policy that leans on it is one
// `WIRE_BASE_URL` away from being wrong."
//
// That sentence is right, and it was also being used to refuse a family of
// routes it does not describe. `POST /api/capabilities/browser-sessions` does
// not fail offline for want of credentials: `providers/index.ts` binds
// `agentcore` to `mockAgentCore` at module load when MOCK_AGENTCORE is set, so
// the handler's `agentcore.createBrowserSession(...)` IS the fixture write —
// there is no AWS call to fail. Same for `mockGuardrails` under the guardrail
// patches, and for the whole local-compute surface under MOCK_AURORA. Refusing
// those with "replaying it costs money" states something untrue about the
// process being captured, and a refusal whose stated reason is false reads as
// a considered decision when it is a mistake.
//
// So which is it — a property of the route, or of the configuration?
//
// BOTH, and the policy now says which half is which. The route property is:
// *this route spends unless the process serving it intercepts the provider it
// spends through.* That is true everywhere and needs no laptop to hold. The
// configuration question — is THIS process intercepting it? — is not something
// this file may assume, and it is not something the laptop's own environment
// can answer either, because the capture may be pointed anywhere with
// `WIRE_BASE_URL`. It is a fact about the server, so it is ASKED OF THE SERVER:
// `GET /api/health` reports `mocks: { aurora, agentcore, guardrails,
// cloudwatch }`, and `capture-writes.ts` reads it before it replays anything.
//
// A spec that leans on interception declares it (`intercepts: ['agentcore']`)
// and is REFUSED BY DEFAULT — rule `not-intercepted`. It is admitted only when
// the server the capture is talking to has said, of itself, that it is running
// those mock providers. Point the capture at a real deployment and every one
// of these refuses itself, by mechanism rather than by the author having
// remembered; lose the health endpoint and the capture stops rather than
// guessing (`capture-writes.ts` treats an unreadable `/api/health` as fatal).
//
// WHY A PRECONDITION AND NOT JUST A RULE ID. A distinct refusal id — "spends,
// unless the mock providers intercept it" — would have been the smaller
// change, and it would have left the same hole: it is still this file
// ASSERTING something about a configuration it cannot see, which is exactly
// the failure mode the `spends` sentence warns about. Naming the assumption
// does not check it. A precondition checked against the server's own statement
// about itself is the same discipline every `build` below already follows,
// where every value in a request body comes from the server rather than from
// memory. The reasoning belongs in the same place as the reason.
//
// WHAT THIS DOES NOT DO. It does not make a spend safe. Routes that spend in
// EVERY configuration stay in `SPENDS` and are enumerated there rather than
// wildcarded — `POST /api/capabilities/browser/web-qa` builds its own
// `BedrockRuntimeClient` in the handler and calls Converse with no mock branch
// above it; `POST /api/capabilities/browser/crawl` starts a loop that fetches
// real pages. The wildcards over `/api/capabilities/*` said both of those
// things about the guardrail patches too: of the ten writes under that prefix
// they actually caught (the four DELETEs hit `destructive` first), exactly two
// were what they described.
//
// WHAT IS STILL UNDECLARED. `intercepts` was retrofitted onto every entry
// already on this list whose own `safe` sentence NAMES the flag it leans on —
// `MOCK_AGENTCORE`, `MOCK_AURORA`, `config.mock.aurora` — so each label is
// copied from the reading that entry was written from rather than from a fresh
// guess. (This paragraph used to say "fifteen of them" and was wrong within two
// slices: it is a count of a list this file keeps growing. A number that has to
// be re-derived on every edit is a stale reason waiting to happen, which is the
// exact failure the rest of this header is about, so it is gone.) Four entries
// say only "under the mock providers"
// (`POST /api/assessment/teams/:id/intake/text`, `POST
// /api/assessment/knowledge/doc/comment`, `POST
// /api/work/findings/analyze-batch`, `POST /api/designs/:id/signoff`). Those
// are very likely `aurora`, and "very likely" is not the standard this file
// holds a `safe` string to, so they are left undeclared and named here
// instead — a printed gap, and a small one to close by reading four
// providers. Undeclared means they replay exactly as they did before; it does
// NOT mean somebody checked and found them independent of the mocks.
//
// ── Re-reading the refusals, and why it keeps paying ────────────────────────
//
// A refusal is not written once. The reasons below describe HANDLERS, and the
// handlers move — usually because somebody gave a provider a mock branch, which
// is a good thing that silently falsifies a sentence in this file. Three sweeps
// have now been run over the whole refusal list and every one found rot: a
// route refused as "answers 503 without writing" that returned 200 and wrote;
// three refused as "drives a devbox microVM" when none did; one pattern that
// matched no live route at all. The third sweep (2026-09) found SIXTEEN more,
// all of the same shape — the mock branch arrived and the reason did not:
//
//   * `POST /harness/runs/:runId/results` and `POST /harness/promote` —
//     "through the RDS Data API with no mock branch"; both branch now.
//   * `POST /calibration/cases`, `POST /quality/feedback`, `POST
//     /memory/events` — the same sentence, the same answer.
//   * `POST /devbox/:sessionId/task`, `/command`, `/shell-url` — all three
//     named a microVM or a ListAgentRuntimes call that MOCK_AGENTCORE has not
//     made for some time; `/shell-url` has its own mock branch above the
//     resolver.
//   * `POST /agent-projects/:id/runs` and `POST /sdlc/changes/:id/address` —
//     "drives a devbox microVM"; what they really do is return before their
//     own work finishes, which is `fires`, not `spends`.
//   * `POST /agent-projects/:id/clone-command` — "borrows the connection's real
//     API key"; `borrowApiKey` throws under MOCK_AGENTCORE on purpose, so
//     `buildCloneCommand` never calls it offline — it builds the command with
//     the token left out (every seeded repository is private and carries a
//     connection).
//   * `POST /sdlc/changes/:id/rereview` — "no mock branch" above a Converse
//     that has had one, deliberately placed above the try, since the offline
//     reviewer shipped.
//   * `POST /agents/:agentId/invoke` — "invokes an AgentCore runtime", which
//     `mockAgentCore.invokeAgentStreaming` makes false. It STAYS refused, on a
//     reason the old one never mentioned: the unawaited session-title Converse
//     in `lib/session-titles.ts`. Re-reading a refusal is not a search for
//     routes to release; it is a search for sentences that are no longer true,
//     and one of them was hiding a spend the file had never named.
//   * `POST /harness/trace`, `POST /harness/results/:id/rejudge`, `POST
//     /harness/runs/:id/execute`, `POST /calibration/runs` — the judge and the
//     embedder. These five paragraphs were WRITTEN, in this file, saying those
//     four still spent, and were false within the hour: `lib/judge.ts`,
//     `lib/trace-sink.ts` and `lib/harness-runner.ts` all gained
//     `config.mock` branches mid-sweep. `/invocations/:id/replay` kept its
//     refusal by a hair — its libraries are mocked too, but the handler's own
//     source `SELECT` is a bare `exec` — so its reason had to be rewritten
//     around what is left rather than deleted.
//
// That last bullet is the lesson worth keeping. A refusal reason is a claim
// about somebody else's file, and it can be falsified by an edit that lands
// while you are typing. That is not an argument for vaguer reasons — a vague
// reason cannot be checked, and an unfalsifiable claim is worse than a stale
// one. It is an argument for re-reading, for saying which reading a sentence
// came from, and for taking the capture LAST: `serverHandlerSha` in the
// snapshot exists precisely so a capture taken against a process older than
// these edits is caught rather than trusted.
//
// What did NOT move is worth recording too, because "I checked" is only
// evidence if the negatives are written down. `POST /environments`,
// `POST /admin/kb-registry`, `/upload-links` and `POST /iq/prompts/*` still
// reach the Data API raw; `POST /test-fixtures/*` still DELETEs and UPDATEs
// through it; `POST /canary/start` still PutParameters two ARNs to SSM and the
// canary LIBRARY writes still create and publish real Bedrock managed prompts
// (the three `config.mock` branches in routes/canary-library.ts are all on
// GETs); `POST /gateway/channels/*` still signs and POSTs to the gateway;
// `lib/crawler.ts` and `lib/site-survey.ts` still fetch. In `FIRES`, every
// reason was re-read against its handler: `addSchedule` still persists the
// JSON and calls `registerTask`, `resume` still calls `registerBot`,
// `enqueueJob`'s mock branch still pushes a `queued` job the dispatcher polls,
// and the assessment-run and compaction timers are still there. Every pattern
// in `SPENDS` and `FIRES` was also matched against the live router table —
// none is dead.
//
// ── How a future route gets classified ──────────────────────────────────────
//
// It does not, until someone reads its handler. A new write route is
// `unclassified` — the catch-all refusal below — and shows up in the writes
// snapshot as such on the very next capture. To move it, add a `WriteSpec`
// entry with `safe` (why the six rules above hold) and `bodyFrom` (which lines
// of the handler's own validation the body comes from). Both are required, on
// the same contract as `allow.ts`: an exemption with no reason is not an
// exemption, and a replay with no stated reason is not a decision.
//
// If the body cannot be synthesised, say so with `unsynthesisable('why')` and
// the route is recorded as uncaptured WITH THAT REASON. That is not a failure.
// A visible gap beats an assumed-away one — the same rule the GET sweep's
// `skipped` list already follows.

import { MOCK_NODE_TOKEN, MOCK_NODE_TOKENS, pairingCodes } from '../../local-compute.js';
import { type PersonaName } from './http.js';
import { type Json } from './shape.js';

// The imports above are the only VALUES this policy takes from outside
// itself, and all are credentials-shaped things that must not be retyped:
// the seeded node tokens and the seeded pairing code are defined in
// mock/local-compute.ts, which is also what the server serves them from. A
// copy here would be a second source of truth for a string whose whole job is
// to match — the `enterprise` / `enterprise_context` bug, with a bearer token.

// ---------------------------------------------------------------------------
// Building a body
// ---------------------------------------------------------------------------

/** Marks a route whose body cannot be built from the server + its own source. */
export interface Unsynthesisable {
  unsynthesisable: string;
}

export const unsynthesisable = (why: string): Unsynthesisable => ({ unsynthesisable: why });

export function isUnsynthesisable(v: Json | Unsynthesisable): v is Unsynthesisable {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && 'unsynthesisable' in v;
}

/**
 * What a body builder is allowed to draw on: the live server, and nothing else.
 * There is no `random()`, no clock and no id generator here on purpose — every
 * value in a replayed body is either a literal the handler's own source spells
 * or a row the server just handed back.
 */
export interface BodyContext {
  /** The RESOLVED request path, `:params` already filled from the server. */
  path: string;
  /** GET a path as the replay persona. `null` unless it answered 200 with JSON. */
  get(path: string): Promise<Json | null>;
  /** First value of `field` anywhere in `path`'s body — the id the route wants. */
  pick(path: string, field: string): Promise<string | null>;
  /**
   * A name that is unique within one capture run but stable in SHAPE, so a
   * created row is distinguishable without a clock or a random number (rule 3
   * of the floor forbids both in a fixture, and a snapshot diff full of churn
   * is unreadable). `wire-capture-1`, `wire-capture-2`, …
   */
  label(): string;
}

/** Every object in a body that carries all of `keys`, in document order. */
export function objectsWith(v: Json | null, ...keys: string[]): Array<Record<string, Json>> {
  const out: Array<Record<string, Json>> = [];
  const walk = (node: Json): void => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const item of node) walk(item); return; }
    if (keys.every((k) => k in node)) out.push(node);
    for (const child of Object.values(node)) walk(child);
  };
  if (v !== null) walk(v);
  return out;
}

/** Narrow a Json to a string, or `null` — every builder wants exactly this. */
export function str(v: Json | undefined): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * A provider domain `providers/index.ts` can swap for a mock, exactly as
 * `GET /api/health` spells it under `mocks`. Not retyped from memory: the
 * union below is checked against a live `/api/health` by
 * `wire/__tests__`-adjacent code paths and by `capture-writes.ts`, which
 * refuses to replay an interception-dependent spec when the server does not
 * report the flag.
 */
export type MockProvider = 'aurora' | 'agentcore' | 'guardrails' | 'cloudwatch';

export interface WriteSpec {
  /** `POST /api/bots` — as `routeKey()` spells it. */
  route: string;
  /** Which captured session may call it. */
  persona: PersonaName;
  /** Why replaying it satisfies the six rules above. Required. */
  safe: string;
  /** Which of the handler's own validation the body is derived from. Required. */
  bodyFrom: string;
  /**
   * Provider domains that must be INTERCEPTED on the server being captured
   * for `safe` to hold — see the header's "it spends vs it would spend"
   * section. Declaring one makes the spec refused by default (`not-intercepted`)
   * and replayable only against a server whose own `GET /api/health` reports
   * every named flag true. Omit it only for a route that reaches nothing real
   * in ANY configuration.
   */
  intercepts?: readonly MockProvider[];
  /**
   * Extra request headers. The one use is machine-callback auth: a handful of
   * routes authenticate with `Authorization: Bearer <node token>` INSTEAD of a
   * session, so a persona cookie alone gets a 401 from them.
   */
  headers?: Readonly<Record<string, string>>;
  /** Build the request body. Omit for a route that takes none. */
  build?(ctx: BodyContext): Promise<Json | Unsynthesisable>;
  /**
   * Statuses whose body is still a real shape worth pinning. 2xx is always
   * accepted; a route whose interesting answer is a 409 (the money gates name
   * `gate` and `confirmFlag` there) says so here.
   */
  alsoAccept?: readonly number[];
}

// ---------------------------------------------------------------------------
// The refusals
// ---------------------------------------------------------------------------

export interface RefusalRule {
  /** Short id, printed in the snapshot: `destructive`. */
  id: string;
  /** The rule itself, stated so a future route can be tested against it. */
  because: string;
  /** Does this rule cover `route` (`DELETE /api/bots/:id`)? */
  applies(route: string): boolean;
  /** Optional extra clause naming what THIS route reaches. */
  detail?(route: string): string | null;
}

/**
 * A trailing `/*` matches everything below that path; a `*` anywhere else
 * matches exactly one path segment, which is how a `:id` in the middle of a
 * route is written, as in the pause/resume pair under /api/bots. No star at
 * all means an exact route key.
 */
function routeMatches(pattern: string, route: string): boolean {
  if (pattern.endsWith('/*')) return route.startsWith(pattern.slice(0, -1));
  if (!pattern.includes('*')) return pattern === route;
  const rx = pattern.split('*').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]+');
  return new RegExp(`^${rx}$`).test(route);
}

interface Family {
  /** `POST /api/capabilities/*` or an exact route key. */
  pattern: string;
  /** What this family reaches — the clause appended to the rule. */
  what: string;
}

/**
 * Rules 1/2: replaying these reaches a real cloud resource. Two kinds sit here
 * and both belong: a call that SPENDS (a model, an agent runtime, an optimizer)
 * and a call that WRITES somewhere durable (S3, SSM, a Bedrock prompt resource,
 * the RDS Data API with no `config.mock` branch above it). The second kind is
 * harmless on a laptop only because this process has no cluster and no
 * credentials — which is a property of the laptop, not of the route, and a
 * policy that leans on it is one `WIRE_BASE_URL` away from being wrong.
 *
 * That sentence is what keeps this list honest, and it is ALSO what keeps this
 * list from growing to cover routes it does not describe. "No credentials, so
 * it fails" and "this process binds a mock provider, so there is nothing to
 * call" are not the same claim: the first is about the laptop, the second is
 * about the server, and only the first is unknowable from here. A route of the
 * second kind belongs in `intercepts` on its allowlist entry, where the claim
 * is CHECKED against `GET /api/health` on whatever `WIRE_BASE_URL` names,
 * rather than in this list under a reason that is false wherever the mock is
 * bound. See the header's "it spends vs it would spend" section.
 */
const SPENDS: Family[] = [
  // The reason here used to be "invokes an AgentCore runtime", and that half is
  // now false wherever agentcore is intercepted: `providers/index.ts` binds
  // `agentcore` to `mockAgentCore`, whose `invokeAgentStreaming` yields a canned
  // AG-UI stream and reaches no runtime. What keeps this route in `spends` is a
  // different call the reason never named, and one no configuration mocks —
  // which is exactly why the reason had to be re-read rather than deleted.
  { pattern: 'POST /api/agents/*', what: "after the answer streams it calls `maybeGenerateTitle`, and lib/session-titles.ts sends a Bedrock ConverseCommand with no mock branch above it — unawaited, so the spend outlives the request" },

  // Capabilities, narrowed. This used to be a bare `POST /api/capabilities/*`
  // ("opens a real Browser or Code Interpreter session") plus `PATCH
  // /api/capabilities/*` ("edits a live Bedrock Guardrail"), which between
  // them described TWO of the fourteen writes under this prefix. The rest go
  // through `providers/index.ts`, which binds `agentcore`/`guardrails` to the
  // mock implementations when their flags are set — so under the mock
  // providers there is no Browser, no Code Interpreter and no Bedrock
  // Guardrail to reach, and the handler's call IS a fixture write. Those now
  // carry `intercepts` and are refused unless the server says so itself. These
  // two stay, because neither has a mock branch in any configuration:
  { pattern: 'POST /api/capabilities/browser/web-qa', what: "builds its own BedrockRuntimeClient in the handler and Converses with Nova Lite — `_bedrockRt` is module-scope in routes/capabilities.ts, with no provider and no mock branch above it" },
  { pattern: 'POST /api/capabilities/browser/crawl', what: 'starts a crawl loop (lib/crawler.ts) that fetches the start URL and every page it discovers' },

  // Devbox: GONE from this list entirely, and that is the second half of the
  // same correction. `POST /*/task`, `POST /*/command` and `POST /*/shell-url`
  // read "invokes the devbox runtime" / "resolves it via ListAgentRuntimes,
  // then presigns a live socket". None of the three is true under
  // MOCK_AGENTCORE: `lib/devbox-arn.ts` returns a `…-MOCK` ARN without calling
  // ListAgentRuntimes and `devboxDataClient()` returns `mock/devbox-shell.ts`,
  // a fake microVM (routes/devbox.ts keeps its own copy of both, same
  // branches); `shell-url` never even reaches the resolver — it has its own
  // `mockAgentCore()` branch that answers with a `mock-shell://` URL. Verified
  // by hand against a running mock server: `POST /command` with `git status`
  // streamed `fatal: mock devbox: unsupported command …` back from the fixture
  // workspace and `shell-url` answered `{"url":"mock-shell://…","mock":true}`.
  // `/task` moved to `fires` (it registers a box for the reaper), and
  // `/command` and `/shell-url` are on the allowlist behind
  // `intercepts: ['agentcore']`, where the claim is checked against the server
  // rather than asserted here.
  //
  // Agent projects, narrowed again. `POST /*/runs` read "drives a devbox
  // microVM (lib/project-runner.ts)" — it drives the fake one, and what it
  // really does that outlives the request is leave `executeProjectRun`
  // unawaited, so it moved to `fires`. `POST /*/clone-command` read "borrows
  // the connection's real API key through AgentCore Identity"; `borrowApiKey`
  // THROWS under MOCK_AGENTCORE by design (providers/connected-sources.ts
  // refuses to hand out a fake token), so `buildCloneCommand` does not call it
  // offline: it builds the credentialed command with the token left out — it
  // is on the allowlist now.
  { pattern: 'POST /api/drop/*', what: 'reaches the RDS Data API unguarded, then S3' },
  { pattern: 'POST /api/gateway/channels/*', what: 'retired generic signing bridge; returns 410 without an upstream call' },

  // Ingest: enumerated, not wildcarded — `POST /api/ingest/start` next door IS
  // mock-branched and is on the allowlist, so a wildcard here would be wrong.
  { pattern: 'POST /api/ingest/crawl', what: 'fetches the target URL and runs the Bedrock vision extractor' },
  { pattern: 'POST /api/ingest/survey', what: 'fetches robots.txt and every discovered page' },
  { pattern: 'POST /api/ingest/upload', what: 'writes an uploaded object to S3' },

  { pattern: 'POST /api/admin/kb-registry', what: 'INSERTs through the RDS Data API with no mock branch' },
  { pattern: 'POST /api/admin/kb-registry/upload-links', what: 'INSERTs through the RDS Data API with no mock branch' },
  { pattern: 'POST /api/admin/kb-registry/*/landing-zone/upload', what: 'writes the uploaded object to S3' },

  // `POST /api/admin/kb-registry/*/sync` LEFT this list, and the entry was
  // right when it was written: the handler built its own
  // StartIngestionJobCommand and sent it, so offline it reached the real
  // account and answered a live AccessDeniedException — the Knowledge page's
  // primary button could not work under dev:mock at all. This list correctly
  // recorded that and correctly kept the capture away from it, which is also
  // why nothing ever forced the fix: an accurate note about a broken button is
  // still a broken button. It now delegates to `startIngestionJob`, the same
  // provider `POST /api/ingest/start` uses, so it inherits the MOCK_AGENTCORE
  // branch, the already-running guard and the shared failure classifier. It is
  // on the allowlist behind `intercepts: ['agentcore']`, where the claim is
  // checked against a running server instead of asserted here.

  // SDLC: all three left this list, for the same reading. `/rereview` said
  // "sends the diff to Bedrock Converse (lib/change-reviewer.ts, no mock
  // branch)" — there IS a branch, `if (config.mock.agentcore)` above the try,
  // handing the diff to `mock/static-review.ts`; replayed by hand it answered
  // 200 and recorded a review whose model reads `offline/static-diff-review`,
  // and reset dropped it. `/address` and `/deliver` both said "resolves the
  // devbox runtime via ListAgentRuntimes", which `lib/devbox-arn.ts` has not
  // done under MOCK_AGENTCORE for some time. `/address` is `fires` (it goes
  // through the same unawaited `dispatchGovernedRun` as a project run);
  // `/rereview` and `/deliver` are on the allowlist behind `intercepts`.

  { pattern: 'POST /api/environments', what: 'INSERTs through the RDS Data API with no mock branch' },

  // THE WHOLE HARNESS/JUDGE FAMILY LEFT THIS LIST, and it left in one day.
  // `/trace` read "runs Titan embedding AND the Nova judge — it spends even
  // with Aurora down", which was the strongest claim in this file and is now
  // the most comprehensively false one: `lib/trace-sink.ts` embeds through
  // `mock/embedding.ts`'s lexical projection under `config.mock.agentcore`,
  // `lib/judge.ts` answers from `mock/answer-check.ts` under the same flag,
  // and every persistence step branches on `config.mock.aurora` into the
  // `trace-sink-*` fixtures. Replayed by hand it answered 200 with
  // `judgeRationale: "offline/lexical-answer-check: … No model was called."`.
  // `/results/*/rejudge` ("re-judges with three Nova calls") is the same
  // judge, three times — it returned three identical offline verdicts.
  // `/runs/*/execute` ("invokes the fleet and the judge per case") invokes the
  // MOCK fleet now, and what actually disqualifies it is that it answers 202
  // and leaves `void executeRun(...)` behind, so it is `fires`.
  // `/calibration/runs` is the one that refuses ITSELF: routes/calibration.ts
  // answers 503 under `config.mock.aurora` rather than synthesising an MAE for
  // a judge nobody ran. All four are on the allowlist with `intercepts`, where
  // the interception is checked against the server instead of assumed.
  //
  // `/runs/:runId/results` and `/promote` were the same story a slice earlier —
  // "through the RDS Data API with no mock branch" against handlers that now
  // branch into `mockUpsertResult` / `mockPromotePromptVersion`.
  //
  // `PATCH /api/observability/harness/runs/*/results` was here too and matched
  // nothing: the only PATCH under /runs is `PATCH /runs/:id`, which the
  // allowlist covers. A pattern that matches no live route is dead weight that
  // reads like a guarded surface.
  //
  // Three more "no mock branch" claims died the same way and left this list:
  // `POST /calibration/cases` (branches into `mockInsertCalibrationCase`),
  // `POST /quality/feedback` (into `mockSetHumanLabel`) and `POST
  // /memory/events` (into `mockInsertMemoryEvent`).
  { pattern: 'POST /api/observability/test-fixtures/*', what: 'DELETEs and UPDATEs through the RDS Data API with no mock branch' },
  // Survives the same sweep, and only just: the LIBRARIES it calls are all
  // mocked now, but the handler's own source lookup is a bare `exec` with no
  // branch above it (routes/invocations.ts, `SELECT agent_id … FROM
  // observability.invocation_traces`), so the Data API is still reached before
  // anything else happens. The old reason named the model calls, which is the
  // half that stopped being true.
  { pattern: 'POST /api/observability/invocations/*', what: "the handler's own source-row `SELECT` is a bare `exec` with no mock branch, so it reaches the RDS Data API before the (now-mocked) invoke, embed and judge are ever entered" },
  { pattern: 'PUT /api/observability/evaluations/config', what: 'writes the judge config to SSM, changing live judging for the whole fleet' },
  { pattern: 'POST /api/observability/canary/ask', what: 'streams from a Bedrock prompt ARN and fires the judge' },
  { pattern: 'POST /api/observability/canary/start', what: 'writes both subject ARNs to SSM' },
  { pattern: 'POST /api/observability/canary/library', what: 'creates a real Bedrock managed prompt' },
  { pattern: 'POST /api/observability/canary/library/*', what: 'publishes, invokes or optimizes a real Bedrock managed prompt' },
  { pattern: 'PUT /api/observability/canary/library/*', what: 'updates a real Bedrock managed prompt' },
  { pattern: 'POST /api/iq/prompts/experiments/*', what: 'upserts through the RDS Data API with no mock branch' },
  { pattern: 'PUT /api/iq/prompts/meta/*', what: 'upserts through the RDS Data API with no mock branch' },
];

/**
 * Rule 4: replaying these arms or fires something that outlives the request.
 * The seeded bots are parked deliberately (CLAUDE.md) so the scheduler cannot
 * fire against repos that do not exist yet; a capture that resumes one leaves a
 * cron armed behind it.
 */
const FIRES: Family[] = [
  // The pipelines tenant's runbook dry-run (lane P2): it enqueues an
  // `agent_jobs` row of kind `runbook:dry-run` that the already-running fleet
  // dispatcher claims for any idle box and plays through — the job outlives
  // the capture, exactly the `fires` shape.
  { pattern: 'POST /api/pipelines/definitions/*/dry-run', what: 'enqueues a `runbook:dry-run` agent job the running fleet dispatcher claims for an idle box and plays through, outliving the capture' },
  // Moved here out of `spends`, where it read "drives a devbox microVM" — it
  // does not drive one, it hands one to the reaper. `startReaper` is running
  // from boot (index.ts, leader-elected since DE-47), and a registered box enters
  // its sweep: twenty idle minutes later the reaper sends
  // StopRuntimeSessionCommand for that box's session, through whatever
  // transport `dataClient()` resolved to. `lib/devbox-fleet.ts` holds the
  // registry in a module Map that registers no fixture, so `POST
  // /api/__mock/reset` cannot take the box back either — the capture would
  // leave a timer's worth of work behind it, which is rule 4 exactly.
  { pattern: 'POST /api/devbox/boxes', what: 'registers a box the already-running devbox reaper will stop, through the runtime transport, twenty idle minutes later' },
  // Moved out of `spends`, which said "invokes the devbox runtime to run a
  // Claude Code task" — under MOCK_AGENTCORE it invokes `mock/devbox-shell.ts`.
  // What it does in EVERY configuration is the line above `dataClient().send`:
  // `getBoxBySession(sessionId) ?? registerBox({ sessionId })`, which is the
  // identical rule-4 problem `POST /boxes` is refused for, plus a task-event
  // tee into that box's buffer.
  { pattern: 'POST /api/devbox/*/task', what: 'auto-registers the session as a box (`getBoxBySession(...) ?? registerBox(...)`) and tees its events there, handing the already-running reaper a box to stop — and lib/devbox-fleet.ts holds that registry in a module Map reset cannot empty' },
  // Both of these go through `dispatchGovernedRun` (lib/sdlc-pipeline.ts),
  // which returns after starting `void executeProjectRun(...)`: the run, the
  // diff capture, the review and the gate evaluation all happen after the 202.
  // It registers a box on the way, too. Their old `spends` reasons named
  // ListAgentRuntimes and a microVM, neither of which is reached under
  // MOCK_AGENTCORE; this is what is true whatever the flags say.
  { pattern: 'POST /api/agent-projects/*/runs', what: 'answers 202 and leaves `executeProjectRun` running unawaited (`void` in lib/sdlc-pipeline.ts), which then captures a diff, reviews it and evaluates gates — and registers a box for the reaper on the way' },
  { pattern: 'POST /api/sdlc/changes/*/address', what: 'the same unawaited `dispatchGovernedRun` as a project run, with the reviewer’s findings as the prompt' },
  // Also out of `spends`, where it read "invokes the fleet and the judge per
  // case": lib/harness-runner.ts branches on `config.mock.agentcore` for both.
  // What is true in every configuration is the shape of the handler — it
  // answers 202 and leaves the suite running, which is why the client polls
  // /runs/:id/status. Replayed by hand it returned `{started: true,
  // totalCases: 4}` and went on writing results after the response.
  { pattern: 'POST /api/observability/harness/runs/*/execute', what: 'answers 202 and leaves `void executeRun(...)` walking the whole case suite behind it, writing a result row per case long after the request is over' },

  { pattern: 'POST /api/bots/*/run', what: 'fires the bot now' },
  { pattern: 'POST /api/bots/*/resume', what: 'arms the bot on the live cron scheduler' },
  { pattern: 'PATCH /api/bots/*', what: 'calls registerBot, which re-arms the patched bot on the live cron scheduler' },
  { pattern: 'POST /api/bots/dispatch-work', what: 'authorizes a run and enqueues it for the fleet dispatcher' },
  { pattern: 'POST /api/work/dispatch', what: 'drives one dispatcher tick synchronously, claiming queued jobs' },
  // `providers/agent-jobs.ts`'s queue is a registered fixture now
  // (`mock/agent-jobs.ts` — `agent-jobs`), so the row this enqueues is no
  // longer the problem; `POST /api/__mock/reset` takes it back exactly the
  // way it takes back everything else in that fixture. What keeps this route
  // refused is `lib/job-dispatcher.ts`'s tick: `startJobDispatcher()` runs an
  // unconditional `setInterval` (not gated by any `config.mock` flag) that
  // claims and RUNS a queued `devbox:task` row within `JOB_DISPATCH_INTERVAL_MS`
  // (10s default) through `runDevboxTask` — real AgentCore spend unless the
  // server being captured happens to intercept it, which this policy has no
  // way to require the way `intercepts` does for a route's OWN handler. An
  // enqueued `local:*` job is worse in a different way: the push-side
  // dispatcher excludes local kinds by construction (`claimNextJob`'s `kind
  // NOT IN` clause), so nothing here claims it automatically, but nothing
  // targets it to one machine either — it sits claimable by ANY real paired
  // local worker polling this exact server. Both outcomes outlive the
  // request, which is rule 4, independent of the fixture behind the row.
  { pattern: 'POST /api/work/jobs', what: "enqueues into the registered `agent-jobs` fixture (reset restores it), but the always-running job-dispatcher timer claims and runs a `devbox:task` row for real within ~10s, and an untargeted `local:*` row is claimable by any real paired local worker polling this server — both outlive the request" },
  { pattern: 'POST /api/work/jobs/*/requeue', what: 'enqueues a fresh copy of the job' },
  { pattern: 'POST /api/work/findings/*/promote', what: 'enqueues an agent job the dispatcher will claim' },
  { pattern: 'POST /api/assessment/runs', what: 'starts progress timers that auto-complete the run eight seconds later' },
  { pattern: 'POST /api/assessment/teams/*/decks', what: 'launches a draft-review-deck run whose eight-second timer writes a deck revision' },
  { pattern: 'POST /api/assessment/decks/*/revise', what: 'launches a revise-review-deck run whose eight-second timer writes a deck revision' },
  { pattern: 'POST /api/pipelines/decks/*/revise', what: 'starts a requester-private flow run whose executor appends a deck revision after the response, so a reset can land before it writes' },
  { pattern: 'POST /api/assessment/knowledge/pull', what: 'schedules a deferred pull that mutates the section 1.5s later' },
  { pattern: 'POST /api/ingest/schedules', what: 'writes ingest-schedules.json and registers a node-cron task' },
  { pattern: 'PATCH /api/ingest/schedules/*', what: 'writes ingest-schedules.json and starts or stops a node-cron task' },
  { pattern: 'POST /api/ingest/crawl-targets', what: 'writes crawl-targets.json and may register a node-cron task' },
  { pattern: 'PATCH /api/ingest/crawl-targets/*', what: 'writes crawl-targets.json and re-registers its node-cron task' },
  { pattern: 'POST /api/ingest/crawl-targets/*/run', what: 'starts a crawl and writes crawl-targets.json' },
  { pattern: 'POST /api/ingest/survey/*/target', what: 'writes crawl-targets.json and may register a node-cron task' },
  { pattern: 'POST /api/admin/kb-registry/*/provision', what: 'starts a fire-and-forget provisioning job' },
];

/**
 * Rule 5: flips a SEEDED row held in module-level provider state that registers
 * no fixture, so `POST /api/__mock/reset` cannot put it back. The fix is not an
 * exemption — it is `defineFixture`. Until then a replay here would leave the
 * server changed for whoever looks at it next, which is precisely the damage
 * the control plane was built to end.
 */
const UNRESETTABLE: Family[] = [
  // Not empty any more, but everything ABOVE this comment that used to be
  // named here has since been put behind `defineFixture`, which is the fix
  // the rule always pointed at:
  //
  //   * promotions      -> `promotion-candidates` (mock/promotions.ts). Promote
  //                        and dismiss are replayed by the allowlist below.
  //   * session bundles -> `session-bundles` (mock/session-bundle.ts). Publish
  //                        is replayed, predecessor supersession included.
  //   * local compute (presence half) -> `compute-nodes`,
  //                        `compute-pairing-codes` and `local-presence`
  //                        (mock/local-compute.ts), read by
  //                        providers/local-compute.ts and
  //                        lib/local-compute-fleet.ts. The module `Map`s this
  //                        list described are gone; a rename, an announce, a
  //                        heartbeat, a session end and a spent pairing code
  //                        all come back on `POST /api/__mock/reset` (verified
  //                        by hand against a running dev:mock).
  //   * the pull-side job-claim lifecycle -> `agent-jobs` (mock/agent-jobs.ts),
  //                        read by providers/agent-jobs.ts. This used to be
  //                        `MOCK_JOBS`, a bare module-level array, plus a
  //                        second bare `Map` (`MOCK_CLAIM_TOKENS`) fencing
  //                        pull-side claims — both un-registered, so `POST
  //                        /claim` and the four `POST /jobs/:jobId/*` writes
  //                        sat here, refused, because a claim, a start, a
  //                        heartbeat or a completed run MUTATED a row nothing
  //                        could put back. `_resetMockQueue()` existed only as
  //                        a jest hook `routes/mock-control.ts` never called.
  //                        Both are registered now (`agentJobs.reset()` also
  //                        clears the claim-token map, so a fenced write is
  //                        undone as completely as an append), and
  //                        `mock/__tests__/agent-jobs-fixture-writes.test.ts`
  //                        proves a claim → start → heartbeat → complete cycle
  //                        resets clean. What keeps these five off the
  //                        ALLOWLIST is not resettability any more — see each
  //                        entry there for the actual reason (an empty queue
  //                        under the seeded world, or a claim token this
  //                        harness has no way to chain from a prior write).
  //
  // The rule is not idle, though — one provider still has exactly the shape it
  // describes, and the allowlist handles it the other way the header allows.
  // `lib/devbox-fleet.ts` holds the box registry in a module `Map` with no
  // fixture, so `PATCH /api/devbox/boxes/:boxId` may not RENAME a box. It is on
  // the allowlist as an ECHO-BACK — it writes the box's own label back, leaving
  // the row byte-identical — which is rule 5's other permitted move and needs
  // no entry here. This list is for a route with no such move available.
  //
  // The six local-compute PRESENCE routes fell to `unclassified` after that
  // migration — "nobody has written a WriteSpec for them yet", which was true
  // and is now not: all six are on the allowlist below, plus the soft revoke
  // that the `destructive` rule used to swallow. Each carries
  // `intercepts: ['aurora']`, because the fixtures those routes reach are read
  // only inside `if (config.mock.aurora)` in providers/local-compute.ts. The
  // RULE stays, stated, so a provider that goes back to a bare array can be
  // tested against it.
];

/**
 * Rule 3, and its one carve-out. The `destructive` rule refuses every DELETE
 * because a delete is "not reliably undoable" — reset restores registered
 * fixtures and a good deal of mock state registers none.
 *
 * That is a true statement about DELETE in general and it was a false one
 * about `DELETE /api/local-compute/nodes/:id`. That route does not remove a
 * row: `revokeNode` is a soft revoke (`UPDATE compute_nodes SET revoked_at =
 * NOW() ... AND revoked_at IS NULL`, mirrored by `mockRevokeNode` against the
 * REGISTERED `compute-nodes` fixture), the row survives for audit by design,
 * and `POST /api/__mock/reset` puts `revoked_at` back to null. Verified by
 * hand against a running mock server: revoke, `GET /nodes` lists one machine,
 * reset, it lists two again with `revokedAt: null`.
 *
 * So the rule keeps its statement and gains a named exception list rather than
 * a per-route escape hatch. Being on this list is NOT permission — it only
 * lets the route reach the allowlist, where it still needs a full `WriteSpec`
 * with `safe` and `bodyFrom` like everything else. Two gates, and the first
 * one is a sentence someone had to write about a handler they read.
 *
 * A DELETE that is absent from this list is refused as `destructive` whether
 * or not it happens to be restorable — the list means "someone has read this
 * handler and proved it", not "everything else destroys something".
 */
const RESTORABLE_DELETES: Family[] = [
  {
    pattern: 'DELETE /api/local-compute/nodes/:id',
    what: 'a SOFT revoke — providers/local-compute.ts `revokeNode` stamps `revoked_at` on a row that stays for audit, and the row lives in the registered `compute-nodes` fixture, so reset clears the stamp',
  },
  {
    pattern: 'DELETE /api/graph/work-items/:id/decisions/:decisionId',
    what: 'an UNLINK, not a row delete — providers/work-items.ts `unlinkDecisionFromWorkItem` nulls `workItemId` on one row of the registered `graph-decisions` fixture and removes nothing; reset restores the seeded link (proved in routes/__tests__/work-item-decision-links.test.ts, "the fixture reset puts back a seeded link the unlink cleared"). Scoped by the same writeGate as every board write',
  },
];

const family = (list: Family[]) => ({
  applies: (route: string): boolean => list.some((f) => routeMatches(f.pattern, route)),
  detail: (route: string): string | null => list.find((f) => routeMatches(f.pattern, route))?.what ?? null,
});

/**
 * Evaluated in order, and the FIRST match wins — refusals are checked before
 * the allowlist, so no entry can smuggle a route past a rule. `unclassified`
 * is last and matches everything left, which is what makes this an allowlist:
 * silence is a refusal, not a permission.
 *
 * TWO of the rules below are deliberately evaluated OUT of that loop, and
 * `classifyWrite` names both. `unclassified` runs last, after the allowlist
 * lookup, because it means "no entry". `not-intercepted` runs last too,
 * because it is not a question about the route string at all — it is a
 * question about the server this capture is pointed at, and it can only be
 * asked once a spec has said which providers it leans on. Neither can widen
 * anything: both run strictly after the four route rules, and both refuse.
 */
export const REFUSAL_RULES: readonly RefusalRule[] = [
  {
    id: 'active-call-state',
    because: 'Page sharing requires an authenticated, connected participant in a live call with current cookie/socket provenance and grants. Call and page stores are selected independently of MOCK_AURORA and are not resettable fixtures. The capture cannot synthesize a joined call or restore revisions; dedicated HTTP, gateway and two-browser contracts cover this write. (Huddle messages travel over the gateway chat channel, not HTTP.)',
    applies: route => route === 'PUT /api/calls/:callId/page',
  },
  {
    id: 'social-platform-not-verified',
    because: 'The Social platform backend is selected independently of MOCK_AURORA: a configured platform URL takes precedence and can persist a real membership preference. Capture does not verify that backend; isolated provider, handler and browser contracts cover this personal write.',
    applies: route => route === 'PATCH /api/social/teams/:teamId/me',
  },
  {
    id: 'social-private-run',
    because: 'A private /summarize run is readable only by the Social member who started it, from the conversation they may read, and posting needs that member\'s PostMessage grant plus a finished run of their own. The capture signs in without a Social grant and cannot own a run; isolated route tests (social-summarize.test.ts) and the headless spec cover these writes.',
    applies: route => /^POST \/api\/chat\/commands\/summarize\//.test(route),
  },
  {
    id: 'conversation-private-run',
    because: 'A tenant-conversation or huddle /summarize run is a durable flow run readable only by the person who started it, while that conversation\'s own chat history authority (gateway family authority and chat membership rows, or an actual huddle seat) still admits them; posting needs the conversation\'s publish authority plus a finished run of their own. Starting one fires an agent run that outlives the request, and the capture holds neither a run nor a huddle seat; isolated route tests (conversation-summarize.test.ts) and the headless spec cover these writes.',
    applies: route => /^POST \/api\/conversations\/summarize\//.test(route),
  },
  {
    id: 'conversation-artifact-run',
    because: 'A /diagram or /doc run is a durable flow run readable only by the person who started it, from a conversation whose own read authority (Social chatAccess, or a tenant family / huddle chat history) still admits them; posting a diagram and saving a page need that conversation\'s publish authority plus a finished run of their own, and Save is claimed once. Starting one fires an agent run that outlives the request, and the capture holds neither a run nor a conversation seat; isolated route tests (conversation-artifact-social.test.ts, conversation-artifact-tenant.test.ts) and the headless spec cover these writes.',
    applies: route => /^POST \/api\/(?:chat\/commands|conversations)\/(?:diagram|doc)\//.test(route),
  },
  {
    id: 'agent-loop-run',
    because: 'An /agent run is a durable flow run readable only by the person who started it, from a conversation whose own authority (Social chatAccess with PostMessage, or a tenant family / huddle chat publish) still admits them. Starting one plans a goal (no step runs); Approve and Discard are once-only claims on that plan, an approval step pauses the loop and its approve/reject are once-only decisions by the requester (or, where the tenant\'s second-approver rule allows, another editor), and Approve then starts the existing summarize, deck, diagram and doc flows as that person\'s freshly reloaded session. The capture holds neither a run nor a conversation seat, and the loop outlives the request; isolated route tests (agent-loop-social.test.ts, agent-loop-tenant.test.ts, lib/agent-loop) and the headless spec cover these writes.',
    applies: route => /^POST \/api\/(?:chat\/commands|conversations)\/agent\//.test(route),
  },
  {
    id: 'social-deck',
    because: 'A /deck run is private to the Social member who started it and is built from the conversation they may read; saving writes a deck only that member owns, editing is owner-only with a compare-and-set revision, and posting needs PostMessage plus current membership of the source conversation. The capture signs in without a Social grant and can own neither a run nor a deck; isolated route tests (social-deck.test.ts, social-deck-channel.test.ts) and the headless spec cover these writes.',
    applies: route => /^POST \/api\/chat\/(?:commands\/deck\/|decks\/)/.test(route),
  },
  {
    id: 'assessment-private-draft',
    because: 'An evidence summary or follow-up draft is a durable flow run shared by every assessor who can read the team, and accepting one writes follow-up rows into the team the draft names. Generating fires an agent run that outlives the request, and the capture cannot own a draft to accept or discard; isolated route tests (assessment-drafts.test.ts) and the headless spec cover these writes.',
    applies: route => /^POST \/api\/assessment\/(?:teams\/[^/]+\/dimensions\/[^/]+\/drafts\/(?:evidence-summary|followups)|drafts\/[^/]+\/(?:accept|discard|revise))$/.test(route),
  },
  {
    id: 'chat-store-not-verified',
    because: 'The chat pin backend is selected independently of MOCK_AURORA. It may write DynamoDB even when the health response reports every mock provider. Capture does not verify that backend; isolated pin-store and browser tests cover this write.',
    applies: route => route === 'POST /api/chat/pins',
  },
  {
    id: 'document-service',
    because: 'Delegates to durable document or source services outside the resettable Aurora fixture. Proposal writes also verify the canonical document policy through that service. Capture must not seed, publish, restore or transition real documents; dedicated isolated integration tests cover these writes.',
    // A DELETE under these paths (a document comment) is refused all the same,
    // but as `destructive`: every DELETE carries that one label.
    applies: route => !route.startsWith('DELETE ') && (/^POST \/api\/assessment\/knowledge\/canvas$/.test(route)
      || /^POST \/api\/assessment\/knowledge\/doc\/proposals(?:\/[^/]+\/(?:decision|revision))?$/.test(route)
      || /^[A-Z]+ \/api\/assessment\/knowledge\/(source|doc\/workflows)\//.test(route)),
  },
  {
    id: 'destructive',
    because:
      'DELETE removes a row. `POST /api/__mock/reset` restores REGISTERED ' +
      'fixtures only, and a good deal of mock state is a module-level array ' +
      'that registers nothing — so a delete is not reliably undoable, and an ' +
      'un-undone one silently shrinks every shape captured after it. The only ' +
      'exceptions are deletes somebody has read and proved restorable, named ' +
      'in RESTORABLE_DELETES with the reason; that only lets it reach the ' +
      'allowlist, where it still needs a full entry like anything else.',
    applies: (route) =>
      route.startsWith('DELETE ') && !RESTORABLE_DELETES.some((f) => routeMatches(f.pattern, route)),
  },
  {
    id: 'session',
    because:
      "Mutates the capture's own identity. The sweep holds one cookie per " +
      'persona; logging out, switching tenant or masquerading mid-sweep would ' +
      'either drop that cookie or bump `session_epoch` and invalidate it, and ' +
      'every later route would be captured as 401/403. The GET sweep already ' +
      'calls login/tenant itself — those two shapes are pinned there.',
    applies: (route) => /^[A-Z]+ \/api\/(session|auth)\//.test(route),
  },
  {
    id: 'control-plane',
    because:
      "The capture's own tool. `POST /api/__mock/scenario` switches the world " +
      'every later shape would be captured in, so the harness may not replay ' +
      'it. (`POST /api/__mock/reset` IS replayed — the sweep calls it between ' +
      'every write anyway, so its shape comes for free and costs nothing.) ' +
      '`POST /api/__mock/scope` sets a scope cookie on the caller, which would ' +
      'move every later request of the sweep into that scope; ' +
      '`POST /api/__mock/identity/clone` mints a user the sweep would then have ' +
      'to sign in as to learn anything. Both shapes are pinned by ' +
      'routes/__tests__/mock-scope.test.ts instead.',
    applies: (route) => route === 'POST /api/__mock/scenario'
      || route === 'POST /api/__mock/scope' || route === 'POST /api/__mock/identity/clone',
  },
  {
    id: 'spends',
    because:
      'Reaches a real cloud resource IN EVERY CONFIGURATION: a Bedrock model, ' +
      'an AgentCore runtime, a devbox microVM, S3, SSM, the RDS Data API, or ' +
      'an outbound fetch, with no mock branch above it. Replaying it costs ' +
      'money or mutates something outside this process, neither of which a ' +
      'snapshot script gets to do. A route that would spend but whose provider ' +
      'the serving process INTERCEPTS is a different question and a different ' +
      'rule — see `not-intercepted`, which asks the server rather than ' +
      'assuming; this one is for routes no configuration makes safe.',
    ...family(SPENDS),
  },
  {
    id: 'fires',
    because:
      'Arms or fires something that outlives the capture — a cron ' +
      'registration, an agent job enqueued for the fleet dispatcher, a ' +
      'background sweep. The seeded bots are parked deliberately so the ' +
      'scheduler cannot fire against repos that do not exist yet.',
    ...family(FIRES),
  },
  {
    id: 'unresettable',
    because:
      'Flips a seeded row that lives in module-level provider state registering ' +
      'no fixture, so `POST /api/__mock/reset` cannot put it back. Appending a ' +
      'row to such a provider is fine and several specs do it; changing one the ' +
      'seed shipped is not. `defineFixture` is the fix, not an exemption.',
    ...family(UNRESETTABLE),
  },
  {
    id: 'not-intercepted',
    because:
      'This route spends unless the process serving it intercepts the provider ' +
      'it spends through, and the server being captured has not said it does. ' +
      'Whether a mock provider is bound is a fact about that server, not about ' +
      'this laptop — `WIRE_BASE_URL` can point anywhere — so it is asked of the ' +
      'server (`GET /api/health` reports `mocks`) rather than assumed here, and ' +
      'the answer must be yes before the replay happens. Silence, an ' +
      'unreachable health endpoint and a real deployment all refuse alike.',
    applies: (route) => (specFor(route)?.intercepts ?? []).length > 0,
    detail: (route) => {
      const want = specFor(route)?.intercepts ?? [];
      return want.length > 0 ? `it needs ${want.join(' + ')} intercepted` : null;
    },
  },
  {
    id: 'unclassified',
    because:
      'No allowlist entry. A write is replayed only once someone has read its ' +
      'handler and written down why the six safety rules hold and where its ' +
      'body comes from. Until then this is a visible gap, which is the point.',
    applies: () => true,
  },
];

// ---------------------------------------------------------------------------
// The allowlist
// ---------------------------------------------------------------------------

const ok = (body: Json) => async (): Promise<Json> => body;

/**
 * FREE TEXT IS NOT A WIRE STRING. Several bodies below carry `ctx.label()` in a
 * title, a name, a prompt, a note. Those fields are open sets — the check in
 * `shape.ts` deliberately never asserts on them — so a synthetic value there
 * invents nothing that any fixture is measured against. Every CLOSED-set field
 * (a status, a decision, a kind, a cohort, a template) is either a literal the
 * handler's own validation spells or a value read back off the server.
 */
export const WRITE_SPECS: readonly WriteSpec[] = [
  {
    route: 'POST /api/__mock/reset',
    persona: 'orgiq/admin',
    safe: 'It IS the reset. The sweep calls it between every other replay, so capturing its shape adds no mutation that was not already happening.',
    bodyFrom: 'routes/mock-control.ts — `{ fixture? }`, both optional.',
    build: ok({}),
  },

  // ── assessment ────────────────────────────────────────────────────────────
  {
    route: 'POST /api/assessment/teams',
    persona: 'assessment/admin',
    safe: 'Appends to the registered `assessment-teams` fixture; reset restores it. No AWS, no fs, no fetch, no timer.',
    bodyFrom: "routes/assessment.ts: `name` non-empty, `cohort` ∈ VALID_COHORTS ('white_glove'|'self_service'|'general').",
    build: async (ctx) => ({ name: ctx.label(), cohort: 'general' }),
  },
  {
    route: 'PATCH /api/assessment/teams/:id',
    persona: 'assessment/admin',
    safe: 'Every field is optional, so an empty patch mutates nothing at all and still returns the full team shape.',
    bodyFrom: 'routes/assessment.ts: all fields optional; `{}` passes validation.',
    build: ok({}),
  },
  {
    route: 'POST /api/assessment/teams/:id/evidence',
    persona: 'assessment/admin',
    safe: 'Appends one row to the registered `assessment-evidence-log` fixture; reset restores it. No AWS, no model.',
    bodyFrom: 'routes/assessment.ts: `excerpt` non-empty; `source_type`/`dimension_id` optional.',
    build: async (ctx) => ({ excerpt: ctx.label() }),
  },
  {
    route: 'PATCH /api/assessment/teams/:id/exceptions/:dimensionId',
    persona: 'assessment/admin',
    safe: 'Mutates the registered `assessment-teams`/`assessment-scores` fixtures.',
    bodyFrom: "routes/assessment.ts: `status` ∈ {'approved','denied'}; the dimension must carry a 'requested' exception.",
    build: ok({ status: 'approved' }),
  },
  {
    route: 'POST /api/assessment/teams/:id/intake/text',
    persona: 'assessment/admin',
    safe: 'Appends to the registered `assessment-evidence-log` fixture. Despite the name it reaches no agent under the mock providers.',
    bodyFrom: 'routes/assessment.ts: `text` non-empty; everything else optional.',
    build: async (ctx) => ({ text: ctx.label() }),
  },
  {
    route: 'POST /api/assessment/teams/:id/intake/image',
    persona: 'assessment/admin',
    safe: 'Appends to the registered `assessment-evidence-log` fixture. No file is read or written despite the name.',
    bodyFrom: 'routes/assessment.ts: `filename` non-empty; it is a label, not an upload.',
    build: async (ctx) => ({ filename: `${ctx.label()}.png` }),
  },
  {
    route: 'POST /api/assessment/teams/:id/scores/apply',
    persona: 'assessment/admin',
    safe: 'Mutates the registered `assessment-scores`/`assessment-teams` fixtures.',
    bodyFrom: "routes/assessment.ts + providers/assessment.ts: `scores[]`, `relevant_dimension_ids[]`; dimension ids are M.DIMENSION_IDS '1'..'17'; `confidence` ∈ {'low','moderate','high'}.",
    build: ok({
      scores: [{ dimension_id: '1', confidence: 'moderate', rationale: 'wire capture', suggested_level: 3 }],
      relevant_dimension_ids: ['1'],
    }),
  },
  {
    route: 'POST /api/assessment/teams/:id/reset-assessment',
    persona: 'assessment/admin',
    safe: 'Blanks registered score/team/feedback fixtures only, all of which reset restores. No AWS, no model, no timer.',
    bodyFrom: 'routes/assessment.ts: no body.',
  },
  {
    route: 'POST /api/assessment/feedback',
    persona: 'assessment/admin',
    safe: 'Appends one row to the registered `assessment-feedback` fixture; reset restores it. No AWS, no model.',
    bodyFrom: 'routes/assessment.ts: `question` non-empty.',
    build: async (ctx) => ({ question: `${ctx.label()}?` }),
  },
  {
    route: 'POST /api/assessment/feedback/:taskId/resolve',
    persona: 'assessment/admin',
    safe: 'Mutates the registered `assessment-feedback` fixture; reset restores the task. No AWS, no model, no timer.',
    bodyFrom: 'routes/assessment.ts: `response` non-empty.',
    build: async (ctx) => ({ response: ctx.label() }),
  },
  {
    route: 'POST /api/assessment/feedback/:taskId/dismiss',
    persona: 'assessment/admin',
    safe: 'Mutates the registered `assessment-feedback` fixture; reset restores the task. No AWS, no model, no timer.',
    bodyFrom: 'routes/assessment.ts: no body.',
  },
  {
    route: 'POST /api/assessment/runs/:runId/complete',
    persona: 'assessment/admin',
    safe: 'Mutates registered run/score fixtures. It is the agent callback, so it takes no session — the sweep still calls it as a persona, which is allowed.',
    bodyFrom: "routes/assessment.ts: `status` ∈ {'completed','failed'}; the run must still be 'running'.",
    build: ok({ status: 'completed' }),
  },
  {
    route: 'POST /api/assessment/runs/:runId/stop',
    persona: 'assessment/admin',
    safe: 'Mutates the registered run fixture and publishes one broker event, which every gated request already does.',
    bodyFrom: 'routes/assessment.ts: no body; the run must be `running`.',
  },
  {
    route: 'POST /api/assessment/reports/publish',
    persona: 'assessment/admin',
    safe: 'Persists nothing at all — it is a read of the rollup returned under a POST.',
    bodyFrom: 'routes/assessment.ts: body ignored entirely.',
  },
  {
    route: 'PUT /api/assessment/configuration',
    persona: 'assessment/admin',
    safe: 'Both fields optional, so an empty body leaves the single registered configuration row untouched.',
    bodyFrom: 'routes/assessment.ts: `target_level` and `motions` both optional.',
    build: ok({}),
  },
  {
    route: 'POST /api/assessment/submissions/parse',
    persona: 'assessment/admin',
    safe: 'The legacy `rows` shape is deliberately chosen: it stages NOTHING (its staging_token is a throwaway), so unlike the `records` shape it leaves no entry in the module-level STAGED_PARSES map.',
    bodyFrom: 'routes/assessment.ts: legacy shape is `rows[]` with `team_name_raw`; the name is read off GET /api/assessment/teams.',
    build: async (ctx) => {
      const name = str(objectsWith(await ctx.get('/api/assessment/teams'), 'id', 'name')[0]?.['name']);
      if (name === null) return unsynthesisable('GET /api/assessment/teams listed no team to name a row after');
      return { rows: [{ team_name_raw: name }] };
    },
  },
  {
    route: 'POST /api/assessment/submissions/commit',
    persona: 'assessment/admin',
    safe: 'The legacy `team_id`/`envelope_ids` shape mutates the registered `assessment-submissions` fixture and consumes no staging token.',
    bodyFrom: 'routes/assessment.ts: legacy shape needs `team_id` + non-empty `envelope_ids[]`, both read off GET /api/assessment/submissions.',
    build: async (ctx) => {
      const env = objectsWith(await ctx.get('/api/assessment/submissions'), 'envelope_id', 'team_id')[0];
      const team = str(env?.['team_id']);
      const envelope = str(env?.['envelope_id']);
      if (team === null || envelope === null) return unsynthesisable('GET /api/assessment/submissions listed no envelope');
      return { team_id: team, envelope_ids: [envelope] };
    },
  },
  {
    route: 'POST /api/assessment/submissions/clear',
    persona: 'assessment/admin',
    safe: 'An empty `targets` array clears nothing, so the route is exercised and no row moves.',
    bodyFrom: 'routes/assessment.ts: `targets` is an array and may be empty.',
    build: ok({ targets: [] }),
  },
  {
    route: 'PATCH /api/assessment/submissions/:team/:envelope/links',
    persona: 'assessment/admin',
    safe: 'Mutates the registered `assessment-submissions` fixture; reset restores the envelope. No AWS, no fetch.',
    bodyFrom: "routes/assessment.ts: `status` ∈ {'fetched','skipped'} plus one of `url`/`dimension_id`, read off the envelope itself.",
    build: async (ctx) => {
      const envelope = await ctx.get(ctx.path.replace(/\/links$/, ''));
      const url = str(objectsWith(envelope, 'url')[0]?.['url']);
      if (url === null) return unsynthesisable('the envelope carries no link to mark');
      return { status: 'fetched', url };
    },
  },
  {
    route: 'PUT /api/assessment/knowledge/doc',
    persona: 'assessment/admin',
    safe: 'An echo-back write: it saves the document’s OWN current markdown, so the registered docs fixture ends byte-identical while the real save path runs.',
    bodyFrom: 'routes/assessment.ts: `id` must resolve, `markdown` must be a string. Both are read off GET /api/assessment/knowledge/doc.',
    build: async (ctx) => {
      const id = await editableDocId(ctx);
      if (id === null) return unsynthesisable('GET /api/assessment/knowledge/tree listed no editable document id');
      const doc = await ctx.get(`/api/assessment/knowledge/doc?id=${encodeURIComponent(id)}`);
      const markdown = objectsWith(doc, 'markdown')[0]?.['markdown'];
      if (typeof markdown !== 'string') return unsynthesisable(`GET /api/assessment/knowledge/doc?id=${id} returned no markdown to write back`);
      return { id, markdown };
    },
  },
  {
    route: 'POST /api/assessment/knowledge/doc/rename',
    persona: 'assessment/admin',
    safe:
      'Sends the node its OWN current title, which the provider short-circuits ' +
      'as a no-op before the sibling-clash check and before any write — so the ' +
      'registered sections fixture ends byte-identical while the validation path ' +
      'and the response shape are both real. Any other title would rename a seed ' +
      'row and the next capture would read a different tree.',
    bodyFrom:
      'routes/assessment.ts: `id` and `title`, both read off ' +
      'GET /api/assessment/knowledge/tree — the title is the node’s own.',
    build: async (ctx) => {
      const tree = await ctx.get('/api/assessment/knowledge/tree');
      const sections = objectsWith(tree, 'sections')[0]?.['sections'];
      if (!Array.isArray(sections)) return unsynthesisable('GET /api/assessment/knowledge/tree returned no sections');
      for (const section of sections as Array<Record<string, unknown>>) {
        // A synced section refuses a rename by design.
        if (section['kind'] !== 'local') continue;
        const nodes = section['nodes'];
        if (!Array.isArray(nodes)) continue;
        for (const node of nodes as Array<Record<string, unknown>>) {
          const id = node['id'];
          const title = node['title'];
          if (typeof id === 'string' && typeof title === 'string' && title.trim()) {
            return { id, title };
          }
        }
      }
      return unsynthesisable('GET /api/assessment/knowledge/tree listed no renameable node in a local section');
    },
  },
  {
    route: 'POST /api/assessment/knowledge/doc/move',
    persona: 'assessment/admin',
    safe:
      'A NO-OP move: it sends the node’s own current parent and its own current ' +
      'index among that parent’s children, so the registered sections fixture ends ' +
      'byte-identical while the whole reparent path — validation, splice, reinsert, ' +
      'event — actually runs. Choosing any other target would reorder the tree and ' +
      'leave the next capture reading a different seed.',
    bodyFrom:
      'routes/assessment.ts: `id`, `parentId` and `position`. All three are read off ' +
      'GET /api/assessment/knowledge/tree — the id and parent from the node itself, the ' +
      'position by counting its siblings in the section’s own array order, which is ' +
      'exactly how the provider derives sibling order.',
    build: async (ctx) => {
      const tree = await ctx.get('/api/assessment/knowledge/tree');
      const sections = objectsWith(tree, 'sections')[0]?.['sections'];
      if (!Array.isArray(sections)) return unsynthesisable('GET /api/assessment/knowledge/tree returned no sections');
      for (const section of sections as Array<Record<string, unknown>>) {
        // Only a local section accepts a move at all; a synced one 409s by design.
        if (section['kind'] !== 'local') continue;
        const nodes = section['nodes'];
        if (!Array.isArray(nodes) || nodes.length === 0) continue;
        const node = (nodes as Array<Record<string, unknown>>).find((n) => n['is_dir'] !== true);
        if (!node) continue;
        const parentId = (node['parent_id'] ?? null) as string | null;
        const siblings = (nodes as Array<Record<string, unknown>>)
          .filter((n) => (n['parent_id'] ?? null) === parentId);
        const position = siblings.findIndex((n) => n['id'] === node['id']);
        const id = node['id'];
        if (position < 0 || typeof id !== 'string') continue;
        return { id, parentId, position };
      }
      return unsynthesisable('GET /api/assessment/knowledge/tree listed no movable node in a local section');
    },
  },
  {
    route: 'POST /api/assessment/knowledge/doc/restore',
    persona: 'assessment/admin',
    safe: 'Restores a document to a version the server itself lists, inside the registered docs/versions fixtures.',
    bodyFrom: 'routes/assessment.ts: `id` from the tree, `stamp` from GET /api/assessment/knowledge/doc/versions.',
    build: async (ctx) => {
      const id = await editableDocId(ctx);
      if (id === null) return unsynthesisable('GET /api/assessment/knowledge/tree listed no editable document id');
      const versions = await ctx.get(`/api/assessment/knowledge/doc/versions?id=${encodeURIComponent(id)}`);
      const stamp = str(objectsWith(versions, 'stamp')[0]?.['stamp']);
      if (stamp === null) return unsynthesisable(`no seeded version stamp for ${id}; only some documents carry history`);
      return { id, stamp };
    },
  },
  {
    route: 'POST /api/assessment/knowledge/doc/comment',
    persona: 'assessment/admin',
    safe: 'Under the mock providers this persists nothing; it publishes one broker event, which every gated request already does.',
    bodyFrom: 'routes/assessment.ts: `id` must resolve, `body` non-empty.',
    build: async (ctx) => {
      const id = await editableDocId(ctx);
      if (id === null) return unsynthesisable('GET /api/assessment/knowledge/tree listed no editable document id');
      return { id, body: ctx.label() };
    },
  },
  {
    route: 'POST /api/assessment/knowledge/presence',
    persona: 'assessment/admin',
    safe: "action 'enter' touches only the broker's 45-second presence roster and starts no timer — only 'leave' schedules the grace timer.",
    bodyFrom: "routes/assessment.ts: `doc_id`, `tab_id`, `action` ∈ PRESENCE_ACTIONS ('enter'|'heartbeat'|'leave').",
    build: async (ctx) => {
      const id = await editableDocId(ctx);
      if (id === null) return unsynthesisable('GET /api/assessment/knowledge/tree listed no editable document id');
      return { doc_id: id, tab_id: ctx.label(), action: 'enter' };
    },
  },

  // ── program: work, sprints, grants, budgets ───────────────────────────────
  {
    route: 'POST /api/graph/work-items',
    persona: 'orgiq/admin',
    safe: 'Appends to the registered `work-items` fixture (mock/work-items.ts); reset drops the created row. No AWS, no fs, no timer.',
    bodyFrom: "routes/work-items.ts: `projectId`, `type` ∈ {'epic','story','bug'}, `title`; any key outside CREATE_KEYS is a 400.",
    build: async (ctx) => {
      const projectId = await ctx.pick('/api/graph/projects', 'id');
      if (projectId === null) return unsynthesisable('GET /api/graph/projects listed no initiative');
      return { projectId, type: 'story', title: ctx.label() };
    },
  },
  {
    route: 'PATCH /api/graph/work-items/:id',
    persona: 'orgiq/admin',
    safe: 'A REAL edit, not an echo-back: it moves the item to a different priority. `work-items` is a registered fixture (mock/work-items.ts), so reset puts the seeded priority back — which is what stopped this from having to be an echo-back that proved nothing about the write. Priority is a plain column: no transition matrix, no re-parenting, no cost or point recalculation.',
    bodyFrom: "routes/work-items.ts: PATCH_KEYS, `priority` ∈ VALID_PRIORITIES ('critical'|'high'|'medium'|'low'). The value is not typed from that list — it is a priority some OTHER row on GET /api/graph/work already carries, chosen because it differs from this item's own, so the value comes off the server and the write cannot be a no-op.",
    build: async (ctx) => {
      const id = decodeURIComponent(ctx.path.split('/').pop() ?? '');
      const board = objectsWith(await ctx.get('/api/graph/work'), 'id', 'priority');
      const mine = str(board.find((w) => w['id'] === id)?.['priority']);
      if (mine === null) return unsynthesisable(`GET /api/graph/work does not list ${id} with a priority`);
      const other = board.map((w) => str(w['priority'])).find((p) => p !== null && p !== mine);
      if (other === undefined || other === null) {
        return unsynthesisable(`every work item on GET /api/graph/work carries priority '${mine}', so no different value is readable off the server`);
      }
      return { priority: other };
    },
  },
  {
    // `:decisionId` comes from PARAM_RESOLVERS in http.ts: a decision on the
    // SAME initiative as the resolved item, so this pins the 200, not a 409.
    route: 'PUT /api/graph/work-items/:id/decisions/:decisionId',
    persona: 'orgiq/admin',
    safe: 'Sets `workItemId` on one row of the registered `graph-decisions` fixture (mock/decisions.ts) — reset puts the seeded link back. No AWS, no fs, no timer, no row added or removed. A refused link (another initiative, org-wide, already linked elsewhere) writes nothing and answers 409.',
    bodyFrom: 'routes/work-items.ts: the route takes NO body (any key is a 400); both ids are path params the sweep resolves from the server. The resolver picks a same-initiative decision that is unlinked or already on this item; should the server offer none, the 404/409 refusal shapes are still real and pinned.',
    intercepts: ['aurora'],
    alsoAccept: [404, 409],
  },
  {
    // Spared from `destructive` by RESTORABLE_DELETES, which says why.
    route: 'DELETE /api/graph/work-items/:id/decisions/:decisionId',
    persona: 'orgiq/admin',
    safe: 'Nulls `workItemId` on one row of the registered `graph-decisions` fixture (mock/decisions.ts) and removes nothing — reset puts the seeded link back. No AWS, no fs, no timer. Unlinking a decision the item does not hold writes nothing and answers 404.',
    bodyFrom: 'routes/work-items.ts: no body; both ids are path params. The sweep resets between writes, so the PUT above has not linked anything by now: the resolved pair is linked only if the seed links it, and otherwise the handler\'s 404 ("not linked to this work item") is the real shape pinned.',
    intercepts: ['aurora'],
    alsoAccept: [404],
  },
  {
    route: 'PATCH /api/graph/projects/:id',
    persona: 'orgiq/admin',
    safe: "`updateProjectOwner` is mock-branched and answers 503 without touching anything, so this pins the refusal shape rather than the success one.",
    bodyFrom: 'routes/projects.ts: `ownerId` is required as a key and may be null.',
    intercepts: ['aurora'],
    build: ok({ ownerId: null }),
  },
  {
    route: 'PATCH /api/graph/projects/:id/contributors/:personId',
    persona: 'orgiq/admin',
    safe: 'The contribution-role update is mock-branched and answers 503 without touching anything, so this pins the refusal shape.',
    bodyFrom: 'routes/projects.ts: `role` is required as a key and may be null.',
    intercepts: ['aurora'],
    build: ok({ role: null }),
  },
  {
    route: 'PATCH /api/graph/projects/:id/devbox-profile',
    persona: 'orgiq/admin',
    safe: "Points an initiative at a devbox policy profile (DE-40). Under MOCK_AURORA `setInitiativeProfile` writes `devboxProfileId` on the registered `initiatives` fixture row, so reset puts it back. Sending `null` clears to `default`, which every seeded initiative already resolves to, so the round trip changes nothing a reader can see. No AWS, no timer.",
    bodyFrom: 'routes/projects.ts: `profileId` is required as a key, a profile id or null; null is the one value that needs no published profile.',
    intercepts: ['aurora'],
    build: ok({ profileId: null }),
  },
  {
    route: 'PUT /api/devbox/profiles/:id',
    persona: 'orgiq/admin',
    safe: "Appends the next version of a devbox policy profile (DE-40) to the registered `devbox-profiles` fixture (mock/devbox-profiles.ts); reset drops it and leaves the seeded ('default', 1). The body is the profile's current version copied back unchanged, so the new version grants nothing the old did not. No AWS, no timer.",
    bodyFrom: "routes/devbox-profiles.ts: `profile` must pass parseProfileInput (it is the current version's fields, read off GET /api/devbox/profiles/:id), `baseVersion` must be that version, `reason` a non-blank string (`ctx.label()`).",
    intercepts: ['aurora'],
    build: async (ctx) => {
      const got = await ctx.get('/api/devbox/profiles/default') as { profile?: Record<string, Json> } | null;
      const p = got?.profile;
      if (!p || typeof p['version'] !== 'number') return unsynthesisable('GET /api/devbox/profiles/default returned no profile');
      const { models, task_timeout_s, idle_minutes, max_lifetime_minutes, network_class, org_access } = p;
      return { profile: { models, task_timeout_s, idle_minutes, max_lifetime_minutes, network_class, org_access }, baseVersion: p['version'], reason: ctx.label() };
    },
  },
  {
    route: 'POST /api/sprints',
    persona: 'orgiq/admin',
    safe: 'Appends to the registered `sprints` fixture (mock/sprints.ts); reset drops the created sprint. No AWS, no timer.',
    bodyFrom: 'routes/sprints.ts: `initiativeId`, `name`, `startsOn`/`endsOn` as YYYY-MM-DD with endsOn > startsOn. The dates are copied off an existing sprint rather than minted, so no clock enters a request body.',
    build: async (ctx) => {
      const sprint = objectsWith(await ctx.get('/api/sprints'), 'id', 'orgProjectId', 'startsOn', 'endsOn')[0];
      const initiativeId = str(sprint?.['orgProjectId']);
      const startsOn = str(sprint?.['startsOn']);
      const endsOn = str(sprint?.['endsOn']);
      if (initiativeId === null || startsOn === null || endsOn === null) {
        return unsynthesisable('GET /api/sprints listed no sprint to copy an initiative and a date window from');
      }
      return { initiativeId, name: ctx.label(), startsOn, endsOn };
    },
  },
  {
    route: 'PATCH /api/sprints/:sprintId/items',
    persona: 'orgiq/admin',
    safe: 'A REAL move, not an echo-back: the item chosen is on the sprint’s initiative but NOT already in it, so `updateWorkItem` genuinely rewrites `sprintId`. It edits the registered `work-items` fixture, so reset puts the item back where the seed had it — which is what stopped this from having to be a move onto the sprint the item was already in.',
    bodyFrom: 'routes/sprints.ts: `workItemId` non-blank, and the item’s projectId must equal the sprint’s orgProjectId (a 400 otherwise). Both the sprint’s initiative and the candidate item are read off GET /api/sprints and GET /api/graph/work.',
    build: async (ctx) => {
      const sprintId = decodeURIComponent(ctx.path.split('/').slice(-2)[0] ?? '');
      const sprint = objectsWith(await ctx.get('/api/sprints'), 'id', 'orgProjectId')
        .find((s) => s['id'] === sprintId);
      const initiativeId = str(sprint?.['orgProjectId']);
      if (initiativeId === null) return unsynthesisable(`GET /api/sprints does not list ${sprintId} with an initiative`);
      const item = objectsWith(await ctx.get('/api/graph/work'), 'id', 'projectId', 'sprintId')
        .find((w) => w['projectId'] === initiativeId && w['sprintId'] !== sprintId);
      const workItemId = str(item?.['id']);
      if (workItemId === null) {
        return unsynthesisable(`GET /api/graph/work lists no item on ${initiativeId} that is outside sprint ${sprintId}, so no move would change anything`);
      }
      return { workItemId };
    },
  },
  {
    route: 'POST /api/grants',
    persona: 'orgiq/admin',
    safe: 'Appends to the registered `budget-grants` fixture (mock/budgets.ts); reset drops the created envelope. The side-Map overlay this used to write into is gone — providers/grantOverlay.ts mutates the fixture directly now.',
    bodyFrom: 'routes/grants.ts: `initiativeId`+`sprintId` must agree (both off GET /api/sprints), `granteePersonId` off GET /api/roster, `amountUsd` a finite number >= 0 (copied off an existing grant on GET /api/budgets/grants, which spells it `allocatedUsd`).',
    build: async (ctx) => {
      const sprint = objectsWith(await ctx.get('/api/sprints'), 'id', 'orgProjectId')[0];
      const sprintId = str(sprint?.['id']);
      const initiativeId = str(sprint?.['orgProjectId']);
      const granteePersonId = await ctx.pick('/api/roster', 'personId') ?? await ctx.pick('/api/roster', 'id');
      const existing = objectsWith(await ctx.get('/api/budgets/grants'), 'id', 'allocatedUsd')[0]?.['allocatedUsd'];
      if (sprintId === null || initiativeId === null || granteePersonId === null) {
        return unsynthesisable('GET /api/sprints or GET /api/roster listed nothing to grant against');
      }
      return { initiativeId, sprintId, granteePersonId, amountUsd: typeof existing === 'number' ? existing : 0 };
    },
  },
  {
    route: 'PATCH /api/grants/:id',
    persona: 'orgiq/admin',
    safe: 'A REAL re-allocation, not an echo-back: it writes an amount different from the envelope’s own. `budget-grants` is a registered fixture (mock/budgets.ts) and providers/grantOverlay.ts mutates it in place, so reset restores the seeded amount — and with it every headroom figure and dispatch brake derived from it.',
    bodyFrom: 'routes/grants.ts: at least one of `amountUsd` (finite >= 0) / `note`. The amount is not invented: it is a different envelope’s `allocatedUsd` off GET /api/budgets/grants, picked because it differs from this one’s.',
    build: async (ctx) => {
      const id = decodeURIComponent(ctx.path.split('/').pop() ?? '');
      const grants = objectsWith(await ctx.get('/api/budgets/grants'), 'id', 'allocatedUsd');
      const mine = grants.find((g) => g['id'] === id)?.['allocatedUsd'];
      if (typeof mine !== 'number') {
        return unsynthesisable(`GET /api/budgets/grants does not list ${id} with an amount`);
      }
      const other = grants.map((g) => g['allocatedUsd']).find((v) => typeof v === 'number' && v !== mine);
      if (typeof other !== 'number') {
        return unsynthesisable(`every envelope on GET /api/budgets/grants is allocated $${mine}, so no different amount is readable off the server`);
      }
      return { amountUsd: other };
    },
  },
  {
    route: 'PUT /api/budgets/:orgProjectId',
    persona: 'orgiq/admin',
    safe: 'A REAL allocation write. The old reason here — "`upsertAllocation` is mock-branched and returns null, so the route answers 503 without writing" — has been false since providers/budgets.ts gave the mock branch a body: it evaluates the same upsert against the registered `initiative-budgets` fixture and answers 200. That is fine to replay precisely because the fixture is registered: reset puts the seeded allocation back.',
    bodyFrom: 'routes/budgets.ts: `allocatedUsd` a finite number >= 0. The number is another initiative’s allocation off GET /api/budgets, picked because it differs from this one’s, so the value comes off the server and the write is not a no-op.',
    intercepts: ['aurora'],
    build: async (ctx) => {
      const id = decodeURIComponent(ctx.path.split('/').pop() ?? '');
      const budgets = objectsWith(await ctx.get('/api/budgets'), 'orgProjectId', 'allocatedUsd');
      const mine = budgets.find((b) => b['orgProjectId'] === id)?.['allocatedUsd'];
      if (typeof mine !== 'number') {
        return unsynthesisable(`GET /api/budgets does not list ${id} with an allocation`);
      }
      const other = budgets.map((b) => b['allocatedUsd']).find((v) => typeof v === 'number' && v !== mine);
      if (typeof other !== 'number') {
        return unsynthesisable(`every initiative on GET /api/budgets is allocated $${mine}, so no different amount is readable off the server`);
      }
      return { allocatedUsd: other };
    },
  },

  // ── work queue ────────────────────────────────────────────────────────────
  {
    route: 'POST /api/work/sweeps/run',
    persona: 'orgiq/admin',
    safe: 'The mock branch only bumps `lastSeenAt` on the registered org-findings fixture; it enqueues nothing.',
    bodyFrom: 'routes/work.ts: `{}` runs every sweep.',
    build: ok({}),
  },
  {
    route: 'POST /api/work/findings/:id/analyze',
    persona: 'orgiq/admin',
    safe: "`analyzeDocumentLinks` short-circuits on `config.mock.aurora` with problem 'Aurora is mocked' before the S3 read and the model call.",
    bodyFrom: 'routes/work.ts: `dryRun` optional boolean; the finding must be a document one (GET /api/work/findings?sweep=stale_docs).',
    intercepts: ['aurora'],
    build: ok({ dryRun: true }),
  },
  {
    route: 'POST /api/work/findings/analyze-batch',
    persona: 'orgiq/admin',
    safe: '`findUnproposedDocumentFindings` returns [] under the mock providers, so no model runs and nothing is written.',
    bodyFrom: 'routes/work.ts: `limit`/`sweep` both optional.',
    build: ok({}),
  },
  {
    route: 'POST /api/work/findings/:id/dismiss',
    persona: 'orgiq/admin',
    safe: 'Mutates the registered org-findings fixture; reset restores it.',
    bodyFrom: 'routes/work.ts: no body.',
  },
  {
    route: 'POST /api/work/jobs/:id/review',
    persona: 'orgiq/admin',
    safe: 'Mutates one job row in the in-memory queue and enqueues nothing new; the dispatcher has nothing extra to claim.',
    bodyFrom: "routes/work.ts: `decision` ∈ {'accept','reject'}; the job must be awaiting_review.",
    build: ok({ decision: 'accept' }),
  },
  {
    route: 'POST /api/work/proposals',
    persona: 'orgiq/admin',
    safe: '`proposeGraphChange` is mock-branched and returns null, so the route answers 503 without writing.',
    bodyFrom: 'routes/work.ts: `kind` + `targetId`, neither validated at run time.',
    intercepts: ['aurora'],
    build: async () =>
      unsynthesisable(
        '`kind` is a ProposalKind union with no run-time validation, and no GET route enumerates its members — ' +
        'inventing one is exactly the fiction this harness exists to stop.',
      ),
  },
  {
    route: 'POST /api/work/proposals/:id/decide',
    persona: 'orgiq/admin',
    safe: '`decideProposal` is mock-branched and returns null, so the route answers 404 without writing.',
    bodyFrom: "routes/work.ts: `decision` ∈ {'approve','reject'}.",
    intercepts: ['aurora'],
    build: ok({ decision: 'approve' }),
  },

  // ── bots ──────────────────────────────────────────────────────────────────
  {
    route: 'POST /api/bots',
    persona: 'orgiq/admin',
    safe: "Appends a bot; `trigger: 'manual'` means the registerBot call that follows arms no cron. Nothing seeded moves.",
    bodyFrom: "routes/bots.ts: `name`, `template` ∈ TEMPLATES ('epic'|'story'|'bug'), `prompt`, `model`, `trigger` ∈ TRIGGERS ('manual'|'cron'|'pr_watch'); the model id is read off GET /api/bots.",
    build: async (ctx) => {
      const model = str(objectsWith(await ctx.get('/api/bots'), 'id', 'model')[0]?.['model']);
      if (model === null) return unsynthesisable('GET /api/bots listed no bot to copy a model id from');
      return { name: ctx.label(), template: 'epic', prompt: ctx.label(), model, trigger: 'manual' };
    },
  },
  {
    route: 'POST /api/bots/:id/pause',
    persona: 'orgiq/admin',
    safe: 'Pause only DISARMS: it sets a paused reason and unregisters the cron. Its mirror, resume, is refused because it arms one.',
    bodyFrom: 'routes/bots.ts: `reason` optional.',
    build: ok({}),
  },

  // ── sdlc, designs, connections ────────────────────────────────────────────
  {
    route: 'POST /api/sdlc/policies',
    persona: 'orgiq/admin',
    safe: 'Appends a policy row to the registered `sdlc` fixture; reset restores it. Nothing seeded moves.',
    bodyFrom: "routes/sdlc.ts: `name` non-blank, `kind` ∈ {'require_review','protected_paths','max_files','model_allowlist','max_cost'}.",
    build: async (ctx) => ({ name: ctx.label(), kind: 'require_review' }),
  },
  {
    route: 'POST /api/sdlc/changes/:id/decide',
    persona: 'orgiq/admin',
    safe: 'Mutates the registered `sdlc` fixture; reset restores the change row. No AWS, no model, no fs.',
    bodyFrom: "routes/sdlc.ts: `decision` ∈ {'approve','reject'}; the change must be in DECIDABLE.",
    build: ok({ decision: 'approve' }),
  },
  {
    route: 'POST /api/sdlc/changes/:id/rereview',
    persona: 'orgiq/admin',
    safe: 'A REAL re-review, end to end, with no model in it. Refused as `spends` for "sends the diff to Bedrock Converse (lib/change-reviewer.ts, no mock branch)" — there is one, `if (config.mock.agentcore)` ABOVE the try, handing the diff to `mock/static-review.ts`; and it is above the try on purpose, so a real outage still degrades to `request_changes`. The verdict then flows through the genuine `evaluate()`. Everything it writes — the in_review stamp, the appended review, the re-evaluated gates and status — lives in the registered `sdlc-changes`/`sdlc-change-reviews`/`sdlc-change-gates` fixtures. Verified by hand: one review became two, the new one recorded as `offline/static-diff-review`, and reset put it back to one.',
    bodyFrom: 'routes/sdlc.ts: no body at all. The change named by `:id` must carry a stored diff, or the route 400s — GET /api/sdlc/changes lists whether it does.',
    intercepts: ['aurora', 'agentcore'],
  },
  {
    route: 'POST /api/sdlc/changes/:id/deliver',
    persona: 'orgiq/admin',
    safe: 'Under MOCK_AGENTCORE `deliverApprovedChange` runs its real workspace checks against the fake microVM and then takes a branch into `mockDeliverChange`, which appends to the registered `devbox-deliveries` fixture — no credential is borrowed (`borrowApiKey` throws in mock mode) and github.com is never reached. Its old reason, "resolves the devbox runtime via ListAgentRuntimes", describes something `lib/devbox-arn.ts` does not do under interception. In practice this pins the REFUSAL: no seeded change is `approved`, so it answers 409 "change is needs_approval, not approved" before any of the above runs — verified by hand — and that 409 is a real shape worth having.',
    bodyFrom: 'routes/sdlc.ts: no body. `:id` is a change off GET /api/sdlc/changes.',
    intercepts: ['aurora', 'agentcore'],
    alsoAccept: [409],
  },
  {
    route: 'POST /api/designs/:id/answer',
    persona: 'orgiq/admin',
    safe: 'Mutates the registered `design-reviews` fixture; reset restores the thread. No AWS, no model.',
    bodyFrom: 'routes/designs.ts: `questionPostId` from GET /api/designs/:id where kind is question and resolvedBy is null; `body` non-empty.',
    build: async (ctx) => {
      const thread = await ctx.get(ctx.path.replace(/\/answer$/, ''));
      const post = objectsWith(thread, 'id', 'kind', 'resolvedBy')
        .find((p) => p['kind'] === 'question' && p['resolvedBy'] === null);
      const questionPostId = str(post?.['id']);
      if (questionPostId === null) return unsynthesisable('the thread carries no open question post to answer');
      return { questionPostId, body: ctx.label() };
    },
  },
  {
    route: 'POST /api/designs/:id/signoff',
    persona: 'orgiq/admin',
    safe: 'Mutates the registered `design-reviews` fixture; reset restores the thread. Under the mock providers the KB write on approval is not taken.',
    bodyFrom: "routes/designs.ts: `decision` ∈ {'approve','reject'}.",
    build: ok({ decision: 'reject' }),
  },
  {
    route: 'POST /api/graph/decisions/:id/decide',
    persona: 'orgiq/admin',
    safe: 'Mutates the registered `graph-decisions` fixture row and appends to the registered `graph-decision-events` fixture (G54); reset restores both. Under the mock providers no SQL runs. A decision the list hands out first may already be settled, which the route answers 409 and the capture records.',
    bodyFrom: "routes/decisions.ts: `outcome` ∈ DECISION_OUTCOMES ('resolved','rejected'), `rationale` non-blank and at most RATIONALE_MAX (500).",
    build: async (ctx) => ({ outcome: 'rejected', rationale: ctx.label() }),
  },
  {
    route: 'POST /api/connections',
    persona: 'orgiq/admin',
    safe: 'Under MOCK_AGENTCORE the key is dropped on the floor and a row is appended to the registered `connected-sources` fixture; no AgentCore credential provider is created and api.github.com is never called.',
    bodyFrom: "routes/connections.ts: `kind` ∈ KINDS ('github'|'confluence'|'jira'), `label` and `apiKey` non-blank (the key is never stored).",
    intercepts: ['agentcore'],
    build: async (ctx) => ({ kind: 'github', label: ctx.label(), apiKey: ctx.label() }),
  },

  // ── lab, rediscovery, distillation, library ───────────────────────────────
  {
    route: 'POST /api/lab/signals',
    persona: 'orgiq/admin',
    safe: 'Appends to (or dedupes into) the registered `org-findings` fixture.',
    bodyFrom: "routes/lab.ts: `title` non-blank; `severity` ∈ {'critical','warning','info'} is optional.",
    build: async (ctx) => ({ title: ctx.label(), severity: 'info' }),
  },
  {
    route: 'POST /api/lab/experiences',
    persona: 'orgiq/admin',
    safe: 'Appends a row to the registered `lab-experiences` fixture (mock/lab.ts — the rows left providers/lab.ts); reset drops it.',
    bodyFrom: "routes/lab.ts: `title` non-blank; `kind` ∈ {'worked','failed','gotcha','decision','convention'} optional.",
    build: async (ctx) => ({ title: ctx.label(), kind: 'gotcha' }),
  },
  {
    route: 'POST /api/lab/consults',
    persona: 'orgiq/admin',
    safe: 'Appends a row to the registered `lab-consults` fixture (mock/lab.ts — the rows left providers/lab.ts); reset drops it.',
    bodyFrom: 'routes/lab.ts: `question` non-blank.',
    build: async (ctx) => ({ question: `${ctx.label()}?` }),
  },
  {
    route: 'POST /api/lab/consults/:id/answer',
    persona: 'orgiq/admin',
    safe: 'Answers the seeded pending consult and leaves it `answered`. The old reason here — "MOCK_CONSULTS ships empty, so there is no seeded consult to flip" — stopped being true when mock/lab.ts gave the fixture two seeded rows; what makes the flip replayable now is that `lab-consults` is REGISTERED, so reset puts the pending consult back.',
    bodyFrom: 'routes/lab.ts: `answer` non-blank (free text, not a wire value); the consult must still be pending, which the seeded `con-mock-1` is.',
    build: async (ctx) => ({ answer: ctx.label() }),
  },
  {
    route: 'POST /api/rediscovery/check',
    persona: 'orgiq/admin',
    safe: 'A pure ranking over the in-memory experience corpus. It writes nothing and calls no embedding model.',
    bodyFrom: 'routes/rediscovery.ts: `problem` non-blank.',
    build: async (ctx) => ({ problem: ctx.label() }),
  },
  {
    route: 'POST /api/rediscovery/outcome',
    persona: 'orgiq/admin',
    safe: 'Appends to the in-memory OUTCOMES array. Nothing seeded moves.',
    bodyFrom: "routes/rediscovery.ts: `experienceId` off GET /api/lab/experiences, `action` ∈ {'used','dismissed'}.",
    build: async (ctx) => {
      const experienceId = await ctx.pick('/api/lab/experiences', 'id');
      if (experienceId === null) return unsynthesisable('GET /api/lab/experiences listed no experience to record an outcome against');
      return { experienceId, action: 'used' };
    },
  },
  {
    route: 'POST /api/library/evals/:assetId/run',
    persona: 'orgiq/admin',
    safe: 'Scoring is a local deterministic simulation — no model. The one Aurora write is best-effort and swallowed. The run row is appended, never a seeded one changed.',
    bodyFrom: 'routes/prompt-evals.ts: `version` is any non-empty string (free text, not a wire value).',
    build: async (ctx) => ({ version: ctx.label() }),
  },
  {
    route: 'POST /api/scores/analysis',
    persona: 'orgiq/admin',
    safe: '`analyzeScores` short-circuits on `config.mock.aurora` before it reads Aurora or opens a Code Interpreter session.',
    bodyFrom: 'routes/scores.ts: body ignored.',
    intercepts: ['aurora'],
    build: ok({}),
  },

  // ── promotions, session bundles ───────────────────────────────────────────
  //
  // All three were refused as `unresettable` until the rows they flip moved
  // behind registered fixtures. They are the reason that rule's list shrank.
  {
    route: 'POST /api/promotions/:id/promote',
    persona: 'orgiq/admin',
    safe: 'Promotes a seeded candidate — a real ladder step, `candidate` -> `approved`/`promoted`, not an append. Replayable because `promotion-candidates` (mock/promotions.ts) and `pipelines.runs` (mock/pipeline-definitions.ts) are registered fixtures: reset puts the status and the `dryRunRunId` back. No AWS, no model, no timer; the ladder is pure in-process bookkeeping.',
    bodyFrom: "routes/promotions.ts: `dryRunRunId` is optional (a run id string); `dryRunPassed` is ignored since pipelines P2 — a client can no longer assert that a dry run passed. The candidate resolved for `:id` is the first `status=candidate` one; when that is a `skill`, rule 1 (providers/promotions.ts `decideDryRunGate`) refuses it with 409 until a completed dry-run of its runbook definition is recorded, and that refusal is the shape captured — hence 409 is accepted.",
    build: ok({}),
    alsoAccept: [409],
  },
  {
    route: 'POST /api/promotions/:id/dismiss',
    persona: 'orgiq/admin',
    safe: 'Dismisses a seeded candidate and appends the reason to its rationale — deliberately not idempotent, which is exactly why it needed a fixture. `promotion-candidates` is registered, so reset restores both the status and the un-appended rationale.',
    bodyFrom: 'routes/promotions.ts: `reason` must be a non-blank string. It is free text appended to `rationale`, not a wire-shaped value, so `ctx.label()` invents nothing any fixture is measured against.',
    build: async (ctx) => ({ reason: ctx.label() }),
  },
  {
    route: 'POST /api/session-bundle/:id/publish',
    persona: 'orgiq/admin',
    safe: 'Publishes the pending bundle to the fleet: it goes `live`, the previously-live one is SUPERSEDED, and its `publishedAt`/`publishedBy` are re-stamped. `session-bundles` (mock/session-bundle.ts) is a registered fixture, so reset restores both rows — the predecessor included, which is the half a per-row undo would have missed. Nothing reaches a box: publishBundle only rewrites those rows.',
    bodyFrom: 'routes/session-bundle.ts + providers/session-bundle.ts `decidePublish`: `dryRunBoxId` is only checked for presence (it gates `hasHooks`), never resolved against the fleet and never stored. `GET /api/devbox/boxes` is empty offline — no box exists to name — so this is `ctx.label()`, an open-set id the shape check never asserts on, and the publish it unlocks is real.',
    build: async (ctx) => ({ dryRunBoxId: ctx.label() }),
  },

  // ── identity ──────────────────────────────────────────────────────────────
  {
    route: 'POST /api/identity/tenants',
    persona: 'orgiq/admin',
    safe: '`createTenant` checks `auroraConfigured()` and throws before any SQL, so nothing is provisioned; this pins the refusal shape.',
    bodyFrom: 'routes/identity.ts: `id` matching /^[a-z][a-z0-9-]{1,30}$/.',
    build: async (ctx) => ({ id: ctx.label(), displayName: ctx.label() }),
  },
  {
    route: 'POST /api/identity/users',
    persona: 'orgiq/admin',
    safe: '`createUser` checks `auroraConfigured()` and throws before any SQL.',
    bodyFrom: 'routes/identity.ts: `id` and `displayName` strings.',
    build: async (ctx) => ({ id: ctx.label(), displayName: ctx.label() }),
  },
  {
    route: 'PUT /api/identity/users/:id/grants',
    persona: 'orgiq/admin',
    safe: '`setGrants` checks `auroraConfigured()` and throws before any SQL.',
    bodyFrom: 'routes/identity.ts: `grants` keyed by tenant; both the tenant and the role name are read off GET /api/identity/roles.',
    build: async (ctx) => {
      const role = objectsWith(await ctx.get('/api/identity/roles'), 'id', 'tenant')
        .find((r) => r['tenant'] === 'orgiq');
      const id = str(role?.['id']);
      const tenant = str(role?.['tenant']);
      if (id === null || tenant === null) return unsynthesisable('GET /api/identity/roles listed no orgiq role to grant');
      return { grants: { [tenant]: [id] } };
    },
  },
  {
    route: 'PUT /api/identity/users/:id/person',
    persona: 'orgiq/admin',
    safe: 'The handler returns 503 before any SQL when Aurora is unconfigured, and `null` is the documented clear-the-link value.',
    bodyFrom: 'routes/identity.ts: `personId` is a person id or null.',
    build: ok({ personId: null }),
  },
  {
    route: 'POST /api/identity/policies/test',
    persona: 'orgiq/admin',
    safe: '`ensureStore` answers 503 before the Verified Permissions call, and the route evaluates rather than writes in any case.',
    bodyFrom: 'routes/identity.ts: `role` off GET /api/identity/roles, `action` off GET /api/session/capabilities.',
    build: async (ctx) => {
      const role = await ctx.pick('/api/identity/roles', 'id');
      const actions = objectsWith(await ctx.get('/api/session/capabilities'), 'actions')[0]?.['actions'];
      const action = actions !== null && typeof actions === 'object' && !Array.isArray(actions)
        ? Object.keys(actions)[0] : undefined;
      if (role === null || action === undefined) {
        return unsynthesisable('no role or capability name was readable off the server');
      }
      return { role, action };
    },
  },
  {
    route: 'POST /api/identity/policies',
    persona: 'orgiq/admin',
    safe: 'The handler answers 503 before the Verified Permissions write when no policy store is configured.',
    bodyFrom: 'routes/identity.ts: `statement` is Cedar policy source.',
    build: async () =>
      unsynthesisable(
        '`statement` is Cedar policy source. GET /api/identity/policies needs a live policy store, so no real ' +
        'statement is readable offline, and writing one from memory is the invention this harness forbids.',
      ),
  },
  {
    route: 'PUT /api/identity/policies/:id',
    persona: 'orgiq/admin',
    safe: 'The handler answers 503 before the Verified Permissions write when no policy store is configured.',
    bodyFrom: 'routes/identity.ts: `statement` is Cedar policy source.',
    build: async () => unsynthesisable('same as POST /api/identity/policies: no Cedar statement is readable offline.'),
  },
  {
    route: 'PUT /api/identity/schema',
    persona: 'orgiq/admin',
    safe: 'The handler answers 503 before the Verified Permissions write when no policy store is configured.',
    bodyFrom: 'routes/identity.ts: `schema` is a Cedar JSON schema.',
    build: async () =>
      unsynthesisable('`schema` is a Cedar JSON schema; GET /api/identity/schema needs a live policy store, so none is readable offline.'),
  },

  // ── ingest / knowledge base (the mock-branched two) ───────────────────────
  {
    route: 'POST /api/ingest/start',
    persona: 'orgiq/admin',
    safe: '`startIngestionJob` takes its MOCK_AGENTCORE branch and appends a job row to the registered knowledge-base fixture; no Bedrock call is made.',
    bodyFrom: 'routes/ingest.ts: `dataSourceId` off GET /api/ingest/data-sources.',
    intercepts: ['agentcore'],
    build: async (ctx) => {
      const dataSourceId = await ctx.pick('/api/ingest/data-sources', 'id');
      if (dataSourceId === null) return unsynthesisable('GET /api/ingest/data-sources listed no data source');
      return { dataSourceId };
    },
  },
  {
    route: 'POST /api/ingest/crawl/:id/sync',
    persona: 'orgiq/admin',
    safe: '`triggerKbSyncForCrawl` refuses immediately when no knowledge base is configured, so the route answers 409 ("KNOWLEDGE_BASE_ID is unset") before any AWS call. It used to answer a flat 502 for this and every other cause alike; the status now distinguishes them, and the no-AWS-call guarantee is unchanged.',
    bodyFrom: 'routes/ingest.ts: no body.',
  },
  {
    route: 'POST /api/assessment/knowledge/doc/publish',
    persona: 'assessment/admin',
    safe: 'Adds a page node to the REGISTERED knowledge-sections fixture (reset restores it) and makes no Confluence or AWS call. It also bumps a module-level version counter that reset cannot lower — a monotonic integer, not a seeded row, and `version` is not a wire-shaped field, so no snapshot value churns on it.',
    bodyFrom: 'routes/assessment.ts: `id` is an editable local doc id from GET /api/assessment/knowledge/tree.',
    build: async (ctx) => {
      const id = await editableDocId(ctx);
      if (id === null) return unsynthesisable('GET /api/assessment/knowledge/tree listed no editable document id');
      return { id };
    },
  },
  {
    route: 'POST /api/knowledge-base/sync',
    persona: 'orgiq/admin',
    safe: '`startSync` short-circuits to the mock job under MOCK_AGENTCORE and unshifts a row into the registered knowledge-base fixture.',
    bodyFrom: 'routes/knowledge-base.ts: `dataSourceId` off GET /api/knowledge-base/data-sources.',
    intercepts: ['agentcore'],
    build: async (ctx) => {
      const dataSourceId = await ctx.pick('/api/knowledge-base/data-sources', 'id');
      if (dataSourceId === null) return unsynthesisable('GET /api/knowledge-base/data-sources listed no data source');
      return { dataSourceId };
    },
  },
  {
    route: 'POST /api/admin/kb-registry/:id/sync',
    persona: 'orgiq/admin',
    safe: '`startIngestionJob` short-circuits to the mock job under MOCK_AGENTCORE and unshifts a row into the registered kb-ingestion-jobs fixture. It used to build and send its own StartIngestionJobCommand — this route was the one KB write with no mock branch, so offline it reached the real account and answered a live AccessDeniedException; it now shares the provider with POST /api/ingest/start. The minted job id comes off a module-level counter reset cannot lower, and `jobId` is not a wire-shaped field, so no snapshot value churns on it.',
    bodyFrom: 'routes/kb-admin.ts: `description` is optional and defaults to a timestamped label; `:id` resolves off GET /api/admin/kb-registry.',
    intercepts: ['agentcore'],
    build: ok({}),
  },
  {
    route: 'PATCH /api/admin/kb-registry/:id',
    persona: 'orgiq/admin',
    safe: 'Both fields are optional and `updateKbEntry` returns before building a statement when the patch is empty, so no RDS Data API call is made.',
    bodyFrom: 'routes/kb-admin.ts: `name`/`description` both optional.',
    build: ok({}),
  },
  {
    route: 'POST /api/admin/kb-registry/reconcile/adopt',
    persona: 'orgiq/admin',
    safe: '`adoptKnowledgeBase` refuses under `config.mock.aurora` before any Bedrock or Aurora call.',
    bodyFrom: 'routes/kb-admin.ts: `slug` off GET /api/admin/kb-registry, `kbId` is a live Bedrock knowledge-base id.',
    intercepts: ['aurora'],
    build: async () =>
      unsynthesisable(
        '`kbId` is a live Bedrock knowledge-base id. Nothing offline enumerates one — GET /reconcile does not surface ' +
        'live AWS ids under the mock providers — and a made-up id would prove nothing.',
      ),
  },
  {
    route: 'PATCH /api/environments/:id',
    persona: 'orgiq/admin',
    safe: 'An empty patch short-circuits to the mock read before the UPDATE, so no RDS Data API call is made.',
    bodyFrom: 'routes/environments.ts: every field optional; `{}` is accepted.',
    build: ok({}),
  },

  // ── observability (the mock-branched subset) ──────────────────────────────
  {
    route: 'POST /api/observability/harness/cases',
    persona: 'orgiq/admin',
    safe: 'Upserts into the registered `harness` fixture under MOCK_AURORA; no model, no AWS.',
    bodyFrom: 'routes/harness.ts: `agentId` and `prompt` non-empty; the agent id is read off GET /api/agents.',
    intercepts: ['aurora'],
    build: async (ctx) => {
      const agentId = await ctx.pick('/api/agents', 'id');
      if (agentId === null) return unsynthesisable('GET /api/agents listed no agent');
      return { agentId, prompt: ctx.label() };
    },
  },
  {
    route: 'PATCH /api/observability/harness/cases/:id',
    persona: 'orgiq/admin',
    safe: 'Mutates the registered `harness` fixture under MOCK_AURORA; no model, no AWS, and reset restores the case.',
    bodyFrom: 'routes/harness.ts: every field optional.',
    intercepts: ['aurora'],
    build: ok({}),
  },
  {
    route: 'POST /api/observability/harness/runs',
    persona: 'orgiq/admin',
    safe: "Inserts into the registered `harness` fixture under MOCK_AURORA. `mode` is left unset so it collapses to 'sim' — 'live' is the one that would drive the fleet.",
    bodyFrom: "routes/harness.ts: `{}` is valid; `mode` must be the literal 'live' to mean anything.",
    intercepts: ['aurora'],
    build: ok({}),
  },
  {
    route: 'PATCH /api/observability/harness/runs/:id',
    persona: 'orgiq/admin',
    safe: 'An empty patch returns `{ ok, changed: 0 }` without touching the RDS Data API, so nothing is written at all.',
    bodyFrom: 'routes/harness.ts: every field optional; `{}` short-circuits.',
    build: ok({}),
  },
  {
    route: 'POST /api/observability/harness/runs/:runId/results',
    persona: 'orgiq/admin',
    safe: 'A REAL upsert of a seeded result row. It was refused as `spends` — "upserts through the RDS Data API with no mock branch" — and routes/harness.ts now takes a `config.mock.aurora` branch into `mockUpsertResult` above that statement, against the REGISTERED `harness-results` fixture (mock/harness.ts). The mock deliberately REPLACES the row rather than merging, exactly as `ON CONFLICT (run_id, test_id) DO UPDATE` assigns every column from EXCLUDED, so a body carrying only `testId` blanks the seeded judge score — which is precisely why it needs a fixture, and it has one: verified by hand, the seeded 0.74 and its rationale came back on `POST /api/__mock/reset`. No model, no AWS, no timer.',
    bodyFrom: "routes/harness.ts: `testId` is the only requirement (`ValidationError` otherwise); `invocationId` must match /^[0-9a-f-]{36}$/i to be stored and is omitted. The id is read off GET /api/observability/harness/runs/:runId — this run's OWN results — so the upsert lands on a row that exists rather than appending a result for a case the run never ran; GET /cases is the fallback when the run has none.",
    intercepts: ['aurora'],
    build: async (ctx) => {
      const run = await ctx.get(ctx.path.replace(/\/results$/, ''));
      const mine = str(objectsWith(run, 'testId', 'passed')[0]?.['testId']);
      const testId = mine ?? await ctx.pick('/api/observability/harness/cases', 'testId');
      if (testId === null) {
        return unsynthesisable('neither this run nor GET /api/observability/harness/cases listed a testId to record a result against');
      }
      return { testId };
    },
  },
  {
    route: 'POST /api/observability/harness/promote',
    persona: 'orgiq/admin',
    safe: 'A REAL promotion — a seeded registry row goes from unpromoted to blessed. Refused as `spends` for "writes through the RDS Data API with no mock branch"; routes/harness.ts now branches into `mockPromotePromptVersion` against the REGISTERED `prompt-versions` fixture (mock/prompt-versions.ts), which stamps `promotedAt`/`promotedBy`/`promoteNotes` on the row in place. Replayable because that fixture is registered: verified by hand, promoting the advisor revision made GET /promoted-versions list three rows and reset put it back to the seeded two. Nothing is recomputed — `promptVersion` stays the short SHA of the content — so no id can end up disagreeing with its own text.',
    bodyFrom: 'routes/harness.ts: `promptVersion` and `agentId` both required and non-blank, and the fixture 409s a SHA that belongs to a different agent. Both are read as a PAIR off GET /api/observability/prompt-versions, so the two always agree and the success path is what gets pinned rather than the mismatch. `promotedBy` is omitted, taking the handler’s own `harness-runner` default.',
    intercepts: ['aurora'],
    build: async (ctx) => {
      const row = objectsWith(await ctx.get('/api/observability/prompt-versions'), 'promptVersion', 'agentId')[0];
      const promptVersion = str(row?.['promptVersion']);
      const agentId = str(row?.['agentId']);
      if (promptVersion === null || agentId === null) {
        return unsynthesisable('GET /api/observability/prompt-versions listed no registered prompt to promote');
      }
      return { promptVersion, agentId };
    },
  },
  {
    route: 'POST /api/observability/harness/trace',
    persona: 'orgiq/admin',
    safe: 'The whole sink pipeline, offline. This carried the strongest refusal in the file — "runs Titan embedding AND the Nova judge; it spends even with Aurora down" — and every clause of it has since been closed: `embedForTrace` takes `mock/embedding.ts`\'s lexical projection under `config.mock.agentcore`, `judgeResponse` takes `mock/answer-check.ts` under the same flag, and each persistence step branches on `config.mock.aurora` into the registered `trace-sink-*` fixtures. Verified by hand: 200, `judgeRationale` reading `offline/lexical-answer-check: … No model was called.`, `trace-sink-traces` 0 rows -> 1 -> 0 across reset. It APPENDS; nothing seeded moves. Note it is a machine callback (`requireTraceAuth`, open while the secret is unset) — the sweep calls it as a persona, which is allowed.',
    bodyFrom: "routes/harness.ts: `agentId` non-empty, `prompt` non-empty, `response` a string — the three ValidationErrors; every other field is optional and omitted. The agent id is read off GET /api/agents. `response` is deliberately non-empty: `processTrace` drops a bundle with no substance on any axis as a phantom row, so an empty one would prove nothing.",
    intercepts: ['aurora', 'agentcore'],
    build: async (ctx) => {
      const agentId = await ctx.pick('/api/agents', 'id');
      if (agentId === null) return unsynthesisable('GET /api/agents listed no agent');
      return { agentId, prompt: ctx.label(), response: ctx.label() };
    },
  },
  {
    route: 'POST /api/observability/harness/results/:invocationId/rejudge',
    persona: 'orgiq/admin',
    safe: 'It writes NOTHING — it reads one trace and returns three judge verdicts. Refused as `spends` for "re-judges with three Nova calls"; `lib/judge.ts` now answers from `mock/answer-check.ts` under `config.mock.agentcore`, and the handler reads its trace from the registered `trace-sink-traces` fixture under `config.mock.aurora`. Verified by hand: three identical `offline/lexical-answer-check` verdicts, no model. In practice this records as UNCAPTURED — the route demands a uuid, the seeded traffic ids (`mock-inv-0`) are not uuids, and the only uuids offline belong to traces `POST /trace` created in this process, which the reset before each replay removes. Safe, and nothing to run it against.',
    bodyFrom: 'routes/harness.ts: no body. `:invocationId` must match /^[0-9a-f-]{36}$/i and name a row the sink holds.',
    intercepts: ['aurora', 'agentcore'],
  },
  {
    route: 'POST /api/observability/calibration/runs',
    persona: 'orgiq/admin',
    safe: 'It refuses ITSELF offline, and that refusal is the shape worth pinning: routes/calibration.ts answers 503 under `config.mock.aurora` — "calibration runs invoke the Nova-Pro judge — no Bedrock in dev:mock" — after loading the active cases and BEFORE the run row is inserted, deliberately rather than synthesising an MAE about a judge nobody ran. Verified by hand. Nothing is written, so there is nothing for reset to undo. The `intercepts` is what makes that true: against an un-mocked server this route really does call the judge once per active case, which is why it may not be replayed there.',
    bodyFrom: 'routes/calibration.ts: `label`, `judgeModelId` and `notes` are all optional and defaulted, so `{}` is the whole valid body. The 503 needs at least one active case, which GET /api/observability/calibration/cases lists.',
    intercepts: ['aurora'],
    alsoAccept: [503],
    build: ok({}),
  },
  {
    route: 'POST /api/observability/calibration/cases',
    persona: 'orgiq/admin',
    safe: 'Appends one row to the registered `calibration-cases` fixture (mock/calibration.ts); reset drops it and nothing seeded moves. It was refused as `spends` for "INSERTs through the RDS Data API with no mock branch", which routes/calibration.ts contradicts: `mockInsertCalibrationCase` runs above the INSERT under `config.mock.aurora`. No judge runs here — that is `POST /calibration/runs`, which is still refused.',
    bodyFrom: "routes/calibration.ts: `agentId` non-blank, `prompt` non-empty, `response` a string, `humanScore` a finite number (clamped 0..1). The agent id is read off GET /api/agents; prompt/response/score are free text and a mid-scale number, none of them wire-shaped fields.",
    intercepts: ['aurora'],
    build: async (ctx) => {
      const agentId = await ctx.pick('/api/agents', 'id');
      if (agentId === null) return unsynthesisable('GET /api/agents listed no agent');
      return { agentId, prompt: ctx.label(), response: ctx.label(), humanScore: 0.5 };
    },
  },
  {
    route: 'POST /api/observability/quality/feedback',
    persona: 'orgiq/admin',
    safe: 'A REAL relabel of a seeded trace. Refused as `spends` for "UPDATEs through the RDS Data API with no mock branch"; routes/quality.ts branches into `mockSetHumanLabel` against the registered `observability-human-labels` fixture (mock/observability.ts), which ships five labelled invocations anchored by agentId + prompt rather than by a fixed `mock-inv-N` id (the day\'s errors are interleaved through the tail, so a hardcoded id would drift onto the wrong row). Verified by hand: the supervisor\'s Kubernetes-experts row reads `good`, the write makes it `fixed`, reset makes it `good` again.',
    bodyFrom: "routes/quality.ts: `invocationId` required and, offline, must name a row the trace tail serves (the mock reproduces the real query's `RETURNING` miss as a 404); `label` ∈ ALLOWED_LABELS ('good'|'bad'|'fixed'), spelled in the handler. The id comes off GET /api/observability/recent-invocations; `note` is free text.",
    intercepts: ['aurora'],
    build: async (ctx) => {
      const invocationId = await ctx.pick('/api/observability/recent-invocations', 'invocationId');
      if (invocationId === null) return unsynthesisable('GET /api/observability/recent-invocations listed no invocation to label');
      return { invocationId, label: 'good', note: ctx.label() };
    },
  },
  {
    route: 'POST /api/observability/memory/events',
    persona: 'orgiq/admin',
    safe: 'Appends one row to the registered `observability-memory-writes` fixture (mock/observability.ts), which the events feed concatenates onto the fleet’s derived ops; reset drops it. Refused as `spends` for "INSERTs through the RDS Data API with no mock branch" — routes/memory.ts branches into `mockInsertMemoryEvent` inside the `try`, above the statement. Verified by hand: one event carrying a distinctive queryText appears in GET /events and is gone after reset.',
    bodyFrom: "routes/memory.ts: `agentId` non-blank and `kind` accepted by `isValidKind` ('retrieve'|'write'|'summarize'|'expire'), or the route 400s. The kind is a literal that function spells; the agent id is read off GET /api/agents. Everything else is optional and omitted.",
    intercepts: ['aurora'],
    build: async (ctx) => {
      const agentId = await ctx.pick('/api/agents', 'id');
      if (agentId === null) return unsynthesisable('GET /api/agents listed no agent');
      return { agentId, kind: 'retrieve', queryText: ctx.label() };
    },
  },
  {
    route: 'PATCH /api/observability/calibration/cases/:id',
    persona: 'orgiq/admin',
    safe: 'An empty patch returns `{ ok, changed: 0 }` without touching the RDS Data API.',
    bodyFrom: 'routes/calibration.ts: every field optional; `{}` short-circuits.',
    build: ok({}),
  },
  {
    route: 'POST /api/observability/prompt-versions',
    persona: 'orgiq/admin',
    safe: 'Fully in-memory under MOCK_AURORA (`mockRegisterPromptVersion`); appends a version, moves nothing.',
    bodyFrom: 'routes/prompt-versions.ts: `agentId` and `content` non-empty; the agent id is read off GET /api/agents.',
    intercepts: ['aurora'],
    build: async (ctx) => {
      const agentId = await ctx.pick('/api/agents', 'id');
      if (agentId === null) return unsynthesisable('GET /api/agents listed no agent');
      return { agentId, content: ctx.label() };
    },
  },
  {
    route: 'PUT /api/observability/canary/weight',
    persona: 'orgiq/admin',
    safe: "An echo-back write: it sets the weight to the value GET /api/observability/canary/weight just reported, and the canary weight is a registered fixture besides.",
    bodyFrom: 'routes/canary.ts: `weight_b` an integer 0..100, read off GET /api/observability/canary/weight.',
    build: async (ctx) => {
      const current = objectsWith(await ctx.get('/api/observability/canary/weight'), 'weight_b')[0]?.['weight_b'];
      if (typeof current !== 'number') return unsynthesisable('GET /api/observability/canary/weight reported no weight_b to echo back');
      return { weight_b: current };
    },
  },
  {
    route: 'POST /api/observability/canary/halt',
    persona: 'orgiq/admin',
    safe: 'Sets the registered canary-weight fixture to halted; reset restores it. No SSM write — that is `start`, which is refused.',
    bodyFrom: 'routes/canary.ts: no body.',
  },
  {
    route: 'POST /api/observability/canary/reset',
    persona: 'orgiq/admin',
    safe: 'Resets the registered canary-weight fixture and the in-process controller. No SSM write.',
    bodyFrom: 'routes/canary.ts: no body.',
  },
  {
    route: 'POST /api/observability/approvals/request',
    persona: 'orgiq/admin',
    safe: 'The approvals surface runs entirely on its in-memory mock store under these flags, and the store ships empty — this appends, it moves nothing seeded.',
    bodyFrom: 'routes/approvals.ts: `txId` and `agentId` non-empty; the agent id is read off GET /api/agents.',
    build: async (ctx) => {
      const agentId = await ctx.pick('/api/agents', 'id');
      if (agentId === null) return unsynthesisable('GET /api/agents listed no agent');
      return { txId: ctx.label(), agentId };
    },
  },
  {
    route: 'POST /api/observability/approvals/:id/decision',
    persona: 'orgiq/admin',
    safe: 'Decides an approval in the in-memory mock store, which ships empty — only a row this capture created is reachable.',
    bodyFrom: "routes/approvals.ts: `decision` ∈ {'APPROVED','REJECTED'}.",
    build: ok({ decision: 'APPROVED' }),
  },

  // ── capabilities: the guardrail ───────────────────────────────────────────
  //
  // All three were refused by a wildcard reading "edits a live Bedrock
  // Guardrail". Under
  // MOCK_GUARDRAILS `providers/index.ts` binds `guardrails` to `mockGuardrails`,
  // which mutates the registered `guardrail` fixture (mock/capabilities.ts) in
  // place — there is no Bedrock guardrail in the process to edit. Hence
  // `intercepts: ['guardrails']`: the claim is checked against the server
  // rather than asserted here.
  {
    route: 'PATCH /api/capabilities/guardrail/pii',
    persona: 'orgiq/admin',
    safe: 'A REAL edit to a seeded PII filter, not an echo-back: `mockGuardrails.togglePiiFilter` finds the filter in the registered `guardrail` fixture and rewrites its action in place, so reset puts the seeded action back. No AWS, no model, no timer.',
    bodyFrom: "routes/capabilities.ts: `{ type, action?, enabled? }`; the type must name a filter that exists. Both values come off GET /api/capabilities/guardrail — the type is the first filter's, and the action is a DIFFERENT filter's action, chosen because it differs from this one's, so the value is one the server itself sends (`mapPiiAction` in providers/guardrails.ts is what narrows it) and the write cannot be a no-op.",
    intercepts: ['guardrails'],
    build: async (ctx) => {
      const filters = objectsWith(await ctx.get('/api/capabilities/guardrail'), 'type', 'action');
      const type = str(filters[0]?.['type']);
      const mine = str(filters[0]?.['action']);
      if (type === null || mine === null) {
        return unsynthesisable('GET /api/capabilities/guardrail listed no PII filter with a type and an action');
      }
      const other = filters.map((f) => str(f['action'])).find((a) => a !== null && a !== mine);
      if (other === undefined || other === null) {
        return unsynthesisable(`every PII filter on GET /api/capabilities/guardrail is set to '${mine}', so no different action is readable off the server`);
      }
      return { type, action: other };
    },
  },
  {
    route: 'PATCH /api/capabilities/guardrail/topics/:name',
    persona: 'orgiq/admin',
    safe: 'A REAL flip of a seeded denied topic. `mockGuardrails.updateDeniedTopic` edits the row inside the registered `guardrail` fixture, so reset restores both the flag and `updatedAt`.',
    bodyFrom: "routes/capabilities.ts: `{ enabled?, definition? }`; the topic named by `:name` must exist. `enabled` is not typed from a list — it is a DIFFERENT topic's `enabled` off GET /api/capabilities/guardrail, chosen because it differs from this topic's, so the write moves the row rather than rewriting it unchanged. `:name` itself is resolved by key path (`#deniedTopics[].name` in http.ts) because a fuzzy id search returns the guardrail's own name instead.",
    intercepts: ['guardrails'],
    build: async (ctx) => {
      const name = decodeURIComponent(ctx.path.split('/').pop() ?? '');
      const topics = objectsWith(await ctx.get('/api/capabilities/guardrail'), 'name', 'enabled');
      const mine = topics.find((t) => t['name'] === name)?.['enabled'];
      if (typeof mine !== 'boolean') {
        return unsynthesisable(`GET /api/capabilities/guardrail does not list a denied topic '${name}'`);
      }
      const other = topics.map((t) => t['enabled']).find((v) => typeof v === 'boolean' && v !== mine);
      if (typeof other !== 'boolean') {
        return unsynthesisable(`every denied topic on GET /api/capabilities/guardrail is enabled=${String(mine)}, so no different value is readable off the server`);
      }
      return { enabled: other };
    },
  },
  {
    route: 'POST /api/capabilities/guardrail/topics',
    persona: 'orgiq/admin',
    safe: 'Appends a topic to the registered `guardrail` fixture; reset drops it and nothing seeded moves. `mockGuardrails.addDeniedTopic` is a push onto the row it already holds — no UpdateGuardrail, no AWS call of any kind.',
    bodyFrom: 'routes/capabilities.ts: `name` and `definition` both required and non-empty; a topic name and its definition are free text (the shape check never asserts on either), so `ctx.label()` invents no wire value.',
    intercepts: ['guardrails'],
    build: async (ctx) => ({ name: ctx.label(), definition: ctx.label() }),
  },

  // ── capabilities: browser + code interpreter ──────────────────────────────
  {
    route: 'POST /api/capabilities/code-interpreter/execute',
    persona: 'orgiq/admin',
    safe: '`mockAgentCore.executeCode` runs nothing and writes nothing: it counts `print(` occurrences in the string and returns a canned line. No sandbox is opened, no fixture is touched, so there is nothing for reset to undo.',
    bodyFrom: 'routes/capabilities.ts: `code` must be a non-blank string; `language` is optional and defaults to python. The code is free text — under interception it is never executed and the shape check never asserts on it — so `ctx.label()` is the smallest thing that passes validation.',
    intercepts: ['agentcore'],
    build: async (ctx) => ({ code: ctx.label() }),
  },
  {
    route: 'POST /api/capabilities/browser-sessions',
    persona: 'orgiq/admin',
    safe: 'Appends a session to the registered `browser-sessions` fixture (mock/capabilities.ts); reset drops it. `url` is deliberately omitted: the handler auto-navigates on launch when one is given, and the point here is the create response, not a second write.',
    bodyFrom: 'routes/capabilities.ts: `{ agentName, url? }`. `agentName` is free text echoed back onto the session row, so `ctx.label()` invents no wire value; omitting `url` takes the `about:blank` default the provider spells.',
    intercepts: ['agentcore'],
    build: async (ctx) => ({ agentName: ctx.label() }),
  },
  {
    route: 'POST /api/capabilities/browser-sessions/:sessionId/navigate',
    persona: 'orgiq/admin',
    safe: 'An echo-back navigation: it navigates the session to the URL it is ALREADY on, read off GET /api/capabilities/browser-sessions. `mockAgentCore.navigateBrowser` rewrites the row inside the registered `browser-sessions` fixture — pageTitle, lastActivityAt and requestCount move, and reset puts all three back. Nothing is fetched: the mock derives the title from the URL string.',
    bodyFrom: 'routes/capabilities.ts: `{ url, captureScreenshot? }`. `captureScreenshot` is omitted so no screenshot is taken and no journey step is appended. The URL is the session’s own `currentUrl`, so no address this harness made up is ever handed to a navigator.',
    intercepts: ['agentcore'],
    build: async (ctx) => {
      const sessionId = decodeURIComponent(ctx.path.split('/').slice(-2)[0] ?? '');
      const sessions = objectsWith(await ctx.get('/api/capabilities/browser-sessions'), 'sessionId', 'currentUrl');
      const url = str(sessions.find((s) => s['sessionId'] === sessionId)?.['currentUrl']);
      if (url === null) {
        return unsynthesisable(`GET /api/capabilities/browser-sessions does not list ${sessionId} with a currentUrl to navigate back to`);
      }
      return { url };
    },
  },
  {
    route: 'POST /api/capabilities/browser-sessions/:sessionId/screenshot',
    persona: 'orgiq/admin',
    safe: '`mockAgentCore.screenshotBrowser` checks the session exists in the registered fixture and returns a 1x1 PNG data URL. It mutates no row. The one lasting effect is a capability event appended to the in-memory ring in lib/invocations.ts — an append to an event log, never a seeded row moved.',
    bodyFrom: 'routes/capabilities.ts: no body; the session id comes from the path.',
    intercepts: ['agentcore'],
  },
  {
    route: 'POST /api/capabilities/browser/crawl/:crawlId/cancel',
    persona: 'orgiq/admin',
    safe: '`cancelCrawl` flips one in-memory crawl to cancelled and reaches nothing. Its sibling `POST /browser/crawl` is refused as `spends`, so this sweep never creates a crawl — the crawl registry ships empty and stays empty, which means in practice this records as uncaptured with the resolver’s own reason rather than as a replay. That is the honest state: the route is safe, and there is nothing here to run it against.',
    bodyFrom: 'routes/capabilities.ts: no body; `:crawlId` comes from GET /api/capabilities/browser/crawl, which lists nothing offline.',
  },

  // ── devbox ────────────────────────────────────────────────────────────────
  //
  // Three of these were refused as `spends` under reasons that named a real
  // microVM. Under MOCK_AGENTCORE there is none: `lib/devbox-arn.ts` (and
  // routes/devbox.ts's own copy of the same two functions) returns a `…-MOCK`
  // ARN without calling ListAgentRuntimes, and hands every caller
  // `mock/devbox-shell.ts`. Hence `intercepts: ['agentcore']` — asked of the
  // server rather than asserted here.
  {
    route: 'POST /api/devbox/sessions',
    persona: 'orgiq/admin',
    safe: 'The whole handler is `normalizeRuntimeSessionId` — pad a caller-supplied id, or mint one from randomUUID — and a 201. No client is constructed, no ARN is resolved, no registry is touched, in mock mode or out of it. It is the one write on this surface that needs no interception to be safe, which is why it carries no `intercepts`.',
    bodyFrom: 'routes/devbox.ts: `sessionId` is optional; an absent one is minted. `{}` is the whole valid body.',
    build: ok({}),
  },
  {
    route: 'PATCH /api/devbox/boxes/:boxId',
    persona: 'orgiq/admin',
    safe: 'An ECHO-BACK rename, and it has to be one. `renameBox` (lib/devbox-fleet.ts) assigns `s.box.label = label` and touches nothing else, but the fleet lives in a module `Map` that registers NO fixture — so reset cannot undo a real rename, and rule 5 allows only a value written back unchanged. Writing the box’s own label back leaves the row byte-identical while the handler, its `canSee` check and the response shape all run for real. Nothing outside the process is reached in any configuration (`canSee` short-circuits on the persona’s org-wide `admin` role before any lookup), which is why this carries no `intercepts`. In practice it records as UNCAPTURED: the fleet registry ships empty, `GET /api/devbox/boxes` lists nothing, and `:boxId` never resolves. That is the honest state — the route is safe, and offline there is no box to run it against.',
    bodyFrom: "routes/devbox.ts: `label` must be a non-blank string or the route 400s with 'label is required'; `:boxId` must name a box `canSee` allows. The label is the box's own, read off GET /api/devbox/boxes.",
    build: async (ctx) => {
      const boxId = decodeURIComponent(ctx.path.split('/').pop() ?? '');
      const label = str(objectsWith(await ctx.get('/api/devbox/boxes'), 'id', 'label')
        .find((b) => b['id'] === boxId)?.['label']);
      if (label === null) return unsynthesisable(`GET /api/devbox/boxes does not list ${boxId} with a label to write back`);
      return { label };
    },
  },
  {
    route: 'POST /api/devbox/:sessionId/command',
    persona: 'orgiq/admin',
    safe: 'Under MOCK_AGENTCORE this runs one shell command against `mock/devbox-workspace.ts` through the fake client, registers no box (unlike `/task` next door) and writes nothing durable. Verified by hand: `git status` streamed back `fatal: mock devbox: unsupported command …` from the fixture and `GET /api/devbox/boxes` was still empty afterwards. Its answer is `text/event-stream`, so the capture records it as uncaptured rather than pinning a shape — as it does `:sessionId`, which nothing offline enumerates.',
    bodyFrom: "routes/devbox.ts: `command` 1–4000 chars, free of shell metacharacters in safe mode, and prefixed by one of `commandAllowlist()`. The prefix is not typed here — it is read off GET /api/devbox/status, which returns that same array, so the one closed-set value in this body comes from the server. `cwd` defaults to /mnt/workspace and `mode` defaults to 'safe', both omitted.",
    intercepts: ['agentcore'],
    build: async (ctx) => {
      const allowlist = objectsWith(await ctx.get('/api/devbox/status'), 'commandAllowlist')[0]?.['commandAllowlist'];
      const command = Array.isArray(allowlist) ? str(allowlist[0]) : null;
      if (command === null) return unsynthesisable('GET /api/devbox/status reported no commandAllowlist to take a prefix from');
      return { command };
    },
  },
  {
    route: 'POST /api/devbox/:sessionId/shell-url',
    persona: 'orgiq/admin',
    safe: 'The handler’s OWN `mockAgentCore()` branch answers before `requireArn` is ever called, with `{ url: "mock-shell://…", mock: true }` — no ARN resolution, no presign, no socket, and nothing written anywhere. Verified by hand against a running mock server. Its old `spends` reason ("resolves the devbox runtime via ListAgentRuntimes, then presigns a live socket into the microVM") described the branch below it. Records as uncaptured offline: `:sessionId` has no collection to come from.',
    bodyFrom: 'routes/devbox.ts: `shellId` and `expiresIn` are both optional — an absent shellId defaults to `portal-<session tail>`. `{}` is the whole valid body.',
    intercepts: ['agentcore'],
    build: ok({}),
  },

  // ── agent projects ────────────────────────────────────────────────────────
  //
  // These four were refused as `spends` under "drives a devbox microVM
  // (lib/project-runner.ts)" and, for clone-command, "borrows the connection's
  // real API key through AgentCore Identity". Neither describes them: the link
  // /clone/finish trio is an INSERT and two UPDATEs that branch on
  // `config.mock.aurora` into the registered `agent-projects` /
  // `agent-project-runs` fixtures, and clone-command builds a string. They
  // then sat at `unclassified` — "nobody has written a WriteSpec" — which was
  // true and is now not. Each round trip below was run by hand against a mock
  // server and undone by `POST /api/__mock/reset`.
  {
    route: 'POST /api/agent-projects',
    persona: 'orgiq/admin',
    safe: 'Appends one repository to the registered `agent-projects` fixture (mock/agent-projects.ts); verified by hand — 14 rows, 15 after, 14 after reset. The conflict target is `repo_full_name`, so a NEW name appends rather than editing a seeded row. No AWS, no fs, no timer.',
    bodyFrom: "routes/agent-projects.ts: `repoFullName` must match /^[\\w.-]+\\/[\\w.-]+$/ — everything else is optional and omitted, so no initiative is charged and no connection is attached. The owner half of the name is read off an existing repo on GET /api/agent-projects rather than invented; the name half is `ctx.label()`, free text the shape check never asserts on.",
    intercepts: ['aurora'],
    build: async (ctx) => {
      const existing = str(objectsWith(await ctx.get('/api/agent-projects'), 'id', 'repoFullName')[0]?.['repoFullName']);
      const owner = existing?.split('/')[0] ?? null;
      if (owner === null || owner === '') return unsynthesisable('GET /api/agent-projects listed no repository to copy an owner from');
      return { repoFullName: `${owner}/${ctx.label()}` };
    },
  },
  {
    route: 'POST /api/agent-projects/:id/cloned',
    persona: 'orgiq/admin',
    safe: 'A REAL flip of a seeded repository: `markCloned` stamps `sessionId` and `clonedAt` on the row, which is what moves it from "linked" to "in workspace". Replayable because `agent-projects` is registered — verified by hand, both fields go back to null on reset. Nothing is cloned: the route only records that a clone the caller already ran succeeded, and the mock stamp comes from mock/core/clock.ts.',
    bodyFrom: 'routes/agent-projects.ts: `sessionId` must be a non-blank string; it is stored verbatim as an opaque workspace handle and never resolved against the devbox, so `ctx.label()` invents no wire value. `:id` is a repository off GET /api/agent-projects.',
    intercepts: ['aurora'],
    build: async (ctx) => ({ sessionId: ctx.label() }),
  },
  {
    route: 'POST /api/agent-projects/runs/:runId/finish',
    persona: 'orgiq/admin',
    safe: 'A REAL close of a seeded run — `mockFinishRun` rewrites `status`, `finishedAt`, and (from the omitted fields) clears `filesChanged`/`diffSummary`/`error`/`costUsd`, exactly as the real UPDATE assigns all of them. Replayable because `agent-project-runs` is registered: verified by hand, the auth-service run went `failed` -> `done` and came back `failed` with its $0.81 and its error string after reset. No devbox is touched — this is the callback a finished run makes, not the run.',
    bodyFrom: "routes/agent-projects.ts: `status` collapses to 'failed' for the literal 'failed' and to 'done' for anything else — both spelled in the handler; every other field is optional. `:runId` is resolved by key path (`projects[].runs[].id` in http.ts) off GET /api/agent-projects, because `/api/agent-projects/runs` is a write-only prefix with no collection of its own.",
    intercepts: ['aurora'],
    build: ok({ status: 'done' }),
  },
  {
    route: 'POST /api/agent-projects/:id/clone-command',
    persona: 'orgiq/admin',
    safe: 'It runs the clone in the box server-side through lib/devbox-git.ts `cloneIntoBox` and returns only redacted text. Under MOCK_AGENTCORE the git entrypoint path is on (DE-45): a fake per-run token from the `local` provider goes in the invoke payload to the fake microVM in mock/devbox-shell.ts, never into a shell command, and the mint appends one row to the registered `credential-issues` fixture, which reset clears. No `borrowApiKey`, no GitHub. The persona is a fleet-wide role, so `requireBoxAccess` adopts the label session as an operator would. Deliberately NOT paired with `/cloned`: running the clone is not confirming it, and the handler must not mark the project cloned.',
    bodyFrom: 'routes/agent-projects.ts: `sessionId` must be a non-blank string the caller can reach (`requireBoxAccess`); a fleet-wide persona adopts an unknown one. `:id` is a repository off GET /api/agent-projects.',
    intercepts: ['aurora', 'agentcore'],
    build: async (ctx) => ({ sessionId: ctx.label() }),
  },

  // ── local compute ─────────────────────────────────────────────────────────
  //
  // The six writes here were refused as `unresettable` until mock/local-compute.ts
  // put `compute-nodes`, `compute-pairing-codes` and `local-presence` behind
  // registered fixtures; after that they sat at `unclassified` because nobody
  // had written the entries. These are the entries.
  //
  // Every one carries `intercepts: ['aurora']`, and that is not boilerplate:
  // providers/local-compute.ts reads the fixtures only inside
  // `if (config.mock.aurora)`, so without it these are INSERTs and UPDATEs
  // through the RDS Data API against a real `compute_nodes`, and the seeded
  // node tokens below authenticate nothing.
  {
    route: 'POST /api/local-compute/pair/start',
    persona: 'orgiq/admin',
    safe: 'Appends one pairing code to the registered `compute-pairing-codes` fixture; reset drops it. Nothing seeded moves, no timer is armed — the code expires by comparison against the clock, not by a scheduled sweep.',
    bodyFrom: 'routes/local-compute.ts: no body at all; the owner is the session, never the request. Persona is orgiq/admin because the route is behind requireTenant(‘orgiq’) + ConnectLocalCompute.',
    intercepts: ['aurora'],
  },
  {
    route: 'POST /api/local-compute/pair/claim',
    persona: 'anonymous',
    safe: 'Spends the seeded unclaimed code and appends the machine it mints to the registered `compute-nodes` fixture. Both rows come back on reset — verified by hand: claim, `GET /nodes/all` lists four machines, reset, three. The route takes no session (a pairing code is the entire credential), so the persona is `anonymous`.',
    bodyFrom: 'routes/local-compute.ts: `code` non-blank and `node.label` non-blank are the two requirements; `nodeId`/`platform` are optional and omitted so the provider mints the id. The code is the seeded one, read from `pairingCodes` — the fixture module that DEFINES it — rather than retyped here, which is the same rule the fixtures are held to. Against a server built from different fixtures the claim simply 404s, which is a refusal, not damage.',
    intercepts: ['aurora'],
    build: async (ctx) => {
      const seeded = pairingCodes.rows().find((row) => row.claimedAt === null)?.code;
      if (!seeded) return unsynthesisable('the `compute-pairing-codes` fixture seeds no unclaimed code to present');
      return { code: seeded, node: { label: ctx.label() } };
    },
  },
  {
    route: 'POST /api/local-compute/announce',
    persona: 'anonymous',
    safe: 'An echo-back announce: it re-announces the sessions the demo machine is ALREADY reporting, so the registered `local-presence` fixture ends with the same session on the same node. `lastSeenAt` on the presence row and on the node are re-stamped, and reset restores both. No session is created or dropped.',
    bodyFrom: 'routes/local-compute.ts `parseSessions`: `sessions` is an array of at most 20 records, each needing a non-empty `sessionId`; every other field is optional and `lastSeenAt` is stamped server-side. The records are the node’s own, read off GET /api/local-compute/nodes as the same cookie-less caller the demo machine belongs to. Auth is the node token, not a cookie — the seeded value from `MOCK_NODE_TOKEN` in mock/local-compute.ts, which is where it is defined.',
    intercepts: ['aurora'],
    headers: { authorization: `Bearer ${MOCK_NODE_TOKEN}` },
    build: async (ctx) => {
      const sessions = objectsWith(await ctx.get('/api/local-compute/nodes'), 'sessionId', 'harness');
      if (sessions.length === 0) {
        return unsynthesisable('GET /api/local-compute/nodes reported no announced session to echo back');
      }
      return { sessions };
    },
  },
  {
    route: 'POST /api/local-compute/heartbeat',
    persona: 'anonymous',
    safe: 'Re-stamps `lastSeenAt` on the demo machine’s presence row and on its node row, both in registered fixtures, and touches nothing else. Reset restores the seeded ages — which matters, because those ages are the ONLY input to the connected/stale/offline derivation the fleet page renders.',
    bodyFrom: 'routes/local-compute.ts: no body; the node is identified entirely by its bearer token, taken from `MOCK_NODE_TOKEN` in mock/local-compute.ts.',
    intercepts: ['aurora'],
    headers: { authorization: `Bearer ${MOCK_NODE_TOKEN}` },
  },
  {
    route: 'POST /api/local-compute/register',
    persona: 'anonymous',
    safe: 'The worker announcing its own capabilities. `recordNodeCapabilities` rewrites `localModels`/`jobKinds`/`maxConcurrency` on the demo machine’s row in the registered `compute-nodes` fixture, and reset restores the seeded values. It only NARROWS — jobKinds are intersected with LOCAL_JOB_KINDS and maxConcurrency is capped at 2 — so nothing outside the seeded shape can be written, and `acceptJobs` (the owner’s switch, which the machine cannot set) is left untouched. No AWS under MOCK_AURORA, no timer, no job claimed.',
    bodyFrom: 'routes/local-compute.ts: `localModels`/`jobKinds`/`maxConcurrency` all optional. The kinds are closed-set values the handler itself spells via LOCAL_JOB_KINDS (lib/local-work.ts); `devbox:task` is sent alongside `local:task` to exercise the documented rejection path, so the response’s `rejectedKinds`/`runnableKinds` shape comes from the handler rather than from imagination. Model ids are free text — an open set the shape check never asserts on. Auth is the node token, `MOCK_NODE_TOKEN` in mock/local-compute.ts.',
    intercepts: ['aurora'],
    headers: { authorization: `Bearer ${MOCK_NODE_TOKEN}` },
    build: async () => ({ jobKinds: ['local:task', 'devbox:task'], maxConcurrency: 4 }),
  },
  {
    route: 'POST /api/local-compute/sessions/:sessionId/end',
    persona: 'anonymous',
    safe: 'Ends a REAL session — the seeded `demo-local-session-…` on the demo machine — so the response carries `removed: true` rather than the empty-handed shape a made-up id would produce. The session lives in the registered `local-presence` fixture, so reset announces it back.',
    bodyFrom: 'routes/local-compute.ts: no body. `:sessionId` is resolved by key path (`#nodes[].presence.sessions[].sessionId` in http.ts) off GET /api/local-compute/nodes as the same cookie-less caller that owns the machine — a fuzzy id search returns the NODE’s id there and the end would silently remove nothing. The bearer token is that machine’s, so the node and the session agree.',
    intercepts: ['aurora'],
    headers: { authorization: `Bearer ${MOCK_NODE_TOKEN}` },
  },
  {
    route: 'PATCH /api/local-compute/nodes/:id',
    persona: 'orgiq/admin',
    safe: 'A REAL rename of a seeded machine the sweep’s own persona owns: `u-operator` holds `node-operator-mini` and `node-operator-thinkpad` (mock/local-compute.ts splits ownership precisely so this route has a row it may edit). `renameNode` rewrites the label in the registered `compute-nodes` fixture and reset puts `retired-mac-mini` back.',
    bodyFrom: "routes/local-compute.ts: at least one of `label` (non-blank, trimmed to 80) / `acceptJobs` (boolean), or the route 400s with 'nothing to update'. A label is free text — the shape check never asserts on it — so `ctx.label()` invents no wire value.",
    intercepts: ['aurora'],
    build: async (ctx) => ({ label: ctx.label() }),
  },
  {
    route: 'DELETE /api/local-compute/nodes/:id',
    persona: 'orgiq/admin',
    safe: 'One of two deletes on the allowlist (the decision unlink is the other), and it deletes nothing: `revokeNode` is a soft revoke that stamps `revoked_at` on a row kept for audit, inside the registered `compute-nodes` fixture, so reset clears the stamp and the machine is listed again. See RESTORABLE_DELETES for why the `destructive` rule lets it through — and note the rule itself is unchanged for every other DELETE.',
    bodyFrom: 'routes/local-compute.ts: no body; `:id` is a node off GET /api/local-compute/nodes, which lists only machines this persona owns, so the ownership clause in the UPDATE is satisfied by construction.',
    intercepts: ['aurora'],
  },

  // ── the pull-side job-claim lifecycle ───────────────────────────────────────
  //
  // `providers/agent-jobs.ts`'s queue moved behind a registered fixture
  // (`mock/agent-jobs.ts` — `agent-jobs`), which is what makes these six safe
  // to put HERE rather than in UNRESETTABLE above: whatever any of them
  // mutates, `POST /api/__mock/reset` now restores it, proven by
  // `mock/__tests__/agent-jobs-fixture-writes.test.ts`'s claim → start →
  // heartbeat → complete → reset cycle. Two different reasons still keep five
  // of the six from producing a captured 2xx shape, and each entry below says
  // which:
  //
  //   * `POST /claim` always finds an empty queue under the seeded `default`
  //     world (every seeded row comes from bot-run history and is already
  //     terminal), so it 204s with no body — a genuine empty-queue answer, not
  //     a refusal, and `capture-writes.ts` records that honestly as
  //     "uncaptured" on its own, with no `unsynthesisable` needed.
  //   * `start`/`heartbeat`/`log`/`complete` all require a LIVE `claimToken`,
  //     minted only by a real `POST /claim` that actually claimed a row. This
  //     harness's `BodyContext` (see `build?` above) exposes GET only
  //     (`ctx.get`/`ctx.pick`) — it cannot chain a prior WRITE's response into
  //     a later one, and every route in this file is captured against a
  //     server `POST /api/__mock/reset` just reset, independently of every
  //     other route's own capture. So no claim survives from one spec's
  //     replay to the next, and there is no live token to present. Each
  //     `build` says so via `unsynthesisable`, which is what makes the
  //     snapshot's "uncaptured" line for these four exact rather than a guess.
  {
    route: 'POST /api/local-compute/claim',
    persona: 'anonymous',
    safe: "Claims (or, honestly, tries to) against the registered `agent-jobs` fixture — status, box/session id and attempts all land on a row reset restores. `node-operator-thinkpad` is the one seeded machine with `acceptJobs` on and a registered kind (`local:distill`/`local:consolidate`; mock/local-compute.ts), so it is the only node whose token is worth presenting. Under the seeded `default` world there is nothing queued for it — every job seedAgentJobs() mints is `devbox:task` and already terminal — so this always answers 204 with no body, the SAME empty-queue answer a real idle worker gets, not a policy refusal.",
    bodyFrom: 'routes/local-compute.ts: no body; the node is identified entirely by its bearer token.',
    intercepts: ['aurora'],
    headers: { authorization: `Bearer ${MOCK_NODE_TOKENS['node-operator-thinkpad']}` },
  },
  {
    route: 'POST /api/local-compute/jobs/:jobId/start',
    persona: 'anonymous',
    safe: 'On the allowlist because the fixture behind it resets cleanly, not because this harness can produce a 2xx: `markRunning` needs a claimToken this node actually holds, and nothing here can mint one — see the section header above.',
    bodyFrom: "routes/local-compute.ts: `claimToken` is required in the body. `:jobId` resolves to a real row off GET /api/work/jobs (this node holds no claim on it, which is exactly why `build` bails before the route would 404 for a less exact reason).",
    intercepts: ['aurora'],
    headers: { authorization: `Bearer ${MOCK_NODE_TOKENS['node-operator-thinkpad']}` },
    build: async () => unsynthesisable("a live claimToken only exists once POST /claim actually claims a row for this node, and this harness's BodyContext exposes GET only — it cannot chain a prior WRITE's response into this one, and every route is captured against an independently-reset world, so no claim from another spec's replay survives to be reused here"),
  },
  {
    route: 'POST /api/local-compute/jobs/:jobId/heartbeat',
    persona: 'anonymous',
    safe: 'Same shape as `start` immediately above: the fixture resets, the claimToken chain is what this harness lacks.',
    bodyFrom: 'routes/local-compute.ts: `claimToken` is required in the body; `:jobId` resolves the same way `start` does.',
    intercepts: ['aurora'],
    headers: { authorization: `Bearer ${MOCK_NODE_TOKENS['node-operator-thinkpad']}` },
    build: async () => unsynthesisable("a live claimToken only exists once POST /claim actually claims a row for this node, and this harness's BodyContext exposes GET only — it cannot chain a prior WRITE's response into this one, and every route is captured against an independently-reset world, so no claim from another spec's replay survives to be reused here"),
  },
  {
    route: 'POST /api/local-compute/jobs/:jobId/log',
    persona: 'anonymous',
    safe: 'Same shape again: `appendLog` writes to `lib/local-compute-logs.ts`\'s own `logs` Map (fine to leave unregistered on its own terms — that module\'s header: a log has no seed and nothing to reset to but empty), but `fencedJob` gates every write in this group on the same live claimToken `start`/`heartbeat`/`complete` need.',
    bodyFrom: 'routes/local-compute.ts: `claimToken` required in the body, plus `seq`/`chunk` this harness never reaches; `:jobId` resolves the same way `start` does.',
    intercepts: ['aurora'],
    headers: { authorization: `Bearer ${MOCK_NODE_TOKENS['node-operator-thinkpad']}` },
    build: async () => unsynthesisable("a live claimToken only exists once POST /claim actually claims a row for this node, and this harness's BodyContext exposes GET only — it cannot chain a prior WRITE's response into this one, and every route is captured against an independently-reset world, so no claim from another spec's replay survives to be reused here"),
  },
  {
    route: 'POST /api/local-compute/jobs/:jobId/complete',
    persona: 'anonymous',
    safe: 'Same shape again, and the route whose absence from the allowlist mattered most before this migration: `completeJob` writes a TERMINAL status. It is on the allowlist now because the row it would touch lives in a registered fixture — reset undoes a terminal write exactly as completely as it undoes any other — but the claimToken chain this harness lacks still keeps it from producing a 2xx.',
    bodyFrom: 'routes/local-compute.ts: `claimToken` required, plus a `status` this harness never reaches; `:jobId` resolves the same way `start` does.',
    intercepts: ['aurora'],
    headers: { authorization: `Bearer ${MOCK_NODE_TOKENS['node-operator-thinkpad']}` },
    build: async () => unsynthesisable("a live claimToken only exists once POST /claim actually claims a row for this node, and this harness's BodyContext exposes GET only — it cannot chain a prior WRITE's response into this one, and every route is captured against an independently-reset world, so no claim from another spec's replay survives to be reused here"),
  },
  {
    route: 'POST /api/local-compute/nodes/:nodeId/work',
    persona: 'orgiq/admin',
    // SAFE either way this lands, which is what actually matters here: if it
    // enqueues, the row lands in the registered `agent-jobs` fixture
    // (`payload.nodeId`-targeted, so reset removes it and no OTHER real
    // paired worker could ever claim it — unlike the generic `POST
    // /api/work/jobs`, refused above under `fires`, an untargeted `local:*`
    // row there is claimable by any real local worker polling this server).
    // If it 409s, nothing is written at all.
    //
    // It reliably does the LATTER. `:nodeId` has no PARAM_SOURCES override, so
    // it resolves via the default `prefix` source — `GET
    // /api/local-compute/nodes` for `u-operator`, first id in `nodes[]` — and
    // `mockListNodesByOwner` (mock/local-compute.ts) orders that
    // `ORDER BY created_at` ascending, same as the real SELECT. Verified live:
    // `node-operator-mini` (`createdAt: daysAgo(96)`) sorts before
    // `node-operator-thinkpad` (`createdAt: hoursAgo(5)`), so `:nodeId`
    // resolves to the machine with `acceptJobs: false` — the gate this route
    // checks first, before it ever reaches the queue. `alsoAccept: [409]` pins
    // that shape (`{gate:'accept_jobs', error: '...'}`) rather than treating
    // it as a failed capture; there is no PARAM_SOURCES mechanism to filter
    // the owned-nodes list by `acceptJobs`, and hand-writing one path-param
    // override for one persona's fixture-specific ordering would be a second,
    // narrower source of truth for exactly the kind of drift this file exists
    // to avoid.
    safe: "Either enqueues into the registered `agent-jobs` fixture (targeted, reset restores it, nothing else could claim it) or, as it reliably does under the default fixtures, 409s on the accept-jobs gate before touching the queue at all — see the comment above for why `:nodeId` resolves to `node-operator-mini` rather than `node-operator-thinkpad`, the only node that would actually accept the kind.",
    bodyFrom: "routes/local-compute.ts: `prompt` is required unless a `workItemId`/`botId` supplies one, and `kind` must be one of LOCAL_JOB_KINDS.",
    intercepts: ['aurora'],
    alsoAccept: [409],
    build: async () => ({ prompt: 'wire capture: local compute dispatch smoke test', kind: 'local:distill' }),
  },

  // ── the pipelines tenant's four P2 writes, classified in lane E ───────────
  //
  // Each was `unclassified` — nobody had read the handler for the sweep. They
  // replay as the orgiq admin persona: `admin` passes requireTenant('pipelines')
  // and every Cedar gate, and the sweep has no pipelines persona of its own.
  {
    route: 'PUT /api/pipelines/configuration',
    persona: 'orgiq/admin',
    safe: 'An ECHO-BACK: the body is the default approver role GET /api/pipelines/configuration just returned, so the registered `pipelines.config` fixture (mock/pipeline-definitions.ts, read by providers/pipeline-definitions.ts `setDefaultApproverRole` under `config.mock.aurora`) ends with the same value and only `updatedBy` moves — which reset puts back. No AWS, no model, no timer.',
    bodyFrom: 'routes/pipelines.ts: `defaultApproverRole` must be one of APPROVER_ROLE_OPTIONS — read off the GET, never retyped.',
    intercepts: ['aurora'],
    build: async (ctx) => {
      const role = await ctx.pick('/api/pipelines/configuration', 'defaultApproverRole');
      return role === null ? unsynthesisable('GET /api/pipelines/configuration named no defaultApproverRole to echo back') : { defaultApproverRole: role };
    },
  },
  {
    route: 'PUT /api/pipelines/definitions/:id/approvers',
    persona: 'orgiq/admin',
    safe: "Records an author's version — `recordApproverRoles` bumps the version and stores the roles on one row of the registered `pipelines.definitions` fixture (an append for a derived definition, an update for a stored one); reset restores the seeded rows. `roles: []` means \"the tenant default\", so the effective approvers the Approvals page shows do not change.",
    bodyFrom: 'routes/pipelines.ts: `roles` is a list drawn from APPROVER_ROLE_OPTIONS; the empty list is valid and spelled in the handler\'s own error text ("empty = the tenant default"). `:id` resolves off GET /api/pipelines/definitions.',
    intercepts: ['aurora'],
    build: ok({ roles: [] }),
  },
  {
    route: 'POST /api/pipelines/approvals/:id/decide',
    persona: 'orgiq/admin',
    safe: "It owns no store: `decideApproval` routes the decision to the gate's OWN verb — `reviewJob` (agent-jobs), `decideChange` (sdlc) or `answerConsult` (lab) — and each of those is on this allowlist in its own right (`POST /api/work/jobs/:id/review`, `POST /api/sdlc/changes/:id/decide`, `POST /api/lab/consults/:id/answer`) over a registered fixture reset restores. An approve on a job accepts it; nothing new is enqueued.",
    bodyFrom: "routes/pipelines.ts: `decision` ∈ {'approve','reject'}; `note` optional. `:id` resolves off GET /api/pipelines/approvals — when the seeded world has nothing waiting, the route's 404 (\"No approval … is waiting\") is the shape captured, and a 409 is the gate's own \"no longer awaiting\" answer.",
    build: ok({ decision: 'approve' }),
    alsoAccept: [404, 409],
  },
  {
    route: 'POST /api/pipelines/runs/:id/cancel',
    persona: 'orgiq/admin',
    safe: "Cancels through the source's own verb: `cancelJob` on the registered `agent-jobs` fixture (a queued or claimed job only) or `stopRun` on the registered assessment runs — both restored by reset — and anything else answers 409 \"stopped where it runs\" without writing. It does not reach a devbox: cancelling a claimed job only marks the row.",
    bodyFrom: 'routes/pipelines.ts: no body. `:id` resolves off GET /api/pipelines/runs; the first run there is usually finished, so the 409 refusal is the usual shape captured.',
    alsoAccept: [404, 409],
  },

  // ── the access tenant's A0 writes (docs/access-tenant-goal.md §Routes) ────
  //
  // Each writes only the registered access fixtures (mock/access-requests.ts,
  // mock/access-policies.ts) through providers/access.ts, which answers 503
  // outside MOCK_AURORA — no AWS, no model, no timer. Lane A1's provisioning
  // (lib/access-provision.ts) runs only on a last approval, which this persona
  // never makes, and writes only registered fixtures (identity.grant-writes,
  // initiatives) when it does. They replay as the orgiq admin persona: `admin`
  // passes requireTenant('access') and every Cedar gate.
  {
    route: 'POST /api/access/requests',
    persona: 'orgiq/admin',
    safe: 'Appends one submitted request, its approval steps and a `submitted` event to the registered `access.requests` / `access.request-steps` / `access.events` fixtures; reset restores the seed. Submitting provisions nothing; the bell item it sends goes through notify(), a logged no-op without the gateway sink.',
    bodyFrom: 'routes/access.ts: `itemId` must name a catalog item (read off GET /api/access/catalog, never retyped), `justification` at least 20 characters, `duration` one of DURATIONS. A request the beneficiary already holds or has open is the 409 captured instead.',
    intercepts: ['aurora'],
    alsoAccept: [409],
    build: async (ctx) => {
      const itemId = await ctx.pick('/api/access/catalog', 'id');
      return itemId === null ? unsynthesisable('GET /api/access/catalog listed no item to request')
        : { itemId, justification: 'wire capture: an access request smoke test', duration: '7d' };
    },
  },
  {
    // The request page's summary (routes/access.ts `assessSubmission`): the
    // submit's own checks and chain, with nothing written.
    route: 'POST /api/access/requests/preview',
    persona: 'orgiq/admin',
    safe: 'A READ over POST: runs the submit\'s checks (`assessSubmission`) and the chain resolver over the registered access fixtures and the directory, and writes nothing — no request, step, event or bell item — so there is nothing for reset to undo.',
    bodyFrom: 'routes/access.ts: `itemId` must name a catalog item (read off GET /api/access/catalog, never retyped); `duration` optional, one of DURATIONS. A held or duplicate item rides in `refusal`, not a status.',
    intercepts: ['aurora'],
    build: async (ctx) => {
      const itemId = await ctx.pick('/api/access/catalog', 'id');
      return itemId === null ? unsynthesisable('GET /api/access/catalog listed no item to preview') : { itemId, duration: '7d' };
    },
  },
  {
    // The in-tenant quick request (routes/access-requests-quick.ts): the same
    // submit path as POST /api/access/requests, for the caller only, limited to
    // the caller's current tenant's items — so the Work budget-visibility item.
    route: 'POST /api/access-requests/quick',
    persona: 'orgiq/admin',
    safe: 'Appends one submitted request (the operator for budget visibility in Work), its approval step and a `submitted` event to the registered `access.requests` / `access.request-steps` / `access.events` fixtures; reset restores the seed. It never decides or provisions; the bell item goes through notify(), a logged no-op without the gateway sink.',
    bodyFrom: 'routes/access-requests-quick.ts: `itemId` must name a catalog item of the caller\'s current tenant (the orgiq persona: `capability:orgiq:budgets-read`, read off the route\'s own GET /api/access-requests/mine query), `justification` at least 20 characters, `duration` one of DURATIONS. An open duplicate is the 409 captured instead.',
    intercepts: ['aurora'],
    alsoAccept: [409],
    build: async () => ({ itemId: 'capability:orgiq:budgets-read', justification: 'wire capture: a budget visibility request smoke test', duration: '30d' }),
  },
  {
    route: 'POST /api/access/requests/:id/withdraw',
    persona: 'orgiq/admin',
    safe: 'Moves one row of the registered `access.requests` fixture to `withdrawn`, skips its open steps and appends an event; reset restores them. Only a party may withdraw, so the persona usually gets the 403 (or the 409 on a closed request) — both real shapes.',
    bodyFrom: 'routes/access.ts: an optional `reason` string; no other key.',
    intercepts: ['aurora'],
    alsoAccept: [403, 404, 409],
    build: ok({}),
  },
  {
    route: 'POST /api/access/requests/:id/steps/:step/decide',
    persona: 'orgiq/admin',
    safe: 'Decides one step of a registered `access.requests` row (status, steps and events, all registered; reset restores them). The cross-tenant admin is never an eligible decider (lib/access/chain.ts), so the 403 refusal is the usual shape captured; a last approval would provision into the registered `identity.grant-writes` / `initiatives` fixtures, which reset also restores.',
    bodyFrom: "routes/access.ts: `decision` ∈ {'approve','reject','info'}; `comment` optional for approve. `:step` is the request's current step, read off GET /api/access/requests/:id.",
    intercepts: ['aurora'],
    alsoAccept: [403, 404, 409],
    build: ok({ decision: 'approve' }),
  },
  {
    route: 'PUT /api/access/policies/:id',
    persona: 'orgiq/admin',
    safe: 'An ECHO-BACK: the body is the severity GET /api/access/policies just returned for the first policy, so the registered `access.policies` fixture ends with the same rule and only `updatedAt`/`updatedBy` move — which reset puts back.',
    bodyFrom: "routes/access.ts: `severity` ∈ {'warn','block'} and/or a non-empty `reason` — read off the GET, never retyped.",
    intercepts: ['aurora'],
    build: async (ctx) => {
      const severity = await ctx.pick('/api/access/policies', 'severity');
      return severity === null ? unsynthesisable('GET /api/access/policies named no severity to echo back') : { severity };
    },
  },

  // ── the access tenant's A2 writes (docs/access-tenant-goal.md §A2) ─────────
  //
  // Two of the four replay: the SoD override and opening a review campaign
  // write only registered fixtures. The manual revoke and a review decision are
  // deliberately NOT here: a revoke bumps the beneficiary's session_epoch
  // (lib/access-provision.ts `revokeAccess`), which lives on the identity
  // provider's seed mirror and is not a fixture reset restores — rule 5 — so
  // they stay refused as unclassified.
  {
    route: 'POST /api/access/requests/:id/sod-override',
    persona: 'orgiq/admin',
    safe: 'Records an override on one registered `access.requests` row (sodOverriddenBy / sodOverrideReason and a `sod-override` event) and, when that row is approved, provisions it into the registered `identity.grant-writes` / `initiatives` fixtures; reset restores all of them. No seeded request carries a live block, so the 409 "no blocking conflict" is the usual shape captured.',
    bodyFrom: 'routes/access.ts: `reason`, at least 20 characters; no other key.',
    intercepts: ['aurora'],
    alsoAccept: [403, 404, 409],
    build: ok({ reason: 'wire capture: an SoD override smoke test' }),
  },
  {
    route: 'PUT /api/access/configuration',
    persona: 'orgiq/admin',
    safe: 'An ECHO-BACK: an empty `items` list validates the body and answers the configuration without writing a row; a non-empty one would edit only the registered `access.catalog` fixture, which reset restores.',
    bodyFrom: 'routes/access.ts: `items` — an array of `{ id, defaultDuration?, sensitive? }` naming catalog items; `durations` / `stewards` are refused as fixed.',
    intercepts: ['aurora'],
    build: ok({ items: [] }),
  },
  {
    route: 'POST /api/access/reviews',
    persona: 'orgiq/admin',
    safe: 'Appends one open campaign and its items (one per standing grant the directory holds in the tenant) to the registered `access.reviews` / `access.review-items` fixtures; reset restores the seed. It reads the directory and writes no grant.',
    bodyFrom: "routes/access.ts: `tenant` ∈ ACCESS_TENANTS and a `title` of 3–200 characters; no other key.",
    intercepts: ['aurora'],
    build: ok({ tenant: 'pipelines', title: 'wire capture: a review campaign smoke test' }),
  },

  // ── access delegations (A3: docs/access-tenant-api.md § "Escalation timers and delegation") ──
  {
    route: 'POST /api/access/delegations',
    persona: 'orgiq/admin',
    safe: 'Pushes one row onto the registered `access.delegations` fixture (mock/access-delegations.ts) and notifies through the same social sink the already-allowlisted decide route uses; reset restores the seed. Whether a delegation is in force is derived from the mock clock, never stored. The persona may be refused (400/403/409) by the delegation rules, which is a real shape too.',
    bodyFrom: 'routes/access.ts: `delegateId` (a directory person, read off the seeded delegation), `endsAt` (an ISO instant) and `reason` (a string); `startsAt` defaults to the mock clock.',
    intercepts: ['aurora'],
    alsoAccept: [400, 403, 404, 409],
    build: async (ctx) => {
      const delegateId = await ctx.pick('/api/access/delegations', 'delegateId');
      return delegateId === null ? unsynthesisable('GET /api/access/delegations listed no delegate to hand decisions to')
        : { delegateId, endsAt: '2099-01-01T00:00:00.000Z', reason: 'wire capture: a delegation smoke test' };
    },
  },
  {
    route: 'POST /api/access/delegations/:id/end',
    persona: 'orgiq/admin',
    safe: 'Stamps `endedAt` / `endedBy` on one row of the registered `access.delegations` fixture; reset restores it. The seeded delegation has already run its course, so the 409 "already ended" may be the shape captured.',
    bodyFrom: 'routes/access.ts: an optional `reason` string; `:id` resolves off GET /api/access/delegations.',
    intercepts: ['aurora'],
    alsoAccept: [403, 404, 409],
    build: ok({ reason: 'wire capture: ending a delegation' }),
  },

  // ── runbooks (R3/R4: routes/runbooks.ts) ──────────────────────────────────
  //
  // Every runbook write goes through the store (lib/runbooks/store.ts), which in
  // `dev:mock` is RowsRunbookStore over five REGISTERED fixtures (mock/runbooks.ts),
  // so `POST /api/__mock/reset` undoes all of it. Time comes from `now()` (the mock
  // clock); ids derive from the run and runbook, or `randomUUID` for a proposal row
  // the snapshot records by key path only. Nothing reaches AWS or a model.
  {
    route: 'POST /api/runbooks/proposals',
    persona: 'orgiq/admin',
    safe: 'Appends one open proposal to the registered `runbook-proposals` fixture and lints/similarity-checks it in process; reset restores the seed.',
    bodyFrom: 'routes/runbooks.ts: `kind` ∈ new | edit | retire and a `rationale`; an edit or retire names `runbook_id`, read off GET /api/runbooks. The person case takes no attribution from the body.',
    alsoAccept: [400, 403, 409],
    build: async (ctx) => {
      const runbookId = await ctx.pick('/api/runbooks', 'id');
      return runbookId === null ? unsynthesisable('GET /api/runbooks listed no runbook to propose retiring')
        : { kind: 'retire', rationale: 'wire capture: a proposal smoke test', runbook_id: runbookId };
    },
  },
  {
    route: 'POST /api/runbooks/proposals/:pid/withdraw',
    persona: 'orgiq/admin',
    safe: 'Moves one open row of the registered `runbook-proposals` fixture to withdrawn; reset restores it. Only the proposer may withdraw, so the persona usually gets the 403 NOT_PROPOSER (or 409 on a closed proposal) — both real shapes. Takes no body.',
    bodyFrom: 'routes/runbooks.ts: no body; `:pid` resolves off GET /api/runbooks/proposals.',
    alsoAccept: [403, 404, 409],
  },
  {
    route: 'POST /api/runbooks/proposals/:pid/accept',
    persona: 'orgiq/admin',
    safe: 'Decides one row of the registered `runbook-proposals` fixture and, for an edit or new, writes a runbook version into the registered `runbooks` / `runbook-versions` fixtures; reset restores all of them. Only in-process lint and persistence; no model, no AWS.',
    bodyFrom: 'routes/runbooks.ts: optional `note`; a `new` proposal also needs `scope`, which the persona omits, so the 400/403/409 refusal is the usual shape captured.',
    alsoAccept: [400, 403, 404, 409],
    build: ok({ note: 'wire capture: accept smoke test' }),
  },
  {
    route: 'POST /api/runbooks/proposals/:pid/reject',
    persona: 'orgiq/admin',
    safe: 'Decides one row of the registered `runbook-proposals` fixture to rejected; reset restores it.',
    bodyFrom: 'routes/runbooks.ts: a `note` saying why (required).',
    alsoAccept: [400, 403, 404, 409],
    build: ok({ note: 'wire capture: reject smoke test' }),
  },
  {
    route: 'POST /api/runbooks/proposals/:pid/merge',
    persona: 'orgiq/admin',
    safe: 'Closes one proposal as merged and appends the edit proposal it spawns, both in the registered `runbook-proposals` fixture; reset restores it.',
    bodyFrom: 'routes/runbooks.ts: `into`, the id of a published runbook, read off GET /api/runbooks; optional `note`.',
    alsoAccept: [400, 403, 404, 409],
    build: async (ctx) => {
      const into = await ctx.pick('/api/runbooks', 'id');
      return into === null ? unsynthesisable('GET /api/runbooks listed no runbook to merge into') : { into, note: 'wire capture: merge smoke test' };
    },
  },
  {
    route: 'POST /api/runbooks/:id/retire',
    persona: 'orgiq/admin',
    safe: 'Marks one row of the registered `runbooks` fixture retired; reset restores it.',
    bodyFrom: 'routes/runbooks.ts: a `reason` (required); `superseded_by` is optional and omitted. `:id` resolves off GET /api/runbooks.',
    alsoAccept: [400, 403, 404, 409],
    build: ok({ reason: 'wire capture: retire smoke test' }),
  },
  {
    route: 'POST /api/runbooks/:id/applications',
    persona: 'orgiq/admin',
    safe: 'Would append one application to the registered `runbook-applications` fixture, but it is a BOX callback.',
    bodyFrom: 'routes/runbooks.ts: `run_ref`, `outcome`, and an X-Service-Auth HMAC envelope PLUS a per-run token (lib/run-token.ts) for exactly that run_ref.',
    build: async () =>
      unsynthesisable(
        'the route authenticates with an HMAC envelope over the raw body plus a run token bound to the run_ref, neither of which this harness can mint; routes/__tests__/runbooks*.test.ts and lib/__tests__/lab-cli-brief.test.ts cover the write.',
      ),
  },

  // ── the social tenant's context bindings (lane E) ─────────────────────────
  {
    route: 'PUT /api/social/bindings',
    persona: 'orgiq/admin',
    safe: 'Writes one row of the registered `social.bindings` fixture (mock/social-bindings.ts), which reset restores. No AWS, no model, no timer.',
    bodyFrom: 'routes/social.ts: `channel` must be `social:ch:<slug>` of a directory channel, and the CONTEXT rides the query string (`?context=initiative:<id>`).',
    build: async () =>
      unsynthesisable(
        'the context this binds is a query parameter (`?context=<kind>:<id>`), and this harness replays a write at its resolved path with a body only — it has no way to carry a query string. The GET side is captured with a QUERY_HINT; routes/__tests__/social-bindings.test.ts covers the write.',
      ),
  },
];

/**
 * The first editable document the knowledge tree lists. The tree says which
 * node that is — `editable: true`, `is_dir: false` — so nothing is guessed
 * from the shape of an id. An earlier version matched "id contains a colon"
 * and picked the FOLDER `ec:standards`, which 404s on every doc route: the
 * lesson being that a heuristic over an id is a guess, and the server's own
 * flag is a fact.
 */
async function editableDocId(ctx: BodyContext): Promise<string | null> {
  const tree = await ctx.get('/api/assessment/knowledge/tree');
  const node = objectsWith(tree, 'id', 'editable', 'is_dir')
    .find((n) => n['editable'] === true && n['is_dir'] === false);
  return str(node?.['id']);
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export type Classification =
  | { kind: 'replay'; spec: WriteSpec }
  | { kind: 'refused'; rule: string; reason: string };

const byRoute = new Map<string, WriteSpec>(WRITE_SPECS.map((s) => [s.route, s]));

const ruleById = (id: string): RefusalRule => {
  const rule = REFUSAL_RULES.find((r) => r.id === id);
  if (!rule) throw new Error(`write-policy: no refusal rule '${id}'`);
  return rule;
};

const refuse = (rule: RefusalRule, route: string): Classification => {
  const extra = rule.detail?.(route);
  return { kind: 'refused', rule: rule.id, reason: extra ? `${rule.because} Here: ${extra}.` : rule.because };
};

/**
 * What the server being captured says it is running, from its own
 * `GET /api/health`. `capture-writes.ts` reads it once and passes it here.
 */
export type Intercepted = ReadonlySet<MockProvider>;

/**
 * The one decision. Refusals win; an unlisted route is refused, never
 * replayed.
 *
 * `intercepted` is what the SERVER reported about itself. Omitting it — which
 * is what every caller that is reasoning about the policy rather than running
 * it does, the tests included — means "nothing is known to be intercepted",
 * and every spec that leans on interception is refused. That default is the
 * point: this file never decides on its own that a provider is mocked.
 */
export function classifyWrite(route: string, intercepted?: Intercepted): Classification {
  for (const rule of REFUSAL_RULES) {
    // Both of these are answered below, once the allowlist has been consulted:
    // `unclassified` means "no entry", and `not-intercepted` is a question
    // about the server rather than about the route.
    if (rule.id === 'unclassified' || rule.id === 'not-intercepted') continue;
    if (rule.applies(route)) return refuse(rule, route);
  }
  const spec = byRoute.get(route);
  if (!spec) return refuse(ruleById('unclassified'), route);
  const needs = spec.intercepts ?? [];
  if (needs.some((provider) => !intercepted?.has(provider))) {
    return refuse(ruleById('not-intercepted'), route);
  }
  return { kind: 'replay', spec };
}

/** Exported for the test that proves every spec is reachable and reasoned. */
export function specFor(route: string): WriteSpec | undefined {
  return byRoute.get(route);
}
