// Pure open/close/pin state machine for PersonRef's hover card.
//
// Two independent reasons the card is visible: a hover that will close
// itself again once the pointer leaves (`hoverOpen`), and an explicit pin
// from the keyboard — Enter/Space on the trigger — that only the same
// toggle (or Escape) undoes (`pinned`). Kept as a reducer with zero DOM/
// timer concerns so the transitions are unit-testable directly; the
// component still owns the actual open/close delays, which are timing,
// not state.
//
// This exists because neither library composite fits: PersonHoverCard
// opens on focus and InlinePopover (which it wraps) always moves focus
// into the panel and traps Tab there the moment it opens — the exact
// keyboard trap this state machine, plus PersonCardFrame.tsx, replaces.
// See docs/orgiq-journeys/sme/DEFECTS.md #2.

export interface PersonCardState {
  hoverOpen: boolean;
  pinned: boolean;
}

export type PersonCardAction =
  | { type: 'hover-open' }
  | { type: 'hover-close' }
  | { type: 'toggle-pin' }
  /** Escape, or any other "close it outright" trigger. */
  | { type: 'dismiss' };

export const initialPersonCardState: PersonCardState = { hoverOpen: false, pinned: false };

export function personCardReducer(state: PersonCardState, action: PersonCardAction): PersonCardState {
  switch (action.type) {
    case 'hover-open':
      return state.hoverOpen ? state : { ...state, hoverOpen: true };
    case 'hover-close':
      return state.hoverOpen ? { ...state, hoverOpen: false } : state;
    case 'toggle-pin':
      return { ...state, pinned: !state.pinned };
    case 'dismiss':
      return state.hoverOpen || state.pinned ? { hoverOpen: false, pinned: false } : state;
    default:
      return state;
  }
}

export function isPersonCardVisible(state: PersonCardState): boolean {
  return state.hoverOpen || state.pinned;
}
