// Line-diff renderer for DiffPage and PromptHistoryPage's compare views.
//
// The library HAS diff composites (`ChangeDiff`, `DiffViewer`) but only from
// the package root — importing the root pulls in the `TiptapEditor` chunk's
// `@tiptap/react` peer dep, which this portal never installed, and breaks
// `vite build` even on a page that never touches an editor (same root-import
// gap as `NodeCard`, see docs/ui-components-queue.md). Composed here instead,
// fed by the shared `lineDiff` in `./diffFormat`. ≤ 12 raw elements: 1 wrapper
// + 1 row template (map) + 2 spans inside it = 4.
import type { DiffLine } from './diffFormat';

const KIND_ROW_CLASS: Record<DiffLine['kind'], string> = {
  add: 'bg-success-bg text-success',
  remove: 'bg-danger-bg text-danger',
  same: 'text-text-primary',
};

const KIND_MARK: Record<DiffLine['kind'], string> = { add: '+', remove: '−', same: ' ' };

export function DiffFrame({ lines }: { lines: DiffLine[] }) {
  return (
    <div className="h-full overflow-auto rounded-md border border-border font-mono text-[12px] leading-relaxed">
      {lines.map((line, i) => (
        <div key={i} className={`flex gap-2 px-3 py-px ${KIND_ROW_CLASS[line.kind]}`}>
          <span aria-hidden className="w-3 shrink-0 select-none opacity-60">{KIND_MARK[line.kind]}</span>
          <span className="whitespace-pre-wrap break-words">{line.text}</span>
        </div>
      ))}
    </div>
  );
}
