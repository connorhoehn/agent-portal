import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as verifiedpermissions from 'aws-cdk-lib/aws-verifiedpermissions';
import type { Construct } from 'constructs';

export interface AuthorizationStackProps extends cdk.StackProps {
  readonly prefix?: string;
}

const ROLES = ['member', 'org-leader', 'hr-admin'] as const;
type Role = typeof ROLES[number];

/**
 * OrgIQ-Authorization: AWS Verified Permissions policy store + Cedar policies
 * for the three masquerade roles, plus a signing-key secret consumed by the
 * middleware to mint signed session cookies.
 *
 * The middleware calls AVP IsAuthorized on every request that touches a gated
 * action. Cedar source files live in infra/policies/*.cedar; this stack ships
 * them verbatim so AVP is the source of truth at runtime.
 */
export class AuthorizationStack extends cdk.Stack {
  public readonly policyStoreId: string;
  public readonly policyStoreArn: string;
  public readonly sessionSigningSecretArn: string;

  constructor(scope: Construct, id: string, props?: AuthorizationStackProps) {
    super(scope, id, props);

    const prefix = props?.prefix ?? 'orgiq';
    const policiesDir = join(__dirname, '..', 'policies');
    const schemaJson = readFileSync(join(policiesDir, 'schema.json'), 'utf8');

    const store = new verifiedpermissions.CfnPolicyStore(this, 'PolicyStore', {
      description: 'OrgIQ Cedar policies for member / org-leader / hr-admin masquerade roles',
      validationSettings: { mode: 'STRICT' },
      schema: { cedarJson: schemaJson },
    });
    this.policyStoreId = store.attrPolicyStoreId;
    this.policyStoreArn = store.attrArn;

    for (const role of ROLES) {
      const cedar = readFileSync(join(policiesDir, `${role}.cedar`), 'utf8');
      const pascal = role.split('-').map(s => s[0]!.toUpperCase() + s.slice(1)).join('');
      new verifiedpermissions.CfnPolicy(this, `${pascal}Policy`, {
        policyStoreId: store.attrPolicyStoreId,
        definition: {
          static: {
            description: `OrgIQ ${role} role permissions`,
            statement: cedar,
          },
        },
      });
    }

    // Cookie-signing secret. Middleware reads this on boot and uses HMAC-SHA256
    // to sign the session cookie payload. Rotating the secret forces every
    // active session to re-authenticate.
    const signingKey = new secretsmanager.Secret(this, 'SessionSigningKey', {
      secretName: `${prefix}-session-signing-key`,
      description: 'HMAC key the middleware uses to sign session cookies',
      generateSecretString: {
        passwordLength: 64,
        excludePunctuation: true,
        includeSpace: false,
      },
    });
    this.sessionSigningSecretArn = signingKey.secretArn;

    new cdk.CfnOutput(this, 'PolicyStoreId', {
      value: store.attrPolicyStoreId,
      exportName: `${prefix}-policy-store-id`,
    });
    new cdk.CfnOutput(this, 'PolicyStoreArn', {
      value: store.attrArn,
      exportName: `${prefix}-policy-store-arn`,
    });
    new cdk.CfnOutput(this, 'SessionSigningSecretArn', {
      value: signingKey.secretArn,
      exportName: `${prefix}-session-signing-secret-arn`,
    });
  }
}
