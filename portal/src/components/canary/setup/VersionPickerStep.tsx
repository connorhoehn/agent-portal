// VersionPickerStep — Step 2 of the canary setup wizard.
// Shows the version history of the selected prompt and lets the user pick
// which version is A (baseline) and which is B (challenger).

import { useState } from 'react';
import type { CSSProperties } from 'react';
import { usePromptVersions } from '../usePromptLibrary.js';
import type { PromptLibraryEntry } from '../types.js';

export interface VersionPickerStepProps {
  promptId: string;
  promptName: string;
  selectedVersionA: string | null;
  selectedVersionB: string | null;
  onSelectA: (version: string) => void;
  onSelectB: (version: string) => void;
  onEditFromA: () => void;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function versionLabel(v: string): string {
  return v === 'DRAFT' ? 'Draft' : `Version ${v}`;
}

interface VersionRowProps {
  entry: PromptLibraryEntry;
  selected: boolean;
  onSelect: () => void;
  radioName: string;
  side: 'A' | 'B';
}

function VersionRow({ entry, selected, onSelect, radioName, side }: VersionRowProps): React.ReactElement {
  const [hovered, setHovered] = useState(false);

  const sideColor = side === 'A' ? '#3b82f6' : '#a855f7';

  return (
    <label
      style={{
        ...rowStyle,
        background: hovered || selected
          ? 'var(--color-bg, #f8fafc)'
          : '#fff',
        cursor: 'pointer',
        borderLeft: selected ? `3px solid ${sideColor}` : '3px solid transparent',
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <input
        type="radio"
        name={radioName}
        checked={selected}
        onChange={onSelect}
        style={{ marginRight: 8, flexShrink: 0, accentColor: sideColor }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={rowVersionStyle}>{versionLabel(entry.version)}</span>
          {entry.isDraft && (
            <span style={editableTagStyle}>(editable)</span>
          )}
        </div>
        {entry.description && (
          <div style={rowDescStyle}>{entry.description}</div>
        )}
        <div style={rowDateStyle}>{fmtDate(entry.updatedAt)}</div>
      </div>
    </label>
  );
}

export function VersionPickerStep({
  promptId,
  promptName,
  selectedVersionA,
  selectedVersionB,
  onSelectA,
  onSelectB,
  onEditFromA,
}: VersionPickerStepProps): React.ReactElement {
  const { versions, loading, error } = usePromptVersions(promptId);

  if (loading) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {[0, 1, 2].map((i) => (
          <div key={i} style={skeletonRowStyle} />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div style={errorBoxStyle}>
        <span style={{ fontSize: 12, color: 'var(--color-danger)' }}>{error}</span>
      </div>
    );
  }

  return (
    <div>
      <p style={stepDescStyle}>
        Pick the baseline (A) and challenger (B) versions for <strong>{promptName}</strong>.
      </p>

      <div style={columnsStyle}>
        {/* Left column — Baseline A */}
        <div style={columnStyle}>
          <div style={{ ...sectionHeaderStyle, color: '#3b82f6' }}>Baseline (A)</div>
          {versions.length === 0 ? (
            <div style={emptyStyle}>No versions found</div>
          ) : (
            <div style={listStyle}>
              {versions.map((v) => (
                <VersionRow
                  key={v.version}
                  entry={v}
                  selected={selectedVersionA === v.version}
                  onSelect={() => onSelectA(v.version)}
                  radioName="version-a"
                  side="A"
                />
              ))}
            </div>
          )}
        </div>

        {/* Divider */}
        <div style={dividerStyle} />

        {/* Right column — Challenger B */}
        <div style={columnStyle}>
          <div style={{ ...sectionHeaderStyle, color: '#a855f7' }}>Challenger (B)</div>
          {versions.length === 0 ? (
            <div style={emptyStyle}>No versions found</div>
          ) : (
            <div style={listStyle}>
              {versions.map((v) => (
                <VersionRow
                  key={v.version}
                  entry={v}
                  selected={selectedVersionB === v.version}
                  onSelect={() => onSelectB(v.version)}
                  radioName="version-b"
                  side="B"
                />
              ))}
            </div>
          )}
          {/* Edit from A option */}
          <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--color-border, #e2e8f0)' }}>
            <button
              type="button"
              onClick={onEditFromA}
              disabled={!selectedVersionA}
              style={selectedVersionA ? editBtnStyle : { ...editBtnStyle, opacity: 0.45, cursor: 'not-allowed' }}
              title={selectedVersionA ? 'Open editor to create a new version based on A' : 'Select a baseline (A) version first'}
            >
              Edit from A → publish new version
            </button>
            <div style={{ marginTop: 6, fontSize: 11, color: 'var(--color-text-tertiary, #94a3b8)', lineHeight: 1.4 }}>
              Opens an editor pre-filled with A's template. The new version is published and automatically used as B.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const stepDescStyle: CSSProperties = {
  fontSize: 13,
  color: 'var(--color-text-secondary, #475569)',
  margin: '0 0 20px',
  lineHeight: 1.5,
};

const columnsStyle: CSSProperties = {
  display: 'flex',
  gap: 0,
  alignItems: 'flex-start',
};

const columnStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  padding: '0 16px',
};

const dividerStyle: CSSProperties = {
  width: 1,
  alignSelf: 'stretch',
  background: 'var(--color-border, #e2e8f0)',
  flexShrink: 0,
};

const sectionHeaderStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  marginBottom: 10,
};

const listStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
};

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  padding: '8px 10px',
  borderRadius: 4,
  border: '1px solid transparent',
  transition: 'background 0.1s',
};

const rowVersionStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 500,
  color: 'var(--color-text-primary, #0f172a)',
};

const rowDescStyle: CSSProperties = {
  fontSize: 11,
  color: 'var(--color-text-secondary, #475569)',
  marginTop: 2,
  lineHeight: 1.4,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const rowDateStyle: CSSProperties = {
  fontSize: 10.5,
  color: 'var(--color-text-tertiary, #94a3b8)',
  marginTop: 2,
};

const editableTagStyle: CSSProperties = {
  fontSize: 10,
  color: 'var(--color-optimize)',
  background: '#ede9fe',
  padding: '1px 5px',
  borderRadius: 3,
  fontWeight: 500,
};

const skeletonRowStyle: CSSProperties = {
  height: 52,
  borderRadius: 4,
  background: 'var(--color-bg, #f8fafc)',
  border: '1px solid var(--color-border, #e2e8f0)',
};

const errorBoxStyle: CSSProperties = {
  padding: '10px 12px',
  background: 'var(--color-danger-bg)',
  border: '1px solid var(--color-danger-border)',
  borderRadius: 4,
};

const emptyStyle: CSSProperties = {
  fontSize: 12,
  color: 'var(--color-text-tertiary, #94a3b8)',
  fontStyle: 'italic',
  padding: '8px 0',
};

const editBtnStyle: CSSProperties = {
  width: '100%',
  padding: '8px 12px',
  fontSize: 12,
  fontWeight: 600,
  border: '1px solid var(--color-border, #e2e8f0)',
  borderRadius: 4,
  background: 'transparent',
  color: 'var(--color-text-secondary, #475569)',
  cursor: 'pointer',
  fontFamily: 'inherit',
  textAlign: 'left',
};
