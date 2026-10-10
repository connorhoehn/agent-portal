// A curated initiative summary in the existing Details pane. Overview owns
// rollups and spend; Contributors owns the full roster. Only the active sprint
// needs an additional read, under the same caller gate as the Sprints lens.

import {
  Avatar, AvatarGroup, Card, IconButton, InfoIcon, Tooltip, Inline, Stack, StatusPill, T,
} from '@connorhoehnslalom/ui-components/shared';
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
  const smeLabel = input.smes.length === 1 ? input.smes[0].name : `${input.smes.length} SMEs`;
  return <Stack gap="sm" data-testid="initiative-facts">
    <Card className="border-primary/20 bg-primary/5 px-3 py-2" data-testid="initiative-details-delivery">
      <Stack gap="xs">
        <Inline gap="sm" align="center" justify="between">
          <T size="xs" weight="semibold" tone="secondary">Delivery</T>
          {input.statusLabel && <StatusPill label={input.statusLabel} tone={project.status === 'archived' ? 'neutral' : 'info'} variant="text" />}
        </Inline>
        <T size="sm" weight="medium" className="truncate" title={sprintText}>{sprintText}</T>
        {endsOn && <T size="xs" tone="secondary">Ends {endsOn}</T>}
      </Stack>
    </Card>
    <Inline gap="md" align="center" className="min-w-0" data-testid="initiative-details-people">
      {input.owner && <Inline gap="sm" align="center" wrap={false} className="min-w-0 flex-1">
        <Avatar name={input.owner.name} src={input.owner.avatarUrl} size={24} />
        <Stack gap="none" className="min-w-0"><T size="xs" tone="secondary">Owner</T><T size="sm" weight="medium" className="truncate" title={input.owner.name}>{input.owner.name}</T></Stack>
      </Inline>}
      {input.smes.length > 0 && <Tooltip content={input.smes.map((person) => person.name).join(', ')}>
        <Inline as="span" gap="sm" align="center" wrap={false} className="min-w-0" aria-label={`SMEs: ${input.smes.map(person => person.name).join(', ')}`}>
          <AvatarGroup items={input.smes.map(person => ({ name: person.name, src: person.avatarUrl }))} size={24} maxVisible={2} />
          <T as="span" size="xs" tone="secondary" className="truncate">{smeLabel}</T>
        </Inline>
      </Tooltip>}
      {!input.owner && input.smes.length === 0 && <T size="xs" tone="secondary">No owner or SME assigned</T>}
    </Inline>
  </Stack>;
}

/** The content title's info action reveals the existing Details pane directly. */
export function InitiativeDetailsTrigger({ onOpenDetails }: { onOpenDetails: () => void }) {
  return <Tooltip content="Open initiative details (Shift+I)">
    <IconButton aria-label="Initiative details" aria-keyshortcuts="Shift+I" variant="ghost" size="sm" icon={<InfoIcon size={14} />}
      data-testid="initiative-details-trigger" onClick={onOpenDetails} />
  </Tooltip>;
}
