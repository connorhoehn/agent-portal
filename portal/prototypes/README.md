# Visual prototypes

Sketches to argue with, painted by the real component library and the real
tokens. Not shipping code — when a direction is agreed it gets rebuilt from
library composites, and anything the library is missing goes there first.

```bash
cd portal
npm run prototype         # dev server on :5190, hot reload
npm run prototype:build   # one self-contained .html in prototypes/build
```

`prototypes/build/index.html` opens from a `file://` path and can be sent to
someone — everything is inlined. It is gitignored; the source is what we keep.

## Why it lives inside `portal/`

Fidelity and zero setup. `@connorhoehnslalom/ui-components` is already
installed here, and `src/app.css` is the token sheet the app itself paints
from — so a prototype cannot drift into colours or spacing the product could
not reproduce, and it needs no `npm install` of its own. (These deps resolve
from `github:` over SSH; a fresh install is slow and can fail halfway.)

`tsconfig.json` includes only `src`, so nothing here is typechecked by
`npm run typecheck` or `npm run build`. A sketch must never be able to break
the app's gates.

## Current

| File | What it explores |
|---|---|
| `ComputerLabChat.tsx` | Chat as the way work starts: `/run` dispatches an agent and opens the Computer Lab beside the conversation, with the queue this conversation dispatched above it. Its real subject is the **inspector** — see below. |

### Provenance first

The rule the Computer Lab prototype exists to test, and the fix for detail
panes that run ahead of the product: **every inspector tab opens by saying
what produced this and how, and shows nothing it cannot attribute.** That
gives three honest states instead of one invented one:

- **produced** — a named run or skill did this: inputs, tool calls, cost, output
- **running** — the session is live: what it has done so far, nothing more
- **unavailable** — nothing registered can produce this. Say so, name what
  would (`skill:deck.pptx` is not registered), and offer the action that would
  change it.

The third is the interesting one. A viewer who sees a slide preview that no
capability actually produces stops trusting the whole screen; "no deck skill
is registered on this fleet" is a worse-looking panel and a better one,
because it is a thing somebody can go and fix.

## What is real in a prototype

Worth stating per prototype, so nobody demos a fixture as a feature.

For `ComputerLabChat`: the chrome, the tokens and the **Computer Lab itself**
are the shipped library — `ComputerLab` runs against a fixture client, so the
panes, the terminals and the keyboard layer are the real ones. The
conversation, the run queue and the inspector contents are fixtures in the
file, shaped after what the middleware actually returns (`agent_change_requests`,
`bot_runs`, the devbox event stream), so building them for real is wiring
rather than redesign.
