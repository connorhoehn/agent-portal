/**
 * The AgentCore Runtime container contract — SOURCE-LEVEL assertions.
 *
 * These are not template tests, and this file does not pretend otherwise: no
 * CDK stack builds the agent images (agents/base/build.sh and
 * agents/build-all.sh do, with local `docker buildx`), so there is nothing in a
 * synthesised template to assert against. What is checkable is the Dockerfile
 * text, and the failures these guard are all silent-at-deploy:
 *
 *   - vanilla `opentelemetry-distro` instead of `aws-opentelemetry-distro`:
 *     AgentCore injects OTEL_PYTHON_CONFIGURATOR=aws_configurator, which only
 *     exists in the ADOT package. With the vanilla distro NO configurator loads
 *     and no spans are ever exported — aws/spans stays silently empty, which
 *     starves the span projector, /recent-invocations and online evaluation.
 *     Nothing errors. The fleet just stops being observable.
 *   - x86_64 build: AgentCore Runtime requires ARM64 images.
 *   - running as root, or the wrong port/health path: the runtime contract is
 *     rejected at container start.
 *
 * A grep over a Dockerfile is a weaker guarantee than a template assertion, and
 * it is worth having anyway: the alternative today is prose in CLAUDE.md and
 * nothing enforcing it.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO = path.join(__dirname, '..', '..');
const BASE_DOCKERFILE = path.join(REPO, 'agents', 'base', 'Dockerfile');
const DEVBOX_DOCKERFILE = path.join(REPO, 'agents', 'devbox', 'Dockerfile');

function read(file: string): string {
  assert.ok(fs.existsSync(file), `${file} not found — did the agent build move?`);
  return fs.readFileSync(file, 'utf8');
}

describe('spans are exported at all: ADOT, not the vanilla OTel distro', () => {
  for (const [label, file] of [
    ['agents/base', BASE_DOCKERFILE],
    ['agents/devbox', DEVBOX_DOCKERFILE],
  ] as const) {
    test(`${label} installs aws-opentelemetry-distro`, () => {
      assert.match(read(file), /aws-opentelemetry-distro/);
    });

    test(`${label} does NOT install the vanilla opentelemetry-distro`, () => {
      // The names differ by a prefix; the behaviour differs by everything.
      const withoutComments = read(file)
        .split('\n')
        .filter((line) => !line.trim().startsWith('#'))
        .join('\n');
      const vanilla = /(^|[^-\w])["']?opentelemetry-distro/m.test(withoutComments);
      assert.ok(!vanilla, 'vanilla opentelemetry-distro loads no configurator: aws/spans stays empty');
    });
  }
});

describe('the AgentCore Runtime container contract', () => {
  const base = read(BASE_DOCKERFILE);

  test('images are built for ARM64', () => {
    assert.match(base, /--platform=linux\/arm64/, 'AgentCore Runtime requires ARM64');
  });

  test('the container runs as the non-root bedrock_agentcore user at UID 1000', () => {
    assert.match(base, /useradd .*-u 1000 bedrock_agentcore/);
    assert.match(base, /^USER bedrock_agentcore$/m, 'the runtime contract rejects a root container');
  });

  test('the entrypoint is opentelemetry-instrument — without it the ADOT distro never loads', () => {
    assert.match(base, /CMD \["opentelemetry-instrument", "python", "-m", "main"\]/);
  });

  test('ports 8080 (invocations) and 8000 (health/MCP) are exposed', () => {
    assert.match(base, /EXPOSE 8080 8000/);
  });

  test('the health check hits /ping on 8080, which is what the runtime probes', () => {
    assert.match(base, /HEALTHCHECK/);
    assert.match(base, /localhost:8080\/ping/);
  });

  test('the base image is python 3.12', () => {
    assert.match(base, /python:3\.12-slim/);
  });
});

describe('the devbox image carries no Anthropic API key', () => {
  test('model access is Bedrock-only', () => {
    const devbox = read(DEVBOX_DOCKERFILE);
    assert.ok(
      !/ANTHROPIC_API_KEY/.test(devbox),
      'the devbox Claude exception holds only because everything goes through Bedrock',
    );
    assert.match(devbox, /--platform=linux\/arm64/);
  });
});
