# Local compute — first-run UX audit

Repo: `/Users/connorhoehn/Projects/aws-agentcore`. Read-only trace against
`docs/local-compute-presence.md`, `docs/bots-and-work-marketplace.md`,
`docs/sdlc-capture-delivery-model.md`, and the code the doc names.

All six problems (the five the user hit, plus the double-pairing scenario the
coordinator flagged) have a concrete cause in code. Ranked by user impact.

---

## 1. "Not updating after refreshing but my local computer says connected" — HIGHEST IMPACT

### What's actually correct (verified, not the bug)

The presence pipeline itself is wired correctly for the happy path:

- Worker → `POST /api/local-compute/announce` with `Bearer <nodeToken>`
  (`tools/local-compute-worker.mjs:240-248`).
- Route → `recordAnnounce(node.id, sessions)` + `touchNode(node.id)`
  (`middleware/src/routes/local-compute.ts:242-251`).
- `recordAnnounce` writes into the in-memory presence fixture, keyed by
  `nodeId` (`middleware/src/lib/local-compute-fleet.ts:148-167`,
  `middleware/src/mock/local-compute.ts:663-673` — `upsertPresenceRow`).
- `GET /nodes` derives `presence.status` from `lastSeenAt` via
  `statusOfNode` (≤90s connected, ≤5min stale, else offline) —
  `local-compute-fleet.ts:188-208` — and both the page
  (`portal/src/pages/local-compute/LocalComputePage.tsx:72`) and the header
  chip (`portal/src/components/shell/LocalComputeBadge.tsx:77`) poll this
  same `GET /api/local-compute/nodes` every 15s, and a hard page refresh
  re-fetches it fresh (no client caching in `useFetch`,
  `portal/src/hooks/useFetch.ts:82-95`). So *if the server-side presence row
  is genuinely fresh*, a refresh WILL show it — the "not updating on
  refresh" symptom means the server-side row is genuinely stale, not a
  front-end caching bug.

### The actual bug: silent presence-write failures

`tools/local-compute-worker.mjs:240-248`:

```js
async function announce(config) {
  try {
    await post(config, '/api/local-compute/announce',
      { sessions: presenceSessions() }, authHeaders(config));
  } catch {
    // Presence is best-effort — a missed announce just lets the badge age.
  }
}
```

This **never inspects `res.status` / `res.ok`.** A 401 (revoked or rotated
node token), a 400 (malformed session, e.g. a future field trips
`parseSessions` in `routes/local-compute.ts:208-240` and it 400s the whole
announce), or any other non-2xx is treated exactly like success: no log
line, no exit, nothing. The same is true of `heartbeat()`
(`local-compute-worker.mjs:442-460`, only handles the `409 claim_lost` case
explicitly, and even that path is scoped to a *job* heartbeat, not the
presence heartbeat inside `announce`). Once the token the worker holds in
memory stops authenticating, the worker's own console keeps printing its
normal cadence ("announcing presence every 25s…") forever while the server
never sees another announce — `lastSeenAt` ages past 90s → `stale`, past
5min → `offline`, sessions dropped. This is *exactly* the reported
contradiction: the operator's terminal looks fine, the portal is stale.

**How the token goes bad without the user doing anything obviously wrong**
is problem #6 below — re-pairing rotates the token under a worker that is
still running with the old one cached.

### Fix (smallest change, `tools/local-compute-worker.mjs`)

1. Make `announce()` and `heartbeat()` return/inspect `res.status`:
   - On `401`, stop retrying blindly — print a loud, specific line
     (`node token rejected — this machine was likely re-paired since this
     worker started; restart it`) and exit non-zero, the same way `register()`
     already does at line 134-138. Silence is the wrong default for an auth
     failure; it's the right default only for a *dead network*.
   - On other non-2xx, log once (not on every 25s tick — dedupe) so a
     genuine outage is visible without spamming.
2. Secondary, cheaper mitigation: have `startPresenceLoop`
   (`local-compute-worker.mjs:466-476`) track consecutive announce failures
   and print a warning after N in a row, so even an un-fixed `catch {}` at
   least becomes observable.

