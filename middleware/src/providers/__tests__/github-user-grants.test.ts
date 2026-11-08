// The actor's GitHub user token is read only from a secret under
// `<PROJECT_PREFIX>/github-user/` (sweep 4 M4, docs/microvm-runner-design.md §8).
// The BFF's task role can also read `<prefix>/github-app*`; a grant row naming
// that secret must be refused before Secrets Manager is ever called.

jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));

const send = jest.fn(async () => ({ SecretString: '{"access_token":"ghu_user_token"}' }));
jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn().mockImplementation(() => ({ send })),
  GetSecretValueCommand: jest.fn().mockImplementation((input: unknown) => ({ input })),
}));

import { githubUserSecretArnAllowed, readGithubUserToken } from '../github-user-grants.js';

const ACCT = '111122223333';
const arn = (name: string) => `arn:aws:secretsmanager:us-east-1:${ACCT}:secret:${name}`;
const ENV = { PROJECT_PREFIX: 'orgiq' } as NodeJS.ProcessEnv;

beforeEach(() => send.mockClear());

describe('readGithubUserToken: only <prefix>/github-user/ secrets', () => {
  it('reads a user secret under the grants prefix', async () => {
    await expect(readGithubUserToken(arn('orgiq/github-user/u-nora-AbCdEf'), ENV)).resolves.toBe('ghu_user_token');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('refuses a crafted ARN naming the GitHub App secret, and never calls Secrets Manager', async () => {
    for (const crafted of [
      arn('orgiq/github-app-AbCdEf'),
      arn('orgiq/github-app'),
      arn('orgiq/github-userx/u-nora'),
      arn('orgiq/github-user/'),
      arn('other/github-user/u-nora-AbCdEf'),
      arn('orgiq/github-user-u-nora'),
      `${arn('orgiq/github-app-AbCdEf')}#orgiq/github-user/u-nora`,
      'orgiq/github-user/u-nora',
      `arn:aws:secretsmanager:us-east-1:${ACCT}:secret:xorgiq/github-user/u-nora`,
    ]) {
      await expect(readGithubUserToken(crafted, ENV)).rejects.toThrow(/github-user/);
      expect(githubUserSecretArnAllowed(crafted, ENV)).toBe(false);
    }
    expect(send).not.toHaveBeenCalled();
  });

  it('follows PROJECT_PREFIX, defaulting to orgiq', () => {
    expect(githubUserSecretArnAllowed(arn('acme/github-user/u-1'), { PROJECT_PREFIX: 'acme' } as NodeJS.ProcessEnv)).toBe(true);
    expect(githubUserSecretArnAllowed(arn('orgiq/github-user/u-1'), { PROJECT_PREFIX: 'acme' } as NodeJS.ProcessEnv)).toBe(false);
    expect(githubUserSecretArnAllowed(arn('orgiq/github-user/u-1'), {} as NodeJS.ProcessEnv)).toBe(true);
    // A prefix is matched literally, never as a pattern.
    expect(githubUserSecretArnAllowed(arn('orgiqX/github-user/u-1'), { PROJECT_PREFIX: 'orgiq.' } as NodeJS.ProcessEnv)).toBe(false);
  });
});
