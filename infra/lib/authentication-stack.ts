import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import type { Construct } from 'constructs';

export interface AuthenticationStackProps extends cdk.StackProps {
  readonly prefix?: string;
  /** OAuth callback URLs registered on the app client. The BFF callback is
   * `<origin>/api/auth/callback`. Cognito requires HTTPS except for localhost. */
  readonly callbackUrls?: string[];
  /** Post-logout redirect URLs (portal roots). */
  readonly logoutUrls?: string[];
}

/**
 * OrgIQ-Authentication: the enterprise sign-in identity provider.
 *
 * A Cognito User Pool + Hosted-UI domain + a confidential app client (OIDC
 * authorization-code + PKCE). The middleware BFF drives the flow and mints its
 * own signed session cookie from the resolved OrgIQ user — Cognito is only the
 * authenticator, so this stack is additive and independently destroyable. When
 * these outputs aren't wired into the middleware, the picker login stays the
 * only sign-in path (demo/local dev).
 *
 * Deploy: cdk deploy OrgIQ-Authentication [--context authCallbackUrls=https://host/api/auth/callback,...]
 * Seed users (emails mirror app_users) are created suppressed; set passwords
 * post-deploy with `aws cognito-idp admin-set-user-password --permanent`.
 */
export class AuthenticationStack extends cdk.Stack {
  public readonly userPoolId: string;
  public readonly userPoolClientId: string;
  public readonly hostedUiDomain: string;
  public readonly clientSecretArn: string;

  constructor(scope: Construct, id: string, props?: AuthenticationStackProps) {
    super(scope, id, props);

    const prefix = props?.prefix ?? 'orgiq';

    // localhost dev callbacks are always registered so the flow is testable
    // against the real pool from a laptop; production HTTPS callbacks come in
    // via context (they must be HTTPS — Cognito rejects non-localhost http).
    const devCallbacks = [
      'http://localhost:3001/api/auth/callback',
      'http://localhost:3199/api/auth/callback',
      'http://localhost:5183/api/auth/callback',
    ];
    const devLogouts = ['http://localhost:5183/', 'http://localhost:3001/'];
    const callbackUrls = [...new Set([...devCallbacks, ...(props?.callbackUrls ?? [])])];
    const logoutUrls = [...new Set([...devLogouts, ...(props?.logoutUrls ?? [])])];

    const pool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `${prefix}-users`,
      selfSignUpEnabled: false, // admin-provisioned identities only
      signInAliases: { email: true },
      standardAttributes: {
        email: { required: true, mutable: true },
        fullname: { required: false, mutable: true },
      },
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      // Demo pool: destroy with the stack. Flip to RETAIN before real users exist.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    this.userPoolId = pool.userPoolId;

    const domain = pool.addDomain('HostedUiDomain', {
      cognitoDomain: { domainPrefix: `${prefix}-auth-${this.account}` },
    });
    // baseUrl() → https://<prefix>-auth-<account>.auth.<region>.amazoncognito.com
    this.hostedUiDomain = domain.baseUrl();

    const client = pool.addClient('PortalClient', {
      userPoolClientName: `${prefix}-portal`,
      generateSecret: true, // confidential client — BFF holds the secret
      // userSrp for the Hosted UI; adminUserPassword lets the middleware (and
      // demo scripts / tests) obtain tokens server-side via AdminInitiateAuth
      // without driving a browser — handy for a headless demo login path.
      authFlows: { userSrp: true, adminUserPassword: true },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls,
        logoutUrls,
      },
      preventUserExistenceErrors: true,
      accessTokenValidity: cdk.Duration.hours(1),
      idTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(30),
    });
    this.userPoolClientId = client.userPoolClientId;

    // Stash the client secret in Secrets Manager so the ECS task can inject it
    // as COGNITO_CLIENT_SECRET without it ever appearing in a CFN output.
    const clientSecret = new secretsmanager.Secret(this, 'ClientSecret', {
      secretName: `${prefix}-cognito-client-secret`,
      description: 'OrgIQ Cognito app-client secret (BFF token exchange)',
      secretStringValue: client.userPoolClientSecret,
    });
    this.clientSecretArn = clientSecret.secretArn;

