// TODO(N4): wire post-merge —
//   1. middleware/src/index.ts: import + mount newsroomBeatsRouter at /api/newsroom/beats.
//      Mount BEFORE /api/newsroom (whichever order N3 uses) so /beats doesn't get swallowed.
//   2. portal/src/App.tsx: add child route under <Route path="newsroom">:
//      <Route path="beats" element={<Page element={<BeatsPage />} />} />

import type { CSSProperties } from 'react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { PageSection } from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';

// ── API response types ────────────────────────────────────────────────────────

interface BeatHeatmapResponse {
  beats: string[];
  /** ISO date strings YYYY-MM-DD, ascending */
  days: string[];
  /** matrix[beatIdx][dayIdx] = article count */
  matrix: number[][];
}

// ── Day-range options ─────────────────────────────────────────────────────────

const RANGE_OPTIONS = [
  { label: '7d',  days: 7  },
  { label: '14d', days: 14 },
  { label: '30d', days: 30 },
] as const;

// ── Cell styling ──────────────────────────────────────────────────────────────

function cellStyle(count: number, max: number): CSSProperties {
  const intensity = max === 0 ? 0 : count / max;
  return {
    width: 28,
    height: 28,
    background: count === 0 ? 'transparent' : `rgba(99, 102, 241, ${0.15 + intensity * 0.85})`,
    border: '1px solid var(--color-border)',
    fontSize: 10,
    color:
      count === 0
        ? 'var(--color-text-tertiary)'
        : intensity > 0.5
        ? '#fff'
        : 'var(--color-text-primary)',
    textAlign: 'center',
    lineHeight: '28px',
    cursor: count > 0 ? 'pointer' : 'default',
  };
}

// ── Format a YYYY-MM-DD string as MM/DD ───────────────────────────────────────

function fmtDay(iso: string): string {
  // Avoid timezone shifts by parsing as UTC.
  const parts = iso.split('-');
  if (parts.length !== 3) return iso;
  return `${parts[1]}/${parts[2]}`;
}

// ── Range picker ──────────────────────────────────────────────────────────────

function RangePicker({
  value,
  onChange,
}: {
  value: number;
  onChange: (i: number) => void;
}) {
  return (
    <div style={{ display: 'inline-flex', gap: 4 }}>
      {RANGE_OPTIONS.map((opt, i) => (
        <button
          key={opt.label}
          onClick={() => onChange(i)}
          style={{
            fontSize: 11,
            padding: '4px 10px',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-sm)',
            background: i === value ? 'var(--color-primary)' : 'var(--color-surface)',
            color: i === value ? 'white' : 'var(--color-text-secondary)',
            cursor: 'pointer',
            fontWeight: i === value ? 500 : 400,
          }}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

function BeatsPage() {
  const navigate = useNavigate();
  const [rangeIdx, setRangeIdx] = useState(1); // default 14d
  const range = RANGE_OPTIONS[rangeIdx]!;

  const { data, isLoading, error } = useFetch<BeatHeatmapResponse>(
    `/api/newsroom/beats/coverage?days=${range.days}`,
  );

  // Compute max count for intensity scaling.
  const maxCount =
    data && data.matrix.length > 0
      ? Math.max(...data.matrix.flatMap((row) => row))
      : 0;

  const isEmpty =
    !isLoading &&
    !error &&
    (data == null || data.beats.length === 0);

  return (
    <PageSection
      title="Beat Coverage"
      actions={<RangePicker value={rangeIdx} onChange={setRangeIdx} />}
    >
      {/* Loading */}
      {isLoading && (
        <div style={feedbackStyle}>Loading coverage data…</div>
      )}

      {/* Error */}
      {!isLoading && error && (
        <div style={feedbackStyle}>
          Could not load coverage data — the backend may not be wired yet.
        </div>
      )}

      {/* Empty state */}
      {isEmpty && (
        <div style={emptyStyle}>
          No coverage data yet — articles haven&apos;t been ingested.
        </div>
      )}

      {/* Heatmap */}
      {!isLoading && !error && data && data.beats.length > 0 && (
        <div style={tableWrapStyle}>
          <table style={tableStyle} cellSpacing={0} cellPadding={0}>
            <thead>
              <tr>
                {/* Beat label column header */}
                <th style={beatHeaderStyle} />
                {data.days.map((d) => (
                  <th key={d} style={dayHeaderStyle} title={d}>
                    {fmtDay(d)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.beats.map((beat, bi) => (
                <tr key={beat}>
                  <td style={beatLabelStyle} title={beat}>
                    {beat}
                  </td>
                  {data.days.map((day, di) => {
                    const count = data.matrix[bi]?.[di] ?? 0;
                    return (
                      <td
                        key={day}
                        style={cellStyle(count, maxCount)}
                        title={`${beat} on ${day}: ${count} article${count !== 1 ? 's' : ''}`}
                        onClick={() => {
                          if (count > 0) {
                            void navigate(
                              `/newsroom/articles?section=${encodeURIComponent(beat)}&since=${day}`,
                            );
                          }
                        }}
                      >
                        {count > 0 ? count : ''}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </PageSection>
  );
}

export default BeatsPage;

// ── Styles ────────────────────────────────────────────────────────────────────

const feedbackStyle: CSSProperties = {
  fontSize: 13,
  color: 'var(--color-text-secondary)',
  padding: '12px 0',
};

const emptyStyle: CSSProperties = {
  fontSize: 13,
  color: 'var(--color-text-tertiary)',
  padding: '40px 0',
  textAlign: 'center',
};

const tableWrapStyle: CSSProperties = {
  overflowX: 'auto',
};

const tableStyle: CSSProperties = {
  borderCollapse: 'separate',
  borderSpacing: 2,
};

const beatHeaderStyle: CSSProperties = {
  width: 140,
  minWidth: 100,
};

const dayHeaderStyle: CSSProperties = {
  width: 28,
  fontSize: 10,
  fontWeight: 500,
  color: 'var(--color-text-secondary)',
  textAlign: 'center',
  paddingBottom: 4,
  whiteSpace: 'nowrap',
};

const beatLabelStyle: CSSProperties = {
  paddingRight: 8,
  fontSize: 12,
  color: 'var(--color-text-primary)',
  whiteSpace: 'nowrap',
  maxWidth: 160,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  verticalAlign: 'middle',
};
