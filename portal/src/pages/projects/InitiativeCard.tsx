import {
  AvatarGroup,
  Card,
  Chip,
  Inline,
  Link as ExternalLink,
  ProgressBar,
  Spinner,
  Stack,
  StatusDot,
} from '@connorhoehnslalom/ui-components/shared';
import { relativeTime } from '../../lib/relativeTime';
import { githubRepoUrl } from '../../lib/repoLink';
import { ProjectStatusChip } from './ProjectStatusChip';
import { T } from './Text';
import {
  PRIORITY_TONE,
  SPEND_TITLE,
  allocationFraction,
  cardTone,
  freshnessColor,
  liveAgentsLabel,
  openWorkLine,
  pointsFraction,
  spendLine,
  toneBorderTopClass,
  usd,
} from './projectFormat';
import type { ProjectSummary } from './types';

// One initiative tile on the program wall. The operating model: one person
// runs it, a few SMEs cut across, agents do the labor — so the card shows the
// people as one avatar cluster, the agents as a live line, delivery as a real
// progress bar, and the money against its allocation. Not the library
// `ProjectCard`: that component is built around a synthetic activity feed.

export function InitiativeCard({ project, onClick }: { project: ProjectSummary; onClick: () => void }) {
  const tone = cardTone(project);
  const smes = project.smeNames ?? [];
  const work = openWorkLine(project);
  const spend = spendLine(project);
  const repoUrl = githubRepoUrl(project.repoFullName);
  const live = liveAgentsLabel(project);
  const progress = pointsFraction(project);
  const burn = allocationFraction(project);

  return (
    // role="button" rather than a real button element: the footer carries a repo <a>,
    // and an anchor nested in a button is invalid HTML (hydration warning). A
    // Card with keyboard handling keeps the tile fully operable and lets the
    // link nest legally.
    <Card
      padding="sm"
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}
      className={`flex min-h-[170px] cursor-pointer flex-col gap-2.5 border-t-4 text-left transition-shadow hover:shadow-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${toneBorderTopClass(tone)}`}
    >
      {/* Name + status + priority. The name wraps rather than truncating — it
          is the one thing on a tile that has to be readable. */}
      <Inline gap="sm" align="start" justify="between" wrap={false}>
        <T as="div" className="min-w-0 flex-1 text-[14px] font-semibold leading-snug text-text-primary" wrap>
          {project.name}
        </T>
        <Inline gap="xs" wrap={false}>
          {project.priority && (
            <Chip tone={PRIORITY_TONE[project.priority] ?? 'neutral'} size="xs" uppercase
              title={`Hottest open work item: ${project.priority}`}>
              {project.priority}
            </Chip>
          )}
          <ProjectStatusChip status={project.status} />
        </Inline>
      </Inline>

      {/* The people — owner leads the cluster, SMEs behind. One bubble row
          instead of a name + a chip wall. */}
      {project.ownerName ? (
        <Inline gap="xs" wrap={false} className="min-w-0">
          <AvatarGroup names={[project.ownerName, ...smes]} size={22} maxVisible={4} />
          <T className="truncate text-[12px] text-text-secondary">
            <T className="font-semibold">{project.ownerName}</T>
            {smes.length > 0 && <T className="text-text-tertiary"> +{smes.length} SME{smes.length === 1 ? '' : 's'}</T>}
          </T>
        </Inline>
      ) : (
        <T className="text-[12px] text-text-tertiary">No owner yet</T>
      )}

      {/* Live agents — the real-time line. Pulsing dot while anything runs;
          otherwise the last-run stamp from the spend line stands in. */}
      {live ? (
        <Inline gap="xs" wrap={false}>
          {/* A working bot SPINS — the motion is the signal that compute is
              burning right now, not that something happened recently. */}
          <Spinner size="sm" color="var(--color-success)" aria-label="Agents working now" />
          <T className="text-[12px] font-medium text-text-secondary">{live}</T>
        </Inline>
      ) : (
        <T className={spend.muted ? 'text-[12px] text-text-tertiary' : 'text-[12px] text-text-secondary'} title={SPEND_TITLE}>
          {spend.text}
        </T>
      )}

      {/* Delivery + money, pinned to the bottom of the tile */}
      <Stack gap="xs" className="mt-auto">
        {progress != null && (
          <ProgressBar
            value={project.pointsDone ?? 0}
            max={Math.max(project.pointsTotal ?? 0, 1)}
            size="sm"
            showRatio={false}
            label={
              <T className="text-[11px] text-text-tertiary">
                {project.pointsDone}/{project.pointsTotal} pts{work ? ` · ${work}` : ''}
              </T>
            }
          />
        )}
        {burn != null && (
          <ProgressBar
            value={Math.min(burn, 1) * 100}
            size="sm"
            showRatio={false}
            color={burn > 1 ? 'var(--color-danger)' : burn > 0.8 ? 'var(--color-warning)' : 'var(--color-primary)'}
            aria-label="Spend against monthly allocation"
            label={
              <T className={`text-[11px] ${burn > 1 ? 'text-danger font-medium' : 'text-text-tertiary'}`} title={SPEND_TITLE}>
                {usd(project.agentSpendUsd ?? 0)} of {usd(project.allocatedUsd ?? 0)} allocation{burn > 1 ? ' — over' : ''}
              </T>
            }
          />
        )}
      </Stack>

      {/* Footer: freshness + codebase link */}
      <Inline gap="xs" justify="between" wrap={false} className="border-t border-border pt-2">
        <StatusDot
          size="xs"
          color={freshnessColor(project.lastActivityAt)}
          label={<T className="text-[11px] text-text-tertiary">{relativeTime(project.lastActivityAt ?? project.createdAt)}</T>}
        />
        {repoUrl && (
          // The card itself navigates to the detail page, so clicking the
          // repo link must not also open the initiative.
          <ExternalLink external
            href={repoUrl}
            onClick={e => e.stopPropagation()}
            title={project.repoFullName ?? undefined}
            className="max-w-[55%] truncate text-[11px] text-primary no-underline hover:underline"
          >
            ↗ {project.repoFullName}
          </ExternalLink>
        )}
      </Inline>
    </Card>
  );
}
