# Visual prototypes

Sketches to argue with, painted by the real component library and the real
tokens. Not shipping code — when a direction is agreed it gets rebuilt from
library composites, and anything the library is missing goes there first.

```bash
cd portal
npm run prototype                         # active-now on :5190, hot reload
PROTOTYPE=computer-lab-chat npm run prototype
npm run prototype:build                   # → prototypes/<name>/build/index.html
```

The built `index.html` opens from a `file://` path and can be sent to
someone — everything is inlined. Builds are gitignored; the source is what we
keep. `?view=split|full|details|lab` picks the starting arrangement, the way
the Codex exports did with `data-preview-view`.

## Why it lives inside `portal/`

Fidelity and zero setup. `@connorhoehnslalom/ui-components` is already
installed here, and the app's own stylesheet is what these paint from — so a
prototype cannot drift into colours or spacing the product could not
reproduce, and it needs no `npm install` of its own. (These deps resolve from
`github:` over SSH; a fresh install is slow and can fail halfway.)

`tsconfig.json` includes only `src`, so nothing here is typechecked by
`npm run typecheck` or `npm run build`. A sketch must never be able to break
the app's gates.

One peer is shimmed: `@tiptap/extension-mention`, which the rich composer
imports and the app never installs (it never mounts that composer). See
`shims/tiptap-extension-mention.ts` — `@`-mentions do not open a people menu
in a prototype. Adding the real peer to `package.json` and deleting the alias
in `vite.prototype.config.ts` is the whole fix when one needs them.

## Prototypes

| Directory | What it is |
|---|---|
| `active-now/` | **The real Social shell** — the Codex "Active Now" preview (`~/Documents/Codex/2026-09-19/…/work/component-preview`), copied in and rewired from a sibling checkout's `src/` to the installed package. Rail, conversation, split panel with the activity graph, right inspector. This is the one to extend: it is the app's layout. |
| `computer-lab-chat/` | An earlier standalone sketch of the same idea with the chat column hand-composed. Superseded by the variant below; kept because its inspector states are spelled out plainly. |

### The Computer Lab variant (`active-now/`)

Three additions to the Codex preview, each in the place the real app would
put it:

1. **`/run` in the composer.** The library's own command bar (`commands` on
   `RichChatComposer`): `/run` → pick an initiative from the argument menu →
   type the instruction → send. The chat records an `AgentRunCard`
   (`command="/run"`), and the split panel opens on the **Computer Lab**
   instead of the activity graph — the shipped `ComputerLab` on a fixture
   transport, with the queue this conversation dispatched above it. A
   segmented switch in the panel moves between Activity and Computer Lab
   without closing the split. `/terminal`, `/doc`, `/schedule` are listed;
   `/deck` is listed *disabled*, with the reason.
2. **Cloud terminal nodes open a live shell.** Selecting a cloud-terminal node
   puts an AgentCore devbox `ShellTerminal` in the inspector (the library's
   simulator behind `mock-shell:`), in place of a sentence about observation
   capabilities.
3. **Provenance first in the inspector.** The presentation node's
   "Generation tools · Slides · Charts · Files" chips are gone. In their place:
   *Produced by — Not backed by a registered skill. `skill:deck.pptx` is not
   registered.* with what a registered skill would show and a way to the skill
   library. Same block on the generation run.

That third one is the point of the variant. A detail pane that shows more
than the platform can attribute — a slide preview from a generator that does
not exist — teaches a viewer to distrust the whole screen, and it is the pane
a demo lingers on. Every inspector should lead with what produced this and
how; when nothing registered can, it should say so. Worse-looking panel,
better panel: it is a thing somebody can go and fix.

## What is real in a prototype

Worth stating per prototype, so nobody demos a fixture as a feature. For
`active-now/`: the shell, the composer and its command bar, the graph nodes,
the inspector frame and the Computer Lab (panes, terminals, keyboard layer)
are the shipped library. The conversation, the graph scenario, the run queue
and the inspector's numbers are fixtures — the queue's rows are shaped after
what `POST /api/bots/dispatch-work` returns, so wiring them is not a
redesign.
