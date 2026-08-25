import type { CSSProperties } from 'react';
import { useState, useRef, useCallback } from 'react';
import { PageSection, Card, Spinner } from '@connorhoehnslalom/ui-components/shared';

// ─── Types ────────────────────────────────────────────────────────────────────

interface HeadlineVariant {
  variant: string;
  angle: string;
  clarity: number;
  engagement: number;
  seo: number;
  rationale: string;
}

// ─── Score bar ────────────────────────────────────────────────────────────────

function ScoreBar({ value }: { value: number }) {
  const pct = Math.min(Math.max(value / 10, 0), 1) * 100;
  const color =
    pct >= 70 ? '#22c55e' : pct >= 40 ? '#f59e0b' : '#ef4444';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <div
        style={{
          flex: 1,
          height: 6,
          borderRadius: 3,
          background: 'var(--color-border, #e5e7eb)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: '100%',
            background: color,
            borderRadius: 3,
            transition: 'width 0.4s ease',
          }}
        />
      </div>
      <span
        style={{
          fontSize: 11,
          fontWeight: 600,
          color,
          minWidth: 18,
          textAlign: 'right',
        }}
      >
        {value}
      </span>
    </div>
  );
}

// ─── Angle badge ──────────────────────────────────────────────────────────────

const ANGLE_COLORS: Record<string, { bg: string; text: string }> = {
  DESCRIPTIVE:  { bg: '#dbeafe', text: '#1e40af' },
  QUESTION:     { bg: '#fef9c3', text: '#854d0e' },
  SURPRISE:     { bg: '#fce7f3', text: '#9d174d' },
  'LIST-FORMAT':{ bg: '#dcfce7', text: '#166534' },
  'QUOTE-STYLE':{ bg: '#ede9fe', text: 'var(--color-optimize-hover)' },
};

function AngleBadge({ angle }: { angle: string }) {
  const norm = angle.toUpperCase();
  const colors = ANGLE_COLORS[norm] ?? { bg: '#f3f4f6', text: '#374151' };
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: 9999,
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: '0.04em',
        background: colors.bg,
        color: colors.text,
        textTransform: 'uppercase',
        whiteSpace: 'nowrap',
      }}
    >
      {norm}
    </span>
  );
}

// ─── Results table ────────────────────────────────────────────────────────────

