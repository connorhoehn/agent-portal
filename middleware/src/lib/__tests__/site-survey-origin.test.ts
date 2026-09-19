jest.mock('../public-web-fetch.js', () => ({ publicWebFetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args) }));
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', agentcore: {} } }));
jest.mock('../../providers/index.js', () => ({ agentcore: {} }));
jest.mock('../vision-extractor.js', () => ({ extractFromScreenshot: jest.fn() }));
jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: class { async send() { return { output: { message: { content: [{ text: '{"sections":[]}' }] } } }; } },
  ConverseCommand: class {},
}));

import { startSurvey } from '../site-survey.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

it('follows actual same-origin links but not a hostname or port with the same prefix', async () => {
  const requested: string[] = [];
  globalThis.fetch = jest.fn(async (input: string | URL | Request) => {
    const url = String(input);
    requested.push(url);
    if (url.endsWith('/robots.txt')) return new Response('', { status: 404 });
    const html = url === 'https://example.com/'
      ? '<a href="/docs">Local</a><a href="https://example.com.evil.test/private">Host</a><a href="https://example.com:8443/private">Port</a>'
      : '<p>Documentation</p>';
    return new Response(html, { headers: { 'content-type': 'text/html' } });
  }) as typeof fetch;
  const survey = await startSurvey({ startUrl: 'https://example.com/', useBrowserFallback: false });
  // The background survey uses resolved fake network calls; drain its work
  // without introducing real HTTP, AWS calls or a wall-clock sleep.
  for (let i = 0; i < 100 && survey.status === 'running'; i++) {
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  expect(survey.status).toBe('completed');
  expect(requested).toEqual(['https://example.com/robots.txt', 'https://example.com/', 'https://example.com/docs']);
});
