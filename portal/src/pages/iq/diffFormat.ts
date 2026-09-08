// Pure line-diff helpers shared by DiffPage and PromptHistoryPage.
//
// The actual diff RENDERING goes through the library's <ChangeDiff> composite
// (before/after prose diff) — this file only computes the "+N -M unchanged"
// counts shown alongside it, so both pages read the same numbers from the
// same LCS pass instead of each hand-rolling one.

export type DiffLineKind = 'same' | 'add' | 'remove';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

export interface DiffStats {
  added: number;
  removed: number;
  unchanged: number;
}

/** Line-level LCS diff between two texts, split on `\n`. */
export function lineDiff(a: string, b: string): DiffLine[] {
  const la = a.split('\n');
  const lb = b.split('\n');
  const m = la.length, n = lb.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i]![j] = la[i] === lb[j]
        ? 1 + (dp[i + 1]?.[j + 1] ?? 0)
        : Math.max(dp[i + 1]?.[j] ?? 0, dp[i]?.[j + 1] ?? 0);
    }
  }
  const result: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < m || j < n) {
    if (i < m && j < n && la[i] === lb[j]) {
      result.push({ kind: 'same', text: la[i]! }); i++; j++;
    } else if (j < n && (i >= m || (dp[i + 1]?.[j] ?? 0) <= (dp[i]?.[j + 1] ?? 0))) {
      result.push({ kind: 'add', text: lb[j]! }); j++;
    } else {
      result.push({ kind: 'remove', text: la[i]! }); i++;
    }
  }
  return result;
}

export function diffStats(lines: DiffLine[]): DiffStats {
  let added = 0, removed = 0, unchanged = 0;
  for (const l of lines) {
    if (l.kind === 'add') added++;
    else if (l.kind === 'remove') removed++;
    else unchanged++;
  }
  return { added, removed, unchanged };
}
