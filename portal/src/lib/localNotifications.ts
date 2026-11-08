// Entries the portal itself adds to the notification center, beside the
// gateway's inbox (G19: a background job the voice queued, mirrored from its
// toast's onSettled).
//
// realtime-modules' useNotifications() holds only what the gateway sends and
// has no way to add an entry; SharedNotificationsProvider merges these in
// (mergeNotifications), so the bell, its unread count and its read marks treat
// them as one list. They live for the tab: a reload keeps the gateway's items
// and drops these, and the job's own page keeps the record.
//
// No React: a module-level store read through useSyncExternalStore.

import type { Notification } from '@connorhoehn/realtime-modules/client';

export const MAX_LOCAL_NOTIFICATIONS = 50;

let items: Notification[] = [];
const listeners = new Set<() => void>();

function emit(): void { for (const l of [...listeners]) l(); }

export function subscribeLocalNotifications(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** Oldest first, like the library's list. */
export function getLocalNotifications(): Notification[] {
  return items;
}

/** Add an entry, or replace the one with the same id (a job's final state wins). */
export function addLocalNotification(n: Notification): void {
  items = [...items.filter((x) => x.id !== n.id), n].slice(-MAX_LOCAL_NOTIFICATIONS);
  emit();
}

export function markLocalRead(id: string): boolean {
  if (!items.some((x) => x.id === id && !x.read)) return items.some((x) => x.id === id);
  items = items.map((x) => (x.id === id ? { ...x, read: true } : x));
  emit();
  return true;
}

function markAllLocalRead(): void {
  if (!items.some((x) => !x.read)) return;
  items = items.map((x) => ({ ...x, read: true }));
  emit();
}

function removeLocal(id: string): boolean {
  if (!items.some((x) => x.id === id)) return false;
  items = items.filter((x) => x.id !== id);
  emit();
  return true;
}

export function clearLocalNotifications(): void {
  if (!items.length) return;
  items = [];
  emit();
}

/** The slice of useNotifications() the merge needs. */
export interface InboxLike {
  notifications: Notification[];
  unreadCount: number;
  markAsRead(id: string): void;
  markAllRead(): void;
  remove(id: string): void;
  clearAll(): void;
}

/** The gateway's inbox with the local entries merged in, oldest first; each verb reaches whichever list holds the id. */
export function mergeNotifications<T extends InboxLike>(remote: T, local: readonly Notification[]): T {
  if (!local.length) return remote;
  const notifications = [...remote.notifications, ...local]
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  return {
    ...remote,
    notifications,
    unreadCount: remote.unreadCount + local.filter((n) => !n.read).length,
    markAsRead: (id: string) => { if (!markLocalRead(id)) remote.markAsRead(id); },
    markAllRead: () => { markAllLocalRead(); remote.markAllRead(); },
    remove: (id: string) => { if (!removeLocal(id)) remote.remove(id); },
    clearAll: () => { clearLocalNotifications(); remote.clearAll(); },
  };
}
