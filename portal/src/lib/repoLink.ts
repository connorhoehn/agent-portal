// Codebase link — Mission-2 data.
//
// The projects rollup (`GET /api/graph/projects`) carries `repoFullName`
// (e.g. `connorhoehnslalom/orgiq-observability`). The portal renders it as a
// link to the repo on GitHub, visible to any signed-in role (no capability
// gate). This is the one place that builds that URL, so the card and the
// detail header agree by construction.

/**
 * `owner/repo` → `https://github.com/owner/repo`, or null when there is no
 * repo to link (missing, blank, or only slashes). Leading/trailing slashes are
 * trimmed so a stray `/owner/repo/` still resolves; interior structure is left
 * untouched. The path is NOT re-encoded — GitHub owner/repo slugs are already
 * URL-safe and encoding the slash would break the link.
 */
export function githubRepoUrl(repoFullName: string | null | undefined): string | null {
  if (!repoFullName) return null;
  const slug = repoFullName.trim().replace(/^\/+|\/+$/g, '');
  if (!slug) return null;
  return `https://github.com/${slug}`;
}
