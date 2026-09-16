# Handoff — Computer Lab and Environments

> **Updated after the nine-agent integration (2026-09-01).** The "What is
> left" list below is largely CLOSED: the portal adopted ComputerLab (inline,
> host-themed, ⌘⇧U rail focus, ?box= deep links), LabRail groups by project
> with budget quick-lines, the tail pane is a real activity feed (job banners,
> cost chips, follow affordance), cost/token attribution flows in mock mode,
> `dev:mock` serves every page without 500s (DEV_OFFLINE=true skips .env.aws
> outright), the SME journey closes offline end to end (suggestions from your
> initiatives → TaskComposer → queue → simulated dispatched run → awaiting
> review), initiative pages show their charged computers, and the dev sign-in
> picker lives on /select. Storybook covers the dock, tail, chooser, summary
> and status line. Start from `git log` on both repos rather than the sections
> below for current state; what follows is kept for the design reasoning,
> which still holds.

Two pieces of work, in two repos, that have not yet met each other.

1. **`@connorhoehnslalom/ui-components/compute`** — a new surface package: a
   tmux-shaped multiplexer over AgentCore microVM sessions, plus the primitives
   it needed. All of it lives in ui-components and is on `main` there.
2. **Environments, in aws-agentcore** — schema, provider, routes and
   Cedar actions for "where an initiative's code runs, and who may reach it."
   Backend only; nothing renders it yet.

The portal is deliberately untouched. Adopting `/compute` there is the next
piece of work and is described at the bottom.

---

## Where things are

| Repo | Branch | HEAD | State |
|---|---|---|---|
| `~/projects/ui-components` | `main` | `297cb23` | pushed; v2.117.0 |
| `~/Projects/aws-agentcore` | `main` | `c753cf9` | pushed |

Compute commits on ui-components `main`, oldest first:

- `2d21c2f` — Computer Lab: the multiplexer (2.115.0)
- `7395cd8` — terminals are the point; drop the fake prompt, mock the shell
- `28f230e` — changelog correction
- `fc8808b` — the `enabled` gate on the provider, README made true
- `3e8cbe9` — surface-tone escape hatch so primitives work in code chrome
- `1b05d37` — move the keyboard focus with the border
- `c203f17` — layout pieces for apps with deep trails and stacked navs
- `089e51a` — projects as cost centres in the lab
- `297cb23` — README surfaces table

aws-agentcore: `9c52b34` (environments), merged as `c753cf9`.

Gates as of this handoff — ui-components `tsc --noEmit` **clean**,
`lint:static-styles` **pass**, `lint:node-controls` **pass**, compute suite
**115 tests / 7 files pass**.
Note the script names are `lint:static-styles` and `lint:node-controls`, not
`check-*`; the `check-*` spellings do not exist and will send you to an npm
"did you mean" error.

---

## Part 1 — the `/compute` package

Full API documentation is in `src/components/compute/README.md` (301 lines) —
quick start, the key table, the pane-kind registry, the client contract. This
section covers only what that README cannot tell you: why certain things are
shaped the way they are, and what breaks if you change them.

### The two extension seams

Everything else in the package is replaceable. These two are the reason the
package is worth having, and both were designed to be extended from outside
without editing the library.

**`ComputeClient` (`lib/computeClient.ts`)** is the whole transport surface —
eleven endpoints, one interface. The library never calls `fetch` anywhere else.
A host that wants a different backend implements the interface and passes it in;
a host that wants the default passes `clientOptions: { baseUrl }`. It was
verified endpoint-by-endpoint against the middleware's `/api/devbox` routes, and
three things in it are not guesses:

- `runCommand` mode is `'safe' | 'full'`, not `'allowlist'`. `mode: 'full'` is
  required by `shellProtocol` and `workspaceTree` — both are documented as such,
  because in `'safe'` mode they silently return nothing useful.
- `tail(boxId)` returns a `TailTarget` (`{ url, withCredentials, headers }`),
  not a bare URL string. `EventSource` is GET-only and cannot send headers; a
  URL alone cannot express an authenticated stream. The consumer decides how to
  open it.
- `listProjects?()` is optional. A host without cost centres omits it and the
  lab hides the project affordances rather than showing empty ones.

**The pane-kind registry (`lib/paneKinds.ts`)** is an open registry, not a
closed union. This started as a `PaneView` union type and that was a design
error: every new pane kind would have been a library edit plus a switch-statement
edit plus a release. A `PaneKind` is `{ id, label, quota?, inputSuffix?, render }`
and a host registers its own. `DEFAULT_PANE_KINDS` ships two — `SHELL_PANE_KIND`
(the default) and `TAIL_PANE_KIND` (read-only). A bastion/SSM pane, a logs pane,
an agent-transcript pane are all host-side additions with no library change.

