// Six runbooks written after a day somebody lost (docs/demo-content-engineering-brief.md,
// "The runbook library"). Each is generalised so a consultant can follow it on any
// AWS engagement; the org's own values sit in a labelled "This org" paragraph of
// its notes. They are hand-authored v1s (author: the person who lost the day,
// accepted by a reviewer from the area), not migrations, so they carry no
// source_artifact_ids.
//
//   rb-kb-search-type-pin        Bedrock KB default search ranked results backwards
//   rb-adot-span-export          vanilla OTel distro under aws_configurator exported nothing
//   rb-pin-bump-verify           a short SHA / stale bundler cache hid a pin bump
//   rb-two-phase-runtime-deploy  runtimes created against empty ECR repositories
//   rb-ecs-healthy-not-serving   CREATE_COMPLETE with zero running tasks
//   rb-custodian-sg-allowlist    a compliance custodian revoking open ingress
//
// Every timestamp is read from mock/core/clock.ts inside a factory (fixture floor
// rule 3). The seam (runbooks-seed-seam.ts) adds these rows to the default world.
import type { Runbook, RunbookApplication, RunbookDoc, RunbookProposal, RunbookScope, RunbookVersion } from '../lib/runbooks/index.js';
import { lintRunbook, versionOf } from '../lib/runbooks/index.js';
import { clock } from './core/clock.js';

const bash = (...lines: string[]) => ({ lang: 'bash' as const, text: lines.join('\n') });
const sql = (...lines: string[]) => ({ lang: 'sql' as const, text: lines.join('\n') });

// ─── 1. Knowledge base search type ───────────────────────────────────────────

export const kbSearchTypePin: RunbookDoc = {
  title: "Pin a Bedrock knowledge base's search type and prove the ranking order",
  summary: 'Pin the search type on every Retrieve call and prove on a labelled query set that the right document ranks first, because the default can rank results backwards.',
  use_when: [
    'Retrieval answers cite the right documents in the wrong order, or the best match comes last.',
    'You are wiring a new caller (an agent, a Lambda, a notebook) to a Bedrock knowledge base on a vector store you manage.',
    'Top-1 accuracy on your labelled retrieval queries dropped after a knowledge base or index change.',
  ],
  not_for: [
    'A knowledge base that returns nothing at all: look for a failed or missing ingestion job first.',
    'Tuning chunk size or the embedding model, which changes what is indexed, not how it is ranked.',
  ],
  triggers: {
    work_item_labels: ['retrieval', 'rag', 'knowledge-base', 'evals'],
    repos: ['orgiq-llm-platform', 'orgiq-rag-search'],
    tools: ['bedrock-kb'],
    keywords: ['retrieve', 'search type', 'hybrid', 'semantic', 'ranking', 'score', 'knowledge base', 'top-1'],
  },
  preconditions: [
    'The knowledge base id is in `$KB_ID` and the AWS CLI can call `bedrock-agent-runtime` in its region.',
    'You have `queries.jsonl` with at least eight labelled queries, one `{"q": "...", "expect": "s3://..."}` per line.',
    'For HYBRID on a self-managed store such as Aurora pgvector, the full-text index on the chunk text column exists.',
  ],
  steps: [
    {
      do: 'Run one labelled query with the default search type and save the ranked sources.',
      command: bash(
        'Q=$(head -1 queries.jsonl | jq -r .q)',
        'aws bedrock-agent-runtime retrieve --knowledge-base-id "$KB_ID" --retrieval-query text="$Q" \\',
        "  --query 'retrievalResults[].{uri:location.s3Location.uri,score:score}' --output table | tee default.txt",
      ),
      expect: 'five sources with scores, and a note of whether the expected document is first or last.',
    },
    {
      do: 'Repeat the same query with HYBRID search pinned and compare the order.',
      command: bash(
        'aws bedrock-agent-runtime retrieve --knowledge-base-id "$KB_ID" --retrieval-query text="$Q" \\',
        '  --retrieval-configuration \'{"vectorSearchConfiguration":{"numberOfResults":5,"overrideSearchType":"HYBRID"}}\' \\',
        "  --query 'retrievalResults[].location.s3Location.uri' --output text",
      ),
      expect: 'the expected document first.',
      why: 'Some stores report cosine distance where Bedrock expects a similarity, so the default ordering sorts the best match last.',
    },
    {
      do: 'Measure top-1 accuracy over the whole labelled set for both search types.',
      command: bash(
        'for t in SEMANTIC HYBRID; do',
        '  hits=0; n=0',
        '  while read -r line; do',
        '    q=$(jq -r .q <<<"$line"); want=$(jq -r .expect <<<"$line")',
        '    got=$(aws bedrock-agent-runtime retrieve --knowledge-base-id "$KB_ID" --retrieval-query text="$q" \\',
        '      --retrieval-configuration "{\\"vectorSearchConfiguration\\":{\\"numberOfResults\\":5,\\"overrideSearchType\\":\\"$t\\"}}" \\',
        "      --query 'retrievalResults[0].location.s3Location.uri' --output text)",
        '    n=$((n+1)); [ "$got" = "$want" ] && hits=$((hits+1))',
        '  done < queries.jsonl',
        '  echo "$t top-1 $hits/$n"',
        'done',
      ),
      expect: 'two lines such as `SEMANTIC top-1 0/8` and `HYBRID top-1 8/8`, and the winner is the type you pin.',
    },
    {
      do: 'Pin the winning search type in the one shared helper every caller uses to build its retrieval configuration.',
      command: bash('git grep -n -E "retrieval_?[Cc]onfiguration|retrieve\\(" -- "*.py" "*.ts"'),
      expect: 'every call site passes the helper\'s configuration, and none builds its own dictionary.',
    },
    {
      do: 'Find literal copies of the configuration the helper cannot reach, such as a Lambda packaged separately.',
      command: bash('git grep -n "overrideSearchType" -- "*.py" "*.ts" "*.json"'),
      expect: 'the same search type in every hit, and a copy that disagrees is a second caller to fix.',
    },
    {
      do: 'Add a unit test that asserts the search-type key is present on every Retrieve call the code makes.',
      command: bash('python -m pytest -q -k search_type'),
      expect: '`1 passed`, and the test fails if a new call site omits the key.',
      why: 'Asserting the key rather than the ranking keeps the test offline, fast and free.',
    },
  ],
  verify: [
    { check: 'Step 3 rerun after the change ships prints the same top-1 score for the pinned type.' },
    { check: 'No call site builds its own retrieval configuration (step 4 and step 5 agree).' },
  ],
  failure_modes: [
    { symptom: '`ValidationException` when HYBRID is requested', cause: 'The vector store has no full-text index for hybrid search', response: 'Create the text index on the chunk column, then rerun step 2' },
    { symptom: 'Right order in the console, reversed in the app', cause: 'A second caller builds its own configuration', response: 'Run step 5 and route that caller through the helper' },
    { symptom: 'The best match disappears from long answers', cause: 'The caller trims result lists from the tail of a reversed list', response: 'Fix the order first, then trim' },
  ],
  rollback: [
    { do: 'Revert the commit that pinned the search type if answer quality drops on the full eval set.', command: bash('git revert --no-edit "$PIN_COMMIT"') },
  ],
  notes: 'This org: the knowledge base sits on Aurora pgvector. Default search scored top-1 0/8 on the retrieval eval set and HYBRID 8/8; HYBRID needs the GIN text index the knowledge base stack creates. The agents pin the type through one helper, and the MCP gateway Lambda carries a literal copy of the same dictionary, which is what step 5 found.\nNina Rivera lost most of a day tuning prompts before anyone looked at the order of the sources.',
};

