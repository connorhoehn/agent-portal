// GitHub identities people granted OrgIQ, offline — the `github_user_grants`
// rows (docs/microvm-runner-design.md §13). Starts empty: the OAuth link page
// that writes a grant is a later lane, so offline nobody has one and a microvm
// job is held back with `no-github-identity`, exactly as it would be against
// Aurora today. The token never lives here (or anywhere but Secrets Manager).

import { defineFixture } from './core/index.js';
import type { GithubUserGrant } from '../providers/github-user-grants.js';

export const githubUserGrants = defineFixture<GithubUserGrant>({
  key: 'github-user-grants',
  scenarios: { default: () => [] },
});
