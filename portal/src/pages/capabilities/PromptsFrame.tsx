// Prompt Studio's shell: a fixed-width prompt rail on the left, one workspace
// pane on the right, both full-bleed against the shell's own content box edge.
// No composite in the library expresses a two-column rail+pane shell with the
// rail on the left and no `aside` — `RailLayout` puts its rail on the right,
// and `ExplorerFrame` (assessment/knowledge) is the closest shape but bakes in
// a 300px rail width and an xl-only aside neither of which apply here. Kept to
// two raw elements (well under the ≤12 budget) and queued once rather than
// hand-rolled at the PromptsPage call site.
//
// No negative margin here: `app.css`'s `[data-shell-nav] main { padding: 0 }`
// already zeroes the nested "Prompt Management" SubNavLayout's own
// `<main class="p-6">`, so this frame's content box already starts flush at
// the shell's content edge. An `-m-6` here used to cancel that same 24px of
// padding a second time, which pulled the whole frame (and its `rail`'s first
// column) 24px left of the content box — under the nested sub-rail — clipping
// the first character of every row.
import type { ReactNode } from 'react';

export interface PromptsFrameProps {
  /** Left rail content — flush to the pane's left edge, scrolls independently. */
  rail: ReactNode;
  /** The workspace pane's content. */
  children: ReactNode;
}

export function PromptsFrame({ rail, children }: PromptsFrameProps) {
  return (
    <div className="flex h-full min-h-0">
      {rail}
      <div className="flex min-w-0 flex-1 flex-col overflow-auto bg-surface">
        {children}
      </div>
    </div>
  );
}

export default PromptsFrame;
