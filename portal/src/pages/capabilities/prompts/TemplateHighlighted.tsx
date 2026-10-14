// Read-only template view: line numbers in a gutter, `{{variables}}` picked
// out in the accent colour.
//
// Not `CodeBlock` — the library highlighter has no notion of a mustache
// placeholder, and picking those out is the entire point of this view. The
// gutter and the code column share `leading-[1.7]`; changing one without the
// other slides the numbers off their lines. Queued in
// docs/ui-components-queue.md; the `<pre>`/`<span>` per-line markup below is
// the actual highlighting technique, not hand-rolled chrome, so it stays raw.

import { Inline, T } from '@connorhoehnslalom/ui-components/shared';

const LINE_CLASS = 'block min-h-[1.7em]';

function HighlightedLine({ line }: { line: string }) {
  const parts = line.split(/({{[^}]+}})/g);
  return (
    <>
      {parts.map((part, i) =>
        /^{{[^}]+}}$/.test(part)
          ? <T key={i} className="font-semibold text-[var(--color-optimize)]">{part}</T>
          : <span key={i}>{part}</span>,
      )}
    </>
  );
}

export function TemplateHighlighted({ text }: { text: string }) {
  const lines = text.split('\n');
  const gutterWidth = String(lines.length).length;

  return (
    <Inline gap="none" wrap={false} align="stretch" className="min-h-full">
      <div
        aria-hidden
        className="flex-none select-none border-r border-border bg-surface-inset py-5 pl-5 pr-3 text-right font-mono text-sm leading-[1.7] text-text-tertiary"
      >
        {lines.map((_, i) => (
          <T key={i} className={LINE_CLASS}>{String(i + 1).padStart(gutterWidth, ' ')}</T>
        ))}
      </div>
      <pre className="m-0 min-w-0 flex-1 whitespace-pre-wrap break-words px-6 py-5 font-mono text-sm leading-[1.7] text-text-primary">
        {lines.map((line, i) => (
          <span key={i} className={LINE_CLASS}><HighlightedLine line={line} /></span>
        ))}
      </pre>
    </Inline>
  );
}