/** v2 as proposed by run sess-llm-07: check the text index before trying HYBRID. */
const kbSearchTypePinV2Proposed: RunbookDoc = {
  ...kbSearchTypePin,
  steps: [
    kbSearchTypePin.steps[0]!,
    {
      do: 'Check that the chunk table has the full-text index HYBRID search needs before you request it.',
      command: sql(
        "SELECT indexname, indexdef FROM pg_indexes",
        "WHERE tablename = 'bedrock_kb' AND indexdef ILIKE '%gin%';",
      ),
      expect: 'one GIN index on the chunk text column, and no rows means create it before step 3.',
      why: 'A freshly rebuilt environment answered HYBRID with ValidationException because the index was created by a later stack.',
    },
    ...kbSearchTypePin.steps.slice(1),
  ],
};

// ─── 2. ADOT, not vanilla OTel ───────────────────────────────────────────────

export const adotSpanExport: RunbookDoc = {
  title: "Prove an agent's spans actually export (ADOT, not vanilla OTel)",
  summary: 'Check that a Python agent image ships the AWS Distro for OpenTelemetry its runtime configures, and prove one span reaches the backend before trusting an empty dashboard.',
  use_when: [
    'Trace dashboards for an agent or service are empty and nothing in its logs says why.',
    'You are building a Python agent image for a runtime that sets `OTEL_PYTHON_CONFIGURATOR=aws_configurator`.',
    'Someone swapped `aws-opentelemetry-distro` for the upstream `opentelemetry-distro` to make the image smaller.',
  ],
  not_for: [
    'Spans that arrive and are then sampled away: check the sampling rate before the exporter.',
    'Node or Java services, whose auto-instrumentation is configured differently.',
  ],
  triggers: {
    work_item_labels: ['otel', 'observability', 'tracing'],
    repos: ['orgiq-observability'],
    tools: ['otel', 'adot', 'xray'],
    keywords: ['spans', 'traces', 'adot', 'opentelemetry', 'exporter', 'configurator', 'empty dashboard', 'x-ray', 'agent image'],
  },
  preconditions: [
    'You can pull or build the agent image (`$IMAGE`) locally with Docker.',
    'You know the command that runs one request through the agent offline (`$SMOKE_CMD`).',
    'You know the service name the agent reports under (`$OTEL_SERVICE_NAME`).',
  ],
  steps: [
    {
      do: 'List the OpenTelemetry packages installed in the agent image.',
      command: bash("docker run --rm --entrypoint pip \"$IMAGE\" list 2>/dev/null | grep -i -E 'opentelemetry-distro|aws-opentelemetry'"),
      expect: '`aws-opentelemetry-distro` in the list, and only `opentelemetry-distro` means the image cannot honour the runtime configurator.',
    },
    {
      do: 'Check which configurators the image registers under the runtime settings.',
      command: bash(
        'docker run --rm -e OTEL_PYTHON_CONFIGURATOR=aws_configurator --entrypoint python "$IMAGE" -c \\',
        '  "from importlib.metadata import entry_points; print(sorted(e.name for e in entry_points(group=\'opentelemetry_configurator\')))"',
      ),
      expect: '`aws_configurator` in the printed list.',
      why: 'When the named configurator is missing, instrumentation starts, configures no exporter and raises no error.',
    },
    {
      do: 'Replace the upstream distro with ADOT in the image requirements and rebuild the agent image.',
      command: bash(
        "sed -i.bak 's/^opentelemetry-distro.*/aws-opentelemetry-distro>=0.12.1/' requirements.txt",
        'docker buildx build --platform linux/arm64 -t "$IMAGE" --load .',
      ),
      expect: 'a finished build, and step 1 now lists `aws-opentelemetry-distro`.',
    },
    {
      do: 'Run one request through the agent locally with console export to watch a span leave the process.',
      command: bash(
        'docker run --rm -e OTEL_PYTHON_CONFIGURATOR=aws_configurator -e OTEL_TRACES_EXPORTER=console \\',
        '  -e OTEL_SERVICE_NAME="$OTEL_SERVICE_NAME" --entrypoint opentelemetry-instrument "$IMAGE" $SMOKE_CMD 2>&1 | grep -m1 \'"trace_id"\'',
      ),
      expect: 'one span printed as JSON with a `trace_id`.',
    },
    {
      do: 'Deploy the rebuilt agent image and look for its first trace in X-Ray.',
      command: bash(
        'aws xray get-trace-summaries --start-time "$(( $(date +%s) - 900 ))" --end-time "$(date +%s)" \\',
        '  --filter-expression "service(\\"$OTEL_SERVICE_NAME\\")" --query \'length(TraceSummaries)\'',
      ),
      expect: 'a number above zero within five minutes of the first real request.',
    },
  ],
  verify: [
    {
      check: 'Traces for the service arrive from real traffic over the last hour, not only from the smoke run.',
      command: bash('aws xray get-trace-summaries --start-time "$(( $(date +%s) - 3600 ))" --end-time "$(date +%s)" --filter-expression "service(\\"$OTEL_SERVICE_NAME\\")" --query \'length(TraceSummaries)\''),
    },
  ],
  failure_modes: [
    { symptom: 'Step 4 prints spans but the backend shows none', cause: 'The runtime role cannot write traces, or the OTLP endpoint variable is unset', response: 'Grant `xray:PutTraceSegments` to the runtime role and check the endpoint the runtime injects' },
    { symptom: 'Every trace is a single root span', cause: 'Trace context is not propagated on the agent\'s outbound calls', response: 'Instrument the HTTP client and pass the context on every sub-agent call' },
    { symptom: 'Some requests report and most do not', cause: 'A sampling rate below 1.0 applied before persistence', response: 'Read the sampler setting before blaming the exporter' },
  ],
  rollback: [
    {
      do: 'Restore the previous requirements and image tag if the ADOT build breaks start-up.',
      command: bash('mv requirements.txt.bak requirements.txt && docker tag "$IMAGE_PREVIOUS" "$IMAGE"'),
    },
  ],
  notes: 'This org: agent images run `opentelemetry-instrument python -m main` under the runtime\'s `aws_configurator`. One image built on the vanilla distro starved the trace dashboards for a week with no error anywhere.\nThe supervisor must also set its trace context on the streaming path, or sub-agent spans arrive with no parent and the topology view loses its edges.',
};

