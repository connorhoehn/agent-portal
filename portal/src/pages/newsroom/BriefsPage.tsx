// TODO(N6): wire post-merge —
//   1. portal/src/App.tsx: under <Route path="newsroom">, add <Route path="briefs" element={<Page element={<BriefsPage />} />} />.
//      (The N2 NewsroomLayout already has 'briefs' in its sub-nav.)
//   2. agents/build-all.sh: add 'news-brief' to the AGENTS=(...) default list.
//   3. CDK redeploy with --context deployRuntimes=true to expose the runtime.

import type { CSSProperties, ChangeEvent, KeyboardEvent } from 'react';
import { useState, useCallback } from 'react';
import { PageSection, Card } from '@connorhoehnslalom/ui-components/shared';
import { Markdown } from '../../components/Markdown';
import { useAgUiStream } from '../../hooks/useAgUiStream';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function ToolCallBadge({ name, done }: { name: string; done: boolean }) {
  return (
    <span style={toolBadgeStyle(done)}>
      {done ? '✓' : '…'} {name}
    </span>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

function BriefsPage() {
  const [startDate, setStartDate] = useState<string>(todayIso());
  const [endDate, setEndDate]     = useState<string>(todayIso());
  const [beat, setBeat]           = useState<string>('');

  const { isStreaming, streamingText, activeToolCalls, error, sendMessage, reset } =
    useAgUiStream('/api/agents/news-brief/invoke');

  const handleGenerate = useCallback(() => {
    if (isStreaming) return;
    reset();
    const dateRange =
      startDate === endDate
        ? startDate
        : `${startDate} to ${endDate}`;
    const beatClause = beat.trim() ? ` on beat "${beat.trim()}"` : '';
    sendMessage(
      `Generate brief for ${dateRange}${beatClause}`,
      { selection: { peopleIds: [] } },
    );
  }, [isStreaming, startDate, endDate, beat, sendMessage, reset]);

  const hasOutput = isStreaming || streamingText.length > 0;

  return (
    <div style={{ padding: '24px 32px' }}>
    <PageSection title="Brief Synthesizer">
      {/* Controls */}
      <Card padding="md">
        <div style={controlsRowStyle}>
          {/* Date range */}
          <div style={fieldGroupStyle}>
            <label style={labelStyle} htmlFor="brief-start">From</label>
            <input
              id="brief-start"
              type="date"
              value={startDate}
              max={endDate}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setStartDate(e.target.value)}
              style={inputStyle}
            />
          </div>
          <div style={fieldGroupStyle}>
            <label style={labelStyle} htmlFor="brief-end">To</label>
            <input
              id="brief-end"
              type="date"
              value={endDate}
              min={startDate}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setEndDate(e.target.value)}
              style={inputStyle}
            />
          </div>

          {/* Beat / section */}
          <div style={{ ...fieldGroupStyle, flex: '1 1 180px' }}>
            <label style={labelStyle} htmlFor="brief-beat">Beat (optional)</label>
            <input
              id="brief-beat"
              type="text"
              placeholder="e.g. Tech, Business…"
              value={beat}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setBeat(e.target.value)}
              onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => { if (e.key === 'Enter') handleGenerate(); }}
              style={inputStyle}
            />
          </div>

          {/* Generate button */}
          <button
            type="button"
            onClick={handleGenerate}
            disabled={isStreaming}
            style={generateBtnStyle(isStreaming)}
          >
            {isStreaming ? 'Generating…' : 'Generate brief'}
          </button>
        </div>
      </Card>

      {/* Live tool calls */}
      {activeToolCalls.length > 0 && (
        <div style={toolCallRowStyle}>
          {activeToolCalls.map((tc) => (
            <span key={tc.id}>
              <ToolCallBadge name={tc.name} done={tc.done} />
            </span>
          ))}
        </div>
      )}

      {/* Error state */}
      {error && (
        <Card padding="md">
          <div style={errorStyle}>{error}</div>
        </Card>
      )}

      {/* Streaming / completed brief */}
      {hasOutput && (
        <Card padding="md">
          <div style={briefOutputStyle}>
            <Markdown>{streamingText}</Markdown>
            {isStreaming && <span style={cursorStyle} />}
          </div>
        </Card>
      )}

      {/* Empty state (before first generation) */}
      {!hasOutput && !error && (
        <Card padding="md">
          <div style={emptyStyle}>
            Select a date range and click "Generate brief" to synthesise a
            markdown brief from articles in the newsroom.
          </div>
        </Card>
      )}

      {/* Recent briefs placeholder */}
      <div style={sectionHeadStyle}>Recent briefs</div>
      <Card padding="md">
        <div style={emptyStyle}>
          No saved briefs yet — persistence will land in a future sprint.
        </div>
      </Card>
    </PageSection>
    </div>
  );
}

export default BriefsPage;

// ─── Styles ───────────────────────────────────────────────────────────────────

const controlsRowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'flex-end',
  gap: 12,
};

const fieldGroupStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  flex: '0 0 auto',
};

const labelStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  color: 'var(--color-text-secondary, #6b7280)',
};

const inputStyle: CSSProperties = {
  padding: '6px 10px',
  fontSize: 13,
  borderRadius: 6,
  border: '1px solid var(--color-border, #e5e7eb)',
  background: 'var(--color-surface, #fff)',
  color: 'var(--color-text, #111827)',
  outline: 'none',
  minWidth: 130,
};

function generateBtnStyle(disabled: boolean): CSSProperties {
  return {
    padding: '7px 18px',
    borderRadius: 6,
    border: 'none',
    background: disabled
      ? 'var(--color-text-tertiary, #9ca3af)'
      : 'var(--color-primary, #6366f1)',
    color: '#fff',
    fontSize: 13,
    fontWeight: 600,
    cursor: disabled ? 'not-allowed' : 'pointer',
    transition: 'background 0.15s',
    whiteSpace: 'nowrap',
    alignSelf: 'flex-end',
  };
}

const toolCallRowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 8,
  padding: '4px 0',
};

function toolBadgeStyle(done: boolean): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    padding: '3px 10px',
    borderRadius: 9999,
    fontSize: 11,
    fontWeight: 500,
    background: done
      ? 'var(--color-success-subtle, #dcfce7)'
      : 'var(--color-accent-subtle, #eff6ff)',
    color: done
      ? 'var(--color-success, #166534)'
      : 'var(--color-accent, #2563eb)',
    border: `1px solid ${done ? 'var(--color-success-border, #bbf7d0)' : 'var(--color-accent-border, #bfdbfe)'}`,
  };
}

const briefOutputStyle: CSSProperties = {
  position: 'relative',
};

const cursorStyle: CSSProperties = {
  display: 'inline-block',
  width: 2,
  height: '1.1em',
  background: 'var(--color-text, #111827)',
  verticalAlign: 'text-bottom',
  marginLeft: 2,
  animation: 'blink 1s step-start infinite',
};

const errorStyle: CSSProperties = {
  color: 'var(--color-error, #dc2626)',
  fontSize: 13,
};

const emptyStyle: CSSProperties = {
  padding: '8px 0',
  color: 'var(--color-text-tertiary, #9ca3af)',
  fontSize: 13,
  fontStyle: 'italic',
};

const sectionHeadStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: 'var(--color-text-secondary, #6b7280)',
  marginTop: 8,
  marginBottom: 4,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
};
