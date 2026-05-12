import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as verifiedpermissions from 'aws-cdk-lib/aws-verifiedpermissions';
import type { Construct } from 'constructs';

export interface AuthorizationStackProps extends cdk.StackProps {
  readonly prefix?: string;
}

/**
 * OrgIQ-Authorization: AWS Verified Permissions policy store + the signing-key
 * secret the middleware uses to mint signed session cookies.
 *
 * Policies are NOT managed here — they're seeded by the middleware on first
 * boot from middleware/seeds/*.cedar, then edited at runtime via the
 * Identity Management UI. This means `cdk deploy` does not overwrite live
 * Cedar policies after the initial seed.
 *
 * Schema starts from middleware/seeds/schema.json but can also be updated via
 * the UI at runtime (AVP PutSchema). CDK will only push schema changes if the
 * source JSON in this repo changes.
 */
export class AuthorizationStack extends cdk.Stack {
  public readonly policyStoreId: string;
  public readonly policyStoreArn: string;
  public readonly sessionSigningSecretArn: string;

  constructor(scope: Construct, id: string, props?: AuthorizationStackProps) {
    super(scope, id, props);

    const prefix = props?.prefix ?? 'orgiq';
    // Initial schema is sourced from the middleware seeds — single source of
    // truth so both CDK and the middleware boot path read the same JSON.
    const schemaJson = readFileSync(
      join(__dirname, '..', '..', 'middleware', 'seeds', 'schema.json'),
      'utf8',
    );

    const store = new verifiedpermissions.CfnPolicyStore(this, 'PolicyStore', {
      description: 'OrgIQ Cedar policies — runtime-managed by middleware after first-boot seed',
      validationSettings: { mode: 'STRICT' },
      schema: { cedarJson: schemaJson },
    });
    this.policyStoreId = store.attrPolicyStoreId;
    this.policyStoreArn = store.attrArn;

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
