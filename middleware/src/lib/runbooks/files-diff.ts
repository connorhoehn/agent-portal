// A proposal's file changes as one git-style multi-file unified diff, the shape
// the library DiffViewer reads (`diff --git a/P b/P`, new/deleted file mode,
// then hunks). Content is shown as text only; the viewer never executes it.
import type { RunbookFile } from './types.js';
import { unifiedDiff } from '../unified-diff.js';

export interface FilesDiff {
  text: string;
  added: number;
  removed: number;
  /** Per path: added | deleted | modified | unchanged. */
  files: Array<{ path: string; status: 'added' | 'deleted' | 'modified' | 'unchanged'; size: number; sha256: string | null }>;
}

export function filesUnifiedDiff(base: readonly RunbookFile[], proposed: readonly RunbookFile[]): FilesDiff {
  const a = new Map(base.map((f) => [f.path, f]));
  const b = new Map(proposed.map((f) => [f.path, f]));
  const paths = [...new Set([...a.keys(), ...b.keys()])].sort();
  const chunks: string[] = [];
  const files: FilesDiff['files'] = [];
  let added = 0, removed = 0;
  for (const path of paths) {
    const before = a.get(path), after = b.get(path);
    const status = !before ? 'added' : !after ? 'deleted' : before.sha256 === after.sha256 && before.mode === after.mode ? 'unchanged' : 'modified';
    files.push({ path, status, size: (after ?? before)!.size, sha256: after?.sha256 ?? null });
    if (status === 'unchanged') continue;
    const d = unifiedDiff(before?.content ?? '', after?.content ?? '', { from: before ? `a/${path}` : '/dev/null', to: after ? `b/${path}` : '/dev/null' });
    added += d.added; removed += d.removed;
    const head = [`diff --git a/${path} b/${path}`];
    if (status === 'added') head.push(`new file mode 100${after!.mode}`);
    if (status === 'deleted') head.push(`deleted file mode 100${before!.mode}`);
    if (status === 'modified' && before!.mode !== after!.mode) head.push(`old mode 100${before!.mode}`, `new mode 100${after!.mode}`);
    chunks.push(head.join('\n') + '\n' + d.text);
  }
  return { text: chunks.join(''), added, removed, files };
}