// ─── 3. Pin bump verification ────────────────────────────────────────────────

export const pinBumpVerify: RunbookDoc = {
  title: 'Verify a dependency pin bump against what is actually installed',
  summary: 'Prove the installed package is the version you pinned and exports what you need, then clear the bundler cache, because a version check can pass for code you cannot import.',
  use_when: [
    'You moved a dependency pin (a version, a tarball or a git SHA) and the app still behaves like the old version.',
    'The browser or Node reports "does not provide an export named" right after a pin bump.',
    'A release note promises an API and you are about to build on it.',
  ],
  not_for: [
    'Choosing which version to adopt, which is a changelog and compatibility question.',
    'Publishing the library itself: use the packed-library release procedure.',
  ],
  triggers: {
    work_item_labels: ['deps', 'upgrade', 'frontend'],
    repos: [],
    tools: ['npm', 'vite'],
    keywords: ['pin', 'bump', 'dependency', 'installed', 'dist', 'export', 'vite cache', 'sha', 'lockfile'],
  },
  preconditions: [
    'You know the package (`$PKG`), the version you expect (`$WANT`), one export the change adds (`$EXPORT`) and one prop it adds (`$PROP`).',
    'The pin and lockfile change are committed or staged, so you can revert them.',
  ],
  steps: [
    {
      do: 'Check that a git dependency is pinned by its full 40-character SHA, not a short one.',
      command: bash(
        'node -e "const p=require(\'./package.json\'); const s=({...p.dependencies,...p.devDependencies})[process.env.PKG]||\'\';',
        '  const sha=s.split(\'#\')[1]||\'\'; console.log(s, sha && sha.length!==40 ? \'SHORT SHA\' : \'ok\')"',
      ),
      expect: '`ok`, and `SHORT SHA` means npm may treat the dependency as already satisfied and install nothing.',
    },
    {
      do: 'Read the version npm resolved and the version on disk, and compare both with the pin.',
      command: bash('npm ls "$PKG" --depth=0', 'jq -r .version "node_modules/$PKG/package.json"'),
      expect: '`$WANT` from both commands.',
      why: 'A git dependency is foldered by its dependency key, so `npm ls` can report a version for a folder whose package has another name.',
    },
    {
      do: 'Import the export you need from the installed build, the way the app will.',
      command: bash('node --input-type=module -e "import(process.env.PKG).then((m) => console.log(typeof m[process.env.EXPORT]))"'),
      expect: '`function` or `object`, and `undefined` means the installed dist does not have it, whatever the changelog says.',
    },
    {
      do: 'Search the installed type declarations for the prop the release promised.',
      command: bash('grep -rn "$PROP" "node_modules/$PKG/dist" --include="*.d.ts" | head -5'),
      expect: 'at least one declaration line.',
    },
    {
      do: 'Clear the bundler dependency cache and restart the dev server.',
      command: bash('rm -rf node_modules/.vite && npm run dev'),
      expect: 'the dev server re-optimises dependencies on start and the page loads the new export.',
      why: 'Vite serves its pre-bundled copy of the old dist until the cache is cleared and the server restarts.',
    },
  ],
  verify: [
    {
      check: 'The installed build exports what the change needs.',
      command: bash('node --input-type=module -e "import(process.env.PKG).then((m) => console.log(typeof m[process.env.EXPORT]))"'),
    },
    { check: 'CI installs from the lockfile and step 2 prints the same version there.' },
  ],
  failure_modes: [
    { symptom: '`npm install` finished at once and nothing changed', cause: 'A short SHA was treated as already satisfied', response: 'Pin the full SHA (step 1) and reinstall' },
    { symptom: '"does not provide an export named" in the browser only', cause: 'A stale bundler cache', response: 'Run step 5 before reimplementing anything' },
    { symptom: 'Step 3 prints `undefined` though the changelog lists the export', cause: 'The release documented an API it never shipped', response: 'Report it upstream and stay on the previous pin' },
  ],
  rollback: [
    { do: 'Revert the pin and the lockfile, then reinstall from the lockfile.', command: bash('git checkout -- package.json package-lock.json && npm ci && rm -rf node_modules/.vite') },
  ],
  notes: 'This org: the portal consumes the design-system packages as packed tarballs pinned by `file:` dependencies. One release documented and tested a prop it never shipped, which step 4 finds in a minute.',
};

