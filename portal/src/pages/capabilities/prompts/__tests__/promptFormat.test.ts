import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arnTail } from '../promptFormat.ts';

test('arnTail keeps the part of an ARN that identifies the prompt', () => {
  const arn = 'arn:aws:bedrock:us-east-1:000000000000:prompt/mock-supervisor';
  const out = arnTail(arn);
  assert.ok(out.startsWith('…'), out);
  assert.ok(out.endsWith('mock-supervisor'), out);
  assert.ok(out.length <= 29, `${out.length}`);
  // Two prompts that share everything but the name must not read the same.
  const other = arnTail('arn:aws:bedrock:us-east-1:000000000000:prompt/mock-search');
  assert.notEqual(out, other);
  // Short enough to fit is returned whole.
  assert.equal(arnTail('arn:short'), 'arn:short');
});
