// The initiative's details, on hover and in full (the user, 2026-10-07: "a
// card that would pop up and hover for project details and then you could
// open up the fourth vertical side window (far right) for project details").
//
// `InitiativeFacts` states the facts once — status, owner, SMEs, sprint,
// budget against the maintenance floor, repository and counts — for both the
// hover card (`compact`) and the pane's Details tab. Every number is read
// from a route this page already reads under its own gate: the project
// detail, `GET /api/bots/initiative-runs` (session floor — the Agents tab's
// table) for the cron floor and the agents that ran here, and
// `GET /api/sprints?initiative=` (the Sprints lens's read: the caller's own
// sprints unless they may read the whole board).
//
// `InitiativeDetailsTrigger` is the info glyph beside the title: hover or
// focus shows the card (the library `HoverCard`, 2.437.0 — non-modal,
// non-trapping, the library's one hover timing), Escape hides it, and a
// click or Enter opens the Details tab in the right pane. It is also the
// compact header's description: the card leads with the summary.

import { StatStrip } from '@connorhoehnslalom/ui-components';
import {
  Avatar, Button, HoverCard, IconButton, InfoIcon, Inline, KeyValue, Link, Stack, StatusPill, T, type KeyValueItem,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { usd } from '../../lib/format';
import type { ProjectDetail } from '../project-detail/types';
import type { Sprint } from '../sprints/types';
import type { BotRun } from '../bots/BotsPage';
import { calendarDay, maintenanceFact, type Maintenance30d } from './initiativePaneModel';
import portraits from '../../lib/demoPortraits.json';

/** What the page already knows about the initiative, with its overrides applied. */
export interface InitiativeFactsInput {
  project: ProjectDetail;
  statusLabel: string | null;
  ownerName: string | null;
  smes: string[];
  repo: { label: string; href: string } | null;
  /** Null while unknown (a pending or failed read): the strip says "—", never 0. */
  counts: { work: number | null; decisions: number | null; contributors: number };
}

interface RunsRead { runs: BotRun[]; bots: Array<{ id: string; name: string }>; degraded?: boolean; maintenance30d?: Maintenance30d | null }
interface SprintsRead { sprints: Sprint[] }

const day = calendarDay;

function sprintValue(sprint: Sprint | null, read: { loading: boolean; error: string | null }, compact: boolean): { value: string; muted: boolean } {
  if (sprint && compact) return { value: sprint.endsOn ? `${sprint.name} · ends ${day(sprint.endsOn)}` : sprint.name, muted: false };
  if (sprint) {
    const dates = [day(sprint.startsOn), day(sprint.endsOn)].filter(Boolean).join(' – ');
    return { value: `${sprint.name}${dates ? ` · ${dates}` : ''}`, muted: false };
  }
  if (read.loading) return { value: 'Loading…', muted: true };
  if (read.error) return { value: 'Sprints could not be read', muted: true };
  return { value: 'No active sprint you can see', muted: true };
}

export function InitiativeFacts({ input, compact = false }: { input: InitiativeFactsInput; compact?: boolean }) {
  const { project } = input;
  const id = encodeURIComponent(project.id);
  // Shared: the hover card and the Details tab ask for the same rows.
  const runs = useFetch<RunsRead>(`/api/bots/initiative-runs?orgProjectId=${id}`, 60_000, { share: true });
  const sprints = useFetch<SprintsRead>(`/api/sprints?initiative=${id}&status=active`, 60_000, { share: true });
  // The 30-day floor as the server states it (v_initiative_maintenance_30d); not known is said, never 0.
  const floor = runs.data?.maintenance30d ?? null;
  const sprint = sprints.data?.sprints.find((s) => s.orgProjectId === project.id) ?? null;
  const sprintFact = sprintValue(sprint, { loading: sprints.isLoading && !sprints.data, error: sprints.error }, compact);
  const money = (n: number) => usd(n);
  const budget = project.agentSpendUsd == null
    ? { value: 'Spend not known', muted: true }
    : { value: project.allocatedUsd != null && project.allocatedUsd > 0
        ? `${usd(project.agentSpendUsd)} of ${usd(project.allocatedUsd)}${compact ? '' : ' spent this month'}`
        : `${usd(project.agentSpendUsd)}${compact ? '' : ' spent this month'} · no allocation`, muted: false };

  const items: KeyValueItem[] = [
    { label: 'Status', value: input.statusLabel
      ? <StatusPill label={input.statusLabel} tone={project.status === 'archived' ? 'neutral' : 'info'} variant="text" />
      : 'Not set', muted: !input.statusLabel },
    { label: 'Owner', value: input.ownerName ?? 'Unowned', muted: !input.ownerName },
    { label: input.smes.length === 1 ? 'SME' : 'SMEs', value: input.smes.length ? input.smes.join(', ') : 'None yet', muted: !input.smes.length },
    ...(!compact && project.sponsorName ? [{ label: 'Sponsor', value: project.sponsorTitle ? `${project.sponsorName} · ${project.sponsorTitle}` : project.sponsorName }] : []),
    ...(!compact ? [{ label: 'Started', value: day(project.createdAt) ?? 'Not recorded', muted: !project.createdAt }] : []),
    { label: 'Sprint', value: sprintFact.value, muted: sprintFact.muted, title: sprintFact.value },
    { label: 'Budget', value: budget.value, muted: budget.muted },
    { label: 'Maintenance', ...maintenanceFact({ loading: runs.isLoading && !runs.data, error: runs.error, floor }, money, compact),
      title: 'Cron-triggered bot runs — the standing cost of keeping this initiative’s repos alive (v_initiative_maintenance_30d). Part of the spend, not added to it.' },
    // The floor read against the allocation (the program model: an allocation is read against its floor).
    ...(!compact && floor && project.allocatedUsd != null && project.allocatedUsd > 0
      ? [{ label: 'Floor share', value: `${Math.round((floor.costUsd / project.allocatedUsd) * 1000) / 10}% of the monthly allocation` }] : []),
    { label: 'Repository', value: input.repo
      ? <Link href={input.repo.href} external data-testid="initiative-facts-repo">{compact ? input.repo.label.split('/').pop() : input.repo.label}</Link>
      : 'Not linked', muted: !input.repo },
  ];
  const count = (n: number | null) => (n == null ? '—' : String(n));
  const agents = runs.data ? runs.data.bots.length : null;
  if (!compact) {
    const face = (name: string) => portraits.personas.find(persona => persona.name === name)?.portraitUrl;
    const person = (label: string, name: string | null, detail?: string | null) => <Inline gap="sm" align="center" key={`${label}:${name}`}>
      <Avatar name={name ?? 'Unassigned'} src={name ? face(name) : undefined} size={24} />
      <Stack gap="none" className="min-w-0 flex-1"><T size="xs" tone="secondary">{label}</T><T size="sm" weight="medium" className="truncate" title={detail ? `${name} · ${detail}` : name ?? undefined}>{name ?? 'Unassigned'}</T></Stack>
    </Inline>;
    return <Stack gap="sm" data-testid="initiative-facts">
      <Stack gap="xs" className="rounded-lg border border-border bg-surface-panel/50 px-3 py-2">
        <Inline justify="between" align="center"><T size="xs" weight="semibold" tone="secondary">DELIVERY</T>{input.statusLabel && <StatusPill label={input.statusLabel} tone="info" variant="text" />}</Inline>
        <Stack gap="xs"><T size="sm" weight="medium" wrap>{sprint?.name ?? sprintFact.value}</T>
          <Inline gap="sm" wrap justify="between">{sprint && <T size="xs" tone="secondary">{[day(sprint.startsOn), day(sprint.endsOn)].filter(Boolean).join(' – ')}</T>}
          {project.createdAt && <T size="xs" tone="secondary">Started {day(project.createdAt)}</T>}</Inline>
        </Stack>
      </Stack>
      <Stack gap="xs">
        <T size="xs" weight="semibold" tone="secondary">PEOPLE</T>
        <div className="grid grid-cols-2 gap-x-3 gap-y-2">
          {person('Owner', input.ownerName)}
          {project.sponsorName && person('Sponsor', project.sponsorName, project.sponsorTitle)}
          {input.smes.map(name => person('SME', name))}
        </div>
      </Stack>
      {project.agentSpendUsd != null && <Stack gap="xs" className="rounded-lg border border-border px-3 py-2">
        <Inline gap="sm" justify="between"><T size="xs" weight="semibold" tone="secondary">THIS MONTH</T><T size="sm" weight="semibold">{usd(project.agentSpendUsd)}<span className="ml-1 text-xs font-normal text-text-secondary">{project.allocatedUsd ? ` / ${usd(project.allocatedUsd)}` : ' · no allocation'}</span></T></Inline>
        {!!project.allocatedUsd && <div className="h-1.5 overflow-hidden rounded-full bg-surface-inset" role="progressbar" aria-label="Monthly budget used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, Math.round(project.agentSpendUsd / project.allocatedUsd * 100))}>
          <div className="h-full min-w-1 rounded-full bg-primary" style={{ width: `${Math.min(100, project.agentSpendUsd / project.allocatedUsd * 100)}%` }} />
        </div>}
        <T size="xs" tone="secondary" wrap>Automation · {maintenanceFact({ loading: runs.isLoading && !runs.data, error: runs.error, floor }, money, true).value}</T>
      </Stack>}
      <div className="grid grid-cols-4 gap-2 border-y border-border py-2" aria-label="Initiative counts">
        {[
          { label: 'Work', value: count(input.counts.work) }, { label: 'Decisions', value: count(input.counts.decisions) },
          { label: 'Agents', value: count(agents) }, { label: 'People', value: String(input.counts.contributors) },
        ].map(stat => <Inline gap="xs" key={stat.label}><T size="sm" weight="semibold">{stat.value}</T><T size="xs" tone="secondary">{stat.label}</T></Inline>)}
      </div>
      {input.repo && <Stack gap="xs"><T size="xs" tone="secondary">Repository</T><Link href={input.repo.href} external className="break-all text-xs">{input.repo.label}</Link></Stack>}
    </Stack>;
  }
  return (
    <Stack gap="sm" data-testid={compact ? 'initiative-facts-compact' : 'initiative-facts'}>
      <KeyValue items={items} labelWidth="w-24" aria-label={`${project.name} facts`} data-testid="initiative-facts-list" />
      <StatStrip variant="line" size="sm" aria-label="Counts" data-testid="initiative-facts-counts" items={[
        { label: input.counts.work === 1 ? 'work item' : 'work items', value: count(input.counts.work) },
        { label: input.counts.decisions === 1 ? 'decision' : 'decisions', value: count(input.counts.decisions) },
        { label: agents === 1 ? 'agent' : 'agents', value: count(agents), title: 'Bots and dispatched agents with runs on this initiative' },
        { label: input.counts.contributors === 1 ? 'contributor' : 'contributors', value: String(input.counts.contributors) },
      ]} />
    </Stack>
  );
}

/** The info glyph beside the title: the card on hover/focus, the Details tab on click. */
export function InitiativeDetailsTrigger({ input, onOpenDetails }: { input: InitiativeFactsInput; onOpenDetails: () => void }) {
  return (
    // pinOnKey off: Enter/Space keep the button's own action (open Details).
    <HoverCard label={`${input.project.name} details`} width="lg" pinOnKey={false} data-testid="initiative-details-card-frame"
      content={(
        <Stack gap="sm" data-testid="initiative-details-card">
          <Stack gap="none">
            <T size="sm" weight="semibold" wrap>{input.project.name}</T>
            {input.project.summary && <T size="xs" tone="secondary" wrap>{input.project.summary}</T>}
          </Stack>
          <InitiativeFacts input={input} compact />
          <Button variant="primary" size="sm" onClick={onOpenDetails} data-testid="initiative-details-open">Open details</Button>
        </Stack>
      )}>
      {(trigger) => (
        <IconButton {...trigger} aria-label="Initiative details" variant="ghost" size="sm" icon={<InfoIcon size={14} />}
          data-testid="initiative-details-trigger" onClick={onOpenDetails} />
      )}
    </HoverCard>
  );
}
