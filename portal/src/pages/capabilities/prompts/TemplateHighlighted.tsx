// Read-only template view: line numbers in a gutter, `{{variables}}` picked
// out in the accent colour.
//
// Not `CodeBlock` — the library highlighter has no notion of a mustache
// placeholder, and picking those out is the entire point of this view. The
// gutter and the code column share `leading-[1.7]`; changing one without the
// other slides the numbers off their lines.

const LINE_CLASS = 'block min-h-[1.7em]';

function HighlightedLine({ line }: { line: string }) {
  const parts = line.split(/({{[^}]+}})/g);
  return (
    <>
      {parts.map((part, i) =>
        /^{{[^}]+}}$/.test(part)
          ? <span key={i} className="font-semibold text-[var(--color-optimize)]">{part}</span>
          : <span key={i}>{part}</span>,
      )}
    </>
  );
}

export function TemplateHighlighted({ text }: { text: string }) {
  const lines = text.split('\n');
  const gutterWidth = String(lines.length).length;

  return (
    <div className="flex min-h-full items-stretch">
      <div
        aria-hidden
        className="flex-none select-none border-r border-border bg-surface-inset py-5 pl-5 pr-3 text-right font-mono text-[13px] leading-[1.7] text-text-tertiary"
      >
        {lines.map((_, i) => (
          <span key={i} className={LINE_CLASS}>{String(i + 1).padStart(gutterWidth, ' ')}</span>
        ))}
      </div>
      <pre className="m-0 min-w-0 flex-1 whitespace-pre-wrap break-words px-6 py-5 font-mono text-[13px] leading-[1.7] text-text-primary">
        {lines.map((line, i) => (
          <span key={i} className={LINE_CLASS}><HighlightedLine line={line} /></span>
        ))}
      </pre>
    </div>
  );
}
