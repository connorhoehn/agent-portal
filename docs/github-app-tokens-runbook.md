# GitHub App tokens for devbox clone and push (DE-45)

What the deploy machine must set up so a devbox clones and pushes with a
one-hour, one-repository token instead of a stored personal access token, and
so that token never appears in a shell string. Spec:
`docs/deployment-enhancements/DE-45-credentials-out-of-shell.md`.

## What is built (in the tree, works offline)

- `middleware/src/lib/repo-token-provider.ts`: the `RepoTokenProvider`
  interface and `mintAuditedRepoToken()`, the one call site API. Providers:
  `github-app` (real), `pat` (the stored connection credential, the default
  when no app is configured, so nothing that works today stops working) and
  `local` (dev:mock, a fake token per mint).
- `middleware/src/lib/github-app-token.ts`: signs the app JWT, finds the
  installation for the repo owner, mints a token with
  `repositories: [name]` and only the permissions asked for. When the app is
  not installed on the owner it refuses, with no fallback to a PAT.
- `middleware/src/lib/devbox-git.ts`: `cloneIntoBox()` and `pushFromBox()`.
  With the git entrypoint on, the token goes in an `InvokeAgentRuntime`
  payload. `agents/devbox/main.py` (`op: clone | push`) hands it to git as
  an HTTP auth header through the child's environment (`GIT_CONFIG_*`), so
  it never reaches argv, `.git/config` or disk.
- `schema/credential_issues_schema.sql`: one audit row per mint (run, repo,
  provider, permissions, expiry, caller), never the token.
- Both shell wrappers now delete `/tmp/.orgiq-probe` and `/tmp/.orgiq-cmd`
  after each run.

## Deploy-machine steps

1. **Create the GitHub App** in the org that owns the initiative repos
   (Settings → Developer settings → GitHub Apps → New). Name it
   `orgiq-devbox`. Turn webhooks off. Give it these repository permissions
   and nothing else: Contents read & write, Pull requests read & write,
   Metadata read-only. Allow installation only on this account.
2. **Install it** on that org, choosing only the repositories initiatives
   deliver to. A repo the app cannot see gets "not installed" and is refused.
3. **Generate a private key** on the app page. Store the app id and the PEM
   in Secrets Manager in 647757222309 / us-east-1. Do not commit the PEM or
   paste it into `--context`.

   ```bash
   aws secretsmanager create-secret --name orgiq/github-app \
     --secret-string "$(jq -n --arg id "$APP_ID" --rawfile key app.pem '{appId:$id, privateKey:$key}')"
   shred -u app.pem
   ```
4. **Give the BFF task the two variables.** Deploy `OrgIQ-MiddlewareService`
   with `--context githubAppSecretArn=<the secret's complete ARN>` (from the
   create-secret output). The stack then injects `GITHUB_APP_ID` and
   `GITHUB_APP_PRIVATE_KEY` as ECS secrets (fields `appId`, `privateKey`);
   CDK grants the read to the task execution role only. Never grant it to the
   devbox execution role.
5. **Apply the schema:** `schema/credential_issues_schema.sql` and
   `schema/devbox_profiles_schema.sql` (both additive, listed in
   `schema/manifest.json`).
6. **Rebuild the devbox image** (`agents/devbox/build.sh`) so the git
   entrypoint exists, and redeploy `OrgIQ-Devbox`. This rolls the runtime
   and **wipes every `/mnt/workspace`**, so ship it with the next planned
   image change.
7. **Turn the entrypoint on** for the BFF: deploy with
   `--context devboxGitEntrypoint=true` (sets `DEVBOX_GIT_ENTRYPOINT=on`). Until then a real runtime keeps the legacy shell
   clone; an image without the entrypoint answers the git payload with
   "missing prompt", which `runDevboxGit` reports as "the devbox image has no
   git entrypoint yet".

## Verify after the rebuild

```bash
# On a box, after a clone and a delivery: both must print nothing.
ls /tmp/.orgiq-* 2>/dev/null
grep -r x-access-token /mnt/workspace
```

Then check the audit trail:
`SELECT run_ref, repo, provider, permissions, expires_at FROM credential_issues ORDER BY created_at DESC LIMIT 5;`
Rows should show `provider = 'github-app'` and an `expires_at` about an hour
after `created_at`.

## Selection and fallback, in order

1. `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` are both set: the
   `github-app` provider. An owner without an installation is refused.
2. `MOCK_AGENTCORE=true`: the `local` fake.
3. Otherwise: `pat`, the connection's stored token, unchanged. Each mint is
   still audited, with `expires_at` null.

PAT retirement is an open decision (the spec proposes keeping PATs for
read-only discovery for one release, then refusing them for clone and push).