// ─── 4. Two-phase runtime deploy ─────────────────────────────────────────────

export const twoPhaseRuntimeDeploy: RunbookDoc = {
  title: 'Deploy container runtimes after their repositories have images',
  summary: 'Deploy the image repositories first, push an image to each, then deploy the runtimes that pull from them, because a runtime created against an empty repository never stabilises.',
  use_when: [
    'One stack creates both the container repositories and the runtimes (AgentCore, ECS or Lambda container) that pull from them.',
    'A first deploy fails every runtime with an image-not-found or not-stabilised error.',
    'You are rebuilding an environment from nothing after a teardown.',
  ],
  not_for: [
    'Rolling a new image onto a runtime that already exists: push and update the runtime instead.',
    'Runtimes that pull from a public registry.',
  ],
  triggers: {
    work_item_labels: ['infra', 'deploy', 'cdk'],
    repos: ['orgiq-inference-platform', 'orgiq-llm-platform'],
    tools: ['cdk', 'ecr', 'agentcore'],
    keywords: ['ecr', 'runtime', 'two-phase', 'deploy', 'image', 'repository', 'not stabilized', 'context flag'],
  },
  preconditions: [
    'The stack gates runtime creation behind a CDK context flag (`$RUNTIME_FLAG`).',
    'Docker buildx can build for the runtime architecture, and `$REGISTRY` names the account registry.',
  ],
  steps: [
    {
      do: 'Confirm the account before you deploy anything.',
      command: bash('aws sts get-caller-identity --query Account --output text'),
      expect: 'the target account id, and any other account means stop.',
    },
    {
      do: 'Deploy the stack with runtime creation off, so only the repositories and roles exist.',
      command: bash('npx cdk deploy "$STACK" --context "$RUNTIME_FLAG=false" --require-approval never'),
      expect: '`CREATE_COMPLETE` or `UPDATE_COMPLETE`, with the repositories in the stack outputs.',
    },
    {
      do: 'List the repositories that still hold no image.',
      command: bash(
        "for r in $(aws ecr describe-repositories --query 'repositories[].repositoryName' --output text); do",
        "  [ \"$(aws ecr list-images --repository-name \"$r\" --query 'length(imageIds)')\" = 0 ] && echo \"empty $r\"",
        'done',
      ),
      expect: 'one `empty` line per repository the runtimes pull from.',
    },
    {
      do: 'Build and push an image to each empty repository for the runtime architecture.',
      command: bash(
        'aws ecr get-login-password | docker login --username AWS --password-stdin "$REGISTRY"',
        'docker buildx build --platform linux/arm64 -t "$REGISTRY/$REPO:$TAG" --push .',
      ),
      expect: 'a pushed digest per repository, and step 3 now prints nothing.',
    },
    {
      do: 'Deploy the stack again with runtime creation on.',
      command: bash('npx cdk deploy "$STACK" --context "$RUNTIME_FLAG=true" --require-approval never'),
      expect: 'every runtime reaches a ready state.',
      why: 'The runtime resource waits for its first image pull, and an empty repository makes it time out instead of failing fast.',
    },
  ],
  verify: [
    {
      check: 'Every runtime reports READY.',
      command: bash("aws bedrock-agentcore-control list-agent-runtimes --query 'agentRuntimes[].[agentRuntimeName,status]' --output table"),
    },
  ],
  failure_modes: [
    { symptom: 'A runtime sits in CREATE_IN_PROGRESS, then fails `NotStabilized`', cause: 'Its repository was empty or the tag did not exist', response: 'Run step 3, push, and redeploy' },
    { symptom: 'A stack delete leaves runtimes in `DELETE_FAILED`', cause: 'Runtimes delete slower than CloudFormation waits', response: 'Delete endpoints, then runtimes, treat "already deleting" as success, and retry the stack delete' },
    { symptom: 'Image pulls fail with `exec format error`', cause: 'Built for the wrong CPU architecture', response: 'Rebuild with the runtime platform in step 4' },
  ],
  rollback: [
    {
      do: 'Redeploy with runtime creation off to remove the runtimes and keep the repositories and images.',
      command: bash('npx cdk deploy "$STACK" --context "$RUNTIME_FLAG=false" --require-approval never'),
    },
  ],
  notes: 'This org: the agent runtime stack creates the ECR repositories and the runtimes; runtimes are a second phase behind `deployRuntimes=true`, and `onlyAgents=a,b` narrows a redeploy. Inference Platform rebuilt its sandbox environment twice before the order was written down.',
};

