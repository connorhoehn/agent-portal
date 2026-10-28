# DE-41 Egress control for devbox microVMs

Status: spec, 2026-10-27. Backlog: `docs/deployment-enhancements-2026-10-27.md`.
Depends on DE-40 (a profile names a `network_class`; the BFF picks the runtime
by it). Helps DE-51 (a VPC gives the lab loop a stable source address).

## Current state (read from the code, 2026-10-27)

- The devbox runtime is `networkMode: 'PUBLIC'` with no `networkModeConfig`
  (`infra/lib/devbox-stack.ts:222`). The nine agent runtimes are PUBLIC too
  (`infra/lib/agentcore-runtime-stack.ts:415`). A box can reach any internet
  address; nothing in the tree restricts or logs its egress.
- Claude Code runs with `--dangerously-skip-permissions`
  (`agents/devbox/main.py:118-120`), so in task mode the model may run any
  Bash, `curl` or WebFetch without a prompt. The image's managed settings
  carry hooks only, no `permissions` block (`agents/devbox/managed-settings.json`).
  The CLI is installed unpinned (`npm install -g @anthropic-ai/claude-code`,
  `agents/devbox/Dockerfile:30`), so its permission semantics can change on any
  rebuild.
- Two of the three access modes bypass `main.py` entirely: command mode
  (`InvokeAgentRuntimeCommand`, `middleware/src/routes/devbox.ts:663-687`,
  `full` mode is arbitrary shell unless `DEVBOX_FULL_EXEC_DISABLED=1`,
  `devbox.ts:150-166`) and the PTY (`/shell-url`, `devbox.ts:839`). An
  in-container control therefore cannot be the boundary; the network has to be.
- Secrets in reach of a box: the execution role's credentials, the clone token
  interpolated into a shell string (DE-45), and `LAB_CALLBACK_SECRET` in the
  runtime env (`devbox-stack.ts:258`). Unrestricted egress is how any of these
  leaves.
- The installed CDK (`aws-cdk-lib` 2.270.0) types `CfnRuntime`'s
  `networkConfiguration` as `{ networkMode, networkModeConfig?: { subnets,
  securityGroups } }` (`infra/node_modules/aws-cdk-lib/aws-bedrockagentcore/lib/bedrockagentcore.generated.d.ts:11135-11170`).
  Network mode is per runtime, not per session, so "per profile" means one
  runtime per network class (DE-40).
- Existing VPCs are not reusable as is: Aurora's has isolated subnets and no
  NAT (`infra/lib/aurora-stack.ts:47-58`); the middleware VPC has one NAT
  (`infra/lib/middleware-service-stack.ts:204-207`) and hosts the BFF, which
  should not share a network with untrusted code.
- The custodian (`custodian-restrict-security-group-admin-ingress`,
  `middleware-service-stack.ts:1120-1136`) revokes open **ingress** within
  seconds. This design needs no open ingress. Whether the custodian also
  touches SG **egress** rules, or SG-to-SG ingress on endpoint groups, is
  unverified.

## Change

A new `OrgIQ-DevboxNetwork` stack (opt-in, `--context devboxEgress=allowlist`)
and a second devbox runtime in VPC mode. The PUBLIC runtime stays as the
`public` network class until the decision below retires it.

**VPC**: two AZs, private subnets for the runtime, one public subnet per AZ
for NAT. AgentCore VPC mode is only offered in some AZ IDs per region; pick
subnets by AZ ID, not name (supported list unverified from code; read it from
the AgentCore VPC documentation at build time and assert it in a CDK test).
AgentCore creates ENIs in the subnets through a service-linked role
(name and creation behaviour unverified; check on first deploy).

**Security groups**: the runtime SG has **no ingress** and egress TCP 443 only
(plus UDP/TCP 53 to the VPC resolver). The endpoint SG admits 443 from the
runtime SG by group reference, never a CIDR, which keeps it out of the
custodian's open-ingress pattern.

**AWS services through VPC endpoints**, so they never cross the firewall:

