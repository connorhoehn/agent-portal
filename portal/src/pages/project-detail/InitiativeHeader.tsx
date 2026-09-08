// The initiative's identity, its summary, who authorized it, and its three
// headline numbers.
//
// Two rounds of fixes are visible here. First, the old header was one Card
// carrying a status pill, an owner/SME line, a free-floating row of
// hand-centred stat divs and a bare progress track; the stats became a
// compact StatStrip and the title block became PageHeader.
//
// Then the Card-wrapped StatStrip drew its OWN border inside the Card — a
// card in a card, two rounded boxes a few pixels apart standing in for a
// hierarchy that does not exist. It renders `frameless` now, with a Divider
// doing the separating.
//
// The bigger gap was in what the block SAID. It named the owner (who runs the
// initiative) and the SMEs (who attach to it), and stopped — so the page
// answered "who is doing this" but never "what is this for" or "who
// authorized it". Both are now first-class: the summary is prose above the
// identity row, and the SPONSOR leads that row, since the executive who
// signed off is the originator every funding conversation starts from.

import {
  Avatar,
  Button,
  Card,
  Chip,
  Divider,
  Inline,
  SectionLabel,
  StatStrip,
  PageHeader,
  Stack,
} from '@connorhoehnslalom/ui-components/shared';
import { OwnerEditor } from '../../components/marketplace/GovernanceEditor';
import { ExternalLink } from './ExternalLinkFrame';
import { PersonRef } from './PersonRef';
import { T } from './Text';
import { agentSpendStripItem, type AgentSpendInputs } from './AgentSpendStat';
import { PROJECT_STATUS_TONE, daysRunning, runningLabel } from './projectFormat';
import type { ProjectContributor, ProjectDetail } from './types';

/** The uppercase caption naming one role in the identity row. */
function RoleLabel({ children }: { children: React.ReactNode }) {
  return (
    <SectionLabel className="text-[10px] font-semibold tracking-wide">
      {children}
    </SectionLabel>
  );
}

/**
 * Who authorized the initiative, who runs it, and who directs agents on it —
 * in that order, because that is the order of authority.
 *
 * Every name here is a PersonRef: one link, one hover card, wherever a person
 * appears on this page. They used to be ghost buttons opening a modal, which
 * meant a name behaved differently here than in the work table and could not
 * be opened in a new tab or linked to.
 *
 * The owner edit affordance only renders for sessions holding DispatchAgentRun
 * (OwnerEditor gates itself).
 */
