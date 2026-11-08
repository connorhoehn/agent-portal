// A curated initiative summary in the existing Details pane. Overview owns
// rollups and spend; Contributors owns the full roster. Only the active sprint
// needs an additional read, under the same caller gate as the Sprints lens.

import {
  Avatar, IconButton, InfoIcon, KeyValue, Tooltip, Inline, Stack, T,
} from '@connorhoehn/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import type { ProjectDetail } from '../project-detail/types';
import type { Sprint } from '../sprints/types';
import { calendarDay } from './initiativePaneModel';

interface InitiativePerson { name: string; avatarUrl?: string }

/** Names and photos from the page's authorized contributor read, with overrides applied. */
export interface InitiativeFactsInput {
  project: ProjectDetail;
  statusLabel: string | null;
  owner: InitiativePerson | null;
  smes: InitiativePerson[];
}

interface SprintsRead { sprints: Sprint[] }

export function InitiativeFacts({ input }: { input: InitiativeFactsInput }) {
  const { project } = input;
  const sprints = useFetch<SprintsRead>(`/api/sprints?initiative=${encodeURIComponent(project.id)}&status=active`, 60_000, { share: true });
  const sprint = sprints.data?.sprints.find((s) => s.orgProjectId === project.id) ?? null;
  const sprintText = sprint?.name ?? (sprints.isLoading && !sprints.data ? 'Loading sprint…'
    : sprints.error ? 'Sprint unavailable' : 'No active sprint');
  const endsOn = sprint?.endsOn ? calendarDay(sprint.endsOn) : null;
  const person = (value: InitiativePerson) => <Inline gap="sm" align="center" wrap={false}>
    <Avatar name={value.name} src={value.avatarUrl} size={20} />
    <T size="sm" wrap>{value.name}</T>
  </Inline>;
  // The status is the header's badge beside the title, so the pane does not
  // repeat it; the people sit on one wrapping line each (the user, 2026-11-02).
  return <KeyValue labelWidth="w-16" aria-label="Initiative facts" data-testid="initiative-facts" items={[
    { label: 'Sprint', value: <Inline gap="sm" align="baseline" wrap><T size="sm" tone={sprint ? 'primary' : 'secondary'} wrap>{sprintText}</T>{endsOn && <T size="xs" tone="secondary">Ends {endsOn}</T>}</Inline> },
    { label: 'Owner', value: input.owner ? person(input.owner) : 'Unassigned', muted: !input.owner },
    { label: 'SMEs', value: input.smes.length ? <Inline gap="md" align="center" wrap>{input.smes.map(value => <Inline key={value.name}>{person(value)}</Inline>)}</Inline> : 'None assigned', muted: input.smes.length === 0 },
  ]} />;
}

/** The content title's info action reveals the existing Details pane directly. */
export function InitiativeDetailsTrigger({ onOpenDetails }: { onOpenDetails: () => void }) {
  return <Tooltip content="Open initiative details (Shift+I)">
    <IconButton aria-label="Initiative details" aria-keyshortcuts="Shift+I" variant="ghost" size="sm" icon={<InfoIcon size={14} />}
      data-testid="initiative-details-trigger" onClick={onOpenDetails} />
  </Tooltip>;
}
