// Stable React keys for an editable list of plain strings (the kit editor's clarifying questions and follow-ups): an
// index key moves every row after a removed one onto its neighbour's input, so this keeps one key per row instead.
// `remove(j)` before the list drops row j; `for(n)` gives the keys for the list as it now is, trimmed or extended from
// the end when the list changed from outside (a reload, an added row).
let minted = 0;

export class RowKeys {
  private keys: string[] = [];

  for(length: number): string[] {
    if (this.keys.length > length) this.keys = this.keys.slice(0, length);
    while (this.keys.length < length) this.keys.push(`row-${++minted}`);
    return [...this.keys];
  }

  remove(index: number): void {
    this.keys = this.keys.filter((_, k) => k !== index);
  }
}