No middleware change is required for this half — the wire contract is fine;
the worker just needs to stop swallowing status codes.

---

## 2. "Logs are black" — confirmed, root cause in ui-components, already a *known* debt item

`portal/src/pages/local-compute/LocalComputePage.tsx:410-417` (`RunLog`)
passes `LogStream` only `lines`, `follow`, `maxHeight`, `emptyMessage` —
there is no `tone`/`theme` prop to pass, because `LogStream` doesn't have
one:

`~/Projects/ui-components/src/components/shared/LogStream.tsx:154`:

```js
'bg-[var(--color-surface-subtle,#0b1020)] text-[var(--color-text-primary,#e5e7eb)]',
```

`--color-surface-subtle` **is not defined anywhere in ui-components'
`styles.css`** — confirmed by
`~/Projects/ui-components/src/components/__tests__/darkSurfaceTokens.test.tsx:58-70`,
which carries `LogStream.tsx` on an explicit "undefined token" burndown list
(rule (c) in that file's own comment: *"the fallback silently wins in BOTH
palettes, so the element is permanently pinned to one hardcoded color"*).
So `LogStream` renders `#0b1020` (near-black navy) with light text
**unconditionally**, light theme or dark — it is not reading the app's
theme at all, it's reading a token that resolves to nothing and falling
back to a hardcoded dark literal. This is a real, tracked-but-unfixed bug
in the shared library, not a portal misuse.

Separately: the log content itself is not empty for a `claude -p` run — the
worker ships raw `--output-format stream-json` lines
(`local-compute-worker.mjs:334-345, 363-372`) verbatim to
`POST /jobs/:id/log`, and `RunLog` renders each chunk as one `LogLine`
(`LocalComputePage.tsx:393`, `e.text` → `message`, no `id`/`level`/`source`
mapped). So the box isn't black-because-empty; it's black-because-token-bug,
and even once fixed the content will be raw JSON objects per line rather
than readable text — worth flagging as a second, smaller trip hazard (see
"Also worth noting" below).

### Fix
- **ui-components** (cross-repo; per `docs/local-compute-presence.md`'s own
  coordination rule, "never edit ui-components from this repo" — file this
  as the same kind of cross-repo ask the doc already tracks for
  `HeaderStatusMenu`/`Computer.kind`): define `--color-surface-subtle` (and
  a paired ink token) in `styles.css` for both `:root` and
  `[data-theme="dark"]`, or simplify `LogStream` to use an existing *defined*
  dark-surface token (there is clearly prior art — `TranscriptPanel`/
  `SummaryPanel` are cited in the same test file as the pattern to copy:
  `bg-surface`/`border-border`, tokens that exist in both palettes) instead
  of a hand-rolled `#0b1020` fallback.
- Once fixed, no portal change is needed — `RunLog` doesn't need a new
  prop, just a library that resolves its own token.

---

## 3. "Awaiting review doesn't make sense" — confirmed, wrong default, wrong lane

### Where the status is assigned

- Portal composer dispatch never sends `requiresReview`:
  `LocalComputePage.tsx:135-150` — `handleDispatch` posts
  `{ title, prompt, kind: 'local:task' }` only.
- Middleware defaults it to `true` unconditionally when absent:
  `middleware/src/routes/local-compute.ts:816` —
  `requiresReview: body.requiresReview !== false` (comment at 813-816 admits
  this is deliberate: *"defaults to true — the same default the composer
  sends"*).
- Worker completes accordingly, same rule, same default:
  `tools/local-compute-worker.mjs:527-535` —
  `const needsReview = job.payload?.requiresReview !== false;` →
  `status = outcome.ok ? (needsReview ? 'awaiting_review' : 'done') : 'failed'`.

So a 10+10 arithmetic question — no repo, no diff, no artifact — lands in
`awaiting_review` not because anything about the job *needs* review, but
because **nothing in the path ever offers the option not to**, and the
default silently wins.

### Why that status is semantically wrong here

`docs/bots-and-work-marketplace.md:47-53,63` and
`docs/sdlc-capture-delivery-model.md:23,40-44` describe the review step as
"the reviewer must see exactly one run's **change**" inside
`capture → independent review → policy gates → decide → deliver PR` — review
exists to gate a diff/capture before it's delivered. A no-artifact ad hoc
prompt has no change to review.

### Where it's actually surfaced — and why that's the tell

`portal/src/pages/work/WorkHomePage.tsx:178-208` — the **Automate "Needs
your review"** lane renders every `status === 'awaiting_review'` job with
an `Accept`/`Reject` pair (`WorkHomePage.tsx:203-204`), designed for
reviewing a code change's summary. The "math" job lands in that exact lane,
next to real change reviews, showing `j.result?.summary` (whatever text
`claude -p "what is 10+10"` produced) with Accept/Reject buttons that don't
correspond to anything reviewable. Same status/tone shown again on the
Local Compute page's own Runs table via
`portal/src/pages/local-compute/localComputeFormat.ts:5-9` (`'awaiting
review'` chip, tone `info`). It genuinely confuses a reviewer, and it is
not just cosmetic — `WorkHomePage`'s reviewer has no way to tell "this
needs review" from "this had nowhere else to go."

### Fix
1. **Gate the default on whether the job can produce a reviewable
   artifact**, not on "did the caller remember to say no." In
   `middleware/src/routes/local-compute.ts`'s `/nodes/:nodeId/work` handler
   (~line 764-820), only default `requiresReview: true` when `repo` is
   present (a job with no `repo` cannot produce a diff at all — there is
   nothing to capture, and nothing to review). Concretely:
   `requiresReview: body.requiresReview !== false && Boolean(repo)`. Mirror
   the same rule worker-side at `local-compute-worker.mjs:533` so a job
   dispatched via a route other than the composer (or via `POST
   /api/work/jobs`) gets the same honest default.
2. A no-artifact, no-repo ad hoc run should land in `done` (success) or
   `failed` — never `awaiting_review` — and it should be visible only on the
   Local Compute page's own Runs table (`LocalComputePage.tsx:336-353`),
   not in the cross-cutting Automate review lane. That already falls out of
   fix (1): the review lane filter (`WorkHomePage.tsx:182`) only ever sees
   `awaiting_review` rows, so removing the false-positive status removes
   the false-positive lane entry for free.

---

## 4. "Dispatch work shouldn't be manual like this" — confirmed by design, real governance gap

### What the page actually offers

`LocalComputePage.tsx:297-334` — a `TaskComposer` with a **free-text
prompt field**, gated only on `ConnectLocalCompute` (the same capability
that pairs a machine and flips its accept-jobs switch —
`middleware/src/routes/local-compute.ts:755-758`, comment at 722-741
explicitly defends this choice: *"the right question for local work is 'is
this your machine'"*). It posts straight to
`POST /api/local-compute/nodes/:nodeId/work` with `kind: 'local:task'`
hardcoded (`LocalComputePage.tsx:142`) — no initiative, no bot, no budget
envelope, no `dispatched_by` attribution chain beyond the raw session sub.

### How work is supposed to reach a machine, per the docs

`docs/local-compute-presence.md`'s "P2 — working the queue" section (and
the Authorization section, "Job participation… reuses the existing
money/attribution rails unchanged… still hits the envelope gates in
`bot-runner.ts`") describes local nodes as **queue consumers behind the
same governance rails as cloud dispatch** — `agent_jobs`, `dispatched_by`
from a real session, envelope/budget checks. The two *existing*, properly
governed paths into that queue are:

- **Bots** — `POST /api/bots/dispatch-work` (`middleware/src/routes/bots.ts:202`),
  gated `DispatchAgentRun` (`bots.ts:50`), which runs `grantScopedDispatchVerdict`
  (grant/sprint authorization), `preflightWorkItem` (is this dispatchable at
  all, against which codebase) and budget checks *before* it ever calls
  `dispatchWorkItem` (`bots.ts:224-260+`) — i.e. a work-item-shaped,
  budgeted, attributed dispatch.
- **Initiative work items** — the same route, keyed by `workItemId` off
  `/iq/projects` work tables, which is exactly the "something from a
  project initiative" the user asked for.
- Cron/scheduled bots live under `/admin/bots` and the bot-runner's own
  scheduling (`middleware/src/lib/bot-runner.ts`), which already carries the
  envelope gates (`decideRunBudget`, `decideAllocation` — referenced at
  `bots.ts:29`) local compute is supposed to "not bypass" per the design
  doc.

None of that path currently has a way to *target a specific local node* —
`dispatchWorkItem`/`bot-runner.ts` picks a devbox, not a `local:<nodeId>`
box (confirmed: no `nodeId`/`local:` string anywhere in
`middleware/src/lib/bot-runner.ts`). So today the *only* way to get work
onto a paired laptop through the browser is the freeform composer — which
is why it exists, and exactly why it's the wrong shape: it's standing in
for a feature (targeted dispatch from a work item / bot) that was never
built, by exposing the raw pull-queue write.

### Proposed replacement

1. Kill (or capability-gate far tighter, e.g. hide by default behind a
   `LocalComputeDevConsole` internal flag) the freeform `TaskComposer` on
   `LocalComputePage.tsx:297-334`.
2. Replace the "Hand work to `<machine>`" section with **"What this machine
   will pick up next"**: a read-only view over `GET /api/local-compute/runs`
   (already implemented, `local-compute.ts:842-872`) filtered to
   `queued`/`claimed` rows whose `payload.nodeId` matches the selected
   machine, plus a link "Dispatch from a project" → `/iq/projects` (or the
   specific initiative's work table) and "Create scheduled work" →
   `/admin/bots`. This turns the page into what the header chip already is
   — a status surface — rather than a second, ungoverned dispatch door.
3. If a "point this bot/work-item at *my* machine" control is wanted, that
   is new work, not a fix: add a `boxId`/`nodeId` targeting field to
   `dispatchWorkItem`'s payload (`bot-runner.ts`) and thread it through
   `POST /api/bots/dispatch-work`, so a person can say "run this work item,
   and prefer my paired laptop" while every existing budget/grant/attribution
   gate in `bots.ts:202-260` still applies unchanged. That is the "per-
   initiative dispatch that targets a machine" option and it is additive to
   an existing, already-governed route rather than a new door.

---

## 5. Pairing dialog doesn't close/advance on its own — confirmed

`portal/src/pages/local-compute/PairMachineDialog.tsx:56-59,61-73`: the
dialog mints a code on open and then does **nothing** until the user clicks
`Done` (line 72) — there is no poll, no SSE subscription, no
`GET /api/local-compute/pair/:code`-style status endpoint (confirmed: no
such route exists in `middleware/src/routes/local-compute.ts` — only
`/pair/start` and `/pair/claim`). The dialog's own copy at line 93 tells the
user to go look elsewhere ("The machine appears under Your machines within
15 seconds of claiming") instead of the dialog doing that watching itself.

Two structural reasons a new backend endpoint isn't needed:
- Pairing is always owner-bound to the session that minted the code
  (`createPairingCode(session.sub)`, `local-compute.ts:176-179`), so the
  already-implemented, owner-scoped `GET /api/local-compute/nodes` is
  sufficient to detect "a new node of mine just appeared."
- Claiming a code does **not** emit anything on the presence SSE stream
  (`subscribePresence`/`notify` in `local-compute-fleet.ts` only fire from
  `recordAnnounce`/`recordHeartbeat`/`endSession` — pairing-claim never
  calls any of them), so `GET /api/local-compute/stream` will not tell the
  dialog about a fresh pairing either; a poll against `/nodes` is the only
  signal available today.

### Fix (`PairMachineDialog.tsx`)
1. On mint (`mint()`, line 45-52), snapshot the caller's current node ids —
   either accept the already-fetched node list as a prop from
   `LocalComputePage` (it already holds `nodesData` at line 72) or issue one
   `GET /nodes` at mint time.
2. While the dialog is open and a code is showing, poll `GET /nodes` on a
   **tight interval independent of the page's 15s cadence** — e.g. every
   2-3s, matching the log poll's own precedent
   (`LocalComputePage.tsx:401`, `setInterval(poll, 2000)`) — cheap because
   it only needs to run while this modal is mounted.
3. When a node id appears that wasn't in the snapshot, auto-advance the
   dialog to step 2 (show the worker command with a toast/banner "Paired as
   `<label>`") rather than closing outright — pairing alone doesn't make the
   machine usable yet (it's still offline until the worker announces), so a
   silent full-close would trade one confusing wait for another. Only
   auto-close once the same node also reaches `presence.status !== 'offline'`
   were you to unify both steps into one dialog; short of that, advancing
   the dialog and stopping the "still minting" spinner is the honest minimal
   fix.

---

## 6. Re-pairing the same machine rotates its token underneath a running worker — confirmed, and it's a plausible cause of #1

### The mechanism

`tools/local-compute-plugin/orgiq-presence.mjs:78-88` (`pair()`): if
`~/.claude-mem/orgiq-presence.json` already has a `nodeId` (i.e. this
machine was paired before), a second `pair <NEWCODE>` run sends that same
`nodeId` back to the server:

```js
const res = await post({ baseUrl }, '/api/local-compute/pair/claim', {
  code,
  node: { ...(config.nodeId ? { nodeId: config.nodeId } : {}), label, platform },
});
```

Server-side, both the real path and the mock path treat a claim against an
**existing** node id as a **re-pair of the same row**, not a new node:

- Real: `middleware/src/providers/local-compute.ts:184-196` —
  `INSERT INTO compute_nodes (...) ON CONFLICT (id) DO UPDATE SET label =
  EXCLUDED.label, platform = EXCLUDED.platform, token_hash =
  EXCLUDED.token_hash, revoked_at = NULL`. Same `id`, **new
  `token_hash`** — the old token's hash no longer matches any row.
- Mock: `middleware/src/mock/local-compute.ts:621-654` (`mockClaimPairingCode`)
  — `const existing = byId(node.nodeId); if (existing) { existing.tokenHash
  = node.tokenHash; ... return toNode(existing); }` — identical semantics,
  in-memory.

So: **no duplicate row is created, and presence is not split** — `nodeId`
is the join key for both `compute_nodes` and the presence fixture
(`localBoxId`/`presenceRowFor` key off `node.id`, not off the token), so
the UI does *not* end up reading a stale row while the worker reports
against a fresh one. That specific "two rows" failure mode does not exist
in this code.

**What does happen**, and is the real hazard: the *token* the second claim
mints (`claimPairingCode`'s `randomBytes(24)` at
`providers/local-compute.ts:164`) is written back to
`~/.claude-mem/orgiq-presence.json` by the plugin
(`orgiq-presence.mjs:108`), instantly invalidating whatever token any
**already-running** `local-compute-worker.mjs` process is holding in
memory (`config = readConfig()` is read exactly once, at module load,
`local-compute-worker.mjs:562`, and never re-read for the life of the
process). Two concrete ways this bites a first-time user:

- They pair, start the worker (`register()` succeeds with token A), then —
  confused because the portal still shows the machine offline (worker
  hasn't announced its first heartbeat yet, or they hit bug #1) — go back to
  "Pair a machine," mint a fresh code, and re-run
  `orgiq-presence.mjs pair`. This rotates to token B. The already-running
  worker keeps using token A for every subsequent `announce`/`heartbeat`/
  `claim` call.
- The Claude Code hook script (`orgiq-presence.mjs hook`/`heartbeat`) is a
  **fresh process per invocation** and re-reads the config file every time
  (`readJson(CONFIG_PATH, null)`, line 167/205) — so an interactive
  session's own presence self-heals immediately after a re-pair. The
  long-running `local-compute-worker.mjs` is the one process that does
  **not** self-heal, because it caches the token for its entire lifetime.

Combined with bug #1 (`announce()`/`heartbeat()` never check `res.ok`), the
result is exactly the reported symptom: the worker's terminal keeps
printing its normal "registered / polling / announcing" cadence — it never
crashes, because nothing in its loop treats a 401 as fatal outside of
`register()` (which already ran, with the token that was valid *then*) and
`claim()` (which *does* generically log `claim failed: 401 …` on every poll,
so a careful read of the terminal would show it, but nothing stops the
loop, so it scrolls past unnoticed) — while the portal reads a node whose
`lastSeenAt` stopped advancing the moment the token rotated.

### Fix
1. **Worker**: implement bug #1's fix (`announce`/`heartbeat` check
   `res.status`, exit loudly on 401) — this alone converts "silently stale
   forever" into "worker exits with `node token rejected — restart it`,"
   which is the correct failure mode for a rotated credential.
2. **Plugin** (`orgiq-presence.mjs:89-116`, the `pair()` function): when a
   `config.nodeId` already exists and the pairing *succeeds* (not just the
   existing failure-path warning at lines 96-99, which only fires when
   pairing *fails*), print an explicit warning: `this machine was already
   paired; its token has been rotated — if a worker is running for it,
   restart it now`. This is a one-line addition right after
   `console.log('paired as ...')` at line 109.
3. **Portal** (`PairMachineDialog.tsx`): when `/pair/start` is invoked while
   the caller already owns a node (i.e. "Pair another" was clicked, or the
   empty-state action is hit a second time for the same physical machine —
   which the portal cannot detect *is* the same machine, since a nodeId is
   only known to the plugin's local config file), there's no way to warn
   pre-emptively from the browser side; the plugin-side warning in (2) is
   the only place that actually knows a nodeId already existed on disk, so
   that's where the message belongs.

---

## Also worth noting (smaller trip hazards on this path)

- **Header pill reads "⌂ Connors-MacBook-Pro · 0" while the machine is
  actively polling.** `~/Projects/ui-components/src/components/compute/components/MachinePresenceMenu.tsx:81` sums `sessions.length` across nodes; the worker's own
  `presenceSessions()` (`local-compute-worker.mjs:224-238`) only reports a
  session for each **currently held job** — between claims (idle, polling
  every `POLL_INTERVAL_S`) it legitimately announces zero sessions, by
  design (`local-compute-worker.mjs:212-219`'s comment: *"An idle-but-
  running worker still announces… so it reads 'connected' rather than
  dropping to 'offline'"*). Correct per spec, but a bare `· 0` reads as
  "nothing is happening" to a first-time user who just watched their
  terminal print "registered… polling…". Cheap fix: in
  `MachinePresenceMenu.tsx`, when `status === 'connected' && total === 0`,
  render `idle` instead of `· 0` (cross-repo, ui-components).
- **The run log is raw `stream-json`, not prose**, even once the black-box
  theming bug (#2) is fixed. `RunLog` (`LocalComputePage.tsx:372-418`) maps
  each shipped chunk straight to `LogLine.message` with no parsing — a user
  watching a live run will see raw JSON objects (`{"type":"assistant",...}`)
  rather than the assistant's text. Not blocking, but worth a follow-up:
  either have the worker ship a distilled text line per JSON event, or have
  `RunLog` parse `type: 'assistant'`/`'result'` events client-side.
- **The offline/no-runnable-kinds banner copy is good and already handles
  the "paired but worker never ran" state well** (`LocalComputePage.tsx:304-316`,
  with the exact worker command inline) — this part of onboarding is not a
  problem; call it out as the thing *not* to regress while fixing the above.
- **`EmptyState` for "No paired machines"** (`LocalComputePage.tsx:265-272`)
  correctly branches on capability (`canDispatch`), but note it and
  `PairMachineDialog` both hardcode the assumption that the visitor is
  running the worker from "the aws-agentcore checkout" — true today,
  correct per the design doc's Open Question #1 (plugin ships from this
  repo until it has an external home), but worth a comment/TODO tying it to
  that open question so it isn't silently stale once the plugin moves out.
