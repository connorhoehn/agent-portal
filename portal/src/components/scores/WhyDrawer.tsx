import React from 'react';
import { Drawer } from '@connorhoehnslalom/ui-components/shared';

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

export interface WhyDrawerProps {
  open: boolean;
  onClose: () => void;
  contributions: ContributionsResponse | null | undefined;
}

const SECTION_HEADER = 'text-[11px] font-semibold uppercase tracking-wider text-text-tertiary mb-1 mt-2.5';
const ROW = 'flex justify-between items-center py-[3px]';
const ROW_LABEL = 'text-xs text-text-primary';
const ROW_META = 'text-[10.5px] text-text-tertiary';
const NO_DATA = 'text-[11px] text-text-tertiary';

export function WhyDrawer({ open, onClose, contributions }: WhyDrawerProps): React.ReactElement | null {
  return (
    <Drawer open={open} onClose={onClose} title="Why this score?" width={420}>
      {contributions === undefined && <span className={NO_DATA}>Loading contributions...</span>}
      {contributions === null && <span className={NO_DATA}>No contributions data</span>}
      {contributions && (
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
                <span
                  className={`${ROW_LABEL} cursor-pointer underline decoration-dotted underline-offset-2`}
                  title={`View project: ${p.projectName}`}
                >
                  {p.projectName}
                </span>
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
      )}
    </Drawer>
  );
}