| Need | Endpoint | Why |
|------|----------|-----|
| Claude via Bedrock | `bedrock-runtime` (interface) | `CLAUDE_CODE_USE_BEDROCK=1` |
| Workload identity | `bedrock-agentcore` (interface) | `GetWorkloadAccessToken*` grant (`devbox-stack.ts:163-167`) |
| Logs, metrics, traces | `logs`, `monitoring`, `xray` (interface) | Logs/Metrics/Xray statements (`devbox-stack.ts:147-162`) |
| Image pull | `ecr.api`, `ecr.dkr` (interface), `s3` (gateway) | whether AgentCore pulls the image through the customer VPC is unverified; include them and remove later if VPC flow logs show no use |
| Org-read profile only | `rds-data`, `secretsmanager`, `bedrock-agent-runtime` | `devboxOrgAccess` statements (`devbox-stack.ts:176-198`) |

Each interface endpoint carries an endpoint policy limited to this account.
Rough cost: about nine interface endpoints in two AZs plus a NAT gateway and a
firewall endpoint; price it before deploy (unverified figure, not estimated here).

**Internet egress through NAT and AWS Network Firewall** with a stateful
domain allowlist on TLS SNI and HTTP Host, default action drop and alert:

- `github.com`, `api.github.com`, `codeload.github.com`,
  `objects.githubusercontent.com` (clone, push, PR, releases);
- `registry.npmjs.org`, `pypi.org`, `files.pythonhosted.org`;
- the lab origin from `labApiBase` (`devbox-stack.ts:257`).

Per-profile additions come from the profile row (`egress_domains`), compiled
into the firewall rule group at deploy. That stays a deploy step: the firewall
is shared by the runtime, so a per-initiative list needs either its own runtime
or acceptance that the union applies (decision below).

Options considered for the GitHub allowlist, and why not alone:

- SG rules on GitHub's published ranges (`api.github.com/meta`): large, change
  without notice, and cover all of GitHub's tenants, not just ours.
- Route 53 Resolver DNS Firewall: cheap, and worth adding as a second layer,
  but a process that connects by IP skips it.
- An HTTP proxy through `HTTPS_PROXY`: any process can ignore the variable.

The firewall decides by SNI, so it cannot tell our GitHub org from anyone
else's. Repo scope comes from DE-45's short-lived, repo-scoped tokens; the two
together are the control.

**Lab loop**: the NAT's Elastic IP is a stable /32. Add it to `albAllowCidr` and
the lab callback works without CloudFront, which helps DE-51.

**Inside the box**: keep `--dangerously-skip-permissions` (headless runs
cannot answer prompts), but pin the CLI version in the Dockerfile, and add a
`permissions.deny` block to `managed-settings.json` for WebFetch and WebSearch
outside the allowlist, as a clearer error than a firewall drop. That is a
courtesy layer, not the boundary.

**Observability**: VPC flow logs and firewall alert logs to CloudWatch, with a
metric filter on dropped flows per runtime (feeds DE-50 alarms).

## Decisions owed

- Retire the PUBLIC devbox runtime once the VPC one is verified, or keep it as
  the `public` class? Proposal: keep it one release behind a profile only
  admin can assign, then delete it.
- One shared domain allowlist (the union), or a runtime per allowlist?
  Proposal: one shared list now; per-initiative lists only when an initiative
  actually needs a domain others must not reach.
- Network Firewall (hourly per firewall endpoint plus per-GB; price unverified here) against DNS
  Firewall alone. Proposal: Network Firewall in front of AWS deploys, DNS
  Firewall as the cheap second layer.
- Move the nine agent runtimes too? Proposal: not in this item. They run our
  code, not arbitrary shell.

## Done when

- `cd infra && npx cdk synth OrgIQ-DevboxNetwork OrgIQ-Devbox -c deployDevbox=true -c devboxEgress=allowlist`
  produces a `CfnRuntime` with `networkMode: VPC`, a runtime SG with zero
  ingress rules and 443-only egress, and the endpoints in the table. A Jest
  snapshot test in `infra/test/` locks those three facts.
- `scripts/validate-devbox-egress.sh` (new) runs through
  `POST /api/devbox/:sid/command` with `mode: full` on a deployed VPC box and
  asserts: `git ls-remote https://github.com/<org>/<repo>` succeeds;
  `curl -sS -m 10 https://example.com` fails; `curl` to the instance metadata
  address gets nothing beyond what AgentCore exposes; a Claude task completes
  (Bedrock reached through the endpoint).
- The firewall alert log shows the `example.com` drop within five minutes.
- After the deploy, `aws ec2 describe-security-groups` on the runtime and
  endpoint SGs returns the same rules ten minutes later (custodian check).
- `agents/devbox/Dockerfile` pins `@anthropic-ai/claude-code@<version>`.
