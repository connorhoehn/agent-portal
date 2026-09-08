# Infra tests

CDK assertion tests for `infra/`. They exist to turn the deploy hazards recorded
in CLAUDE.md into something that fails a build instead of a deploy.

```bash
cd infra && npm test          # ~11s, 180+ assertions, no AWS calls
npm run test:watch            # same, re-runs on change
node --require ts-node/register --test test/foundation-stack.test.ts   # one file
```

No new dependencies: the runner is Node's built-in `node --test` with
`ts-node/register`, and `aws-cdk-lib/assertions` was already there. There is no
jest and none is needed.

## They run offline, on purpose

`cdk synth --all` does **not** work on a box without credentials. The CLI
resolves `env` from ambient credentials, which makes the two VPC-owning stacks
(`OrgIQ-Aurora`, `OrgIQ-MiddlewareService`) account-specific and sends them to
the availability-zones context provider — a live STS call. With expired
credentials it dies with *"AWS was not able to validate the provided access
credentials"*.

The tests synthesise **in-process** instead. With `CDK_DEFAULT_ACCOUNT` unset
every stack is environment-agnostic, `new ec2.Vpc` falls back to `Fn::GetAZs`,
and nothing touches the network. All 18 stacks synthesise this way — nothing is
skipped for want of credentials.

Two consequences worth knowing:

- Account and region appear in templates as `{"Ref": "AWS::AccountId"}` /
  `{"Ref": "AWS::Region"}`, so assertions on ARNs match the surrounding
  `Fn::Join`, not a flat string.
- `agentcore-runtime-stack.ts`'s `resolveContainerUri` shells out to
  `aws ecr describe-images` **at synth time** to digest-pin images. The test
  helpers stub `execFileSync` so the documented `:latest` fallback is what gets
  synthesised, and no test depends on a real registry.

## Layout

| File | Covers |
|---|---|
| `test/helpers/app-assembly.ts` | in-process synth of the whole `bin/app.ts`, plus export/import readers |
| `test/helpers/stacks.ts` | single-stack builders with dummy cross-stack props |
| `test/helpers/cfn.ts` | template readers (notably `statementsForRole`, which reads *both* `inlinePolicies` and detached `AWS::IAM::Policy`) |
| `test/app-wiring.test.ts` | cross-stack: every `Fn::ImportValue` resolves, export names unique, deploy gates off by default, runtime prompt names match the prompts `OrgIQ-Agents` creates |
| `test/foundation-stack.test.ts` | bucket teardown, the custodian-resistant emptier, RETAIN-vs-DESTROY per resource |
| `test/middleware-service-stack.test.ts` | ARM64, `openListener: false`, two-phase deploy, ECS secrets not plaintext env |
| `test/agentcore-runtime-stack.test.ts` | ECR chicken-and-egg, prompt-read grant on the *execution* role, ADOT env, read-only graph role swap |
| `test/agents-stack.test.ts` | one role + one prompt per agent, PassRole scoping, assessment-tenant isolation |
| `test/aurora-stack.test.ts` | Data API on, isolated/no-NAT VPC, RETAIN + fast-deleter teardown, read-only credential charset |
| `test/knowledge-base-stack.test.ts` | Data-API readiness gate, DbInit ordering, Titan v2 @ 1024d |
| `test/devbox-stack.test.ts` | session storage, the Claude-on-Bedrock exception, opt-in org access |
| `test/agentcore-telemetry-stack.test.ts` | the two eval gates and the online-eval config's service limits |
| `test/supporting-stacks.test.ts` | guardrails, capabilities, span projector, observability |
| `test/agent-image-contract.test.ts` | Dockerfile source checks (ADOT vs vanilla distro, ARM64, non-root, `/ping`) |
| `test/deploy-config.test.ts` | `cdk.json` gates, and `deploy.sh` / `destroy.sh` regression greps |

## Two files are source-level, not template-level

`agent-image-contract.test.ts` and `deploy-config.test.ts` grep source text.
They say so in their headers. No CDK stack builds the agent images
(`agents/base/build.sh` and `agents/build-all.sh` do, with local
`docker buildx`), so there is no template to assert against — and the failure
they guard is silent: with the vanilla `opentelemetry-distro` instead of
`aws-opentelemetry-distro`, AgentCore's injected
`OTEL_PYTHON_CONFIGURATOR=aws_configurator` finds no configurator, no spans are
ever exported, and `aws/spans` stays empty with nothing logged. A grep is weaker
than a template assertion; it is also the only thing available, and it catches
the specific undo, which is the failure these have actually had.

## Writing new ones

Name the failure, not the property. `RuntimePlatform is ARM64` is worth less
than `the middleware task must be ARM64 — Fargate defaults to x86_64 and the
image is arm64`, because the second tells the next person why they may not
"simplify" it. Put the symptom in the test name or a comment above it.

`infra/lib/middleware-service-stack.ts` is under active change by other work:
assert against behaviour in the template, never against line numbers.
