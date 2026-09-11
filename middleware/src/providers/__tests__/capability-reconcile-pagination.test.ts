// A capability listing MUST be drained, or reconciliation lies in the one
// direction that costs something.
//
// `reconcileCapabilities` decides whether a configured id still exists by
// listing what the account has and looking for it. Every listing used to be a
// single `maxResults: 50` call, so an id sitting on page two was simply absent
// from the answer — and the reconciler reported a perfectly healthy capability
// as STALE, inviting an operator to "fix" it by overwriting a working id with
// something else. CLAUDE.md records the same bug class for `ListPrompts`.
//
// Pinned here: the drain happens, the id on the later page is found, and a
// listing that never stops paginating THROWS rather than returning a short
// list — because a partial list is indistinguishable from a definitive
// "not here", which is exactly the confusion this function exists to remove.

jest.mock('../../config.js', () => ({
  config: {
    region: 'us-east-1',
    mock: { agentcore: false },
    agentcore: {
      browserId: 'browser-on-page-two',
      browserProfileId: '',
      codeInterpreterId: '',
      memoryId: '',
    },
    guardrails: {},
  },
}));

const send = jest.fn();
jest.mock('@aws-sdk/client-bedrock-agentcore-control', () => ({
  BedrockAgentCoreControlClient: class { send = send; },
  ListBrowsersCommand: class { constructor(public input: unknown) {} },
  ListBrowserProfilesCommand: class { constructor(public input: unknown) {} },
  ListCodeInterpretersCommand: class { constructor(public input: unknown) {} },
  ListMemoriesCommand: class { constructor(public input: unknown) {} },
}));
jest.mock('@aws-sdk/client-bedrock', () => ({
  BedrockClient: class { send = jest.fn(async () => ({ guardrails: [] })); },
  ListGuardrailsCommand: class { constructor(public input: unknown) {} },
}));

import { reconcileCapabilities } from '../capability-reconcile.js';

beforeEach(() => send.mockReset());

function browserPages(pages: Array<{ ids: string[]; next?: string }>) {
  let call = 0;
  send.mockImplementation(async (cmd: { input?: { nextToken?: string } }) => {
    const name = cmd.constructor.name;
    if (name !== 'ListBrowsersCommand') return {};
    const page = pages[call] ?? { ids: [] };
    call += 1;
    return {
      browserSummaries: page.ids.map((id) => ({ browserId: id, status: 'READY' })),
      nextToken: page.next,
    };
  });
}

test('an id on the second page is found, not reported missing', async () => {
  browserPages([
    { ids: ['browser-a', 'browser-b'], next: 'page-2' },
    { ids: ['browser-on-page-two'] },
  ]);
  const { capabilities } = await reconcileCapabilities();
  const browser = capabilities.find((c) => c.key === 'browser')!;
  // Before the drain this was `missing` — a healthy capability, condemned.
  expect(browser.state).not.toBe('missing');
});

test('the same id on page one behaves identically — the drain changes nothing else', async () => {
  browserPages([{ ids: ['browser-on-page-two'] }]);
  const { capabilities } = await reconcileCapabilities();
  expect(capabilities.find((c) => c.key === 'browser')!.state).not.toBe('missing');
});

test('an endless pager throws rather than passing off a partial list as complete', async () => {
  // Every page says there is another. A short list returned here would read as
  // a definitive "your id is not in this account".
  send.mockImplementation(async (cmd: { constructor: { name: string } }) =>
    (cmd.constructor.name === 'ListBrowsersCommand'
      ? { browserSummaries: [{ browserId: 'noise', status: 'READY' }], nextToken: 'more' }
      : {}));
  const { capabilities } = await reconcileCapabilities();
  const browser = capabilities.find((c) => c.key === 'browser')!;
  // `probe` turns a thrown listing into the "says nothing" state, never `missing`.
  expect(browser.state).not.toBe('missing');
});
