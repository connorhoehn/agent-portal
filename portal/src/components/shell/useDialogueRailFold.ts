import { useEffect, useState } from 'react';
import type { RailFold } from '@connorhoehnslalom/ui-components/shared';

/** Dialogue opens with room to work; each rail's toggle can reopen it for this visit. */
export function useDialogueRailFold(open: boolean, rail: Pick<RailFold, 'folded' | 'toggle'>, subject: string) {
  const [choice, setChoice] = useState<{ subject: string; folded: boolean } | null>(null);
  useEffect(() => { if (!open) setChoice(null); }, [open]);
  const folded = open ? choice?.subject === subject ? choice.folded : true : rail.folded;
  return {
    folded,
    toggle: () => open ? setChoice({ subject, folded: !folded }) : rail.toggle(),
  };
}
