# Interactive terminals for devbox — what's possible, and what isn't

Research note. The question: can we get a tmux-style interactive experience
against a devbox, attach to boxes properly rather than driving a black box, and
watch several boxes at once while they work a queue / do code discovery / review
PRs?

Short answer: **a true PTY is impossible through the AgentCore Runtime data
plane as it exists today.** Three workable paths exist around that, and the one
that best serves the stated use cases needs no new transport at all.

## The constraint, established from the SDK

`InvokeAgentRuntimeCommand` — the shell-exec operation the devbox console uses —
has this request body:

```ts
interface InvokeAgentRuntimeCommandRequestBody {
  command: string | undefined;
  timeout?: number | undefined;
}
```

One string in. The response is a stream:

```ts
interface InvokeAgentRuntimeCommandResponse {
  stream: AsyncIterable<InvokeAgentRuntimeCommandStreamOutput> | undefined;
}
```

The task operation is the same shape: `InvokeAgentRuntimeRequest.payload` is a
`Uint8Array`, a single buffer, not a stream.

So the channel is **half-duplex**: one payload in, many chunks out. There is no
stdin after the request begins. That rules out, through this API:

- typing into a running process (a REPL, `vim`, `less`)
- `Ctrl-C` to a running command
- `tmux attach` in the sense of a live attached client
- terminal resize events

Anything that "feels like a terminal" has to work around that, not through it.

Worth knowing: AWS *does* ship a full-duplex interactive channel in this
service — just not for Runtime. The Browser tool exposes a SigV4-signed
WebSocket CDP endpoint, which `providers/agentcore.ts` already dials with
`new WebSocket(wsUrl, { headers: signedWsHeaders(...) })`. The capability
exists in the platform; it is not offered for runtime containers.

## Option 1 — Multi-pane fleet view (no new transport)

The use cases actually named — watching boxes drain a queue, following code
discovery, reviewing what a PR-review run did — are **observation**, not
interaction. Nothing about them needs stdin.

That is already served end to end: the dispatcher tees every task event into
the box's server-side ring buffer, and `GET /api/devbox/boxes/:id/tail` replays
the buffer then streams live over SSE, so any number of clients can watch any
box. The gap is presentation, not plumbing — the portal shows one box at a
time.

A grid of live panes, one per box, each an SSE tail with a status chip, gets
the tmux *feeling* (several things visible at once, all live) for the workflows
described. It is a UI change against infrastructure that already exists.

**Cost:** low. **Latency:** live. **Interactivity:** none, and none needed.

## Option 2 — tmux in the container, driven by send-keys + capture-pane

For when you do want to *drive* something interactive, the trick is to stop
trying to hold the session open across the wire and let the container hold it
instead. tmux becomes the state; AgentCore stays a half-duplex transport.

```sh
# once
tmux new-session -d -s work -x 200 -y 50

# per interaction — this is one InvokeAgentRuntimeCommand
tmux send-keys -t work 'npm test' Enter
sleep 0.2
tmux capture-pane -p -e -t work    # -e keeps ANSI colour
```

The session persists between invocations for as long as the microVM session
lives, so `cd`, environment, a running `vim`, a paused REPL, and scrollback all
survive. Multiple named windows give real multiplexing. `capture-pane` output
renders straight into xterm.js.

This genuinely runs interactive programs. You send `:wq` to vim the same way
you send `ls`. What you do not get is fluid typing: every keystroke batch is a
round trip, so expect 200–800 ms per exchange. It is command-and-look, not a
smooth terminal.

Needs `tmux` in the devbox image — the current one installs only
`git curl ca-certificates ripgrep procps` plus node and python.

**Cost:** small — one image change, one route, an xterm.js pane.
**Latency:** a round trip per interaction. **Interactivity:** real but chunky.

## Option 3 — Reverse WebSocket tunnel (a genuine TTY)

If fluid typing matters, the container has to dial *out*, because nothing lets
us dial in. AgentCore containers have egress (they reach Bedrock), so the
devbox can open a WebSocket to the middleware and act as the client:

```
browser ──ws──> middleware ──ws (reverse, container-initiated)──> devbox PTY
  xterm.js         bridge                      node-pty / script
```

The middleware already runs a `WebSocketServer` on `/ws`, so the browser leg is
solved; the missing leg is container → middleware. Authenticate with the
workload access token the runtime already has (`GetWorkloadAccessToken`).

This gives the real thing: `Ctrl-C`, resize, `tmux attach`, `vim`, a proper
prompt.

The catch is topology. The container must be able to reach the middleware, so
this works when the middleware is deployed behind a load balancer and does
**not** work while it runs on a laptop — which is the current dev setup. It is
also a real piece of infrastructure: reconnection, backpressure, auth, session
affinity, and a security review of a container-initiated tunnel that carries a
shell.

**Cost:** high. **Latency:** true real time. **Interactivity:** complete.

## Option 4 — Sidestep AgentCore for interactive work

ECS Exec (`aws ecs execute-command`, SSM under the hood) gives a genuine
interactive shell into a Fargate task, with existing browser frontends. If an
interactive terminal is a first-class product requirement rather than a
convenience, this is the boring correct answer.

The trade is everything AgentCore Runtime provides that the rest of this system
leans on: `/mnt/workspace` session storage, workload identity, the session
lifecycle, and the observability integration. Running devboxes on ECS would
mean rebuilding those.

## Recommendation

1. **Build the multi-pane fleet view first.** It is the smallest change and it
   is what the described workflows actually need — several boxes visible and
   live while they work. No new transport, no image change.
2. **Add tmux + send-keys/capture-pane** when you want to drive something
   interactive. Persistent multiplexed sessions, real interactive programs,
   works with today's API. This is the best value-per-unit-effort for "attach
   to a box properly".
3. **Only build the reverse tunnel** if fluid typing turns out to matter, and
   only once the middleware is deployed somewhere the container can reach. Do
   not build it against a laptop.

## What would change this

The constraint is one API shape. If AgentCore Runtime ever exposes a
bidirectional stream for `InvokeAgentRuntimeCommand` — or a signed WebSocket
endpoint for runtime containers the way it already does for Browser sessions —
option 3 collapses from "build a tunnel" to "connect to it", and becomes the
obvious choice. Worth re-checking the SDK on each upgrade: the operation list
is `node_modules/@aws-sdk/client-bedrock-agentcore/dist-types/commands/`, and
the shape to watch is `InvokeAgentRuntimeCommandRequestBody`.
