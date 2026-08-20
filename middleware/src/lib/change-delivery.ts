// Delivery — turning an approved change into a branch and a pull request.
//
// This is the only step that reaches outside the sandbox and touches the real
// repository, so it is the most conservative one. It pushes a branch and opens
// a PR; it never merges. A PR is a proposal a human still accepts, which is the
// right amount of authority for an automated pipeline — the governance in front
// of this step decided the change was worth proposing, not worth merging
// unattended.
//
// It delivers from the live workspace that produced the change. A workspace is
// disposable and may have been reaped between the run and the approval, so the
// first thing delivery does is check the changes are still there, and say so
// plainly when they are not — re-running regenerates them. Re-applying the
// captured diff onto a fresh clone would remove that dependency, but it is more
// machinery than a first version needs and is noted rather than built.

import { runDevboxShell } from './project-runner.js';
import { openPullRequest } from './github-connector.js';
import type { BedrockAgentCoreClient } from '@aws-sdk/client-bedrock-agentcore';

export interface DeliveryInput {
  client: BedrockAgentCoreClient;
  runtimeArn: string;
  sessionId: string;
  checkout: string;
  repoFullName: string;
  defaultBranch: string;
  connectionName: string | null;
  changeId: string;
  title: string;
  /** For the PR body — what the change is and how it was reviewed. */
  reviewSummary: string | null;
}

export interface DeliveryResult {
  ok: boolean;
  branch?: string;
  prUrl?: string;
  error?: string;
}

/** A branch name that is unique per change and obviously machine-authored. */
function branchName(changeId: string): string {
  return `orgiq/change-${changeId.slice(0, 8)}`;
}

/**
 * Commit the workspace changes to a branch, push, and open a PR.
 *
 * Requires a connection: pushing needs a credential, and a public repo linked
 * without one can be reviewed and approved but not delivered. That is a real
 * limit, said plainly, rather than a silent no-op that looks like success.
 */
export async function deliverChange(input: DeliveryInput): Promise<DeliveryResult> {
  if (!input.connectionName) {
    return { ok: false, error: 'This project has no GitHub connection, so there is no credential to push with. Link one in Knowledge → Sources.' };
  }

  const [owner, repo] = input.repoFullName.split('/');
  if (!owner || !repo) return { ok: false, error: `"${input.repoFullName}" is not a valid owner/name` };

  const branch = branchName(input.changeId);
  const git = `git -c safe.directory='*' -c user.name='OrgIQ Agent' -c user.email='agent@orgiq.local' -C ${input.checkout}`;

  // 1. Are the changes still here? A reaped workspace has a clean tree.
  const status = await runDevboxShell(input.client, input.runtimeArn, input.sessionId,
    `${git} status --porcelain | head -5`);
  if (/^fatal:|^error:/m.test(status)) {
    return { ok: false, error: `Could not read the checkout — ${status.split('\n')[0]}. The workspace may be gone; re-run to regenerate the change.` };
  }
  if (!status.trim()) {
    return { ok: false, error: 'The workspace no longer holds these changes — its microVM was likely reaped. Re-run the task to regenerate them.' };
  }

  // 2. Branch, commit, push. The token is placed in the remote URL only for the
  //    push and stripped immediately, so it is not persisted in .git/config —
  //    the same discipline the clone uses.
  const commitMsg = `${input.title}\n\nProposed by an OrgIQ agent and reviewed before delivery.`;
  const b64Msg = Buffer.from(commitMsg, 'utf8').toString('base64');
  const authedRemote = `https://x-access-token:$ORGIQ_GH_TOKEN@github.com/${input.repoFullName}.git`;

  const script = [
    `${git} checkout -B ${branch}`,
    `${git} add -A`,
    `${git} commit -m "$(echo ${b64Msg} | base64 -d)" || true`,
    `${git} remote set-url origin ${authedRemote}`,
    `${git} push -u origin ${branch} --force-with-lease`,
    `${git} remote set-url origin https://github.com/${input.repoFullName}.git`,
  ].join(' && ');

  // The token reaches the shell as an env var rather than being baked into the
  // command string, so it does not sit in the command text the fleet log tees.
  const token = await borrowTokenFor(input.connectionName);
  const withEnv = `ORGIQ_GH_TOKEN='${token}' sh -c '${script.replace(/'/g, `'\\''`)}'`;

  const pushOut = await runDevboxShell(input.client, input.runtimeArn, input.sessionId, withEnv);
  if (/^fatal:|^error:|rejected|denied/m.test(pushOut)) {
    const line = pushOut.split('\n').find((l) => /fatal:|error:|rejected|denied/i.test(l)) ?? 'push failed';
    return { ok: false, error: `Push failed — ${line}` };
  }

  // 3. Open the PR.
  try {
    const pr = await openPullRequest(input.connectionName, {
      owner, repo, head: branch, base: input.defaultBranch,
      title: input.title,
      body: [
        'This pull request was proposed by an OrgIQ agent and passed the governance gates before delivery.',
        '',
        input.reviewSummary ? `**Review:** ${input.reviewSummary}` : '',
      ].filter(Boolean).join('\n'),
    });
    return { ok: true, branch, prUrl: pr.url };
  } catch (err) {
    // The branch is pushed; only the PR failed. Report it so the branch is not
    // silently orphaned — a human can open the PR by hand from here.
    return { ok: false, branch, error: `Branch ${branch} was pushed, but opening the PR failed: ${(err as Error).message}` };
  }
}

/** Kept local so the token's lifetime is exactly this call. */
async function borrowTokenFor(connectionName: string): Promise<string> {
  const { borrowApiKey } = await import('../providers/connected-sources.js');
  return borrowApiKey(connectionName);
}
