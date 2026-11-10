// The in-page role-switch offer, once per page for the demo identity (lib/roleSwitchOffer.ts).
//
// A locked control calls this instead of `roleSwitchOffer`: it claims the page's
// offer slot while it is mounted and gets the offer only when its claim is the
// first (for the demo identity), or always (for a real persona). A control
// that gets null shows its plain reason.
import { useEffect, useId, useSyncExternalStore } from 'react';
import { useLocation } from 'react-router';
import { SwitchOfferSlots, offerOnThisControl, roleSwitchOffer, type RoleSwitchOffer } from './roleSwitchOffer';

/** One claim list for the app: keyed by path, so another page starts clean. */
const slots = new SwitchOfferSlots();

export function usePageSwitchOffer(
  session: Parameters<typeof roleSwitchOffer>[0] & { sub?: string | null } | null | undefined,
  purpose: string,
  locked: boolean,
): RoleSwitchOffer | null {
  const { pathname } = useLocation();
  const control = useId();
  const offer = locked ? roleSwitchOffer(session, purpose) : null;
  const wants = offer != null;
  useEffect(() => {
    if (!wants) return undefined;
    slots.claim(pathname, control);
    return () => slots.release(pathname, control);
  }, [wants, pathname, control]);
  const claimants = useSyncExternalStore(slots.subscribe, () => slots.claimants(pathname));
  return offer && offerOnThisControl(session, claimants, control) ? offer : null;
}