`quota: 'shell'` exists because AgentCore allows ten concurrent shells per
runtime; the registry counts them so the UI can refuse before the service does
with an opaque close code.

### Two silent-failure bugs that were fixed — don't reintroduce them

`devbox_error` and `devbox_end` are emitted by the middleware *after* the SSE
head has already gone out. The original stream handling treated the head as the
verdict, so a run that failed or timed out resolved as a **successful, empty
result** — the worst possible shape, because the caller sees success. Both
events are now terminal, and the stderr tail is retained rather than discarded
so a failure says why. If you refactor `useComputeTask`, keep both events
terminal.

### The `enabled` gate on `ComputeProvider`

`ComputeProvider` polls `/api/devbox` every 5s. That route is gated on
`ManageDevbox`. Mounted app-wide with no gate, it produces a **403 every five
seconds for every user who lacks the capability** — a storm that looks like an
auth outage. Pass `enabled={can('ManageDevbox')}`. This is the single most
likely thing to get wrong during portal adoption.

### Keyboard model

Plain Mac chords by default, no prefix: `⌘⇧` + arrows to move focus, `⌘⏎` /
`⌘⇧⏎` to split, `⌘⌫` to close, `⌘K` to jump, `⌘⇧B` broadcast, `⌘/` help. A tmux
leader is available but **off by default** (`TMUX_LEADER`, `⌃B`), because a
leader is only worth learning if you already know one; every binding carries its
leader equivalent so turning it on costs nothing.

`matchBinding` compares modifiers **exactly**. This matters: a loose match makes
`⌘←` (browser back) move pane focus, which is unrecoverable-feeling in a
terminal. Don't relax it.

Focus is geometry-based, not sibling-based — `neighborPane` does a real overlap
test against `layoutRects`, so "the pane to the right" means the pane that is
visually to the right, not the next node in the tree. In a deep split tree those
are different panes and only the first is what anyone expects.

Moving focus also moves the **cursor**, not just the border. That was a real
reported bug: `registerInput` only had a send channel, so the blue border moved
and typing still went to the old pane. It is now `registerPane(handle)` with
`PaneHandle { send?, focus? }`.

### The terminal is xterm.js, and it is an optional peer dependency

`ShellTerminal` wraps `@xterm/xterm` v6 + `@xterm/addon-fit` v0.11, declared as
**optional peer dependencies**. Nothing about terminal emulation is hand-rolled
and nothing should be — the earlier hand-rolled textarea was deleted. A host
that never opens the compute surface doesn't pay for xterm; the portal already
depends on both at the right versions.

Storybook runs against `fixtures/mockShell.ts`, a mock WebSocket shell that
speaks the real Kubernetes `v5.channel.k8s.io` framing (channel byte + payload;
STDIN `0x00`, STDOUT `0x01`, STDERR `0x02`, STATUS `0x03`, RESIZE `0x04`,
HEARTBEAT `0x05`, CLOSE `0xff`). That is why the playground panes actually
respond to typing instead of sitting inert.

### Projects as cost centres

The most recent piece. `Computer` carries `projectId`, `spendUsd`,
`tokensUsed`, `contextUsed`, `activeModel`, `idleMsLeft`, `lifetimeMsLeft`;
`ComputeProject` carries budget, spend, maintenance floor, token budget and bot
count. `rollUpProjects()` is a pure join producing a `ProjectRollup`, with an
`UNASSIGNED_PROJECT_ID` bucket so an untracked box is never invisible.

`ProjectSummary` is the quick line — `$412.55 / $1200 │ 84k tok · 3 bots ·
2/4 ▣ · ⟳ 41m` — with an optional `DotMeter` showing what share of the budget is
upkeep rather than work. `createComputer({ label?, projectId? })` charges a new
box to a project at creation. `LabChooser` finds projects by fuzzy match; note
the query is gated on non-empty, because `fuzzyScore('', x)` returns 0 which is
a *match*, and without the gate every project appeared before you typed.

**This is UI-side only.** The backend does not yet attribute spend or tokens per
box — see "What is left" below.

### Primitives added to `/shared`

Per the standing rule that a missing primitive gets shipped to the library
rather than hand-rolled in a page:

`TitledFrame` (bordered box with the title in the border, `tone: 'code' |
'surface'`), `DotMeter` (discrete dots with a `note` slot), `InlinePlaceholder`
(compact empty state — `EmptyState` has a 220px min-height that is wrong inside
a pane), `NavRail` + `NavRailStack` (depth-as-data multi-level nav, for the deep
breadcrumb trails this kind of app has), `Toolbar` (with real roving focus),
`WorkArea`, and `Breadcrumbs` gained `overflow="menu"` with real `<a>` links.

