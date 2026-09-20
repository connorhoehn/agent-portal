import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { documentAssetRoute } from '../knowledge/documentAssetRoute.ts';
const gateway = 'wss://documents.example.test/ws';
const portal = 'https://portal.example.test';
describe('document asset authentication routes', () => {
  it('resolves relative and absolute gateway uploads using only document grants', () => {
    for (const src of ['/api/uploads/assessment%7Cimage', 'https://documents.example.test/api/uploads/assessment%7Cimage']) {
      const result = documentAssetRoute(src, gateway, portal);
      assert.equal(result?.auth, 'grant');
      assert.equal(result?.url.origin, 'https://documents.example.test');
    }
  });
  it('keeps source assets on the cookie-authenticated BFF', () => {
    const result = documentAssetRoute('/api/assessment/knowledge/source/asset?id=page%3A1&name=image.png', gateway, portal);
    assert.equal(result?.auth, 'session');
    assert.equal(result?.url.origin, portal);
  });
  it('never authenticates external images, lookalike hosts, ordinary gateway URLs', () => {
    for (const src of ['https://other.test/api/uploads/x', 'https://documents.example.test.attacker.test/api/uploads/x', 'https://documents.example.test/x', 'data:image/png;base64,abc']) assert.equal(documentAssetRoute(src, gateway, portal), null);
  });
});
