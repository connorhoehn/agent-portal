import type { CSSProperties } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// Read-only markdown renderer for assistant responses, crawl summaries, and
// any other LLM-produced text. Styling matches the rest of the portal —
// modest headings (not page-dominating), tight spacing, code-blocks with the
// same surface tone as Card.

interface MarkdownProps {
  children: string;
  /** Tweak the base font size (default 14, matching MessageContent). */
  size?: number;
}

export function Markdown({ children, size = 14 }: MarkdownProps) {
  return (
    <div style={{ ...root, fontSize: size }}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ node, ...p }) => <h3 style={h1} {...p} />,
          h2: ({ node, ...p }) => <h4 style={h2} {...p} />,
          h3: ({ node, ...p }) => <h5 style={h3} {...p} />,
          h4: ({ node, ...p }) => <h6 style={h4} {...p} />,
          p:  ({ node, ...p }) => <p  style={para} {...p} />,
          ul: ({ node, ...p }) => <ul style={list} {...p} />,
          ol: ({ node, ...p }) => <ol style={list} {...p} />,
          li: ({ node, ...p }) => <li style={li}   {...p} />,
          a:  ({ node, ...p }) => <a  style={link} target="_blank" rel="noreferrer" {...p} />,
          code: ({ node, className, children, ...p }) => {
            const inline = !className?.startsWith('language-');
            return inline ? (
              <code style={inlineCode} {...p}>{children}</code>
            ) : (
              <code className={className} style={blockCodeInner} {...p}>{children}</code>
            );
          },
          pre:        ({ node, ...p }) => <pre   style={pre}   {...p} />,
          blockquote: ({ node, ...p }) => <blockquote style={quote} {...p} />,
          table:      ({ node, ...p }) => <div style={tableWrap}><table style={table} {...p} /></div>,
          th:         ({ node, ...p }) => <th    style={th}    {...p} />,
          td:         ({ node, ...p }) => <td    style={td}    {...p} />,
          hr:         () => <hr style={hr} />,
          strong:     ({ node, ...p }) => <strong style={strong} {...p} />,
          em:         ({ node, ...p }) => <em     style={em}     {...p} />,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

// ── styles ────────────────────────────────────────────────────────────────────

const root: CSSProperties = { lineHeight: 1.6, color: 'var(--color-text-primary)' };
const h1: CSSProperties = { fontSize: 17, fontWeight: 700, margin: '14px 0 6px' };
const h2: CSSProperties = { fontSize: 15, fontWeight: 700, margin: '12px 0 6px' };
const h3: CSSProperties = { fontSize: 14, fontWeight: 600, margin: '10px 0 4px' };
const h4: CSSProperties = { fontSize: 13, fontWeight: 600, margin: '8px 0 4px',  color: 'var(--color-text-secondary)' };
const para: CSSProperties = { margin: '6px 0' };
const list: CSSProperties = { margin: '6px 0 6px 22px', padding: 0 };
const li: CSSProperties = { margin: '2px 0' };
const link: CSSProperties = { color: 'var(--color-primary)', textDecoration: 'underline' };
const strong: CSSProperties = { fontWeight: 600 };
const em: CSSProperties = { fontStyle: 'italic' };
const inlineCode: CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: '0.9em',
  background: 'var(--color-surface-hover)',
  padding: '1px 5px',
  borderRadius: 4,
  border: '1px solid var(--color-border)',
};
const pre: CSSProperties = {
  margin: '8px 0',
  padding: 12,
  background: 'var(--color-surface-hover)',
  border: '1px solid var(--color-border)',
  borderRadius: 6,
  overflow: 'auto',
  fontSize: '0.9em',
};
const blockCodeInner: CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
};
const quote: CSSProperties = {
  margin: '8px 0',
  padding: '4px 12px',
  borderLeft: '3px solid var(--color-border)',
  color: 'var(--color-text-secondary)',
};
const tableWrap: CSSProperties = { overflowX: 'auto', margin: '8px 0' };
const table: CSSProperties = {
  borderCollapse: 'collapse',
  fontSize: '0.95em',
};
const th: CSSProperties = {
  padding: '4px 10px',
  borderBottom: '1px solid var(--color-border)',
  textAlign: 'left',
  fontWeight: 600,
  background: 'var(--color-surface-hover)',
};
const td: CSSProperties = {
  padding: '4px 10px',
  borderBottom: '1px solid var(--color-border)',
};
const hr: CSSProperties = { border: 0, borderTop: '1px solid var(--color-border)', margin: '12px 0' };
