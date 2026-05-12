import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { AwsCustomResource, AwsCustomResourcePolicy, PhysicalResourceId } from 'aws-cdk-lib/custom-resources';
import type { Construct } from 'constructs';

export interface GuardrailsStackProps extends cdk.StackProps {
  readonly prefix?: string;
}

type RoleSlug = 'member' | 'org-leader' | 'hr-admin';

interface RoleGuardrail {
  readonly id: string;
  readonly arn: string;
  readonly version: string;
}

// Topic policies are the only role-varying knob. PII / content / word policies
// stay identical across all three guardrails so the security floor is uniform.
const TOPIC_SALARY = {
  name: 'SalaryCompensation',
  definition: 'Questions about specific employee salaries, compensation packages, or pay grades',
  type: 'DENY' as const,
  examples: [
    'How much does John Smith make?',
    'What is the salary range for the engineering team?',
    'Show me compensation data for directors',
  ],
};

const TOPIC_PERFORMANCE = {
  name: 'PerformanceReviews',
  definition: 'Requests for specific employee performance review content or ratings',
  type: 'DENY' as const,
  examples: [
    "Show me Sarah's last performance review",
    'What rating did the team get?',
    'Who received a PIP this quarter?',
  ],
};

const TOPIC_HEALTH = {
  name: 'PersonalHealth',
  definition: 'Questions about employee health information, medical leave, or disabilities',
  type: 'DENY' as const,
  examples: [
    'Who is on medical leave?',
    'Does anyone have disability accommodations?',
    'Show me sick leave patterns',
  ],
};

const ROLE_TOPICS: Record<RoleSlug, ReadonlyArray<typeof TOPIC_SALARY>> = {
  // Strictest — IC default. Blocks all sensitive HR topics.
  member: [TOPIC_SALARY, TOPIC_PERFORMANCE, TOPIC_HEALTH],
  // Org chart + leaderboard visibility, but still no salary/perf/health.
  'org-leader': [TOPIC_SALARY, TOPIC_PERFORMANCE, TOPIC_HEALTH],
  // HR has business need for salary + performance content. Health stays denied
  // (privacy-floor; HRIS access is the right surface for medical-leave queries).
  'hr-admin': [TOPIC_HEALTH],
};

/**
 * OrgIQ-Guardrails: three role-keyed Bedrock Guardrails that share a common
 * PII / content / word-policy floor and differ only in topic denials. Middleware
 * picks the right guardrail at agent-invoke time based on the caller's role.
 */
export class GuardrailsStack extends cdk.Stack {
  /** Per-role guardrail IDs / ARNs. */
  public readonly guardrails: Record<RoleSlug, RoleGuardrail>;
  /** Back-compat: the member (strictest) guardrail. */
  public readonly guardrailId: string;
  public readonly guardrailArn: string;
  public readonly guardrailVersion: string;

