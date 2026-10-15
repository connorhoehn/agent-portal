// A small unified diff over lines (LCS), for showing a reviewer what a runbook
// proposal changes. Runbooks are a few hundred lines, but the inputs reach this
// from request bodies (a proposal's markdown) and any reader can ask for a diff,
// so the work is bounded: the common prefix and suffix are trimmed first (an
// ordinary edit leaves a small middle), and a middle whose LCS table would pass
// MAX_CELLS is shown as a whole replacement instead of allocating n*m cells.

export interface UnifiedDiff {
  /** Unified-diff text; '' when the inputs are identical. */
  text: string;
  added: number;
  removed: number;
}

type Op = { t: ' ' | '+' | '-'; line: string };

function lines(s: string): string[] {
  const parts = s.replace(/\r\n?/g, '\n').split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

/** 4M cells = 16 MB of Uint32: far above any real runbook pair, far below what hurts the BFF. */
export const MAX_DIFF_CELLS = 4_000_000;

function ops(a0: string[], b0: string[]): Op[] {
  let pre = 0;
  while (pre < a0.length && pre < b0.length && a0[pre] === b0[pre]) pre += 1;
  let suf = 0;
  while (suf < a0.length - pre && suf < b0.length - pre && a0[a0.length - 1 - suf] === b0[b0.length - 1 - suf]) suf += 1;
  const head: Op[] = a0.slice(0, pre).map((line) => ({ t: ' ', line }));
  const tail: Op[] = a0.slice(a0.length - suf).map((line) => ({ t: ' ', line }));
  const a = a0.slice(pre, a0.length - suf), b = b0.slice(pre, b0.length - suf);
  if ((a.length + 1) * (b.length + 1) > MAX_DIFF_CELLS) {
    return [...head, ...a.map((line): Op => ({ t: '-', line })), ...b.map((line): Op => ({ t: '+', line })), ...tail];
  }
  return [...head, ...lcsOps(a, b), ...tail];
}

function lcsOps(a: string[], b: string[]): Op[] {
  const n = a.length, m = b.length;
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i * w + j] = a[i] === b[j] ? dp[(i + 1) * w + j + 1]! + 1 : Math.max(dp[(i + 1) * w + j]!, dp[i * w + j + 1]!);
    }
  }
  const out: Op[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ t: ' ', line: a[i]! }); i += 1; j += 1; }
    else if (dp[(i + 1) * w + j]! >= dp[i * w + j + 1]!) { out.push({ t: '-', line: a[i]! }); i += 1; }
    else { out.push({ t: '+', line: b[j]! }); j += 1; }
  }
  while (i < n) { out.push({ t: '-', line: a[i]! }); i += 1; }
  while (j < m) { out.push({ t: '+', line: b[j]! }); j += 1; }
  return out;
}

export function unifiedDiff(before: string, after: string, labels: { from: string; to: string }, context = 3): UnifiedDiff {
  const all = ops(lines(before), lines(after));
  const added = all.filter((o) => o.t === '+').length;
  const removed = all.filter((o) => o.t === '-').length;
  if (added === 0 && removed === 0) return { text: '', added, removed };

  // Mark which ops are within `context` of a change, then emit contiguous hunks.
  const keep = new Array<boolean>(all.length).fill(false);
  all.forEach((o, k) => {
    if (o.t === ' ') return;
    for (let x = Math.max(0, k - context); x <= Math.min(all.length - 1, k + context); x += 1) keep[x] = true;
  });
  // Old/new line number at the start of each op.
  const oldAt: number[] = [], newAt: number[] = [];
  let o = 1, nn = 1;
  for (const op of all) {
    oldAt.push(o); newAt.push(nn);
    if (op.t !== '+') o += 1;
    if (op.t !== '-') nn += 1;
  }
  const out = [`--- ${labels.from}`, `+++ ${labels.to}`];
  let k = 0;
  while (k < all.length) {
    if (!keep[k]) { k += 1; continue; }
    let end = k;
    while (end < all.length && keep[end]) end += 1;
    const hunk = all.slice(k, end);
    const oldLen = hunk.filter((h) => h.t !== '+').length;
    const newLen = hunk.filter((h) => h.t !== '-').length;
    out.push(`@@ -${oldLen === 0 ? oldAt[k]! - 1 : oldAt[k]},${oldLen} +${newLen === 0 ? newAt[k]! - 1 : newAt[k]},${newLen} @@`);
    for (const h of hunk) out.push(`${h.t}${h.line}`);
    k = end;
  }
  return { text: out.join('\n') + '\n', added, removed };
}
