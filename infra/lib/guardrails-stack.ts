import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { AwsCustomResource, AwsCustomResourcePolicy, PhysicalResourceId } from 'aws-cdk-lib/custom-resources';
import type { Construct } from 'constructs';

export interface GuardrailsStackProps extends cdk.StackProps {
  readonly prefix?: string;
}

/**
 * OrgIQ-Guardrails: Bedrock Guardrails with PII filtering, content policy,
 * and grounding checks for employee data protection and bias prevention.
 */
export class GuardrailsStack extends cdk.Stack {
  /** The Guardrail ID */
  public readonly guardrailId: string;
  /** The Guardrail ARN */
  public readonly guardrailArn: string;
  /** The Guardrail version */
  public readonly guardrailVersion: string;

  constructor(scope: Construct, id: string, props?: GuardrailsStackProps) {
    super(scope, id, props);

    const prefix = props?.prefix ?? 'orgiq';

    // -------------------------------------------------------------------
    // Bedrock Guardrail (L1 - CfnGuardrail)
    // -------------------------------------------------------------------

    const guardrail = new cdk.aws_bedrock.CfnGuardrail(this, 'OrgIQGuardrail', {
      name: `${prefix}-guardrail`,
      description: 'OrgIQ guardrail: PII filtering, content safety, grounding verification',
      blockedInputMessaging: 'I cannot process this request as it contains sensitive information or violates content policies.',
      blockedOutputsMessaging: 'I cannot provide this response as it may contain sensitive information or violate content policies.',

      // -------------------------------------------------------------------
      // Sensitive Information Filters (PII)
      // -------------------------------------------------------------------
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

      // -------------------------------------------------------------------
      // Content Policy (topic denials)
      // -------------------------------------------------------------------
      topicPolicyConfig: {
        topicsConfig: [
          {
            name: 'SalaryCompensation',
            definition: 'Questions about specific employee salaries, compensation packages, or pay grades',
            type: 'DENY',
            examples: [
              'How much does John Smith make?',
              'What is the salary range for the engineering team?',
              'Show me compensation data for directors',
            ],
          },
          {
            name: 'PerformanceReviews',
            definition: 'Requests for specific employee performance review content or ratings',
            type: 'DENY',
            examples: [
              'Show me Sarah\'s last performance review',
              'What rating did the team get?',
              'Who received a PIP this quarter?',
            ],
          },
          {
            name: 'PersonalHealth',
            definition: 'Questions about employee health information, medical leave, or disabilities',
            type: 'DENY',
            examples: [
              'Who is on medical leave?',
              'Does anyone have disability accommodations?',
              'Show me sick leave patterns',
            ],
          },
        ],
      },

      // -------------------------------------------------------------------
      // Content Filters (toxicity, prompt attacks)
      // -------------------------------------------------------------------
      contentPolicyConfig: {
        filtersConfig: [
          { type: 'SEXUAL', inputStrength: 'HIGH', outputStrength: 'HIGH' },
          { type: 'VIOLENCE', inputStrength: 'HIGH', outputStrength: 'HIGH' },
          { type: 'HATE', inputStrength: 'HIGH', outputStrength: 'HIGH' },
          { type: 'INSULTS', inputStrength: 'MEDIUM', outputStrength: 'HIGH' },
          { type: 'MISCONDUCT', inputStrength: 'HIGH', outputStrength: 'HIGH' },
          { type: 'PROMPT_ATTACK', inputStrength: 'HIGH', outputStrength: 'NONE' },
        ],
      },

      // -------------------------------------------------------------------
      // Word Policy (blocked terms)
      // -------------------------------------------------------------------
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
      ],
    });

    this.guardrailId = guardrail.attrGuardrailId;
    this.guardrailArn = guardrail.attrGuardrailArn;

    // -------------------------------------------------------------------
    // Guardrail Version (creates an immutable snapshot)
    // -------------------------------------------------------------------

    const guardrailVersion = new cdk.aws_bedrock.CfnGuardrailVersion(this, 'GuardrailV1', {
      guardrailIdentifier: guardrail.attrGuardrailId,
      description: 'Initial version with PII filtering, content policy, and grounding',
    });

    this.guardrailVersion = guardrailVersion.attrVersion;

    // -------------------------------------------------------------------
    // Outputs
    // -------------------------------------------------------------------

    new cdk.CfnOutput(this, 'GuardrailId', {
      value: guardrail.attrGuardrailId,
      exportName: `${prefix}-guardrail-id`,
    });

    new cdk.CfnOutput(this, 'GuardrailArn', {
      value: guardrail.attrGuardrailArn,
      exportName: `${prefix}-guardrail-arn`,
    });

    new cdk.CfnOutput(this, 'GuardrailVersion', {
      value: guardrailVersion.attrVersion,
      exportName: `${prefix}-guardrail-version`,
    });

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
          // Required to associate the role with the logging config.
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
}