function VariantsTable({ variants }: { variants: HeadlineVariant[] }) {
  const sorted = [...variants].sort(
    (a, b) => b.clarity + b.engagement + b.seo - (a.clarity + a.engagement + a.seo),
  );

  return (
    <div style={tableWrapStyle}>
      <table style={tableStyle}>
        <thead>
          <tr style={theadRowStyle}>
            {['Rank', 'Variant', 'Angle', 'Clarity', 'Engagement', 'SEO', 'Total', 'Rationale'].map(
              (col) => (
                <th
                  key={col}
                  style={{
                    ...thStyle,
                    textAlign: ['Rank', 'Clarity', 'Engagement', 'SEO', 'Total'].includes(col)
                      ? 'center'
                      : 'left',
                    width: col === 'Rationale' ? '28%' : undefined,
                  }}
                >
                  {col}
                </th>
              ),
            )}
          </tr>
        </thead>
        <tbody>
          {sorted.map((v, idx) => {
            const total = v.clarity + v.engagement + v.seo;
            return (
              <tr
                key={idx}
                style={{
                  borderBottom:
                    idx < sorted.length - 1
                      ? '1px solid var(--color-border, #e5e7eb)'
                      : 'none',
                  background: idx === 0 ? 'var(--color-accent-subtle, #eff6ff)' : undefined,
                }}
              >
                <td style={{ ...tdStyle, textAlign: 'center', fontWeight: 700, fontSize: 13 }}>
                  {idx === 0 ? '★' : idx + 1}
                </td>
                <td style={{ ...tdStyle, fontWeight: 500, fontSize: 14, maxWidth: 280 }}>
                  {v.variant}
                </td>
                <td style={{ ...tdStyle, whiteSpace: 'nowrap' }}>
                  <AngleBadge angle={v.angle} />
                </td>
                <td style={{ ...tdStyle, minWidth: 90 }}>
                  <ScoreBar value={v.clarity} />
                </td>
                <td style={{ ...tdStyle, minWidth: 90 }}>
                  <ScoreBar value={v.engagement} />
                </td>
                <td style={{ ...tdStyle, minWidth: 90 }}>
                  <ScoreBar value={v.seo} />
                </td>
                <td
                  style={{
                    ...tdStyle,
                    textAlign: 'center',
                    fontWeight: 700,
                    fontSize: 14,
                    color:
                      total >= 24
                        ? '#16a34a'
                        : total >= 18
                        ? '#d97706'
                        : '#dc2626',
                  }}
                >
                  {total}
                </td>
                <td
                  style={{
                    ...tdStyle,
                    fontSize: 12,
                    color: 'var(--color-text-secondary, #6b7280)',
                    fontStyle: 'italic',
                    maxWidth: 260,
                  }}
                >
                  {v.rationale}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

function HeadlinesPage() {
  const [headline, setHeadline] = useState('');
  const [lede, setLede] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [variants, setVariants] = useState<HeadlineVariant[] | null>(null);
  const [rawResponse, setRawResponse] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const handleGenerate = useCallback(async () => {
    if (!headline.trim()) return;

    setIsStreaming(true);
    setVariants(null);
    setRawResponse(null);
    setError(null);

    const message = `Original headline: ${headline}\n\nLede: ${lede}\n\nGenerate 5 variants.`;
    const controller = new AbortController();
    abortRef.current = controller;

    let accumulated = '';

    try {
      const res = await fetch('/api/agents/orgiq-news-headline/invoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        throw new Error(`Request failed: ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const event = JSON.parse(line.slice(6)) as Record<string, unknown>;
            if (event.type === 'TEXT_MESSAGE_CONTENT' && typeof event.delta === 'string') {
              accumulated += event.delta;
            }
          } catch {
            // skip malformed SSE lines
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setError(err instanceof Error ? err.message : 'Stream error');
      }
      return;
    } finally {
      setIsStreaming(false);
      abortRef.current = null;
    }

    // Try to parse as JSON; fall back to raw display
    const trimmed = accumulated.trim();
    // Strip any accidental markdown fence wrapping
    const jsonText = trimmed.startsWith('```')
      ? trimmed.replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '').trim()
      : trimmed;

    try {
      const parsed = JSON.parse(jsonText) as unknown;
      if (Array.isArray(parsed) && parsed.length > 0) {
        setVariants(parsed as HeadlineVariant[]);
      } else {
        setRawResponse(accumulated);
      }
    } catch {
      setRawResponse(accumulated || '(no response)');
    }
  }, [headline, lede]);

  const canGenerate = headline.trim().length > 0 && !isStreaming;

  return (
    <div style={{ padding: '24px 32px' }}>
    <PageSection title="Headline Optimizer">
      <p style={subtitleStyle}>
        Enter a draft headline and first paragraph to get 5 scored alternatives.
      </p>

      {/* Input form */}
      <Card padding="md">
        <div style={formStyle}>
          <label style={labelStyle} htmlFor="hl-headline">
            Headline
          </label>
          <input
            id="hl-headline"
            type="text"
            value={headline}
            onChange={(e) => setHeadline(e.target.value)}
            placeholder="e.g. Tech giant announces surprise layoffs"
            disabled={isStreaming}
            style={inputStyle}
          />

          <label style={labelStyle} htmlFor="hl-lede">
            Lede (first paragraph)
          </label>
          <textarea
            id="hl-lede"
            value={lede}
            onChange={(e) => setLede(e.target.value)}
            placeholder="Paste or type the opening paragraph of the article…"
            disabled={isStreaming}
            rows={4}
            style={textareaStyle}
          />

          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button
              type="button"
              onClick={handleGenerate}
              disabled={!canGenerate}
              style={{
                ...btnStyle,
                opacity: canGenerate ? 1 : 0.45,
                cursor: canGenerate ? 'pointer' : 'not-allowed',
              }}
            >
              Generate variants
            </button>
            {isStreaming && <Spinner size="md" />}
            {isStreaming && (
              <span style={{ fontSize: 13, color: 'var(--color-text-secondary, #6b7280)' }}>
                Generating…
              </span>
            )}
          </div>
        </div>
      </Card>

      {/* Error state */}
      {error && (
        <Card padding="md">
          <p style={{ color: 'var(--color-error, #dc2626)', fontSize: 13, margin: 0 }}>
            {error}
          </p>
        </Card>
      )}

      {/* Parsed results */}
      {variants && variants.length > 0 && (
        <>
          <h3 style={sectionHeadStyle}>Ranked variants</h3>
          <VariantsTable variants={variants} />
        </>
      )}

      {/* Fallback raw response */}
      {rawResponse && !variants && (
        <>
          <h3 style={sectionHeadStyle}>Agent response</h3>
          <Card padding="md">
            <pre style={rawStyle}>{rawResponse}</pre>
          </Card>
        </>
      )}

    </PageSection>
    </div>
  );
}

export default HeadlinesPage;

// ─── Styles ───────────────────────────────────────────────────────────────────

const subtitleStyle: CSSProperties = {
  fontSize: 13,
  color: 'var(--color-text-secondary, #6b7280)',
  marginBottom: 20,
  marginTop: 0,
};

const formStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
};

const labelStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: 'var(--color-text-secondary, #6b7280)',
  marginBottom: 2,
};

const inputStyle: CSSProperties = {
  padding: '8px 12px',
  borderRadius: 8,
  border: '1px solid var(--color-border, #e5e7eb)',
  fontSize: 14,
  background: 'var(--color-surface, #fff)',
  color: 'var(--color-text, #111827)',
  outline: 'none',
  width: '100%',
  boxSizing: 'border-box',
};

const textareaStyle: CSSProperties = {
  ...inputStyle,
  resize: 'vertical',
  fontFamily: 'inherit',
  lineHeight: 1.5,
};

const btnStyle: CSSProperties = {
  padding: '8px 20px',
  borderRadius: 8,
  border: 'none',
  background: 'var(--color-primary, #6366f1)',
  color: '#fff',
  fontSize: 14,
  fontWeight: 600,
  transition: 'opacity 0.15s',
};

const sectionHeadStyle: CSSProperties = {
  fontSize: 15,
  fontWeight: 600,
  color: 'var(--color-text, #111827)',
  margin: '24px 0 12px',
};

const tableWrapStyle: CSSProperties = {
  background: 'var(--color-surface, #fff)',
  border: '1px solid var(--color-border, #e5e7eb)',
  borderRadius: 10,
  overflow: 'auto',
};

const tableStyle: CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  minWidth: 860,
};

const theadRowStyle: CSSProperties = {
  background: 'var(--color-surface-raised, #f9fafb)',
  borderBottom: '1px solid var(--color-border, #e5e7eb)',
};

const thStyle: CSSProperties = {
  padding: '10px 14px',
  fontSize: 11,
  fontWeight: 600,
  color: 'var(--color-text-secondary, #6b7280)',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  whiteSpace: 'nowrap',
};

const tdStyle: CSSProperties = {
  padding: '12px 14px',
  verticalAlign: 'middle',
};

const rawStyle: CSSProperties = {
  fontSize: 13,
  lineHeight: 1.6,
  color: 'var(--color-text, #111827)',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  margin: 0,
  fontFamily: 'inherit',
};
