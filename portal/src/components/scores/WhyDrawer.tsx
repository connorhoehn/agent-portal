import React from 'react';

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

const sectionHeader: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  color: 'var(--color-text-tertiary)',
  marginBottom: 4,
  marginTop: 10,
};

const rowStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: '3px 0',
};

const rowLabel: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--color-text-primary)',
};

const rowMeta: React.CSSProperties = {
  fontSize: 10.5,
  color: 'var(--color-text-tertiary)',
};

const noData: React.CSSProperties = {
  fontSize: 11,
  color: 'var(--color-text-tertiary)',
};

export function WhyDrawer({ open, onClose: _onClose, contributions }: WhyDrawerProps): React.ReactElement | null {
  if (!open) return null;

  const drawerStyle: React.CSSProperties = {
    marginTop: 8,
    padding: 12,
    borderTop: '1px solid var(--color-border)',
    background: 'var(--color-surface-hover, #f8fafc)',
    borderRadius: '0 0 6px 6px',
  };

  if (contributions === undefined) {
    return (
      <div style={drawerStyle}>
        <span style={noData}>Loading contributions...</span>
      </div>
    );
  }

  if (contributions === null) {
    return (
      <div style={drawerStyle}>
        <span style={noData}>No contributions data</span>
      </div>
    );
  }

  const { collaborators, projects, decisions } = contributions;

  return (
    <div style={drawerStyle}>
      <div style={sectionHeader}>Collaborators</div>
      {collaborators.length === 0 ? (
        <span style={noData}>No data yet</span>
      ) : (
        collaborators.map((c) => (
          <div key={c.otherId} style={rowStyle}>
            <span style={rowLabel}>{c.otherName}</span>
            <span style={rowMeta}>{c.weight.toFixed(2)}</span>
          </div>
        ))
      )}

      <div style={sectionHeader}>Projects</div>
      {projects.length === 0 ? (
        <span style={noData}>No data yet</span>
      ) : (
        projects.map((p, i) => (
          <div key={`${p.projectName}-${i}`} style={rowStyle}>
            <span
              style={{ ...rowLabel, cursor: 'pointer', textDecoration: 'underline dotted', textUnderlineOffset: 2 }}
              title={`View project: ${p.projectName}`}
            >
              {p.projectName}
            </span>
            <span style={rowMeta}>
              {p.role ? `${p.role} · ` : ''}{p.weight.toFixed(2)}
            </span>
          </div>
        ))
      )}

      <div style={sectionHeader}>Decisions</div>
      {decisions.length === 0 ? (
        <span style={noData}>No data yet</span>
      ) : (
        decisions.map((d, i) => (
          <div key={`${d.topic}-${i}`} style={rowStyle}>
            <span style={rowLabel}>{d.topic}</span>
            <span style={rowMeta}>
              {d.role ? `${d.role} · ` : ''}{d.weight.toFixed(2)}
            </span>
          </div>
        ))
      )}
    </div>
  );
}
