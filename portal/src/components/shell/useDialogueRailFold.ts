import { useEffect, useRef, useState } from 'react';
import { useShellFocusMode, type RailFold } from '@connorhoehn/ui-components/shared';

/** Dialogue opens with room to work; each rail's toggle can reopen it for this visit. */
export function useDialogueRailFold(open: boolean, rail: Pick<RailFold, 'folded' | 'toggle'>, subject: string) {
  const [choice, setChoice] = useState<{ subject: string; folded: boolean } | null>(null);
  // Focus mode (a deck presenting in place) folds the rail over any dialogue choice, and a dialogue that closes
  // meanwhile (the page hides its pane while presenting) keeps that choice, so ending focus restores it exactly.
  const { active: focused } = useShellFocusMode();
  // Only a dialogue the reader closes forgets the choice; one hidden while focused (or reopening after) keeps it.
  const wasOpen = useRef(open);
  useEffect(() => {
    if (wasOpen.current && !open && !focused) setChoice(null);
    wasOpen.current = open;
  }, [open, focused]);
  const folded = focused ? true : open ? choice?.subject === subject ? choice.folded : true : rail.folded;
  return {
    folded,
    toggle: () => open ? setChoice({ subject, folded: !folded }) : rail.toggle(),
  };
}
