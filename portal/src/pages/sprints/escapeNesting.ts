// Pure model for "Escape closes the innermost thing first."
//
// The sprint drawer (SprintsLens' Drawer) owns a global Escape-to-close
// listener — the standard, correct behavior for a drawer opened by a row.
// The bug this fixes: an inline form nested INSIDE that drawer (Grant
// envelope, Add work item) had no Escape handling of its own, so the
// drawer's listener was the only one that ever fired — one Escape took the
// whole drawer down mid-edit and dropped focus on the shell instead of the
// control that opened the form.
//
// This reducer is the nesting rule, host-agnostic: a stack of open layer
// ids. Escape pops exactly one. A host with its own Escape-to-close (the
// Drawer) should only act when the stack is empty — `shouldHostHandleEscape`
// says so — which the caller enforces by calling `stopPropagation` on the
// keyboard event before the host's `window` listener ever sees it.

export interface EscapeNestState {
  /** Ids of open nested layers, outermost first. At most one layer is
   *  "current" for focus-return purposes: the last one opened. */
  readonly stack: readonly string[];
}

export const INITIAL_ESCAPE_NEST_STATE: EscapeNestState = { stack: [] };

export type EscapeNestAction =
  | { type: 'open'; id: string }
  | { type: 'close'; id: string }
  | { type: 'escape' };

export function escapeNestReducer(state: EscapeNestState, action: EscapeNestAction): EscapeNestState {
  switch (action.type) {
    case 'open':
      return state.stack.includes(action.id) ? state : { stack: [...state.stack, action.id] };
    case 'close':
      return state.stack.includes(action.id)
        ? { stack: state.stack.filter((id) => id !== action.id) }
        : state;
    case 'escape':
      return state.stack.length === 0 ? state : { stack: state.stack.slice(0, -1) };
    default:
      return state;
  }
}

/** The layer an Escape right now would close, or null when nothing nested is
 *  open — null is the signal to let Escape bubble to the host. */
export function topEscapeLayer(state: EscapeNestState): string | null {
  return state.stack.length === 0 ? null : state.stack[state.stack.length - 1];
}

/** Whether the host's own Escape-to-close should run. False while any
 *  nested layer is open, so a single keypress only ever closes one thing —
 *  the caller must `preventDefault`/`stopPropagation` when this is false. */
export function shouldHostHandleEscape(state: EscapeNestState): boolean {
  return state.stack.length === 0;
}
