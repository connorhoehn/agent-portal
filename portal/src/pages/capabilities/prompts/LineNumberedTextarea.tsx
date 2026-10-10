import { useEffect, useRef } from 'react';
import { Stack, Textarea, T } from '@connorhoehnslalom/ui-components/shared';

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
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  /** Take focus on mount — the editor is what a person came to type in. */
  autoFocus?: boolean;
}) {
  const gutterRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // The panel that renders this REPLACES the button that opened it, so the
  // browser drops focus to <body> on mount unless something claims it.
  useEffect(() => {
    if (autoFocus) textareaRef.current?.focus();
  }, [autoFocus]);

  const lineCount = Math.max(value.split('\n').length, 1);
  const gutterWidth = String(lineCount).length;

  function syncScroll() {
    if (gutterRef.current && textareaRef.current) {
      gutterRef.current.scrollTop = textareaRef.current.scrollTop;
    }
  }

  return (
    <Stack gap="none" className="min-h-[200px] flex-1 overflow-hidden rounded border border-border bg-surface">
      {/* Raw div, not `Stack`: needs a real DOM ref to sync scrollTop from the
          textarea below (see docs/ui-components-queue.md, the `Stack`/`Card`/
          `Inline` ref row). */}
      <Stack
        gap="none"
        ref={gutterRef}
        aria-hidden
        // Scrollbar hidden on purpose — scrollTop is driven from the textarea.
        className={`flex-none select-none overflow-hidden border-r border-border bg-surface-panel p-3 pr-2.5 text-right text-text-tertiary ${EDITOR_METRICS}`}
      >
        {Array.from({ length: lineCount }, (_, i) => (
          <T key={i} className="block whitespace-pre">
            {String(i + 1).padStart(gutterWidth, ' ')}
          </T>
        ))}
      </Stack>
      {/* Textarea is forwardRef'd, so the scroll-sync driver can hold it. */}
      <Textarea
        ref={textareaRef}
        value={value}
        onChange={e => onChange(e.target.value)}
        onScroll={syncScroll}
        placeholder={placeholder}
        spellCheck={false}
        aria-label="Prompt template"
        className={`min-w-0 flex-1 resize-none border-none bg-surface p-3 text-text-primary outline-none ${EDITOR_METRICS}`}
      />
    </Stack>
  );
}
