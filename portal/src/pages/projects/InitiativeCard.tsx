import { Avatar, Card, Chip, Inline, Stack, StatusDot } from '@connorhoehnslalom/ui-components/shared';
import { relativeTime } from '../../lib/relativeTime';
import { githubRepoUrl } from '../../lib/repoLink';
import { ProjectStatusChip } from './ProjectStatusChip';
import {
  SPEND_TITLE,
  freshnessColor,
  spendLine,
  statusTone,
  toneBorderTopClass,
  workLine,
} from './projectFormat';
import type { ProjectSummary } from './types';

// The operating model: one person runs each initiative, a few SMEs cut across
// them directing agents. The card shows that — owner + SMEs + real work
// rollups + agent spend — not fabricated activity feeds or ten-avatar walls.
//
// Deliberately not the library `ProjectCard`: that component is built around an
// activity feed + avatar wall, which is exactly the synthetic noise this page
// dropped.

const MAX_SME_CHIPS = 3;

export function InitiativeCard({ project, onClick }: { project: ProjectSummary; onClick: () => void }) {
  const tone = statusTone(project.status);
  const smes = project.smeNames ?? [];
  const work = workLine(project);
  const spend = spendLine(project);
  const repoUrl = githubRepoUrl(project.repoFullName);

  return (
    // role="button" rather than a real <button>: the footer carries a repo <a>,
    // and an anchor nested in a button is invalid HTML (hydration warning). A
    // Card with keyboard handling keeps the tile fully operable and lets the
    // link nest legally.
    <Card
      padding="sm"
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}
      className={`flex min-h-[150px] cursor-pointer flex-col gap-2.5 border-t-4 text-left transition-shadow hover:shadow-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${toneBorderTopClass(tone)}`}
    >
      {/* Name + status. The name wraps rather than truncating — it is the one
          thing on a tile that has to be readable, and the grid keeps rows equal
          height anyway. */}
      <Inline gap="sm" align="start" justify="between" wrap={false}>
        <span className="min-w-0 flex-1 text-[14px] font-semibold leading-snug text-text-primary">
          {project.name}
        </span>
        <ProjectStatusChip status={project.status} />
      </Inline>

      {/* Owner — the one person running it */}
      {project.ownerName ? (
        <Inline gap="xs" wrap={false} className="min-w-0">
          <Avatar name={project.ownerName} size={20} />
          <span className="truncate text-[12px] text-text-secondary">
            Run by <span className="font-semibold">{project.ownerName}</span>
          </span>
        </Inline>
      ) : (
        <span className="text-[12px] text-text-tertiary">No owner yet</span>
      )}

      {/* SMEs — the cross-initiative specialists directing agents */}
      {smes.length > 0 && (
        <Inline gap="xs">
          {smes.slice(0, MAX_SME_CHIPS).map(name => (
            <Chip key={name} tone="info" size="xs" title={`SME: ${name}`}>{name}</Chip>
          ))}
          {smes.length > MAX_SME_CHIPS && (
            <span className="text-[10px] text-text-tertiary">+{smes.length - MAX_SME_CHIPS}</span>
          )}
        </Inline>
      )}

      {/* Work + agent rollups, pinned to the bottom of the tile */}
      <Stack gap="xs" className="mt-auto">
        {work && <span className="text-[12px] text-text-secondary">{work}</span>}
        <span
          className={spend.muted ? 'text-[12px] text-text-tertiary' : 'text-[12px] text-text-secondary'}
          title={SPEND_TITLE}
        >
          {spend.text}
        </span>
      </Stack>

      {/* Footer: freshness + codebase link */}
      <Inline gap="xs" justify="between" wrap={false} className="border-t border-border pt-2">
        <StatusDot
          size="xs"
          color={freshnessColor(project.lastActivityAt)}
          label={<span className="text-[11px] text-text-tertiary">{relativeTime(project.lastActivityAt ?? project.createdAt)}</span>}
        />
        {repoUrl && (
          <a
            href={repoUrl}
            target="_blank"
            rel="noreferrer"
            // The card itself navigates to the detail page, so clicking the
            // repo link must not also open the initiative.
            onClick={e => e.stopPropagation()}
            title={project.repoFullName ?? undefined}
            className="max-w-[55%] truncate text-[11px] text-primary no-underline hover:underline"
          >
            ↗ {project.repoFullName}
          </a>
        )}
      </Inline>
    </Card>
  );
}