  constructor(scope: Construct, id: string, props?: GuardrailsStackProps) {
    super(scope, id, props);

    const prefix = props?.prefix ?? 'orgiq';

    const built: Partial<Record<RoleSlug, RoleGuardrail>> = {};
    for (const role of ['member', 'org-leader', 'hr-admin'] as RoleSlug[]) {
      built[role] = this.makeGuardrail(prefix, role, ROLE_TOPICS[role]);
    }
    this.guardrails = built as Record<RoleSlug, RoleGuardrail>;

    // Back-compat surface: existing consumers (agents-stack, agentcore-policy-stack)
    // hold a single guardrail ARN — wire them to the strictest (member) guardrail
    // so they continue to enforce the most restrictive baseline by default.
    this.guardrailId = this.guardrails.member.id;
    this.guardrailArn = this.guardrails.member.arn;
    this.guardrailVersion = this.guardrails.member.version;

    // -------------------------------------------------------------------
    // Bedrock Model Invocation Logging — account-wide
    //
    // Captures every Bedrock InvokeModel / Converse / ConverseStream call
    // (and its guardrail assessment, if any) to a CloudWatch log group. This
    // is the per-event source of truth for guardrail interventions — far
    // higher fidelity than the lagging CloudWatch metric counts.
    //
    // There's no CFN type for PutModelInvocationLoggingConfiguration, so we
    // use an SDK-call custom resource. The configuration is global per
    // (account, region), so this lives once here in the Guardrails stack.
    // -------------------------------------------------------------------

    const invocationLogGroup = new logs.LogGroup(this, 'BedrockInvocationLogs', {
      logGroupName: `/${prefix}/bedrock-invocations`,
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const loggingRole = new iam.Role(this, 'BedrockInvocationLoggingRole', {
      roleName: `${prefix}-bedrock-invocation-logging-role`,
      assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com'),
      description: 'Role Bedrock uses to write model invocation logs',
    });
    invocationLogGroup.grantWrite(loggingRole);

    const loggingConfig = new AwsCustomResource(this, 'BedrockInvocationLoggingConfig', {
      onCreate: {
        service: 'bedrock',
        action: 'PutModelInvocationLoggingConfiguration',
        parameters: {
          loggingConfig: {
            cloudWatchConfig: {
              logGroupName: invocationLogGroup.logGroupName,
              roleArn: loggingRole.roleArn,
            },
            textDataDeliveryEnabled: true,
            imageDataDeliveryEnabled: false,
            embeddingDataDeliveryEnabled: false,
            videoDataDeliveryEnabled: false,
          },
        },
        physicalResourceId: PhysicalResourceId.of(`${prefix}-bedrock-invocation-logging`),
      },
      onUpdate: {
        service: 'bedrock',
        action: 'PutModelInvocationLoggingConfiguration',
        parameters: {
          loggingConfig: {
            cloudWatchConfig: {
              logGroupName: invocationLogGroup.logGroupName,
              roleArn: loggingRole.roleArn,
            },
            textDataDeliveryEnabled: true,
            imageDataDeliveryEnabled: false,
            embeddingDataDeliveryEnabled: false,
            videoDataDeliveryEnabled: false,
          },
        },
        physicalResourceId: PhysicalResourceId.of(`${prefix}-bedrock-invocation-logging`),
      },
      onDelete: {
        service: 'bedrock',
        action: 'DeleteModelInvocationLoggingConfiguration',
      },
      policy: AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: [
            'bedrock:PutModelInvocationLoggingConfiguration',
            'bedrock:DeleteModelInvocationLoggingConfiguration',
            'bedrock:GetModelInvocationLoggingConfiguration',
          ],
          resources: ['*'],
        }),
        new iam.PolicyStatement({
          actions: ['iam:PassRole'],
          resources: [loggingRole.roleArn],
        }),
      ]),
    });
    loggingConfig.node.addDependency(loggingRole);

    new cdk.CfnOutput(this, 'InvocationLogGroupName', {
      value: invocationLogGroup.logGroupName,
      description: 'CloudWatch log group capturing Bedrock invocation logs (incl. guardrail trace)',
      exportName: `${prefix}-bedrock-invocation-log-group`,
    });
  }

  private makeGuardrail(prefix: string, role: RoleSlug, topics: ReadonlyArray<typeof TOPIC_SALARY>): RoleGuardrail {
    const pascal = role.split('-').map(s => s[0]!.toUpperCase() + s.slice(1)).join('');
    const guardrail = new cdk.aws_bedrock.CfnGuardrail(this, `OrgIQGuardrail${pascal}`, {
      name: `${prefix}-guardrail-${role}`,
      description: `OrgIQ guardrail for role=${role}: PII + content safety + topic denials`,
      blockedInputMessaging: 'I cannot process this request as it contains sensitive information or violates content policies.',
      blockedOutputsMessaging: 'I cannot provide this response as it may contain sensitive information or violate content policies.',

      sensitiveInformationPolicyConfig: {
        piiEntitiesConfig: [
          // EMAIL and PHONE intentionally omitted — org directory queries legitimately
          // return colleague contact info; anonymizing breaks the core search use case.
          { type: 'US_SOCIAL_SECURITY_NUMBER', action: 'BLOCK' },
          { type: 'CREDIT_DEBIT_CARD_NUMBER', action: 'BLOCK' },
          { type: 'AWS_ACCESS_KEY', action: 'BLOCK' },
          { type: 'AWS_SECRET_KEY', action: 'BLOCK' },
          { type: 'IP_ADDRESS', action: 'ANONYMIZE' },
          { type: 'US_BANK_ACCOUNT_NUMBER', action: 'BLOCK' },
          { type: 'DRIVER_ID', action: 'BLOCK' },
          { type: 'US_PASSPORT_NUMBER', action: 'BLOCK' },
        ],
        regexesConfig: [
          {
            name: 'InternalEmployeeId',
            description: 'Block internal employee ID patterns',
            pattern: 'EMP-[0-9]{6,8}',
            action: 'ANONYMIZE',
          },
        ],
      },

      // CfnGuardrail rejects topicPolicyConfig with an empty topicsConfig list,
      // so omit the whole block when a role denies no topics (hr-admin).
      ...(topics.length > 0 && {
        topicPolicyConfig: { topicsConfig: [...topics] },
      }),

      contentPolicyConfig: {
        filtersConfig: [
          { type: 'SEXUAL', inputStrength: 'HIGH', outputStrength: 'HIGH' },
          { type: 'VIOLENCE', inputStrength: 'HIGH', outputStrength: 'HIGH' },
          { type: 'HATE', inputStrength: 'HIGH', outputStrength: 'HIGH' },
          { type: 'INSULTS', inputStrength: 'MEDIUM', outputStrength: 'HIGH' },
          { type: 'MISCONDUCT', inputStrength: 'HIGH', outputStrength: 'HIGH' },
          // MEDIUM (not HIGH) — HIGH false-positives on long structured agentic
          // prompts (multi-step "do X, then Y, then summarize" patterns) which
          // are legitimate use of the supervisor's run_in_sandbox tool.
          { type: 'PROMPT_ATTACK', inputStrength: 'MEDIUM', outputStrength: 'NONE' },
        ],
      },

      wordPolicyConfig: {
        wordsConfig: [
          { text: 'fire someone' },
          { text: 'terminate employee' },
          { text: 'layoff list' },
        ],
        managedWordListsConfig: [
          { type: 'PROFANITY' },
        ],
      },

      tags: [
        { key: 'Project', value: 'OrgIQ' },
        { key: 'Service', value: 'Bedrock Guardrails' },
        { key: 'Role', value: role },
      ],
    });

    const version = new cdk.aws_bedrock.CfnGuardrailVersion(this, `Guardrail${pascal}V1`, {
      guardrailIdentifier: guardrail.attrGuardrailId,
      description: `Initial version of role=${role} guardrail`,
    });

    new cdk.CfnOutput(this, `Guardrail${pascal}Id`, {
      value: guardrail.attrGuardrailId,
      exportName: `${prefix}-guardrail-id-${role}`,
    });
    new cdk.CfnOutput(this, `Guardrail${pascal}Arn`, {
      value: guardrail.attrGuardrailArn,
      exportName: `${prefix}-guardrail-arn-${role}`,
    });

    // Back-compat exports — point the legacy single-guardrail names at member.
    if (role === 'member') {
      new cdk.CfnOutput(this, 'GuardrailId', {
        value: guardrail.attrGuardrailId,
        exportName: `${prefix}-guardrail-id`,
      });
      new cdk.CfnOutput(this, 'GuardrailArn', {
        value: guardrail.attrGuardrailArn,
        exportName: `${prefix}-guardrail-arn`,
      });
      new cdk.CfnOutput(this, 'GuardrailVersion', {
        value: version.attrVersion,
        exportName: `${prefix}-guardrail-version`,
      });
    }

    return {
      id: guardrail.attrGuardrailId,
      arn: guardrail.attrGuardrailArn,
      version: version.attrVersion,
    };
  }
}
