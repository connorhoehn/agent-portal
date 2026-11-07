import * as cdk from 'aws-cdk-lib';
import * as bedrockagentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import type { Construct } from 'constructs';
import { AGENT_NAMES } from './agentcore-runtime-stack';
import { loadGatewayToolManifest, parseGatewayToolManifest } from './gateway-tools-manifest';
import type { GatewayToolManifest, GatewayToolSpec } from './gateway-tools-manifest';

/**
 * The gateway tools any agent may ever call (docs/next-steps.md §8 work item
 * 22). Read-only tools only: the org-graph reads (through the reader login)
 * and the knowledge-base query. A tool added to infra/gateway-tools.json is
 * not callable until it is named here, and only a read-only tool may be.
 */
export const GATEWAY_TOOL_ALLOW_LIST: readonly string[] = [
  'graph-traversal',
  'compute-pagerank',
  'knowledge-base-query',
];

/**
 * The Cedar action a gateway target exposes: "<prefix>-<target>___<tool>".
 * AgentCoreGatewayStack's per-agent permits use the same form; the stack test
 * holds the two together.
 */
export const gatewayToolAction = (prefix: string, tool: Pick<GatewayToolSpec, 'target' | 'name'>): string =>
  `AgentCore::Action::"${prefix}-${tool.target}___${tool.name}"`;

/** A tool is read-only when it reaches Aurora (if at all) as the reader and invokes no model. */
const readOnly = (tool: GatewayToolSpec): boolean =>
  (tool.access.aurora === 'none' || tool.access.aurora === 'reader') && !tool.access.bedrockInvoke;

/**
 * The deny-by-default guard: forbid every action that is not an allow-listed
 * tool. Cedar already denies what nothing permits; this caps every permit,
 * including one added outside this repo (console, CLI), at the allow list,
 * because a forbid always wins over a permit.
 */
export function denyUnlistedToolsStatement(prefix: string, manifest: GatewayToolManifest): string {
  const byName = new Map(manifest.tools.map((t) => [t.name, t]));
  for (const tool of manifest.tools) {
    if (!GATEWAY_TOOL_ALLOW_LIST.includes(tool.name)) {
      throw new Error(`gateway tool "${tool.name}" is in infra/gateway-tools.json but not in GATEWAY_TOOL_ALLOW_LIST `
        + '(infra/lib/agentcore-policy-stack.ts). Add it there if it only reads; agents cannot call it until then.');
    }
  }
  const allowed = GATEWAY_TOOL_ALLOW_LIST.map((name) => {
    const tool = byName.get(name);
    if (!tool) throw new Error(`GATEWAY_TOOL_ALLOW_LIST names "${name}", which infra/gateway-tools.json does not declare`);
    if (!readOnly(tool)) throw new Error(`GATEWAY_TOOL_ALLOW_LIST names "${name}", which is not read-only`);
    return gatewayToolAction(prefix, tool);
  });
  return `forbid (\n  principal,\n  action,\n  resource\n) unless {\n  action in [${allowed.join(', ')}]\n};`;
}

export interface AgentCorePolicyStackProps extends cdk.StackProps {
  readonly prefix?: string;
  /** The tool manifest. Defaults to `infra/gateway-tools.json`; tests pass a fixture. */
  readonly manifest?: unknown;
}

export class AgentCorePolicyStack extends cdk.Stack {
  public readonly policyEngineId: string;
  public readonly policyEngineArn: string;

  constructor(scope: Construct, id: string, props: AgentCorePolicyStackProps) {
    super(scope, id, props);

    const prefix = props.prefix ?? 'orgiq';
    // PolicyEngine name must match ^[A-Za-z][A-Za-z0-9_]*$ — no hyphens
    const safeName = prefix.replace(/-/g, '_');
    const manifest: GatewayToolManifest = props.manifest === undefined
      ? loadGatewayToolManifest(AGENT_NAMES)
      : parseGatewayToolManifest(props.manifest, AGENT_NAMES);

    // -------------------------------------------------------------------
    // Policy Engine. The per-agent permits are created in
    // AgentCoreGatewayStack because they name the gateway as the resource.
    // -------------------------------------------------------------------

    const policyEngine = new bedrockagentcore.CfnPolicyEngine(this, 'PolicyEngine', {
      name: `${safeName}_policy_engine`,
      description: 'OrgIQ Cedar-based access control for agent tools and resources',
    });

    this.policyEngineId = policyEngine.attrPolicyEngineId;
    this.policyEngineArn = policyEngine.attrPolicyEngineArn;

    // -------------------------------------------------------------------
    // Deny by default: the policy set every gateway on this engine gets,
    // whatever permits are added later. Its actions name gateway targets that
    // AgentCoreGatewayStack creates after this stack, so the analyzer cannot
    // resolve them yet: IGNORE_ALL_FINDINGS. The Cedar text itself is pinned
    // by test/agentcore-policy-stack.test.ts.
    // -------------------------------------------------------------------

    new bedrockagentcore.CfnPolicy(this, 'DenyUnlistedTools', {
      name: `${safeName}_deny_unlisted_tools`,
      description: 'Deny by default: every action except the read-only gateway tools in GATEWAY_TOOL_ALLOW_LIST is forbidden.',
      policyEngineId: policyEngine.attrPolicyEngineId,
      definition: { cedar: { statement: denyUnlistedToolsStatement(prefix, manifest) } },
      validationMode: 'IGNORE_ALL_FINDINGS',
    });

    // -------------------------------------------------------------------
    // Outputs
    // -------------------------------------------------------------------

    new cdk.CfnOutput(this, 'PolicyEngineId', {
      value: policyEngine.attrPolicyEngineId,
      exportName: `${prefix}-policy-engine-id`,
    });

    new cdk.CfnOutput(this, 'PolicyEngineArn', {
      value: policyEngine.attrPolicyEngineArn,
      exportName: `${prefix}-policy-engine-arn`,
    });

  }
}