    // Seed users — emails mirror schema/identity_schema.sql app_users so the BFF
    // resolves them by email on first login and links external_sub. Created with
    // suppressed invites; set permanent passwords post-deploy via the CLI.
    const seedUsers: Array<{ email: string; name: string }> = [
      { email: 'operator@orgiq.example', name: 'Platform Operator' },
      { email: 'theo.chang@orgiq.example', name: 'Theo Chang' },
      { email: 'vera.green@orgiq.example', name: 'Vera Green' },
      { email: 'priya.desai@orgiq.example', name: 'Priya Desai' },
      // Program operating model cast (docs/program-operating-model.md). Without
      // these, the release manager and the SMEs — the roles the model is built
      // around — could only reach the app through the dev-only picker, which
      // is disabled in production. Emails match schema/identity_schema.sql, so
      // the BFF resolves each to its existing app_user on first login rather
      // than creating a duplicate.
      { email: 'sienna.garcia@orgiq.example', name: 'Sienna Garcia' },
      { email: 'rachel.kowalski@orgiq.example', name: 'Rachel Kowalski' },
      { email: 'mia.singh@orgiq.example', name: 'Mia Singh' },
      { email: 'nora.dasilva@orgiq.example', name: 'Nora DaSilva' },
      { email: 'eli.garcia@orgiq.example', name: 'Eli Garcia' },
      { email: 'layla.hassan@orgiq.example', name: 'Layla Hassan' },
      { email: 'caleb.turner@orgiq.example', name: 'Caleb Turner' },
      // Assessment tenant cast (docs/assessment-tenant.md) — the seed and the
      // docs already named them; the pool did not, so they could reach the
      // app only through the dev-only picker.
      { email: 'asha.nair@assessment.example', name: 'Asha Nair' },
      { email: 'jonas.lindqvist@assessment.example', name: 'Jonas Lindqvist' },
      { email: 'farah.osei@assessment.example', name: 'Farah Osei' },
      // Social tenant cast (docs/social-tenant-design.md §4.1).
      { email: 'mira.okafor@social.example', name: 'Mira Okafor' },
      { email: 'lena.brandt@social.example', name: 'Lena Brandt' },
      { email: 'sana.iqbal@social.example', name: 'Sana Iqbal' },
      // Pipelines tenant cast (docs/pipelines-tenant-goal.md §Cast).
      { email: 'ines.moreau@orgiq.example', name: 'Ines Moreau' },
      { email: 'kofi.mensah@orgiq.example', name: 'Kofi Mensah' },
      { email: 'dara.whitfield@orgiq.example', name: 'Dara Whitfield' },
    ];
    for (const u of seedUsers) {
      new cognito.CfnUserPoolUser(this, `SeedUser-${u.email.replace(/[^a-z0-9]/gi, '-')}`, {
        userPoolId: pool.userPoolId,
        username: u.email,
        messageAction: 'SUPPRESS',
        desiredDeliveryMediums: ['EMAIL'],
        userAttributes: [
          { name: 'email', value: u.email },
          { name: 'email_verified', value: 'true' },
          { name: 'name', value: u.name },
        ],
      });
    }

    new cdk.CfnOutput(this, 'UserPoolId', {
      value: pool.userPoolId, exportName: `${prefix}-cognito-user-pool-id`,
    });
    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: client.userPoolClientId, exportName: `${prefix}-cognito-client-id`,
    });
    new cdk.CfnOutput(this, 'HostedUiDomain', {
      value: this.hostedUiDomain, exportName: `${prefix}-cognito-domain`,
    });
    new cdk.CfnOutput(this, 'ClientSecretArn', {
      value: clientSecret.secretArn, exportName: `${prefix}-cognito-client-secret-arn`,
    });
    // Convenience for local testing: the exact login URL to open.
    new cdk.CfnOutput(this, 'LoginUrl', {
      value: `${this.hostedUiDomain}/login?client_id=${client.userPoolClientId}&response_type=code&scope=openid+email+profile&redirect_uri=http://localhost:3001/api/auth/callback`,
    });
  }
}
