// Pure parsing of `git status --porcelain -uall` output for change capture.
//
// Kept free of any AWS/IO imports so the governance-critical bits — deciding a
// read failed, and which repo-relative paths a run touched — can be unit-tested
// in isolation. Every path-based policy gate (protected_paths, and the audit
// trail) depends on these paths being correct, so they are pinned by tests.

/** A git read failed (dubious ownership, missing repo, …) rather than returning a clean tree. */
export function isGitFailure(status: string): boolean {
  return /^fatal:|^error:/m.test(status);
}

/**
 * Repo-relative paths from porcelain output. Strips the two-char status code and
 * its trailing whitespace; a clean tree yields [].
 *
 * - With `-uall`, untracked files appear individually (`?? config/app.secret`),
 *   not collapsed to their parent directory (`?? config/`) — which is what lets
 *   a `**​/*.secret` gate see the file at all.
 * - Renames/copies come through as `R  old -> new`; the path that matters (for
 *   gates and the audit trail) is the *new* one, so `-> new` wins.
 */
export function parsePorcelainFiles(status: string): string[] {
  return status
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const path = l.replace(/^\S+\s+/, '');
      const arrow = path.indexOf(' -> ');
      return arrow >= 0 ? path.slice(arrow + 4) : path;
    })
    .filter(Boolean);
}
