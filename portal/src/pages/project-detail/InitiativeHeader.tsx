// The initiative's identity and its three headline numbers.
//
// The old header was one Card carrying a status pill, an owner/SME line, the
// description, a free-floating row of hand-centred stat divs and a bare
// progress track. The stats are now a KPIGrid of StatCards — one grid, one
// scale, one alignment — and the title block is PageHeader, so this page's
// heading matches every other page in the portal.

import {
  Avatar,
  Button,
  Card,
  Chip,
  Inline,
  KPIGrid,
  PageHeader,
  Stack,
  StatCard,
} from '@connorhoehnslalom/ui-components/shared';
import { OwnerEditor } from '../../components/marketplace/GovernanceEditor';
import { AgentSpendStat, type AgentSpendInputs } from './AgentSpendStat';
import { PROJECT_STATUS_TONE } from './projectFormat';
import type { ProjectContributor, ProjectDetail } from './types';

/** Who runs the initiative and who directs agents on it. The edit affordance
 *  only renders for sessions holding DispatchAgentRun (OwnerEditor gates
 *  itself). */
function IdentityLine({
  projectId, contributors, ownerId, ownerName, smes, onOwner, onRole, onOpenPerson,
}: {
  projectId: string;
  contributors: ProjectContributor[];
  ownerId: string | null;
  ownerName: string | null;
  smes: ProjectContributor[];
  onOwner: (ownerId: string | null, ownerName: string | null) => void;
  onRole: (personId: string, role: string | null) => void;
  onOpenPerson: (personId: string, role: string | null) => void;
}) {
  return (
    <Inline gap="sm" align="center" className="text-[12px] text-text-secondary">
      <Inline gap="xs" align="center" wrap={false}>
        {ownerName && <Avatar name={ownerName} size={18} title={ownerName} />}
        <span>Run by</span>
        {ownerName && ownerId ? (
          <Button variant="ghost" size="sm" className="px-0 font-semibold" onClick={() => onOpenPerson(ownerId, 'owner')}>
            {ownerName}
          </Button>
        ) : ownerName ? (
          <span className="font-semibold text-text-primary">{ownerName}</span>
        ) : (
          <span className="text-text-tertiary">—</span>
        )}
        <OwnerEditor
          projectId={projectId}
          contributors={contributors}
          ownerId={ownerId}
          ownerName={ownerName}
          onOwner={onOwner}
          onRole={onRole}
        />
      </Inline>
      {smes.map((s) => (
        <Button
          key={s.personId}
          variant="ghost"
          size="sm"
          className="p-0"
          title={`${s.name} — SME directing agents on this initiative`}
          onClick={() => onOpenPerson(s.personId, 'sme')}
        >
          <Chip tone="info" size="xs">SME · {s.name}</Chip>
        </Button>
      ))}
    </Inline>
  );
}

export function InitiativeHeader({
  project,
  projectId,
  contributors,
  ownerId,
  ownerName,
  smes,
  points,
  openDecisionCount,
  escalatedCount,
  spend,
  repoUrl,
  repoLabel,
  onOwner,
  onRole,
  onOpenPerson,
}: {
  project: ProjectDetail;
  projectId: string;
  contributors: ProjectContributor[];
  ownerId: string | null;
  ownerName: string | null;
  smes: ProjectContributor[];
  points: { done: number; total: number; pct: number };
  openDecisionCount: number;
  escalatedCount: number;
  spend: AgentSpendInputs;
  /** Mission-2 codebase link — the repo that delivers this initiative. */
  repoUrl: string | null;
  repoLabel: string | null;
  onOwner: (ownerId: string | null, ownerName: string | null) => void;
  onRole: (personId: string, role: string | null) => void;
  onOpenPerson: (personId: string, role: string | null) => void;
}) {
  const status = project.status ?? 'unknown';
  const hasIdentity = Boolean(ownerName) || smes.length > 0 || contributors.length > 0;

  return (
    <Stack gap="md">
      <PageHeader
        back={{ label: 'Projects', to: '/iq/projects' }}
        title={project.name}
        description={project.description ?? undefined}
        badge={<Chip tone={PROJECT_STATUS_TONE[status] ?? 'info'} size="sm" uppercase>{status}</Chip>}
        actions={repoUrl ? (
          <a
            href={repoUrl}
            target="_blank"
            rel="noreferrer"
            title={repoLabel ?? undefined}
            className="text-[12px] font-medium text-primary no-underline hover:underline"
          >
            ↗ {repoLabel ?? 'GitHub'}
          </a>
        ) : undefined}
      />

      <Card padding="md">
        <Stack gap="md">
          {hasIdentity && (
            <IdentityLine
              projectId={projectId}
              contributors={contributors}
              ownerId={ownerId}
              ownerName={ownerName}
              smes={smes}
              onOwner={onOwner}
              onRole={onRole}
              onOpenPerson={onOpenPerson}
            />
          )}

          <KPIGrid columns={3} dense>
            {points.total > 0 && (
              // The bare full-width progress track that used to sit under this
              // grid said nothing the tile doesn't; the sparkline-free tile
              // plus its ratio hint is the whole story.
              <StatCard
                accent
                label="points done"
                value={`${points.pct}%`}
                hint={`${points.done}/${points.total} pts`}
              />
            )}
            <AgentSpendStat {...spend} />
            <StatCard
              danger={escalatedCount > 0}
              label="open decisions"
              value={openDecisionCount}
              hint={escalatedCount > 0 ? `${escalatedCount} escalated` : undefined}
            />
          </KPIGrid>
        </Stack>
      </Card>
    </Stack>
  );
}