// ─── 5. Healthy stack, nothing serving ───────────────────────────────────────

export const ecsHealthyNotServing: RunbookDoc = {
  title: 'Tell "stack healthy" from "service serving" on ECS Fargate',
  summary: 'Check running against desired tasks, the stop reasons and target health before declaring a Fargate service up, because a stack can complete with zero tasks running.',
  use_when: [
    'CloudFormation reports the stack complete but the load balancer answers 502 or 503.',
    'A first deploy of a Fargate service pointed at a repository with no image yet.',
    'Someone reports "all stacks healthy" and you need to know whether the service is serving.',
  ],
  not_for: [
    'Tasks running and healthy but returning application errors: read the application logs.',
    'Services on EC2 capacity providers with no registered instances.',
  ],
  triggers: {
    work_item_labels: ['infra', 'fargate', 'ecs', 'deploy'],
    repos: [],
    tools: ['ecs', 'fargate', 'alb'],
    keywords: ['desired', 'running', 'tasks', 'healthy', '503', 'target group', 'stopped reason', 'fargate', 'service'],
  },
  preconditions: [
    'You know the cluster (`$CLUSTER`), the service (`$SERVICE`) and its target group ARN (`$TG_ARN`).',
    'You know the repository and tag the task definition names (`$REPO`, `$TAG`).',
  ],
  steps: [
    {
      do: 'Compare desired, running and pending task counts for the service.',
      command: bash(
        'aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" \\',
        "  --query 'services[0].{desired:desiredCount,running:runningCount,pending:pendingCount,rollout:deployments[0].rolloutState}'",
      ),
      expect: '`running` equal to `desired` and above zero, with rollout `COMPLETED`.',
      why: 'A service with a desired count of zero, or tasks that never start, still leaves the stack COMPLETE.',
    },
    {
      do: 'Read why the service tasks stopped most recently.',
      command: bash(
        'aws ecs list-tasks --cluster "$CLUSTER" --service-name "$SERVICE" --desired-status STOPPED --query \'taskArns[:5]\' --output text \\',
        "  | xargs aws ecs describe-tasks --cluster \"$CLUSTER\" --query 'tasks[].[stoppedReason,containers[0].reason]' --output text --tasks",
      ),
      expect: 'reasons such as `CannotPullContainerError` or `exec format error`, or nothing when no task has stopped.',
    },
    {
      do: 'Check that the image tag the task definition names exists in its repository.',
      command: bash('aws ecr describe-images --repository-name "$REPO" --image-ids imageTag="$TAG" --query \'imageDetails[0].imagePushedAt\''),
      expect: 'a push time, and `ImageNotFoundException` means build and push before anything else.',
    },
    {
      do: 'Check target health behind the service load balancer.',
      command: bash("aws elbv2 describe-target-health --target-group-arn \"$TG_ARN\" --query 'TargetHealthDescriptions[].[Target.Id,TargetHealth.State,TargetHealth.Reason]' --output table"),
      expect: 'every target `healthy`.',
    },
    {
      do: 'Scale the service to its intended task count once the image exists.',
      command: bash('aws ecs update-service --cluster "$CLUSTER" --service "$SERVICE" --desired-count "$COUNT" --force-new-deployment'),
      expect: 'step 1 shows running equal to desired within a few minutes.',
    },
    {
      do: 'Request the health route through the load balancer from an address its listener allows.',
      command: bash("curl -s -o /dev/null -w '%{http_code}\\n' --max-time 10 \"https://$ALB_HOST/health\""),
      expect: '`200`, and a timeout with healthy targets points at the security group, not the service.',
    },
  ],
  verify: [
    {
      check: 'Running equals desired and the load balancer answers 200.',
      command: bash("aws ecs describe-services --cluster \"$CLUSTER\" --services \"$SERVICE\" --query 'services[0].[desiredCount,runningCount]' --output text"),
    },
  ],
  failure_modes: [
    { symptom: '`CannotPullContainerError` in the stop reason', cause: 'An empty repository or a missing tag', response: 'Build and push, then step 5' },
    { symptom: '`exec format error` in the stop reason', cause: 'The image was built for the wrong CPU architecture', response: 'Rebuild for the task definition `runtimePlatform` (ARM64 or X86_64)' },
    { symptom: 'Targets healthy, but curl times out', cause: 'The listener security group does not allow your address', response: 'Follow the security group allow-list runbook' },
    { symptom: 'Tasks start, then stop with exit code 1', cause: 'A missing secret or environment variable', response: 'Read the container log stream of the stopped task' },
  ],
  rollback: [
    {
      do: 'Scale the service back to its previous count if the new tasks fail their health checks.',
      command: bash('aws ecs update-service --cluster "$CLUSTER" --service "$SERVICE" --desired-count "$PREVIOUS_COUNT"'),
    },
  ],
  notes: 'This org: the middleware service stack reaches CREATE_COMPLETE with an empty repository and zero running tasks until its ARM64 image is pushed and the stack is redeployed with the service flag on. "All stacks healthy" was reported twice while nothing served.',
};