`tones.ts` gained `SurfaceTone` and the `CODE_TONE_*` maps. There are two token
families and they are not interchangeable: the app tokens flip with the theme,
and `--color-code-*` (Catppuccin Mocha) is permanently dark. Terminal chrome
must sit on the code family or it inverts under a light theme. `Chip`, `Button`,
`IconButton`, `InlineAlert`, `SearchInput`, `EmptyState` and `ConnectionPill`
were re-toned to accept it — note `Chip` and `InlineAlert` now take `palette`,
not `tone`.

---

## Part 2 — Environments (aws-agentcore)

Backend for "an initiative has environments; developers reach them through
bastion computers; access is decided by the auth profile."

`schema/environments_schema.sql` — one table keyed on `projects(id)`, with
nullable `cluster_name` and `access_role_arn` (not every environment is a
cluster), a `rank` for ordering dev→prod, and 21 seed rows.

`middleware/src/providers/environments.ts` + `routes/environments.ts`:

```
GET    /api/environments            list
GET    /api/environments/:id        one
GET    /api/environments/:id/access how this caller would reach it
GET    /api/environments/:id/runs   latest GitHub workflow runs
POST   /api/environments            create
PATCH  /api/environments/:id
DELETE /api/environments/:id
```

`listWorkflowRuns()` in `github-connector.ts` is **read-only — no dispatch**.
This is deliberate and was asked for explicitly: repos have pipelines, the app
reports their latest runs, and the app is not a CI tool. Don't add a trigger.

There are no DORA metrics and none were wanted.

### The authorization design, and its one stated tradeoff

Two Cedar actions, `EnterEnvironment` and `ManageEnvironments`, both
**attribute-conditioned** on `envName` / `envKind` / `envRank` / `envStatus`
rather than on per-environment resource ids. `member` is explicitly forbidden.
`hr-admin` gets `ManageEnvironments` but is explicitly **forbidden**
`EnterEnvironment` — administering the list of environments and being able to
open a shell in production are different powers, and the person who edits the
registry is not thereby a production operator.

The tradeoff: **there is no per-environment ACL.** Policy conditions on
attributes, so "Ana may enter staging but not prod" is expressible and "Ana may
enter *this particular* staging environment but not that one" is not. That is
the right shape for the ~21 seeded environments and it will need revisiting if
environments ever become per-team-private. It is a deliberate choice, not an
oversight.

`GET /:id/access` is gated with `requireSession('EnterEnvironment')` — read the
note in CLAUDE.md about `requireSession` vs `requireAction` before touching the
gates on this router.

---

## What is left

**1. Portal adoption of `/compute`.** A detailed plan exists from the planning
pass; no portal code has been written. The one non-obvious constraint:
`portal/src/components/devbox/TerminalDock.tsx` must be **rewritten, not
deleted**. The library ships `lib/dockStore.ts` (the store) but no dock
*component* — the floating/docked/grid/stack chrome is still portal-side. The
portal's `terminalDock.ts` store is the thing `dockStore.ts` supersedes. Also in
scope: `DevboxQuickSwitch.tsx` (⌘I) overlaps `LabChooser` (⌘K) and one of them
should win, and `DevboxPage.tsx` is the natural host for `ComputeProvider` —
with `enabled` set, per the gate note above.

**2. `LabRail` does not group computers by project.** The projects data,
`ProjectSummary`, and project search in the chooser all exist; the rail still
lists computers flat. This is the visible half of the cost-centre feature and is
the smallest next piece of value.

**3. Backend cost attribution.** The UI reads `spendUsd` / `tokensUsed` /
`contextUsed` per box, and nothing populates them. The plumbing is real work:
per-session spend attribution against `initiative_budgets` and the existing
`bot_runs.dispatched_by` attribution pattern. Until then those fields are
undefined and the UI degrades to showing the project budget without the live
box-level split.

**4. Nothing renders environments.** The domain is backend-only.

**5. Deferred cleanups noted in passing.** Fold `SubNavLayout` onto `NavRail`'s
internals once that tree is quiet; migrate `pipelines/ContextInspector.tsx` and
`LiveOutputPanel.tsx` off their hand-rolled tone overrides now that the surface
tone exists.

---

## Things that will bite you

- **`ComputeProvider` without `enabled`** → a 403 storm every 5s. Above.
- **The `check-*` npm scripts don't exist.** They are `lint:static-styles` and
  `lint:node-controls`.
- **ui-components has other sessions working in it.** Files have been pruned by
  a peer's `npm install` before (`@types/react` and `react-is` went missing);
  `@types/react` / `@types/react-dom` are now explicit devDependencies as a
  guard. Commit compute work promptly rather than leaving it in the tree.
- **`isolation: worktree` does not protect ui-components.** It isolates the
  *current session's* repo only — aws-agentcore. Work in ui-components is shared
  with every other session on the machine.
- **`vite-plugin-dts` v4 appends `src/declarations.d.ts` to every rolled-up
  entry.** If a new ambient block shows up in the `/compute` types output that
  is why, and it is not a bug in the package.
