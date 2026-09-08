/**
 * Small readers over a synthesised template.
 *
 * IAM in these stacks arrives by two routes — `inlinePolicies` on the
 * `AWS::IAM::Role` itself, and `addToPolicy()` which emits a separate
 * `AWS::IAM::Policy` attached by Ref. An assertion that only looks at one of
 * them can pass while the grant it cares about is missing, so
 * `statementsForRole` reads both.
 */
import type { Template } from 'aws-cdk-lib/assertions';

export interface Statement {
  Sid?: string;
  Effect?: string;
  Action?: string | string[];
  Resource?: any;
  Condition?: any;
}

export function resourcesOfType(template: Template, type: string): Record<string, any> {
  return template.findResources(type);
}

/** Logical id of the single resource of `type` whose properties match, or throw. */
export function logicalIdWhere(
  template: Template,
  type: string,
  predicate: (props: any) => boolean,
): string {
  const hits = Object.entries(template.findResources(type)).filter(([, r]) =>
    predicate(r.Properties ?? {}),
  );
  if (hits.length !== 1) {
    throw new Error(`expected exactly 1 ${type} matching predicate, found ${hits.length}`);
  }
  return hits[0]![0]!;
}

export function actionsOf(statement: Statement): string[] {
  const a = statement.Action;
  if (!a) return [];
  return Array.isArray(a) ? a : [a];
}

/**
 * Every IAM statement that applies to the role with this `RoleName`, whether it
 * came from `inlinePolicies` or a later `addToPolicy()`.
 */
export function statementsForRole(template: Template, roleName: string): Statement[] {
  const roles = template.findResources('AWS::IAM::Role');
  const entry = Object.entries(roles).find(
    ([, r]) => r.Properties?.RoleName === roleName,
  );
  if (!entry) {
    const seen = Object.values(roles)
      .map((r: any) => r.Properties?.RoleName)
      .filter(Boolean);
    throw new Error(`no AWS::IAM::Role named ${roleName}; found: ${seen.join(', ')}`);
  }
  const [logicalId, role] = entry;

  const statements: Statement[] = [];
  // inlinePolicies → Properties.Policies[] on the role itself
  for (const doc of (role.Properties?.Policies ?? []) as any[]) {
    statements.push(...(doc?.PolicyDocument?.Statement ?? []));
  }
  // addToPolicy() → a separate AWS::IAM::Policy referencing the role
  for (const policy of Object.values<any>(template.findResources('AWS::IAM::Policy'))) {
    const attached = (policy.Properties?.Roles ?? []) as any[];
    const targetsRole = attached.some((r) => r?.Ref === logicalId);
    if (targetsRole) statements.push(...(policy.Properties?.PolicyDocument?.Statement ?? []));
  }
  return statements;
}

/** Does any statement for this role allow every one of these actions? */
export function roleAllows(
  template: Template,
  roleName: string,
  actions: string[],
): boolean {
  const granted = new Set(
    statementsForRole(template, roleName)
      .filter((s) => (s.Effect ?? 'Allow') === 'Allow')
      .flatMap(actionsOf),
  );
  return actions.every((a) => granted.has(a));
}

/** Flatten any CloudFormation value to a searchable string. */
export function flatten(value: unknown): string {
  return JSON.stringify(value ?? null);
}

/** The `AWS::BedrockAgentCore::Runtime` with this `AgentRuntimeName`. */
export function runtimeNamed(template: Template, agentRuntimeName: string): any {
  const hits = Object.values<any>(
    template.findResources('AWS::BedrockAgentCore::Runtime'),
  ).filter((r) => r.Properties?.AgentRuntimeName === agentRuntimeName);
  if (hits.length !== 1) {
    throw new Error(
      `expected 1 runtime named ${agentRuntimeName}, found ${hits.length}`,
    );
  }
  return hits[0];
}

export function runtimeNames(template: Template): string[] {
  return Object.values<any>(template.findResources('AWS::BedrockAgentCore::Runtime'))
    .map((r) => r.Properties?.AgentRuntimeName)
    .sort();
}
