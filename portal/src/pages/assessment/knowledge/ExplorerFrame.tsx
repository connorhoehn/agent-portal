// The ONE file in this tree allowed to carry raw layout elements (nav/div
// with className) — see docs/assessment-goal.md "1. Workspace/Enterprise/
// Rules/Prompts layout parity" and docs/ui-components-queue.md. Reproduces
// agentic-assessment-accelerator's DocumentsExplorer.tsx frame: a rail flush
// to the content edge → a flex-1 pane → an xl-only aside that stacks below
// the pane under xl. `RailLayout` (ui-components) renders its rail on the
// RIGHT, so it cannot express a left-hand explorer rail — this frame is the
// composite that can, queued as `ExplorerLayout` for the library.
//
// Height chain: the shell (Layout.tsx, off limits here) already bounds the
// route Outlet to a definite height — `h-screen` at the root, down through
// `flex-1 min-h-0` containers, to the `flex-1 min-h-0 overflow-auto` div the
// Outlet renders into. `h-full` on this frame resolves off that chain (flex
// items give descendants a definite size for percentage resolution), so the
// frame fills exactly the space the shell gives the page — no scrollbar on
// that outer container — while the rail and pane each carry their own
// `overflow-y-auto` and scroll independently of one another and of it.
// `min-h-0` at every flex level is required for those `overflow-y-auto`s to
// actually engage instead of the flex item's default `min-height: auto`
// stretching it to fit its content.

import type { ReactNode } from 'react';

export interface ExplorerFrameProps {
  /** Left rail content — flush to the pane's left edge, 300px at `xl` and up
   *  (240px below it), its own
   *  border, scrolls independently of the pane. */
  rail: ReactNode;
  /** The main pane's content. */
  children: ReactNode;
  /** Optional right-hand activity/context bar. Stacks below the pane under
   *  `xl`, sits beside it at `xl` and up. */
  aside?: ReactNode;
}

export function ExplorerFrame({ rail, children, aside }: ExplorerFrameProps) {
  return (
    <div className="flex h-full min-h-0">
      <nav className="h-full w-[240px] xl:w-[300px] flex-shrink-0 overflow-y-auto border-r border-border bg-surface-panel">
        {rail}
      </nav>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col 2xl:flex-row">
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-surface px-8 py-6">
          {children}
        </div>
        {/* Beside the pane only from 2xl (1536px). At xl the aside's 320px plus
            the 300px rail left the document pane under half the content width
            (measured 0.49 at 1472px); stacked below, the pane keeps ≥ 55%.
            At 2xl the aside used to stay 320px (`2xl:w-80`), which dropped the
            *beside* case below the 0.55 floor too: at a 1560px window the
            protocol measured content column 1312px, rail 300px + aside 320px
            = 620px of overhead, leaving the document pane 692px = 692/1312 =
            0.53. Narrowing the aside to 256px (`2xl:w-64`) instead of widening
            the frame keeps the rail's own 300px (still usable) and drops
            overhead to 300+256=556px: document pane 1312-556=756px,
            756/1312 = 0.576 — clears the floor with margin, and the ratio only
            improves at wider windows since the rail+aside overhead is fixed
            pixels against a content column that keeps growing. Even at the
            2xl breakpoint's own 1536px floor (content ≈ 1288px given the same
            ~248px shell overhead), 1288-556=732, 732/1288 = 0.568 — still
            clear. */}
        {aside && (
          <div className="min-h-0 bg-surface-panel 2xl:w-64 2xl:flex-shrink-0 2xl:overflow-y-auto">
            {aside}
          </div>
        )}
      </div>
    </div>
  );
}

export default ExplorerFrame;
