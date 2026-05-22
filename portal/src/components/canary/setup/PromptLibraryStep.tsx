// PromptLibraryStep — Step 1 of the canary setup wizard.
// Lets the user pick which Bedrock prompt they want to experiment with.

import { useState, useId } from 'react';
import type { CSSProperties } from 'react';
import { usePromptList } from '../usePromptLibrary.js';
import type { PromptLibraryEntry } from '../types.js';

export interface PromptLibraryStepProps {
  onSelect: (entry: PromptLibraryEntry) => void;
  selected: PromptLibraryEntry | null;
}

function relativeTime(iso: string): string {
  const now = Date.now();
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const diffMs = now - then;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} minute${diffMin === 1 ? '' : 's'} ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr} hour${diffHr === 1 ? '' : 's'} ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay} day${diffDay === 1 ? '' : 's'} ago`;
  const diffMo = Math.floor(diffDay / 30);
  return `${diffMo} month${diffMo === 1 ? '' : 's'} ago`;
}

const is503 = (err: string | null): boolean =>
  err !== null && (err.includes('503') || err.toLowerCase().includes('unavailable'));

export function PromptLibraryStep({ onSelect, selected }: PromptLibraryStepProps): React.ReactElement {
  const { prompts, loading, error, refresh } = usePromptList();
  const [search, setSearch] = useState('');
  const [manualArn, setManualArn] = useState('');
  const manualArnId = useId();

  const filtered = prompts.filter((p) =>
    p.name.toLowerCase().includes(search.toLowerCase()),
  );

  const bedrock503 = is503(error);

  return (
    <div>
      <p style={stepDescStyle}>
        Choose a prompt from your Bedrock Prompt Library to run a canary experiment on.
      </p>

      {/* Search */}
      <input
        type="text"
        placeholder="Search prompts…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        style={searchInputStyle}
        aria-label="Search prompts"
      />

      {/* Loading state */}
      {loading && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
          {[0, 1, 2].map((i) => (
            <div key={i} style={skeletonRowStyle} />
          ))}
        </div>
      )}

      {/* Error state */}
      {!loading && error && !bedrock503 && (
        <div style={errorBoxStyle}>
          <span style={{ fontSize: 12, color: '#991b1b' }}>{error}</span>
          <button type="button" onClick={refresh} style={retryBtnStyle}>
            Retry
          </button>
        </div>
      )}

      {/* 503 / credentials unavailable */}
      {!loading && bedrock503 && (
        <div style={warningBoxStyle}>
          <p style={warningTitleStyle}>
            Bedrock Prompt Library unavailable — check AWS credentials
          </p>
          <p style={{ margin: '0 0 10px', fontSize: 12, color: '#92400e', lineHeight: 1.5 }}>
            Cannot reach the Bedrock API. You can enter a prompt ARN directly to continue.
          </p>
          <label htmlFor={manualArnId} style={labelStyle}>Enter ARN directly</label>
          <input
            id={manualArnId}
            type="text"
            placeholder="arn:aws:bedrock:us-east-1:123456789012:prompt/ABCDEFGHIJ"
            value={manualArn}
            onChange={(e) => setManualArn(e.target.value)}
            style={{ ...searchInputStyle, marginTop: 4 }}
          />
          {manualArn.trim() && (
            <button
              type="button"
              style={{ ...primaryBtnStyle, marginTop: 8 }}
              onClick={() => {
                const arn = manualArn.trim();
                // Synthesize a minimal entry from the ARN
                const parts = arn.split('/');
                const id = parts[parts.length - 1] ?? arn;
                onSelect({
                  id,
                  arn,
                  name: arn,
                  version: 'DRAFT',
                  updatedAt: new Date().toISOString(),
                });
              }}
            >
              Use this ARN
            </button>
          )}
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && filtered.length === 0 && (
        <div style={emptyStyle}>No prompts found in your Bedrock library</div>
      )}

      {/* Prompt list */}
      {!loading && !error && filtered.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
          {filtered.map((entry) => {
            const isSelected = selected?.id === entry.id;
            return (
              <div
                key={entry.id}
                style={{
                  ...cardStyle,
                  border: isSelected
                    ? '2px solid var(--color-primary, #6366f1)'
                    : '1px solid var(--color-border, #e2e8f0)',
                  background: isSelected ? '#f5f3ff' : '#fff',
                  cursor: 'pointer',
                }}
                onClick={() => onSelect(entry)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') onSelect(entry);
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                  <span style={cardNameStyle}>{entry.name}</span>
                  <span style={cardMetaStyle}>{relativeTime(entry.updatedAt)}</span>
                </div>
                {entry.description && (
                  <div style={cardDescStyle}>{entry.description}</div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const stepDescStyle: CSSProperties = {
  fontSize: 13,
  color: 'var(--color-text-secondary, #475569)',
  margin: '0 0 16px',
  lineHeight: 1.5,
};

const searchInputStyle: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '7px 10px',
  fontSize: 13,
  border: '1px solid var(--color-border, #e2e8f0)',
  borderRadius: 4,
  outline: 'none',
  fontFamily: 'inherit',
  background: 'var(--color-bg, #f8fafc)',
};

const skeletonRowStyle: CSSProperties = {
  height: 60,
  borderRadius: 4,
  background: 'var(--color-bg, #f8fafc)',
  border: '1px solid var(--color-border, #e2e8f0)',
  animation: 'pulse 1.5s ease-in-out infinite',
};

const errorBoxStyle: CSSProperties = {
  marginTop: 12,
  padding: '10px 12px',
  background: '#fee2e2',
  border: '1px solid #fca5a5',
  borderRadius: 4,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
};

const warningBoxStyle: CSSProperties = {
  marginTop: 12,
  padding: '12px 14px',
  background: '#fef3c7',
  border: '1px solid #fcd34d',
  borderRadius: 4,
};

const warningTitleStyle: CSSProperties = {
  margin: '0 0 6px',
  fontSize: 12,
  fontWeight: 600,
  color: '#92400e',
};

const retryBtnStyle: CSSProperties = {
  padding: '4px 10px',
  fontSize: 12,
  border: '1px solid #dc2626',
  borderRadius: 4,
  background: 'transparent',
  color: '#dc2626',
  cursor: 'pointer',
  flexShrink: 0,
  fontFamily: 'inherit',
};

const emptyStyle: CSSProperties = {
  marginTop: 24,
  textAlign: 'center',
  fontSize: 13,
  color: 'var(--color-text-tertiary, #94a3b8)',
  fontStyle: 'italic',
};

const cardStyle: CSSProperties = {
  padding: '10px 14px',
  borderRadius: 6,
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};

const cardNameStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: 'var(--color-text-primary, #0f172a)',
  flex: 1,
  minWidth: 0,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

const cardDescStyle: CSSProperties = {
  fontSize: 12,
  color: 'var(--color-text-tertiary, #94a3b8)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  display: '-webkit-box',
  WebkitLineClamp: 1,
  WebkitBoxOrient: 'vertical',
};

const cardMetaStyle: CSSProperties = {
  fontSize: 11,
  color: 'var(--color-text-tertiary, #94a3b8)',
  whiteSpace: 'nowrap',
  flexShrink: 0,
};

const labelStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: '#92400e',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  display: 'block',
};

const primaryBtnStyle: CSSProperties = {
  padding: '8px 16px',
  fontSize: 13,
  fontWeight: 600,
  border: 'none',
  borderRadius: 4,
  background: 'var(--color-primary, #6366f1)',
  color: '#fff',
  cursor: 'pointer',
  fontFamily: 'inherit',
};
