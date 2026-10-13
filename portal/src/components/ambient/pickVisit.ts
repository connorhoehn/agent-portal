/** One ambient visit a minute (docs: the shell's decorative mouse). */
export const VISIT_INTERVAL_MS = 60_000;

/** A random surface, a stopping point inside it (15–85%) and a direction. */
export function pickVisit(count: number, random: () => number = Math.random) {
  return { index: Math.floor(random() * count) % Math.max(count, 1), stopAt: 0.15 + random() * 0.7, reverse: random() < 0.5 };
}
