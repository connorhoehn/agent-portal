// The shell's presence and direct-message entry for a session WITHOUT a Social
// grant. Shared people and past DMs come from the authenticated directory;
// online people come from the tenant lobby. The modal is a read-only overview.
// Participation requires entering Social with an account that has that grant.
// Social-granted sessions use the same overview with a direct Social entry.

import { useEffect, useMemo, useState } from 'react';
import { useGatewayOptional, usePresence } from '@connorhoehnslalom/realtime-modules/client';
import { useNavigate } from 'react-router';
import { Button, ChatIcon, Inline, T } from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { onlineIds, readConversations, readSharedPeople, type SharedPeople } from './tenantDirectModel';
import { MessagesOverviewDialog } from './MessagesOverviewDialog';

// A segment of the shell footer row (SocialFooter.tsx), which draws the bar itself.
const BAR = 'min-w-0';

/** Announces this session on the tenant lobby; mounted only while connected. */
function TenantLobby({ directory, onOnline }: { directory: SharedPeople; onOnline(ids: Set<string>): void }) {
  const { roster } = usePresence(directory.lobby, { join: true });
  const ids = useMemo(() => onlineIds(roster, directory.people), [roster, directory]);
  useEffect(() => { onOnline(ids); }, [ids, onOnline]);
  useEffect(() => () => onOnline(new Set()), [onOnline]);
  return null;
}

export function TenantDirectEntry() {
  const navigate = useNavigate();
  const gateway = useGatewayOptional();
  const connected = gateway?.connectionState === 'connected';
  const fetched = useFetch<unknown>('/api/people/shared', 60_000);
  const directory = useMemo(() => readSharedPeople(fetched.data), [fetched.data]);
  const convFetch = useFetch<unknown>('/api/people/conversations', 30_000);
  const history = useMemo(() => readConversations(convFetch.data, directory), [convFetch.data, directory]);
  const [online, setOnline] = useState<Set<string>>(() => new Set());
  const [open, setOpen] = useState(false);
  const unavailable = !gateway ? 'Direct messages need the realtime gateway, which is not configured here.'
    : !connected ? 'Reconnecting to the realtime gateway…'
    : fetched.error ? 'People you share this workspace with could not be loaded.' : null;
  return <>
    {directory && connected && <TenantLobby key={`presence:${directory.lobby}`} directory={directory} onOnline={setOnline} />}
    <Inline gap="sm" align="center" className={BAR} data-testid="shell-tenant-bar">
      <Button variant="ghost" size="sm" className="text-xs" onClick={() => setOpen(o => !o)} aria-pressed={open} data-testid="shell-tenant-open">
        <Inline gap="xs" align="center"><ChatIcon size={14} />Messages</Inline>
      </Button>
      <T className="text-xs text-text-secondary" data-testid="shell-tenant-online">{online.size} online</T>
    </Inline>
    <MessagesOverviewDialog key={`overview:${directory?.lobby ?? 'unavailable'}`} open={open} onClose={() => setOpen(false)}
      title={directory?.tenant === 'orgiq' ? 'Work' : directory?.tenant ?? 'Workspace'}
      conversations={history.map(row => ({ id: row.channel, title: row.peer.displayName, ...(row.peer.avatarUrl ? { avatarUrl: row.peer.avatarUrl } : {}),
        preview: row.lastMessagePreview, at: row.lastMessageAt, unread: row.unreadCount }))}
      loading={fetched.isLoading || convFetch.isLoading} error={unavailable ?? convFetch.error}
      socialLabel="Choose workspace" accessHint="This account has no Social access. Choose an account with Social to participate."
      onOpenSocial={() => { setOpen(false); navigate('/workspaces'); }} testId="tenant-dm-panel" />
  </>;
}
