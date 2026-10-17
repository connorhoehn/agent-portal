// ONE notification store for the whole portal, mounted once beside the gateway
// provider (mirrors realtime-examples' NotificationsContext).
//
// `useNotifications()` keeps its list in component-local state, so each caller
// is an independent store fed by the same socket — the header bell, the Social
// chat workspace and the embedded Social panel each had their own, and a read
// mark made in one never reached the others' counts. Mounting it once makes a
// mark authoritative everywhere. Marks are relayed to the gateway by the library
// (`syncReads`), so the replayed unread set agrees on reconnect.

import { createContext, useContext, type ReactNode } from 'react';
import { useNotifications } from '@connorhoehn/realtime-modules/client';

export type SharedNotificationsApi = ReturnType<typeof useNotifications>;

const SharedNotificationsContext = createContext<SharedNotificationsApi | null>(null);

export function SharedNotificationsProvider({ children }: { children: ReactNode }) {
  // syncReads relays marks to the gateway so the replayed unread set agrees on reconnect.
  const value = useNotifications({ syncReads: true });

  return <SharedNotificationsContext.Provider value={value}>{children}</SharedNotificationsContext.Provider>;
}

/** The app-wide inbox. Throws outside <SharedNotificationsProvider>. */
export function useSharedNotifications(): SharedNotificationsApi {
  const ctx = useContext(SharedNotificationsContext);
  if (!ctx) throw new Error('useSharedNotifications must be used inside <SharedNotificationsProvider>');
  return ctx;
}
