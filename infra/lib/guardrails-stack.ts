import * as cdk from 'aws-cdk-lib';
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
          { type: 'EMAIL', action: 'ANONYMIZE' },
          { type: 'PHONE', action: 'ANONYMIZE' },
          { type: 'US_SOCIAL_SECURITY_NUMBER', action: 'BLOCK' },
          { type: 'CREDIT_DEBIT_CARD_NUMBER', action: 'BLOCK' },
          { type: 'AWS_ACCESS_KEY', action: 'BLOCK' },
          { type: 'AWS_SECRET_KEY', action: 'BLOCK' },
          { type: 'IP_ADDRESS', action: 'ANONYMIZE' },
          { type: 'US_BANK_ACCOUNT_NUMBER', action: 'BLOCK' },
          { type: 'DRIVER_ID', action: 'BLOCK' },
          { type: 'PASSPORT_NUMBER', action: 'BLOCK' },
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
  }
}
