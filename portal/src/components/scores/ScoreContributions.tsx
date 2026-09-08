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

const SECTION_HEADER = 'text-[11px] font-semibold uppercase tracking-wider text-text-tertiary mb-1 mt-2.5 first:mt-0';
const ROW = 'flex justify-between items-center py-[3px]';
const ROW_LABEL = 'text-xs text-text-primary';
const ROW_META = 'text-[10.5px] text-text-tertiary';
const NO_DATA = 'text-[11px] text-text-tertiary';

export function ScoreContributions({ contributions }: ScoreContributionsProps) {
  if (contributions === undefined) {
    return <span className={NO_DATA}>Loading contributions…</span>;
  }
  if (contributions === null) {
    return <span className={NO_DATA}>No contribution data for this person yet.</span>;
  }
  return (
    <>
      <div className={SECTION_HEADER}>Collaborators</div>
      {contributions.collaborators.length === 0 ? (
        <span className={NO_DATA}>No data yet</span>
      ) : (
        contributions.collaborators.map((c) => (
          <div key={c.otherId} className={ROW}>
            <span className={ROW_LABEL}>{c.otherName}</span>
            <span className={ROW_META}>{c.weight.toFixed(2)}</span>
          </div>
        ))
      )}

      <div className={SECTION_HEADER}>Projects</div>
      {contributions.projects.length === 0 ? (
        <span className={NO_DATA}>No data yet</span>
      ) : (
        contributions.projects.map((p, i) => (
          <div key={`${p.projectName}-${i}`} className={ROW}>
            <span className={ROW_LABEL}>{p.projectName}</span>
            <span className={ROW_META}>
              {p.role ? `${p.role} · ` : ''}{p.weight.toFixed(2)}
            </span>
          </div>
        ))
      )}

      <div className={SECTION_HEADER}>Decisions</div>
      {contributions.decisions.length === 0 ? (
        <span className={NO_DATA}>No data yet</span>
      ) : (
        contributions.decisions.map((d, i) => (
          <div key={`${d.topic}-${i}`} className={ROW}>
            <span className={ROW_LABEL}>{d.topic}</span>
            <span className={ROW_META}>
              {d.role ? `${d.role} · ` : ''}{d.weight.toFixed(2)}
            </span>
          </div>
        ))
      )}
    </>
  );
}
