// The Settings gateway panel told every reader, in every deployment, that a
// healthy system was broken — four dashes and the raw text "Failed to execute
// 'fetch' on 'Window': Illegal invocation". Two separate faults stacked:
// the library calls `globalThis.fetch` unbound (queued in
// docs/ui-components-queue.md, worked around at both call sites), and nothing
// distinguished "this host is not a gateway" from "the gateway is down".
//
// These pin the second half. The case that actually matters is the first one:
// a 404 is the NORMAL state here and must never read as a failure.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ProxyClientError,
  ProxyClientHttpError,
  ProxyClientNetworkError,
  ProxyClientTimeoutError,
} from '@connorhoehn/realtime-modules/proxy-client';

import { classifyGatewayError } from '../gatewayMode.ts';

test('a 404 is BFF-only, not an error — the middleware answered, it just is not a gateway', () => {
  const v = classifyGatewayError(new ProxyClientHttpError('Not Found', 404, 'Cannot GET /cluster'));
  assert.equal(v.mode, 'bff-only');
  // Load-bearing: a message here would be rendered, and there is nothing wrong.
  assert.equal(v.message, null);
});

test('a 405 counts with 404 — routed the path, refused the method, still not this API', () => {
  assert.equal(classifyGatewayError(new ProxyClientHttpError('Method Not Allowed', 405, '')).mode, 'bff-only');
});

test('a network failure is unreachable and says what to go check', () => {
  const v = classifyGatewayError(new ProxyClientNetworkError('fetch failed'));
  assert.equal(v.mode, 'unreachable');
  assert.match(v.message ?? '', /gateway is running/);
});

test('a timeout is unreachable and named as a timeout, not as a refusal', () => {
  const v = classifyGatewayError(new ProxyClientTimeoutError('timed out', 5000));
  assert.equal(v.mode, 'unreachable');
  assert.match(v.message ?? '', /Timed out/);
});

test('any other HTTP status is unreachable and carries the number', () => {
  const v = classifyGatewayError(new ProxyClientHttpError('Bad Gateway', 502, ''));
  assert.equal(v.mode, 'unreachable');
  assert.match(v.message ?? '', /502/);
});

test('a 500 is NOT read as BFF-only — only 404/405 mean "not this API"', () => {
  assert.equal(classifyGatewayError(new ProxyClientHttpError('boom', 500, '')).mode, 'unreachable');
});

test('an unrecognised throw never crashes the panel and never claims BFF-only', () => {
  for (const junk of [new Error('???'), new ProxyClientError('base'), 'a string', null, undefined]) {
    const v = classifyGatewayError(junk);
    assert.equal(v.mode, 'unreachable');
    assert.equal(typeof v.message, 'string');
  }
});