// ─── 6. The security-group custodian ─────────────────────────────────────────

export const custodianSgAllowlist: RunbookDoc = {
  title: 'Reach a load balancer when a custodian keeps closing its security group',
  summary: 'Confirm that an account policy is revoking your ingress rule, then reach the load balancer through a /32 allow-list instead of re-opening it to the world.',
  use_when: [
    'An ingress rule you added to a security group disappears within seconds or minutes.',
    'A load balancer is healthy but unreachable from your laptop or CI runner.',
    'The account runs a compliance custodian that remediates open administrative ingress.',
  ],
  not_for: [
    'Service-to-service traffic inside the VPC, which should reference security groups, not CIDRs.',
    'Public production endpoints, which belong behind CloudFront or a WAF rather than an allow-list.',
  ],
  triggers: {
    work_item_labels: ['infra', 'network', 'security'],
    repos: [],
    tools: ['ec2', 'alb', 'cloudtrail'],
    keywords: ['security group', 'ingress', 'custodian', 'revoked', 'allow-list', 'cidr', 'unreachable', 'load balancer'],
  },
  preconditions: [
    'You know the load balancer security group (`$SG_ID`) and its listener host (`$ALB_HOST`).',
    'You can read CloudTrail in the account.',
  ],
  steps: [
    {
      do: 'List the security group ingress rules as they stand.',
      command: bash(
        'aws ec2 describe-security-group-rules --filters Name=group-id,Values="$SG_ID" \\',
        "  --query 'SecurityGroupRules[?!IsEgress].[SecurityGroupRuleId,IpProtocol,FromPort,CidrIpv4]' --output table",
      ),
      expect: 'the current rules, and whether the one you added is missing.',
    },
    {
      do: 'Find who revoked the ingress rule in CloudTrail.',
      command: bash(
        'aws cloudtrail lookup-events --lookup-attributes AttributeKey=EventName,AttributeValue=RevokeSecurityGroupIngress \\',
        "  --max-results 10 --query 'Events[].[EventTime,Username]' --output table",
      ),
      expect: 'a revocation seconds after your change by a remediation role, not by a person.',
      why: 'Knowing it is policy rather than a teammate ends the edit-and-retry loop.',
    },
    {
      do: 'Look up your current public address.',
      command: bash('MYIP=$(curl -s https://checkip.amazonaws.com) && echo "$MYIP"'),
      expect: 'one IPv4 address.',
    },
    {
      do: 'Add a single-address ingress rule for your address on the listener port.',
      command: bash(
        'aws ec2 authorize-security-group-ingress --group-id "$SG_ID" \\',
        '  --ip-permissions "IpProtocol=tcp,FromPort=443,ToPort=443,IpRanges=[{CidrIp=$MYIP/32,Description=temp-access-$USER}]"',
      ),
      expect: 'a `SecurityGroupRuleId` in the response.',
    },
    {
      do: 'Wait two minutes and confirm the allow-list rule survived the next custodian sweep.',
      command: bash(
        'sleep 120 && aws ec2 describe-security-group-rules --filters Name=group-id,Values="$SG_ID" \\',
        '  --query "SecurityGroupRules[?CidrIpv4==\'$MYIP/32\'].SecurityGroupRuleId" --output text',
      ),
      expect: 'the rule id from step 4.',
    },
    {
      do: 'Request the load balancer health route from that address.',
      command: bash("curl -s -o /dev/null -w '%{http_code}\\n' --max-time 10 \"https://$ALB_HOST/health\""),
      expect: '`200`.',
    },
  ],
  verify: [
    {
      check: 'The /32 rule is still present an hour later and the load balancer answers.',
      command: bash('aws ec2 describe-security-group-rules --filters Name=group-id,Values="$SG_ID" --query "SecurityGroupRules[?CidrIpv4==\'$MYIP/32\'].SecurityGroupRuleId" --output text'),
    },
  ],
  failure_modes: [
    { symptom: 'The /32 rule is revoked too', cause: 'The custodian also closes administrative ports to any CIDR', response: 'Use Session Manager port forwarding through a bastion, and ask the account owner for the policy exceptions' },
    { symptom: 'Rule present, requests still time out', cause: 'The listener port or the target security group, not this one', response: 'Check the listener port and the security group on the targets' },
    { symptom: 'It worked yesterday and times out today', cause: 'Your public address changed (VPN or a new network)', response: 'Revoke the old rule and repeat steps 3 and 4' },
  ],
  rollback: [
    {
      do: 'Revoke your temporary allow-list rule when you are done.',
      command: bash('aws ec2 revoke-security-group-ingress --group-id "$SG_ID" --ip-permissions "IpProtocol=tcp,FromPort=443,ToPort=443,IpRanges=[{CidrIp=$MYIP/32}]"'),
    },
  ],
  notes: 'This org: the shared account runs a custodian that closes open administrative ingress within seconds. The middleware load balancer deploys with its listener closed and takes an allow-list CIDR at deploy time; whether the CloudFront origin prefix-list rule survives the custodian is still unverified.',
};

