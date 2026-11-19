// The unread bubble on a call pane's tab (hooks/useCallChatUnread.ts): the library tab's own `badge` slot (TabItem.badge)
// with the count, and "unread" for screen readers, so the tab's accessible name reads "Chat 1 unread".
import { VisuallyHidden, type TabItem } from '@connorhoehn/ui-components/shared';
import { unreadBadgeText } from '../../lib/callChatUnreadModel';

export function UnreadTabBadge({ count }: { count: number }) {
  return <>{unreadBadgeText(count)}<VisuallyHidden> unread</VisuallyHidden></>;
}

/** The tabs with a bubble on each one `counts` names above zero; the others unchanged. */
export function withUnreadBadges<T extends Pick<TabItem, 'id'>>(tabs: readonly T[], counts: Partial<Record<string, number>>): Array<T & { badge?: TabItem['badge'] }> {
  return tabs.map((tab) => {
    const n = counts[tab.id] ?? 0;
    return n > 0 ? { ...tab, badge: <UnreadTabBadge count={n} /> } : tab;
  });
}
