// A least-recently-used map bounded by the total size of its values, not by
// their count. A value larger than the whole bound is never kept.

export class ByteLru<V> {
  private readonly map = new Map<string, { value: V; size: number }>();
  private total = 0;

  constructor(private readonly maxBytes: number, private readonly sizeOf: (v: V) => number) {}

  get(key: string): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    // Re-insert: a Map iterates in insertion order, so the front is the least recent.
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V): void {
    const size = this.sizeOf(value);
    this.delete(key);
    if (size > this.maxBytes) return;
    this.map.set(key, { value, size });
    this.total += size;
    while (this.total > this.maxBytes) {
      const oldest = this.map.keys().next().value as string;
      this.delete(oldest);
    }
  }

  delete(key: string): void {
    const entry = this.map.get(key);
    if (!entry) return;
    this.map.delete(key);
    this.total -= entry.size;
  }

  clear(): void { this.map.clear(); this.total = 0; }

  get bytes(): number { return this.total; }
  get size(): number { return this.map.size; }
}
