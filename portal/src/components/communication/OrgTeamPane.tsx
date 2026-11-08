// One of the linked person's org-graph teams on the Communication plane
// (docs/communication-plane-goal.md §1.4), when it has no bound Social team:
// its members with presence (the library `ActivePeopleGrid` over the shell's
// one presence roster — members linked to an app user carry a dot), each
// member's shared work one click away (§3), and "Create team channel" for a
// ManageTeams holder. A bound team never lands here: its row opens the bound
// conversation.
//
// Members resolve to app users on the server (GET /api/me/groups?kind=org-team, the one "mine" reader);
// a member with no app user cannot be messaged or show presence, and says so.

import { useMemo } from 'react';
import { ActivePeopleGrid } from '@connorhoehn/ui-components/social';
import { Button, ChannelHeader, EmptyState, InlineAlert, Stack } from '@connorhoehn/ui-components/shared';
import { orgTeamPeople, onlineMembers, type OrgTeam } from './planeRailModel';
import type { PlaneOrg } from './usePlaneOrg';

export interface OrgTeamPaneProps {
  org: PlaneOrg;
  teamId: string;
  me: string;
  here: ReadonlyArray<{ id: string; idle?: boolean }>;
  online: ReadonlySet<string>;
  mayManageTeams: boolean;
  onMessage(userId: string): void;
  onSharedWork(userId: string): void;
  /** Creates the Social team channel and binds it; absent until the BFF offers it. */
  onCreateTeamChannel?: (team: OrgTeam) => void;
  busy?: boolean;
}

export function OrgTeamPane({ org, teamId, me, here, online, mayManageTeams, onMessage, onSharedWork, onCreateTeamChannel, busy }: OrgTeamPaneProps) {
  const team = org.orgTeams?.teams.find((t) => t.id === teamId) ?? null;
  const people = useMemo(() => (team ? orgTeamPeople(team, here, me) : []), [team, here, me]);
  if (!team) {
    return org.orgTeams
      ? <EmptyState align="start" testId="plane-org-team-missing" title="Not one of your org teams" description="This plane lists the org-graph teams your linked person is on." />
      : <EmptyState align="start" title="Loading…" description="Finding this team among yours." />;
  }
  const linked = new Set(team.members.flatMap((m) => (m.userId ? [m.userId] : [])));
  const here_ = onlineMembers(team, online);
  return (
    <Stack gap="md" className="min-h-0 min-w-0 flex-1 overflow-auto" data-testid="plane-org-team-pane" data-team={team.id}>
      <ChannelHeader name={team.name} memberCount={team.members.length}
        description={[team.role ? `You: ${team.role}` : '', here_ ? `${here_} online now` : 'Nobody online now'].filter(Boolean).join(' · ')}
        {...(mayManageTeams && onCreateTeamChannel ? {
          actions: <Button variant="primary" size="sm" disabled={busy} onClick={() => onCreateTeamChannel(team)} data-testid="plane-org-team-create-channel">Create team channel</Button>,
        } : {})} />
      {!mayManageTeams && <InlineAlert tone="info">This team has no Social team channel yet. A moderator can create one.</InlineAlert>}
      {people.length
        ? <ActivePeopleGrid people={people} maxVisible={24} emptyLabel="Nobody else is on this team."
          onSelectPerson={(userId) => { if (linked.has(userId)) onMessage(userId); }}
          onSelectSharedWork={(userId) => { if (linked.has(userId)) onSharedWork(userId); }}
          data-testid="plane-org-team-members" />
        : <EmptyState align="start" title="Only you" description="Nobody else is on this team in the org graph." />}
    </Stack>
  );
}
