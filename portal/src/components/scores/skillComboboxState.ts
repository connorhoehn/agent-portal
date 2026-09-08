// Pure open/query/highlight state machine for the skill-search combobox
// (SkillFilter.tsx). Kept separate from the component, same reason as
// `project-detail/personCardState.ts`, so the exact keyboard contract
// DEFECTS.md org-leader #10 asks for is unit-testable without mounting React
// or a DOM:
//   - never opens on a bare focus event, only on typing a non-empty query
//     or ArrowDown
//   - never reports a match/no-match verdict for an empty query
//   - Escape closes without clearing the typed text, and never gets
//     swallowed by a focus trap (the component renders the suggestion list
//     as a plain non-focusable panel, not a library `InlinePopover` — see
//     SkillFilter.tsx and docs/ui-components-queue.md)
//
// This is the ARIA combobox pattern: the input keeps focus for its entire
// lifetime, ArrowDown/ArrowUp only move a highlighted index (rendered as
// `aria-activedescendant` by the component), Enter activates the highlight,
// and Tab is never intercepted — it moves to whatever control is next.

export interface SkillComboboxState {
  query: string;
  open: boolean;
  /** -1 means nothing highlighted. */
  activeIndex: number;
}

export type SkillComboboxAction =
  | { type: 'type'; value: string }
  | { type: 'arrow-down'; count: number }
  | { type: 'arrow-up'; count: number }
  /** A suggestion was picked (Enter or a mousedown on an option). */
  | { type: 'select' }
  /** Escape, an outside click, or Tab moving focus away — close without touching `query`. */
  | { type: 'close' }
  /** The explicit "Clear search" affordance — closes AND blanks the query. */
  | { type: 'clear' };

export const initialSkillComboboxState: SkillComboboxState = {
  query: '',
  open: false,
  activeIndex: -1,
};

export function skillComboboxReducer(
  state: SkillComboboxState,
  action: SkillComboboxAction,
): SkillComboboxState {
  switch (action.type) {
    case 'type':
      // Typing a query opens the panel; clearing it back to empty closes
      // the panel again instead of leaving an empty-query "No skills match"
      // state on screen.
      return { query: action.value, open: action.value.length > 0, activeIndex: -1 };
    case 'arrow-down':
      if (!state.open) return { ...state, open: true, activeIndex: action.count > 0 ? 0 : -1 };
      if (action.count === 0) return state;
      return { ...state, activeIndex: Math.min(state.activeIndex + 1, action.count - 1) };
    case 'arrow-up':
      if (!state.open) return state;
      return { ...state, activeIndex: Math.max(state.activeIndex - 1, 0) };
    case 'select':
      return { query: '', open: false, activeIndex: -1 };
    case 'close':
      return state.open ? { ...state, open: false, activeIndex: -1 } : state;
    case 'clear':
      return { query: '', open: false, activeIndex: -1 };
    default:
      return state;
  }
}
