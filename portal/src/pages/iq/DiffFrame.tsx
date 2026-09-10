// Line-diff renderer for DiffPage and PromptHistoryPage's compare views.
//
// The library HAS diff composites, and BOTH are reachable from `/shared` now
// (`DiffViewer` always was; `ChangeDiff` since 2.243.0). The root-import/@tiptap
// story this comment used to tell was wrong about DiffViewer and is now moot
// for ChangeDiff.
//
// The real blocker is the data shape, and it survives the export fix:
// `ChangeDiff` takes `pairs: {before, after}[]` — before/after values of the
// same field — and `DiffViewer` takes `diff: string`, real unified `git diff`
// output with file headers and hunks. This page has neither. It has
// `DiffLine[] = {kind, text}[]` from the local `lineDiff(a, b)`, which is a
// two-string line comparison, not a git diff and not a field pair. Feeding
// either composite would mean re-encoding that into a format it can parse,
// which is a bigger change than the four elements it would save.
//
// ≤ 12 raw elements: 1 wrapper + 1 row template (map) + 2 spans inside it = 4.
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
