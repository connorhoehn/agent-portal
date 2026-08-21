// The branch-commit-push shell script for delivery — kept pure and free of any
// AWS-SDK or config imports so the one security-critical property here can be
// unit-tested in isolation: the token lands in .git/config only for the push,
// and the strip-back-to-clean runs whether or not the push succeeds. A push
// fails routinely (rejected, auth, network), and gating the strip behind its
// success — a plain `&&` chain — would leave the token in the workspace's
// .git/config on every failed push, until the microVM is reaped.

export interface DeliveryScriptInput {
  /** The `git -C <checkout> ...` prefix, with identity flags already applied. */
  git: string;
  branch: string;
  /** base64 of the commit message, decoded in-shell to avoid quoting hazards. */
  b64CommitMsg: string;
  repoFullName: string;
  /** Commit-per-capture: branch from this commit and push it as-is. When null,
   *  legacy delivery snapshots the working tree into a fresh commit. */
  commitSha?: string | null;
}

/**
 * `$ORGIQ_GH_TOKEN` is left unexpanded here; the caller supplies it as a leading
 * env assignment so the secret never enters the git argv (visible to `ps`).
 */
export function buildDeliveryScript(input: DeliveryScriptInput): string {
  const cleanRemote = `https://github.com/${input.repoFullName}.git`;
  const authedRemote = `https://x-access-token:$ORGIQ_GH_TOKEN@github.com/${input.repoFullName}.git`;
  // Prepare the branch. With a captured commit the work is already committed, so
  // branch straight from that commit and push exactly it — nothing to add or
  // commit. Legacy: snapshot the uncommitted working tree into a fresh commit.
  // Either way, if prep fails the authed remote is never set, so the token never
  // touches .git/config — bail out clean.
  const prep = input.commitSha
    ? `${input.git} checkout -B ${input.branch} ${input.commitSha} || exit 1`
    : `${input.git} checkout -B ${input.branch} && ${input.git} add -A && { ${input.git} commit -m "$(echo ${input.b64CommitMsg} | base64 -d)" || true; } || exit 1`;
  return [
    prep,
    // From here the token is in .git/config; everything below must run.
    `${input.git} remote set-url origin ${authedRemote}`,
    `${input.git} push -u origin ${input.branch} --force-with-lease`,
    `push_rc=$?`,
    `${input.git} remote set-url origin ${cleanRemote}`,
    `exit $push_rc`,
  ].join('\n');
}
