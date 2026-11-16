// Piece I1.1: the density of the three homes at both widths (judges the screenshots piece I0 took).
export default async function run({ record, homes }) {
  // ── I1.1: density at both widths ─────────────────────────────────────────
  const shots = homes.flatMap((h) => h.shots.map((s) => ({ home: h.name, ...s })));
  record('I1.1', shots.length === 6 && shots.every((s) => s.ok),
    shots.map((s) => `${s.home}@${s.width}: first row at ${s.firstRowTop}px${s.horizontalScroll ? ', scrolls sideways' : ''}`).join('; '));
}
