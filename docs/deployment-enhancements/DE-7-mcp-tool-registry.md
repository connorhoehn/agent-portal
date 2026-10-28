# DE-7 MCP gateway tools from a manifest

Status: spec, 2026-10-27. Backlog: `docs/deployment-enhancements-2026-10-27.md`.
Blocked in practice on a caller existing (see below). Touches DE-12-style
policy lifecycle and DE-6 (runtime execution roles).

## Current state (read from the code, 2026-10-27)

The backlog assumes a gateway that agents use and that is hard to extend. The
second half is true; the first is not.

- **Three hand-written tools.** `infra/lib/agentcore-gateway-stack.ts` declares
  three Lambdas (`kb-query`, `graph-traversal`, `compute-pagerank`, `:81`–`:140`),
  one `CfnGatewayTarget` each with an inline JSON schema (`:226`, `:258`, `:289`),
  per-Lambda `grantInvoke` (`:190`–`:192`), an explicit list of Lambda ARNs in
  the gateway role (`:163`–`:170`), and Cedar policies that hard-depend on each
  target by variable (`:362`–`:364`). Adding a tool means editing five places.
  All Lambdas share one bundle (`infra/lib/gateway-tool-code.ts`).
- **Nothing calls the gateway.** No agent has an MCP client: no Python under
  `agents/` mentions the gateway or MCP outside two tests. The BFF has
  `GATEWAY_ID`/`GATEWAY_URL` config (`middleware/src/config.ts:186`–`:187`) that
  nothing reads, and `app.ts` never passes `gatewayId` to the middleware stack.
  The agents' tools run in process (`agents/_shared/`).
- **The Cedar principals name roles the runtimes do not run as.** Policies
  permit `AgentCore::IamEntity::"<orgiq-<agent>-role>"` from `OrgIQ-Agents`
  (`agentcore-gateway-stack.ts:353`, roles at `infra/lib/agents-stack.ts:89`),
  but each runtime executes as `orgiq-<agent>-execution-role`
  (`infra/lib/agentcore-runtime-stack.ts:213`–`:214`, `:409`), which has no
  gateway-invoke grant. With `mode: 'ENFORCE'` (`:204`–`:207`) a deployed
  runtime calling the gateway would probably be denied; unverified in the
  cloud.
- **Policies are not per tool.** Every policy permits any `action` on the
  gateway (`:353`), so the supervisor, search and ingestion grants are equal.
- **Privilege drift.** `kb-query` runs as `toolsLambdaRole` (`:32`, `:87`), which
  holds the Aurora admin secret and RDS write actions it never uses
  (`infra/lambda/gateway-tools/kb_query.py` only calls `bedrock-agent-runtime`).
  Its schema advertises `kb_slug`, which the handler ignores (`kb_query.py:36`).
  The gateway role has `bedrock-agentcore:*` on `*` (`:172`–`:177`).
  `infra/test/gateway-readonly.test.ts` covers only the graph reader.

## Change

Fix the wiring first, then make the manifest the only place a tool is named.

**1. Make the gateway callable (prerequisite).** Cedar principals become the
runtime execution roles (expose them from `AgentCoreRuntimeStack`, or build the
ARN from the fixed role name to avoid an edge). Grant those roles
`bedrock-agentcore:InvokeGateway` on the gateway ARN (action name unverified).
Add one MCP client in `agents/_shared/gateway_tools.py` (Strands MCP client,
SigV4 to `GATEWAY_URL`), behind `GATEWAY_TOOLS=1`, used by one agent first.

**2. The manifest.** `infra/gateway-tools.json`, validated by a JSON schema at
synth time:

```json
{ "tools": [{
  "name": "knowledge-base-query",
  "target": "kb-query",
  "handler": "kb_query.handler",
  "description": "…",
  "inputSchema": { "type": "object", "properties": { "query": { "type": "string" } }, "required": ["query"] },
  "access": { "kb": true, "aurora": "none" },
  "timeoutSeconds": 30, "memoryMb": 256,
  "agents": ["supervisor", "search", "advisor"]
}]}
```

`access` is a closed vocabulary (`aurora: none|reader`, `kb`, `bedrockInvoke`)
mapped to prebuilt policy statements; a manifest cannot carry raw IAM, and
`aurora: admin` is not a value, so the SQL-guard boundary stays a reader. The
stack loops the manifest to create the Lambda (shared bundle, so the handler
file must exist in `infra/lambda/gateway-tools/`), the target, the invoke
grant and one Cedar policy per agent listing the tools it may call
(`action in [AgentCore::Action::"<target>__<tool>"]`; the action naming is
unverified: the current comment at `:331` says the docs show
`TargetName__toolName` and the code wildcards around it).

**3. External targets later.** `"kind": "openapi" | "mcp-server"` entries with a
token-vault credential provider name are a schema extension, not part of the
first cut; the connected-sources vault (`providers/connected-sources.ts`)
would own those credentials.

"Without CDK edits" means without editing TypeScript. A manifest change still
needs a stack deploy; doing it at run time (a Lambda that calls
`CreateGatewayTarget`) would put targets outside CloudFormation and is not
proposed.

## Decisions owed

- **Is the gateway wanted at all?** The agents work without it. Proposal: keep
  it, but only for tools shared by several agents or exposed to external MCP
  clients; in-process tools stay in process.
- **Who approves a new tool?** Proposal: a manifest change is a normal PR plus
  a passing `infra` test; no runtime admin UI.
- **Per-tenant tools.** Not proposed; the gateway is OrgIQ-only today.

## Done when

- `infra/gateway-tools.json` exists; `agentcore-gateway-stack.ts` contains no
  tool name, schema or handler string (`grep -n "pagerank\|graph-traversal\|knowledge-base-query" infra/lib/agentcore-gateway-stack.ts` is empty).
- `cd infra && npm test` asserts: one target and one Lambda per manifest entry;
  every Cedar principal is a runtime execution role; no policy has a bare
  `action`; no gateway Lambda role can read the Aurora admin secret; a manifest
  with `aurora: "admin"` or an unknown key fails synth.
- Adding a fourth tool in a test fixture manifest yields a fourth target
  with no TypeScript change.
- `agents/_shared` unit test for `gateway_tools.py` lists tools from a stubbed
  MCP endpoint and maps them to Strands tools.
- Cloud check (blocked until credentials return): one agent with
  `GATEWAY_TOOLS=1` calls `knowledge-base-query` through the gateway, and an
  agent not listed for a tool gets a policy denial.
