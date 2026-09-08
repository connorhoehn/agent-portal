// Pure helpers for TrafficPage's hour-of-week heatmap. Split out so the
// bucket-to-color mapping is testable without mounting the page.

/** 5-bucket palette of indigo intensities (--color-primary is indigo), plus
 *  the empty state. Returns a literal Tailwind background class so the JIT
 *  scanner can see every possible class name at build time. */
export function heatmapBucketClass(count: number, max: number): string {
  if (count <= 0 || max <= 0) return 'bg-surface';
  const t = Math.min(1, count / max);
  if (t < 0.2) return 'bg-[rgba(99,102,241,0.10)]';
  if (t < 0.4) return 'bg-[rgba(99,102,241,0.25)]';
  if (t < 0.6) return 'bg-[rgba(99,102,241,0.45)]';
  if (t < 0.8) return 'bg-[rgba(99,102,241,0.70)]';
  return 'bg-[rgba(99,102,241,0.95)]';
}
