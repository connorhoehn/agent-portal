// The SDK dispatch queue is opt-in (SOCIAL_DYNAMO_DISPATCH_QUEUE=1): it
// regressed the unchanged burst profile, so the default is the plain client.
jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', aurora: {}, auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: true } },
}));
jest.mock('../role-registry.js', () => ({ roleRegistry: () => [] }));
const constructed = jest.fn();
jest.mock('../dynamo-dispatch.js', () => {
  const actual = jest.requireActual('../dynamo-dispatch.js');
  class Spy extends actual.DynamoDispatchQueue {
    constructor(...args: unknown[]) { super(...(args as [any, number])); constructed(); }
  }
  return { ...actual, DynamoDispatchQueue: Spy };
});

import { createSocialChatBackend } from '../realtime-gateway.js';
import type { SocialChatConfig } from '../social-chat.js';

const cfg = { store: 'dynamo', region: 'us-east-1', endpoint: 'http://127.0.0.1:1', tablePrefix: 'optin-test-' } as unknown as SocialChatConfig;
const prev = process.env['SOCIAL_DYNAMO_DISPATCH_QUEUE'];
afterEach(() => {
  constructed.mockClear();
  if (prev === undefined) delete process.env['SOCIAL_DYNAMO_DISPATCH_QUEUE']; else process.env['SOCIAL_DYNAMO_DISPATCH_QUEUE'] = prev;
});

it('does not construct the dispatch queue by default', () => {
  delete process.env['SOCIAL_DYNAMO_DISPATCH_QUEUE'];
  createSocialChatBackend(cfg);
  expect(constructed).not.toHaveBeenCalled();
});

it('constructs it only when SOCIAL_DYNAMO_DISPATCH_QUEUE=1', () => {
  process.env['SOCIAL_DYNAMO_DISPATCH_QUEUE'] = '1';
  createSocialChatBackend(cfg);
  expect(constructed).toHaveBeenCalledTimes(1);
});
