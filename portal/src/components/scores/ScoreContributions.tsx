// The "Why this score?" content — collaborators/projects/decisions that fed
// a person's composite. Renders as plain content inside a `CollapsibleSection`
// in PersonDetailCard.tsx, not its own surface.
//
// This used to be a `Drawer` (WhyDrawer.tsx) layered UNDER a `▾`/`▴`
// disclosure toggle on the same "Why this score?" label — one control whose
// icon promised an inline reveal but whose implementation popped a second,
// separate overlay surface with the same title, and that overlay's data was
// fetched lazily on open (`whyOpen && detail.id ? ... : ''`), so the first
// paint of every open was "Loading contributions…" and, whenever the
// contributions endpoint had nothing for a person, stayed empty for good
// (the unfiled note in the 2026-09-05 23:50 re-audit: "'Why this score?'
// opens BOTH an inline section and an empty drawer of the same name"). One
// control, one surface: this is now the entire "Why this score?" section —
// PersonDetailCard fetches `contributions` eagerly, the same way it already
// fetches `radar` and `history`, so the section has real content as soon as
// it's expanded instead of racing a fetch that only starts on open.
import { Inline, MetaLine, SectionLabel } from '@connorhoehn/ui-components/shared';

export interface CollaboratorContribution {
  otherId: string;
  otherName: string;
  weight: number;
}

export interface ProjectContribution {
  projectName: string;
  role: string | null;
  weight: number;
}

export interface DecisionContribution {
  topic: string;
  role: string | null;
  weight: number;
}

export interface ContributionsResponse {
  personId: string;
  collaborators: CollaboratorContribution[];
  projects: ProjectContribution[];
  decisions: DecisionContribution[];
}

export interface ScoreContributionsProps {
  contributions: ContributionsResponse | null | undefined;
}

const SECTION_HEADER = 'mb-1 mt-2.5 first:mt-0';

/**
 * One `label — weight` line. All three sections below are the same shape, so
 * they share it rather than repeating a two-span row three times.
 */
function ContributionRow({ label, meta }: { label: string; meta: string }) {
  return (
    <Inline justify="between" align="center" className="py-[3px]">
      <MetaLine size="sm" items={[label]} />
      <MetaLine size="xs" items={[meta]} />
    </Inline>
  );
}

function Section({ title, rows }: { title: string; rows: { key: string; label: string; meta: string }[] }) {
  return (
    <>
      <SectionLabel as="div" className={SECTION_HEADER}>{title}</SectionLabel>
      {rows.length === 0
        ? <MetaLine size="xs" items={['No data yet']} />
        : rows.map((r) => <ContributionRow key={r.key} label={r.label} meta={r.meta} />)}
    </>
  );
}

export function ScoreContributions({ contributions }: ScoreContributionsProps) {
  if (contributions === undefined) {
    return <MetaLine size="xs" items={['Loading contributions…']} />;
  }
  if (contributions === null) {
    return <MetaLine size="xs" items={['No contribution data for this person yet.']} />;
  }
  return (
    <>
      <Section
        title="Collaborators"
        rows={contributions.collaborators.map((c) => ({
          key: c.otherId, label: c.otherName, meta: c.weight.toFixed(2),
        }))}
      />
      <Section
        title="Projects"
        rows={contributions.projects.map((pr, i) => ({
          key: `${pr.projectName}-${i}`,
          label: pr.projectName,
          meta: `${pr.role ? `${pr.role} · ` : ''}${pr.weight.toFixed(2)}`,
        }))}
      />
      <Section
        title="Decisions"
        rows={contributions.decisions.map((d, i) => ({
          key: `${d.topic}-${i}`,
          label: d.topic,
          meta: `${d.role ? `${d.role} · ` : ''}${d.weight.toFixed(2)}`,
        }))}
      />
    </>
  );
}
