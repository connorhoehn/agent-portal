# Interactive terminals for devbox

The question: can we get a tmux-style interactive experience against a devbox,
attach to boxes properly rather than driving a black box, and watch several
boxes at once while they work a queue / do code discovery / review PRs?

**Yes. AWS ships exactly this.** `InvokeAgentRuntimeCommandShell` gives a
persistent, PTY-backed terminal over a bidirectional WebSocket — colors, tab
completion, Ctrl-C, terminal resize, full-screen apps, and reconnect by
`shellId`. Announced 5 June 2026.

> **Correction.** The first version of this note concluded the opposite: that a
> true PTY was impossible because the runtime data plane is half-duplex. That
> was wrong, and the method is why. I enumerated the operations in the
> *installed* SDK (`@aws-sdk/client-bedrock-agentcore` 3.1111.0) and reasoned
> from the request shapes I found there. `InvokeAgentRuntimeCommandShell` is
> not in that version, so I concluded the capability did not exist rather than
> that our SDK was behind. Reading the installed types answers "what can this
> client do", never "what can the service do". Check the service docs.

## What the API actually provides

Two shell modes, from
[Shell execution](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-shell-execution.html):

| | `InvokeAgentRuntimeCommand` (what we use today) | `InvokeAgentRuntimeCommandShell` |
|---|---|---|
| Protocol | HTTP/2 request-response stream | **WebSocket, bidirectional** |
| Shell state | Stateless — fresh process per command | **Persistent** — env, cwd, history |
| Output | Structured `contentStart`/`contentDelta`/`contentStop` + exit code | **Binary frames** — raw terminal I/O |
| Reconnect | No | **Yes, via `shellId`**, replays 256 KB |
| Duration | 1–3600 s timeout | 1 hour, reconnect to continue |

The one-shot mode we already use is the right tool for deterministic work —
the job dispatcher, CI-style gates, `git status`. It is not a worse terminal;
it is a different thing, and the docs recommend it for exactly what we use it
for. The interactive mode is the missing half.

Limits worth designing against: **10 concurrent shells per runtime**, 64 KB max
frame, 250 frames/sec, 1 hour per connection. Binary frames only — five
consecutive text frames closes the socket with code `1003`.

## Why this maps onto what was asked for

- **tmux-style attach/detach** — `agentcore exec --it` binds `Ctrl+]` to detach
  without closing, then prints a reconnect command carrying `--session-id` and
  `--shell-id`. That is the tmux workflow, provided.
- **Watching several boxes** — 10 concurrent shells per runtime, and each
  session is its own Firecracker microVM. The blog's framing: "Run the same
  agent against ten branches. Run three different agents against the same
  ticket."
- **Close the laptop** — the shell process keeps running while disconnected;
  `/mnt/workspace` survives suspend/resume with 14-day inactivity retention.
- **Code discovery / PR review** — these want a real terminal (pagers, `less`,
  `git add -p`, full-screen TUIs), which binary framing supports and the
  one-shot API cannot.

## Authentication — and why the browser should connect directly

Three auth modes are documented: SigV4 with default credentials, a **presigned
URL**, and an OAuth bearer token.

The presigned URL is the one that matters for a web terminal. The middleware
mints a short-lived presigned WebSocket URL and hands it to the browser;
xterm.js connects **straight to AWS**. Binary terminal frames never traverse
our Express process, which removes the proxy as a bottleneck, a failure point,
and a place where 250 frames/sec of terminal output could stall the event loop.

We already have the hard part of the SigV4-over-WebSocket machinery:
`middleware/src/providers/agentcore.ts` signs a WebSocket upgrade for the
Browser tool's CDP endpoint (`signedWsHeaders`, then
`new WebSocket(wsUrl, { headers })`). The same approach applies here.

## What this system needs before it works

1. **Upgrade the SDK.** Installed `@aws-sdk/client-bedrock-agentcore` is
   3.1111.0 and has no `CommandShell` operation. (Or bypass the SDK entirely by
   signing the URL ourselves, as the CDP path already does.)
2. **Grant the caller `bedrock-agentcore:InvokeAgentRuntimeCommandShell`.**
   `infra/lib/middleware-service-stack.ts` currently grants
   `InvokeAgentRuntimeCommand` only. Note this is a *caller* permission — it
   belongs to whoever opens the socket, not to the devbox execution role.
3. **Redeploy the devbox runtime.** Only agents created after 5 June 2026
   support interactive shells. Ours predates that, but the stack is being torn
   down and rebuilt anyway, so a fresh deploy gets it for free.
4. **Session id ≥ 33 characters** — already true of our devbox sessions.

## Plan

1. **xterm.js pane wired to a presigned shell URL.** Replaces the current
   request-response console for interactive use. Keep the one-shot path: it is
   better for scripted work and it is what the job dispatcher runs on.
2. **Persist `shellId` per box** in the fleet registry so reload reattaches
   instead of starting over, and surface "attached / detached / replaced"
   honestly — close code `4000` means another client took the shell, which the
   UI must show rather than silently reconnecting into a fight.
3. **Multi-pane grid.** Up to 10 shells, so a row of live terminals across
   boxes working the queue is within limits. Read frames promptly — a slow
   client fills the server write buffer and gets closed with `1008`.
4. **Handle the close codes deliberately.** `1001`/`1006` auto-reconnect,
   `1008` back off then reconnect, `1003`/`4000` must *not* auto-reconnect. A
   naive reconnect loop against `4000` would fight another operator for the
   same shell.

## What is now obsolete

Earlier drafts proposed a tmux-in-the-container screen-scrape
(`send-keys` + `capture-pane`) and a container-initiated reverse WebSocket
tunnel to the middleware. Both were workarounds for a constraint that does not
exist. Do not build either. The reverse tunnel in particular would have been a
substantial piece of infrastructure — auth, reconnection, backpressure, a
security review of a container dialing out with a shell attached — duplicating
a managed API.

The one earlier idea that survives is the multi-pane fleet view, and it gets
better: the panes can be live terminals rather than read-only tails.
