// A catalog combines its status views and records into one Explorer rail.
// Other list pages still require the existing section → list hierarchy.
export function listRailPlacementProblems(frame) {
  if (frame.combined) {
    return [
      ...(frame.section ? ['combined catalog has a redundant section rail'] : []),
      ...(Math.abs(frame.list.left - frame.contentLeft) > 2 ? ['combined catalog rail is not at the content edge'] : []),
    ];
  }
  if (!frame.section) return ['no section rail at the content edge'];
  const gap = frame.list.left - frame.section.right;
  return gap < -1 || gap > 2 ? [`list rail at x=${frame.list.left}, ${gap}px from the section rail's right ${frame.section.right} — not stacked beside it`] : [];
}
