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

// WorkspaceRail widths: ordinary ListRailLayout uses ms=264; the combined
// catalog replaces two rails with ml=320. Its explicit folded state is w-9=36.
// These are default-state profiles, not a tolerance for arbitrary drift.
export function listRailWidthProblems({ combined = false, collapsed = false, width }, ordinaryWidth = 264) {
  const expected = collapsed ? 36 : combined ? 320 : ordinaryWidth;
  return Math.abs(width - expected) > 2
    ? [`list rail width ${width} vs ${collapsed ? 'folded' : combined ? 'combined catalog' : 'ordinary list'} profile ${expected}`] : [];
}
