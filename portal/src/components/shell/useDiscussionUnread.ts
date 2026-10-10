// The signed-in user's page discussions with new messages, for the tenant rail
// and the palette (discussionUnreadModel.ts). Polled, and re-read whenever the
// route changes — opening a thread advances the reader's cursor on the server,
// so the door's badge clears on the next read rather than on a client count.

import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useLocation } from 'react-router';
import { useSession } from '../../lib/auth';
import { useFetch } from '../../hooks/useFetch';
import { DISCUSSION_TENANTS, readDiscussionUnread, type DiscussionUnread } from './discussionUnreadModel';
import { communicationUnread, withCommunicationCount } from '../../lib/communicationPlane';

export function useDiscussionUnread(): DiscussionUnread {
  const { session } = useSession();
  const tenant = session?.tenant;
  const { pathname } = useLocation();
  const url = tenant && DISCUSSION_TENANTS.has(tenant) ? '/api/discussions/unread' : null;
  const { data, refresh } = useFetch<unknown>(url, 30_000, { share: true });
  const seen = useRef(pathname);
  useEffect(() => {
    if (seen.current === pathname) return; // the first read is useFetch's own
    seen.current = pathname;
    if (url) refresh();
  }, [pathname, url, refresh]);
  // The Communication door also counts the Social DMs with new messages that
  // the shell's Social embedding read (/api/social/embedded, server-counted).
  const social = useSyncExternalStore(communicationUnread.subscribe, communicationUnread.get, communicationUnread.get);
  return useMemo(() => {
    const read = readDiscussionUnread(data, tenant);
    return { ...read, sections: withCommunicationCount(read.sections, tenant, social) };
  }, [data, tenant, social]);
}
