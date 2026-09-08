// Strip credentials out of URLs before text is displayed, logged, or stored.
//
// This exists because of one specific behaviour: `git` echoes the clone URL
// back verbatim in its error messages — `fatal: unable to access
// 'https://x-access-token:<token>@github.com/o/r.git/': SSL certificate
// problem` — and redacts nothing. The computer lab clones private repos by
// putting a GitHub token in the URL userinfo (see
// `middleware/src/providers/agent-projects.ts::buildCloneCommand`, which names
// this as the known weak point), so any path that surfaces raw git output to a
// human is a credential-disclosure path.
//
// Applied at the source — the moment devbox command output is read — rather
// than at each display site, so a new error branch cannot reintroduce the leak
// by forgetting to scrub.

/**
 * Replace the password in every `scheme://user:secret@host` URL with `***`.
 *
 * The username is preserved: `x-access-token` is not a secret and identifies
 * which auth scheme was used, which is exactly what someone reading a clone
 * failure needs. Text with no credentialed URL is returned unchanged.
 */
export function redactUrlCredentials(text: string): string {
  // Userinfo sits between `://` and the last `@` before the host. Neither the
  // user nor the secret may contain `/`, `@`, or whitespace, which is what
  // keeps this from swallowing the rest of the line — and the reason the
  // pattern is anchored on a scheme rather than just looking for `@`.
  return text.replace(
    /(\b[a-z][a-z0-9+.-]*:\/\/)([^/@\s:]+):([^/@\s]+)@/gi,
    (_match, scheme: string, user: string) => `${scheme}${user}:***@`,
  );
}