function IdentityLine({
  projectId, contributors, ownerId, ownerName, smes, sponsorId, sponsorName, sponsorTitle,
  onOwner, onRole,
}: {
  projectId: string;
  contributors: ProjectContributor[];
  ownerId: string | null;
  ownerName: string | null;
  smes: ProjectContributor[];
  sponsorId: string | null;
  sponsorName: string | null;
  sponsorTitle: string | null;
  onOwner: (ownerId: string | null, ownerName: string | null) => void;
  onRole: (personId: string, role: string | null) => void;
}) {
  return (
    <Inline gap="lg" align="center" className="text-[12px] text-text-secondary">
      {sponsorName && (
        <Inline gap="xs" align="center" wrap={false}>
          <RoleLabel>Sponsor</RoleLabel>
          <PersonRef
            personId={sponsorId}
            name={sponsorName}
            title={sponsorTitle}
            className="font-semibold text-text-primary"
          />
          {sponsorTitle && <T className="text-text-tertiary">{sponsorTitle}</T>}
        </Inline>
      )}

      <Inline gap="xs" align="center" wrap={false}>
        <RoleLabel>Owner</RoleLabel>
        {ownerName ? (
          <PersonRef
            personId={ownerId}
            name={ownerName}
            className="font-semibold text-text-primary"
          />
        ) : (
          <T className="text-text-tertiary">—</T>
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

      {smes.length > 0 && (
        <Inline gap="xs" align="center">
          <RoleLabel>SMEs</RoleLabel>
          {smes.map((s) => (
            <PersonRef
              key={s.personId}
              personId={s.personId}
              name={s.name}
              title={s.title}
            />
          ))}
        </Inline>
      )}
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
  repoCount,
  onOwner,
  onRole,
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
  /** How many codebases deliver this initiative. Counted from the codebase
   *  list the page already fetches — never a stored number to drift. */
  repoCount: number;
  onOwner: (ownerId: string | null, ownerName: string | null) => void;
  onRole: (personId: string, role: string | null) => void;
}) {
  const status = project.status ?? 'unknown';
  const hasIdentity =
    Boolean(ownerName) || Boolean(project.sponsorName) || smes.length > 0 || contributors.length > 0;
  // `summary` is the new prose field; `description` is the legacy one some
  // rows still carry. Prefer the former, fall back rather than showing
  // nothing where the older value exists.
  const summary = project.summary ?? project.description ?? null;
  const age = daysRunning(project.createdAt);
  const startedLabel = project.createdAt
    ? new Date(project.createdAt).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })
    : '';

  return (
    <Stack gap="md">
      {/* No `back` here. The shell's Breadcrumbs already renders
          Plan / Initiatives / <name> with Initiatives as a live link, so a
          second "← Initiatives" directly beneath it was two doors to the same
          place stacked on top of each other. */}
      <PageHeader
        title={project.name}
        badge={(
          <Inline gap="xs" align="center" wrap={false}>
            <Chip tone={PROJECT_STATUS_TONE[status] ?? 'info'} size="sm" uppercase>{status}</Chip>
            {/* The initiative's machine slug. Everything under it — epics,
                stories, bots — is addressed by an id derived from this one,
                so the top of the chain should be as citable as the rest. */}
            <T className="font-mono text-[11px] text-text-tertiary">{project.id}</T>
          </Inline>
        )}
        actions={repoUrl ? (
          <ExternalLink
            href={repoUrl}
            title={repoLabel ?? undefined}
            className="text-[12px] font-medium text-primary no-underline hover:underline"
          >
            ↗ {repoLabel ?? 'GitHub'}
          </ExternalLink>
        ) : undefined}
      />

      <Card padding="md">
        <Stack gap="md">
          {summary && (
            <T as="p" className="m-0 max-w-[70ch] text-[13px] leading-relaxed text-text-secondary">
              {summary}
            </T>
          )}

          {hasIdentity && (
            <IdentityLine
              projectId={projectId}
              contributors={contributors}
              ownerId={ownerId}
              ownerName={ownerName}
              smes={smes}
              sponsorId={project.sponsorId ?? null}
              sponsorName={project.sponsorName ?? null}
              sponsorTitle={project.sponsorTitle ?? null}
              onOwner={onOwner}
              onRole={onRole}
            />
          )}

          <Divider spacing="none" />

          {/* One compact strip, not three tall tiles. These numbers are
              context for the work below, and a card apiece spent ~110px of
              vertical space saying three short things — pushing the actual
              board under the fold on a laptop.

              `frameless` because the Card above already provides the frame:
              the strip's own border inside it was a card in a card. */}
          <StatStrip
            frameless
            aria-label="Initiative rollup"
            items={[
              ...(points.total > 0
                ? [{
                    label: 'Points done',
                    value: `${points.pct}%`,
                    tone: 'accent' as const,
                    hint: `${points.done}/${points.total} pts`,
                  }]
                : []),
              agentSpendStripItem(spend),
              // Two questions the rollup never answered: how big is this
              // (repos) and how long has it been going (age). Both come from
              // data already on the page — the codebase list and createdAt —
              // so neither is a number that can drift from reality.
              ...(repoCount > 0
                ? [{
                    label: 'Repos',
                    value: repoCount,
                    hint: repoCount === 1 ? 'codebase' : 'codebases',
                  }]
                : []),
              ...(age != null
                ? [{
                    label: 'Running',
                    value: runningLabel(age),
                    hint: `since ${startedLabel}`,
                  }]
                : []),
              {
                label: 'Open decisions',
                value: openDecisionCount,
                ...(escalatedCount > 0 ? { tone: 'danger' as const } : {}),
                ...(escalatedCount > 0 ? { hint: `${escalatedCount} escalated` } : {}),
              },
            ]}
          />
        </Stack>
      </Card>
    </Stack>
  );
}