// ─── Rows ────────────────────────────────────────────────────────────────────

interface EngagementSpec {
  id: string;
  doc: RunbookDoc;
  scope: RunbookScope;
  /** The person who lost the day and wrote it down. */
  owner: string;
  /** The reviewer from the area who accepted v1. */
  reviewer: string;
  created_h: number;
  accepted_h: number;
  provenance: RunbookVersion['provenance'];
  /** [run_ref, hours ago, outcome, failed_at_step, note] */
  runs: Array<[string, number, RunbookApplication['outcome'], number | null, string | null]>;
}

function specs(): EngagementSpec[] {
  const prov = (session_ids: string[], run_refs: string[] = []): RunbookVersion['provenance'] => ({ run_refs, session_ids, lab_experience_ids: [], source_artifact_ids: [] });
  return [
    {
      id: 'rb-kb-search-type-pin', doc: kbSearchTypePin, scope: { kind: 'tool', ref: 'bedrock-kb' },
      owner: 'p-047', reviewer: 'p-013', created_h: 150, accepted_h: 130, provenance: prov(['sess-llm-03']),
      runs: [
        ['sess-llm-06', 40, 'followed', null, 'HYBRID 8/8 against SEMANTIC 0/8 on the retrieval eval set, pinned in the shared helper.'],
        ['sess-llm-07', 7, 'failed', 2, 'HYBRID answered ValidationException in the rebuilt sandbox, whose chunk table had no text index yet.'],
      ],
    },
    {
      id: 'rb-adot-span-export', doc: adotSpanExport, scope: { kind: 'tool', ref: 'otel' },
      owner: 'p-004', reviewer: 'p-008', created_h: 210, accepted_h: 190, provenance: prov(['sess-obs-07']),
      runs: [
        ['sess-obs-08', 60, 'followed', null, null],
        ['sess-llm-06', 38, 'followed', null, 'Graph-builder image already on ADOT; spans reached X-Ray in 3 minutes.'],
      ],
    },
    {
      id: 'rb-pin-bump-verify', doc: pinBumpVerify, scope: { kind: 'tool', ref: 'npm' },
      owner: 'p-001', reviewer: 'p-002', created_h: 100, accepted_h: 92, provenance: prov(['sess-dsapi-02']),
      runs: [
        ['sess-dsapi-03', 26, 'followed', null, 'Step 4 found the promised prop missing from the installed declarations; stayed on the previous pin.'],
        ['sess-ds-04', 9, 'followed', null, null],
      ],
    },
    {
      id: 'rb-two-phase-runtime-deploy', doc: twoPhaseRuntimeDeploy, scope: { kind: 'tool', ref: 'agentcore' },
      owner: 'p-013', reviewer: 'p-049', created_h: 170, accepted_h: 160, provenance: prov(['sess-inf-02']),
      runs: [['sess-inf-04', 50, 'followed', null, null]],
    },
    {
      id: 'rb-ecs-healthy-not-serving', doc: ecsHealthyNotServing, scope: { kind: 'tool', ref: 'ecs' },
      owner: 'p-011', reviewer: 'p-008', created_h: 125, accepted_h: 110, provenance: prov(['sess-inf-03']),
      runs: [
        ['sess-inf-05', 30, 'followed', null, 'Desired 1, running 0: CannotPullContainerError on an empty repository.'],
        ['sess-cost-05', 12, 'followed', null, null],
      ],
    },
    {
      id: 'rb-custodian-sg-allowlist', doc: custodianSgAllowlist, scope: { kind: 'tool', ref: 'ec2' },
      owner: 'p-011', reviewer: 'p-051', created_h: 230, accepted_h: 215, provenance: prov(['sess-cost-03']),
      runs: [['sess-inf-05', 29, 'followed_with_deviation', null, 'Office VPN rotates its egress address; allow-listed the VPN range instead of a /32.']],
    },
  ];
}

