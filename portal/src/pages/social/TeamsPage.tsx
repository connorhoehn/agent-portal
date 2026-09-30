// /social/teams — teams and the channels that belong to them
// (docs/social-tenant-design.md §4.3, §4.5 — lane S2).
//
// Teams are platform-api's (a team's channel is a room carrying its teamId),
// read and written through the BFF: `GET /api/social/teams` (your teams, each
// with its channels), `GET /api/social/teams/:teamId` (members), and the
// ManageTeams writes — create, add, remove — Cedar-gated there. platform-api's
// own rule stands on top: only a team's OWNER adds or removes other people.
//
// The tree is the library's `TeamChannelTree`; a channel opens as the social
// conversation pair (SocialConversation: `useChat` + WrappedChatPanel +
// ContextComposer) on `social:team:<team>:<channel>`; the team's roster is the
// library's `MembersPanel`. Adding people has no library dialog yet (queued in
// docs/ui-components-queue.md): a Modal over the roster's DataTable.

import { useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { CreateTeamDialog, MembersPanel, TeamChannelTree, type CreateTeamDialogInput } from '@connorhoehnslalom/ui-components/social';
import {
  Button, Card, ChannelHeader, DataTable, EmptyState, ErrorState, Inline, InlineAlert, LoadingState, Modal, PageHeader, Stack,
  type DataTableColumn,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { useSession } from '../../lib/auth';
import { useCapabilities } from '../../lib/capabilities';
import { writeJson } from '../../lib/writeJson';
import SocialConversation from './SocialConversation';
import { dmCandidates, type SocialPerson } from './socialChat';
import { findTeamChannel, teamCandidates, teamTreeItems, type SocialTeam, type SocialTeamMember, type SocialSource } from './socialPlatform';

interface TeamsResponse { source: SocialSource; teams: SocialTeam[]; counts: { total: number; channels: number } }
interface TeamDetail { team: SocialTeam; members: SocialTeamMember[] }
type Candidate = { userId: string; displayName: string; hint?: string };

export default function TeamsPage() {
  const { session } = useSession();
  const me = session?.sub ?? '';
  const { can, ready } = useCapabilities();
  const mayManage = ready && can('ManageTeams');
  const teams = useFetch<TeamsResponse>('/api/social/teams', 30_000);
  const people = useFetch<{ people: SocialPerson[] }>('/api/social/people');
  const [params, setParams] = useSearchParams();
  const channelName = params.get('channel');
  const managing = params.get('team');
  const list = teams.data?.teams ?? [];
  const open = findTeamChannel(list, channelName);
  const focusTeamId = open?.team.teamId ?? managing;
  const detail = useFetch<TeamDetail>(focusTeamId ? `/api/social/teams/${encodeURIComponent(focusTeamId)}` : null);
  const [creating, setCreating] = useState(false);
  const createAnchor = useRef<HTMLElement | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const openCreate = (trigger: HTMLElement) => { createAnchor.current = trigger; setCreating(true); };
  const tree = useMemo(() => teamTreeItems(list), [list]);
  const members = detail.data?.members ?? [];
  const isOwner = detail.data?.team.role === 'owner';
  const canEditMembers = mayManage && isOwner;
  const candidates = useMemo<Candidate[]>(
    () => teamCandidates(dmCandidates(people.data?.people ?? [], me), members),
    [people.data, me, members],
  );

  const go = (next: { channel?: string | null; team?: string | null }) => {
    const p: Record<string, string> = {};
    if (next.channel) p['channel'] = next.channel;
    if (next.team) p['team'] = next.team;
    setParams(p, { replace: true });
  };

  async function createTeam(input: CreateTeamDialogInput) {
    const res = await writeJson<{ team: SocialTeam }>('/api/social/teams', 'POST', input);
    if (!res.ok || !res.data) throw new Error(res.error ?? 'The team could not be created.');
    setCreating(false);
    teams.refresh();
    go({ team: res.data.team.teamId });
  }

  async function membership(method: 'POST' | 'DELETE', userId: string) {
    if (!focusTeamId) return;
    setBusy(true);
    setProblem(null);
    const base = `/api/social/teams/${encodeURIComponent(focusTeamId)}/members`;
    const res = method === 'POST'
      ? await writeJson(base, 'POST', { userId })
      : await writeJson(`${base}/${encodeURIComponent(userId)}`, 'DELETE');
    setBusy(false);
    if (!res.ok) { setProblem(res.error ?? 'The team could not be changed.'); return; }
    detail.refresh();
    teams.refresh();
    if (method === 'DELETE' && userId === me) go({});
  }

  const candidateColumns: DataTableColumn<Candidate>[] = [
    { key: 'displayName', header: 'Name', sortable: true },
    { key: 'hint', header: 'Role', width: '160px' },
  ];

  const membersPanel = focusTeamId && detail.data ? (
    <MembersPanel
      members={members.map((m) => ({ id: m.userId, name: m.displayName, role: m.role, addedAt: m.addedAt }))}
      open={detail.data.team.visibility === 'org'}
      canManage={canEditMembers}
      currentUserId={me}
      {...(canEditMembers ? { onAdd: () => setAdding(true), onRemove: (userId: string) => void membership('DELETE', userId) } : {})}
      data-testid="social-team-members"
    />
  ) : null;

  return (
    <Stack gap="lg" data-testid="social-teams-page">
      <PageHeader
        title="Teams"
        description="Teams and the channels that belong to them. A team's standard channels include everyone on the team."
        {...(mayManage ? { actions: <Button variant="primary" size="sm" onClick={(e) => openCreate(e.currentTarget)} data-testid="social-create-team">New team</Button> } : {})}
      />
      {/* Always anchored to the button that opened it: centred, the library's
          PopoverForm has no Escape (queued in docs/ui-components-queue.md). */}
      <CreateTeamDialog open={creating} anchor={createAnchor} onCreate={createTeam} onClose={() => setCreating(false)} data-testid="social-create-team-dialog" />
      {problem && <InlineAlert tone="error" onDismiss={() => setProblem(null)}>{problem}</InlineAlert>}
      {teams.isLoading && !teams.data ? <LoadingState label="Loading teams…" /> : teams.error && !teams.data ? (
        <ErrorState title="Teams could not be loaded" description={teams.error} actionLabel="Try again" onAction={teams.refresh} />
      ) : list.length === 0 ? (
        <EmptyState
          testId="social-empty-teams"
          align="start"
          title="You are not on a team yet"
          description={mayManage
            ? 'A team groups people and their channels. Create one and add the people it is for.'
            : 'A team groups people and their channels. A moderator adds you to one.'}
          {...(mayManage ? { action: <Button variant="primary" size="sm" onClick={(e) => openCreate(e.currentTarget)} data-testid="social-empty-create-team">New team</Button> } : {})}
        />
      ) : (
        <Inline gap="lg" align="stretch" wrap={false} className="min-h-[32rem]">
          <Card padding="sm" className="w-72 shrink-0">
            <TeamChannelTree
              teams={tree}
              activeChannel={open ? channelName : null}
              onSelectChannel={(channel) => go({ channel })}
              onManageTeam={(teamId) => go({ team: teamId })}
              onLeaveTeam={(teamId) => { go({ team: teamId }); void (async () => {
                setBusy(true);
                const res = await writeJson(`/api/social/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(me)}`, 'DELETE');
                setBusy(false);
                if (!res.ok) { setProblem(res.error ?? 'Could not leave the team.'); return; }
                go({});
                teams.refresh();
              })(); }}
              {...(mayManage ? { onCreateTeam: (trigger: HTMLElement) => openCreate(trigger) } : {})}
              data-testid="social-team-tree"
            />
          </Card>
          {open ? (
            <Inline gap="lg" align="stretch" wrap={false} className="min-w-0 flex-1">
              <SocialConversation
                key={channelName!}
                channel={channelName!}
                name={`${open.team.name} · ${open.channel.name}`}
                {...(open.team.description ? { description: open.team.description } : {})}
                {...(members.length ? { memberCount: members.length } : {})}
                userId={me}
                displayName={session?.name ?? me}
                placeholder={`Message ${open.channel.name}`}
                actions={<Button variant="ghost" size="sm" onClick={() => go({ team: open.team.teamId })} data-testid="social-team-open-members">Members</Button>}
              />
            </Inline>
          ) : managing && detail.data ? (
            <Stack gap="md" className="min-w-0 flex-1" data-testid="social-team-detail">
              <ChannelHeader name={detail.data.team.name} {...(detail.data.team.description ? { description: detail.data.team.description } : {})} memberCount={members.length} />
              {!canEditMembers && (
                <InlineAlert tone="info">
                  {mayManage ? 'Only this team\'s owner adds or removes people.' : 'A moderator who owns this team adds or removes people.'}
                </InlineAlert>
              )}
              {membersPanel}
            </Stack>
          ) : managing && detail.error ? (
            <EmptyState align="start" className="min-w-0 flex-1" testId="social-team-missing" title="This team is not available" description="It does not exist, or it is private and you are not on it." />
          ) : (
            <EmptyState align="start" className="min-w-0 flex-1" title="Pick a channel" description="Choose a channel on the left to read it, or open a team's ⋯ menu to see who is on it." />
          )}
        </Inline>
      )}
      <Modal open={adding} onClose={() => setAdding(false)} title="Add people to the team" maxWidth={560}
        footer={<Button variant="secondary" size="sm" onClick={() => setAdding(false)}>Done</Button>}>
        <DataTable
          data={candidates}
          columns={candidateColumns}
          keyField={(c) => c.userId}
          searchable
          searchPlaceholder="Find a person"
          emptyMessage="Everyone in this workspace is already on the team."
          rowActions={(c) => <Button variant="ghost" size="sm" disabled={busy} onClick={() => void membership('POST', c.userId)} data-testid="social-team-add-person">Add</Button>}
          data-testid="social-team-candidates"
        />
      </Modal>
    </Stack>
  );
}
