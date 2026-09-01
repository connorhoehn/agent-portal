import { useRef } from 'react';

/**
 * Editable template with a line-number gutter.
 *
 * Not `<Textarea>`: the gutter has to share the textarea's exact font metrics
 * and scroll position, and a library textarea owns its own padding. The three
 * metrics that must agree between the two columns — font, size, line-height —
 * are in `EDITOR_METRICS`; the gutter's scrollTop is synced by hand because a
 * textarea gives no scroll-linked styling hook.
 *
 * WANTED IN ui-components: a `CodeEditor`-lite / `Textarea showLineNumbers`.
 * `CodeEditor` exists on the root entry but is a full editor surface, and
 * `CodeBlock showLineNumbers` is read-only.
 */
const EDITOR_METRICS = 'font-mono text-[12px] leading-[1.6]';

export function LineNumberedTextarea({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const gutterRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const lineCount = Math.max(value.split('\n').length, 1);
  const gutterWidth = String(lineCount).length;

  function syncScroll() {
    if (gutterRef.current && textareaRef.current) {
      gutterRef.current.scrollTop = textareaRef.current.scrollTop;
    }
  }

  return (
    <div className="flex min-h-[200px] flex-1 overflow-hidden rounded border border-border bg-surface">
      <div
        ref={gutterRef}
        aria-hidden
        // Scrollbar hidden on purpose — scrollTop is driven from the textarea.
        className={`flex-none select-none overflow-hidden border-r border-border bg-surface-panel p-3 pr-2.5 text-right text-text-tertiary ${EDITOR_METRICS}`}
      >
        {Array.from({ length: lineCount }, (_, i) => (
          <span key={i} className="block whitespace-pre">
            {String(i + 1).padStart(gutterWidth, ' ')}
          </span>
        ))}
      </div>
      <textarea
        ref={textareaRef}
        value={value}
        onChange={e => onChange(e.target.value)}
        onScroll={syncScroll}
        placeholder={placeholder}
        spellCheck={false}
        aria-label="Prompt template"
        className={`min-w-0 flex-1 resize-none border-none bg-surface p-3 text-text-primary outline-none ${EDITOR_METRICS}`}
      />
    </div>
  );
}