export interface EngagementRows {
  runbooks: Runbook[];
  versions: RunbookVersion[];
  applications: RunbookApplication[];
  proposals: RunbookProposal[];
}

/** The six runbooks, their v1s, the runs that followed them and the one open edit. */
export function engagementRunbookRows(): EngagementRows {
  const out: EngagementRows = { runbooks: [], versions: [], applications: [], proposals: [] };
  for (const s of specs()) {
    const createdAt = clock.hoursAgo(s.created_h);
    const acceptedAt = clock.hoursAgo(s.accepted_h);
    out.runbooks.push({ id: s.id, scope: s.scope, owner_person_id: s.owner, status: 'published', current_version: 1, created_at: createdAt, updated_at: acceptedAt });
    out.versions.push(versionOf({
      runbook_id: s.id, version: 1, doc: s.doc, author: { kind: 'person', id: s.owner },
      proposal_id: null, accepted_by: s.reviewer, accepted_at: acceptedAt, provenance: s.provenance,
    }));
    s.runs.forEach(([runRef, h, outcome, failedAt, note], k) => out.applications.push({
      id: `rba-${s.id.slice(3)}-${k + 1}`, runbook_id: s.id, version: 1, run_ref: runRef, brief_id: null,
      outcome, failed_at_step: failedAt, note, at: clock.hoursAgo(h),
    }));
  }
  out.proposals.push({
    id: 'prop-kb-search-text-index', kind: 'edit', runbook_id: 'rb-kb-search-type-pin', base_version: 1,
    proposed: kbSearchTypePinV2Proposed,
    rationale: 'Run sess-llm-07 followed v1 in the rebuilt sandbox and failed at step 2: HYBRID answered ValidationException because the chunk table had no full-text index yet. This adds a check for the index before HYBRID is tried, so the next environment rebuild does not read the error as a ranking problem.',
    source: { kind: 'run', run_ref: 'sess-llm-07', session_id: 'sess-llm-07', work_item_id: 'wi-llm-e2-s1', lab_experience_ids: [] },
    lint: lintRunbook(kbSearchTypePinV2Proposed), similar: [],
    status: 'open', decided_by: null, decided_at: null, note: null, merged_into: null,
    created_at: clock.hoursAgo(6),
  });
  return out;
}

/** The docs, for tests that lint them as skills. */
export const ENGAGEMENT_DOCS: ReadonlyArray<{ id: string; doc: RunbookDoc }> = [
  { id: 'rb-kb-search-type-pin', doc: kbSearchTypePin },
  { id: 'rb-adot-span-export', doc: adotSpanExport },
  { id: 'rb-pin-bump-verify', doc: pinBumpVerify },
  { id: 'rb-two-phase-runtime-deploy', doc: twoPhaseRuntimeDeploy },
  { id: 'rb-ecs-healthy-not-serving', doc: ecsHealthyNotServing },
  { id: 'rb-custodian-sg-allowlist', doc: custodianSgAllowlist },
];
export const ENGAGEMENT_PROPOSED = { kbSearchTypePinV2Proposed } as const;
