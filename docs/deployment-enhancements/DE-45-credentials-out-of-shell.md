# DE-45 Credentials out of shell strings

Status: spec, 2026-10-27. Backlog: `docs/deployment-enhancements-2026-10-27.md`.
Depends on DE-44 row 12 (scope on `clone-command`). Pairs with DE-41 (egress)
and DE-40 (profiles).

## Current state (read from the code, 2026-10-27)

The backlog line is right but understates it. There are two token paths, not
one, and the token is a long-lived PAT, not a per-run credential.

**What the token is.** A "connection" is a pasted API key stored as an
AgentCore Identity API-key credential provider
(`providers/connected-sources.ts:128`, `CreateApiKeyCredentialProvider`) and
read back by the BFF with `borrowApiKey` (`:149`, `GetResourceApiKey`). For
GitHub that is a personal access token: one per connection, shared by every
codebase and initiative that names the connection, valid until someone revokes
it, with whatever scopes its owner gave it.

**Clone** (`buildCloneCommand`, `providers/agent-projects.ts:246`). For a
private repo the token is spliced into the clone URL
(`https://x-access-token:<token>@github.com/…`, `:283`) inside a shell string.
Callers:

- `lib/bot-runner.ts:852` runs it through `runDevboxShell`
  (`lib/project-runner.ts:31`), which base64-writes the whole command to
  `/tmp/.orgiq-probe` in the microVM (`:38`) and never deletes it.
- `POST /api/agent-projects/:id/clone-command`
  (`routes/agent-projects.ts:84`) **returns the token-bearing command to the
  browser**; the portal sends it back through `/api/devbox/:sid/command`
  (`portal/src/pages/admin/AgentProjectsPage.tsx:233-247`), whose wrapper
  writes it to `/tmp/.orgiq-cmd` (`routes/devbox.ts:239`), again never
  deleted. The portal then scrubs the output because git echoes the URL in
  errors (`AgentProjectsPage.tsx:265`). Any `ManageDevbox` holder can call
  this for any codebase (DE-44 row 12).

While the clone runs the token is also in `git clone`'s argv and in
`git-remote-https`'s, visible to `ps` in the box.

**Delivery** (`lib/change-delivery.ts:121-122`). The push token is put in a
leading env assignment, `ORGIQ_GH_TOKEN='<token>' sh -c '…'`, which also goes
through `runDevboxShell` and so lands in `/tmp/.orgiq-probe`. The script
(`lib/delivery-script.ts:27`) writes it into `.git/config` for the push and
strips it afterwards; the comment there is accurate about `.git/config` but
the token still sits in the probe file.

**Who can read it.** Claude Code runs in the same microVM with
`--dangerously-skip-permissions` (`agents/devbox/main.py:120`) and public
egress (DE-41). A task prompt, or a repository file the agent reads, can tell
it to `cat /tmp/.orgiq-probe` and send the PAT anywhere.

**The code comment's proposed fix is wrong.** `agent-projects.ts:240-244` says
the box should fetch its own credential with its workload identity. The devbox
execution role already has `GetWorkloadAccessToken` (`infra/lib/devbox-stack.ts:164`);
adding `GetResourceApiKey` would let the agent fetch every stored PAT itself.
The box must never hold a credential broader than the one run needs.

## Change

**Per-run, repo-scoped tokens from a GitHub App.** Register one GitHub App per
org (contents: write, pull requests: write, metadata: read) and store its app
id and private key in Secrets Manager (`orgiq/github-app`), read only by the
BFF task role. A new `lib/github-app-token.ts`:

```ts
mintRepoToken(repoFullName: string, perms: { contents: 'read' | 'write'; pull_requests?: 'write' })
  : Promise<{ token: string; expiresAt: string }>
```

signs an app JWT, finds the installation for the repo's owner, and calls
`POST /app/installations/{id}/access_tokens` with `repositories: [name]` and
the permissions. GitHub caps these tokens at one hour. Clone asks for
`contents: read`; delivery asks for `contents: write` and opens the PR with
the same token. A connection gains `kind: 'github-app'`; PAT connections keep
working until the decision below retires them.

**Never in a command string.** `InvokeAgentRuntimeCommand` takes only a
command and a timeout, so there is no channel for a secret except the command
text. That makes this the image change the code comment anticipated: a
`credential` entrypoint in `agents/devbox/main.py` that takes
`{ token, op: 'clone' | 'push', repo, target, branch }` in the invoke payload
and runs git as a child process with the token passed as an HTTP auth header
through `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_0`/`GIT_CONFIG_VALUE_0`
(`http.https://github.com/.extraheader`) in the child's environment. Nothing
touches argv, `.git/config` or disk, and the remote URL stays clean, so the
`set-url` dance in `delivery-script.ts` goes away. The payload is not teed to
the fleet log (`runTaskAndForward` tees only `prompt`, `routes/devbox.ts:591`;
the new entrypoint gets its own non-teeing call in `lib/project-runner.ts`).
The child's environment is readable by the same uid while git runs; a one-hour,
one-repo token bounds what that window can leak.

**Remove the browser path.** `POST /:id/clone-command` stops returning a
command; it becomes `POST /:id/clone { sessionId }`, which runs the clone
server-side through the same entrypoint (as `bot-runner.ts` already does) and
streams the redacted output. Clean up `/tmp/.orgiq-probe` and
`/tmp/.orgiq-cmd` after every run in both wrappers (`rm -f` in the script,
before the exit) for the commands that still use them.

**Audit.** Each mint writes one row (`credential_issues`: run ref, repo,
permissions, expires_at, caller sub, never the token), so "which runs could
push to repo X yesterday" has an answer.

## Decisions owed

- **GitHub App ownership.** One app per GitHub org you deliver to, owned by
  whom? Proposal: one app in the org that owns the initiative repos, created
  by you, private key only in Secrets Manager.
- **Retire PAT connections?** Proposal: keep them for read-only discovery
  (`/connections/:name/github/*`) for one release, refuse them for clone and
  push once every linked codebase has an app installation, then remove.
- **Image rebuild timing.** The new entrypoint rolls the runtime, which wipes
  `/mnt/workspace` (CLAUDE.md). Proposal: ship it with the next planned image
  change (DE-40 or DE-41) rather than on its own.

## Done when

- A unit test on the clone and delivery builders asserts the token string
  appears in no command text, argv array or file path they produce.
- `POST /api/agent-projects/:id/clone-command` is gone (404) and the portal's
  clone button calls the server-side clone; the portal test for the clone flow
  passes without `redactUrlCredentials`.
- In mock mode, `mock/devbox-shell.ts` records every command it receives, and
  a test asserts none contains `x-access-token:` followed by anything.
- `mintRepoToken` is tested against a fake GitHub API: one repository, the
  asked permissions, and an error (no fallback to a PAT) when the app has no
  installation for the owner.
- Against a deployed box (after the rebuild): after a clone and a delivery,
  `ls /tmp/.orgiq-*` is empty and `grep -r x-access-token /mnt/workspace`
  finds nothing.
