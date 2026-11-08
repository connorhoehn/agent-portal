// The header activity indicator (docs/social-tenant-design.md §3.1).
//
// The library's bell over realtime-modules' `useNotifications()` — the
// gateway's user-addressed inbox, with its unread set replayed on connect. It
// sits in the one piece of chrome the tenants share, so it is filtered the
// same way the server delivers: only items whose `payload.tenant` this session
// holds a grant in (the server's grant rule already guarantees that for live
// items; the filter also covers a stale tab after a grant is revoked). The
// category line is the tenant's label plus the kind, and a click marks the
// item read — locally and on the server, so another tab and the next reload
// agree — then goes where it points, inside that tenant.
//
// Under the offline gateway (no gatewayUrl) the hook listens to nothing and
// this renders an empty bell; it never sends and never throws.

import { useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router';
import type { SharedNotificationsApi } from './SharedNotifications';
import { useSharedNotifications } from './SharedNotifications';
import { WrappedNotificationBell } from '@connorhoehn/ui-components/integrations/realtime';
import { useSession } from '../../lib/auth';

const KIND_LABEL: Record<string, string> = {
  reply: 'Reply',
  comment: 'Comment',
  mention: 'Mention',
  message: 'Message',
  'call-missed': 'Missed call',
  approval: 'Approval',
  'approval-requested': 'Approval',
  system: 'Notice',
  job: 'Background job',
};

type Entry = SharedNotificationsApi['notifications'][number];

function tenantOf(entry: Entry): string | null {
  const t = entry.payload?.['tenant'];
  return typeof t === 'string' && t ? t : null;
}

function categoryOf(entry: Entry): string {
  const label = entry.payload?.['category'];
  const kind = entry.payload?.['kind'];
  const kindLabel = KIND_LABEL[typeof kind === 'string' ? kind : entry.type] ?? KIND_LABEL[entry.type] ?? entry.type;
  return typeof label === 'string' && label ? `${label} · ${kindLabel}` : kindLabel;
}

export function ActivityBell() {
  const inbox = useSharedNotifications();
  const { session } = useSession();
  const navigate = useNavigate();

  const granted = useMemo(() => new Set(Object.entries(session?.grants ?? {})
    .filter(([, roles]) => Array.isArray(roles) && roles.length > 0)
    .map(([tenant]) => tenant)), [session?.grants]);

  // Newest first, only this identity's tenants, the category line filled in.
  const view = useMemo(() => {
    const items = inbox.notifications
      .filter((n) => { const t = tenantOf(n); return t !== null && granted.has(t); })
      // `type` feeds the adapter's `category`; NotificationCenter (2.407.37)
      // does not render a category line yet (queued in
      // docs/ui-components-queue.md), so the same label also leads the body.
      .map((n) => { const category = categoryOf(n); return { ...n, type: category, body: n.body ? `${category} — ${n.body}` : category }; })
      .reverse();
    return { ...inbox, notifications: items, unreadCount: items.filter((n) => !n.read).length };
  }, [inbox, granted]);

  const onItemClick = useCallback((item: { id: string }, entry: { action?: { href?: string } } | undefined) => {
    inbox.markAsRead(item.id);
    const href = entry?.action?.href;
    if (href && href.startsWith('/') && !href.startsWith('//')) navigate(href);
  }, [inbox, navigate]);

  return <WrappedNotificationBell notifications={view} onItemClick={onItemClick}
    size="sm" label="Activity" data-testid="activity-bell" />;
}
