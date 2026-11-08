// The runbook seed (docs/distillation-runbooks-design.md §5.1, lane C): the
// nine hand-written rewrites of the eleven seeded distillation artifacts, the
// open proposals and the application history that give the Library, Proposals
// and Briefs pages a story. scripts/runbooks/migrate-distillation.mjs emits
// exactly these rows for the seeded artifact ids, so this file IS the
// migration's output for the default corpus.
//
// Shape for the store (lane B):
//   RUNBOOK_DOCS / PROPOSAL_DOCS   static RunbookDocs, no timestamps
//   seedRunbooks()                 RunbookSeed[]: the row, its versions, its
//                                  applications, the presentation header and
//                                  the migration record — one per runbook
//   seedRunbookRows() / seedRunbookVersions() / seedRunbookApplications() /
//   seedRunbookProposals()         the same rows flattened per fixture
//   MIGRATION_MAP                  every seeded artifact id → runbook or reason
//
// Every timestamp is read from mock/core/clock.ts inside a factory, never at
// import (fixture floor rule 3). Ages mirror the source artifacts' ages in
// mock/distillation.ts so the history reads in the same order. People are the
// seed cast (schema/seed_program.sql, providers/identity.ts): owners are the
// initiative owners the distillation fixture already named.
import type {
  Runbook, RunbookApplication, RunbookDoc, RunbookHeader, RunbookProposal, RunbookScope, RunbookStatus, RunbookVersion, SessionBrief,
} from '../lib/runbooks/index.js';
import { findSimilar, lintRunbook, versionOf } from '../lib/runbooks/index.js';
import { assembleBrief, type BriefSkillLibrary } from '../lib/runbooks/brief.js';
import { BOX_SKILLS_DIR } from '../lib/runbooks/library.js';
import { clock } from './core/clock.js';

// ─── Cast and places ─────────────────────────────────────────────────────────

export const PEOPLE = {
  'p-002': 'Vera Green',
  'p-004': 'Nora DaSilva',
  'p-008': 'Layla Hassan',
  'p-011': 'Eli Garcia',
  'p-047': 'Nina Rivera',
} as const;
type PersonId = keyof typeof PEOPLE;

const REPO = {
  OBS: 'connorhoehn/orgiq-observability',
  AUTH: 'connorhoehn/orgiq-auth-service',
  LLM: 'connorhoehn/orgiq-llm-platform',
} as const;

/** The author every migrated v1 carries. */
export const MIGRATION_AUTHOR = { kind: 'migration', id: 'scripts/runbooks/migrate-distillation.mjs' } as const;

const bash = (...lines: string[]) => ({ lang: 'bash' as const, text: lines.join('\n') });

// ─── The nine runbooks ───────────────────────────────────────────────────────

const flakyTestRerunDiff: RunbookDoc = {
  title: 'Tell a flaky test from a real regression',
  summary: 'Rerun a failing collector-fleet test alone and in parallel, then diff the runs, before anyone quarantines it as flaky or files a bug against the code.',
  use_when: [
    'A collector-fleet test failed in CI but passes on your machine.',
    'Someone wants to quarantine a test as flaky.',
  ],
  not_for: [
    'A test that fails the same way on every run, locally and in CI: treat it as a regression and debug it.',
    'A CI job that fails before any test runs (install or build errors).',
  ],
  triggers: {
    work_item_labels: ['flaky', 'ci', 'otel'],
    repos: ['orgiq-observability'],
    tools: ['jest', 'gh'],
    keywords: ['flaky', 'test', 'regression', 'rerun', 'quarantine', 'collector'],
  },
  preconditions: [
    "You have the failing CI run's id (`$RUN_ID`) and the test's file and name (`$TEST_FILE`, `$TEST_NAME`).",
    'Your checkout is at the commit CI tested.',
  ],
  steps: [
    {
      do: 'Save the failing CI log for the test before anything reruns over it.',
      command: bash('gh run view "$RUN_ID" --log-failed > failed-ci.log'),
      expect: '`failed-ci.log` holds the failing assertion and its stack.',
    },
    {
      do: 'Rerun the test alone three times, one after another, on the same commit.',
      command: bash('for i in 1 2 3; do npx jest "$TEST_FILE" -t "$TEST_NAME" --runInBand > "rerun-$i.log" 2>&1; echo "run $i exit $?"; done'),
      expect: 'three exit codes: all non-zero means a real regression, any zero means the failure depends on how CI ran it.',
    },
    {
      do: 'Rerun the test with the rest of its suite in parallel, the way CI runs it.',
      command: bash('npx jest "$(dirname "$TEST_FILE")" --maxWorkers=4 > parallel.log 2>&1; echo "exit $?"'),
      expect: 'a failure here but not in step 2 points at state shared between tests, most often two collectors binding one port.',
    },
    {
      do: 'Diff the failing CI output against a passing rerun.',
      command: bash("diff <(grep -E 'Error|expect|EADDRINUSE' failed-ci.log) <(grep -E 'Error|expect|EADDRINUSE' rerun-1.log)"),
      expect: '`EADDRINUSE` or a timeout only on the CI side for port contention, the same assertion on both sides for a regression.',
    },
    {
      do: 'Record the verdict, flaky or regression, on the work item before anyone quarantines the test.',
      command: bash(
        'curl -s -b "$COOKIE_JAR" -X POST "$BFF/api/graph/work-items/$WORK_ITEM_ID/comments" \\',
        "  -H 'content-type: application/json' \\",
        '  -d \'{"body":"Flaky: EADDRINUSE under parallel CI, passes 3 of 3 alone (rerun-1.log, parallel.log)."}\'',
      ),
      expect: 'the new comment in the response, signed with your name.',
    },
  ],
  verify: [
    { check: 'The work item carries the verdict and names the logs it rests on.' },
    { check: 'A test marked flaky passed all three solo reruns in step 2.' },
  ],
  failure_modes: [
    { symptom: 'All three solo reruns fail', cause: 'A real regression, not a flake', response: 'Debug the code; do not quarantine the test' },
    { symptom: 'Solo reruns pass, the parallel run fails with `EADDRINUSE`', cause: 'Two collectors in the suite bind the same port', response: 'Give each test its own port, then rerun step 3' },
    { symptom: 'The CI log is gone', cause: 'The job was re-run over in CI', response: 'Re-run the CI job once and save its log before anything else' },
  ],
  rollback: [
    { do: 'Take the test back out of quarantine if a later failure contradicts a flaky verdict, and post the new evidence on the work item.' },
  ],
  notes: 'Quarantining without this check once hid a real regression for a week: a seed-value bug shipped under a "known flaky" label.\nThe Library skill `skill-flaky-test-triage` is the invocable form of this runbook.',
};

const auroraColdStartRetry: RunbookDoc = {
  title: 'Wake a cold Aurora Data API and retry the first call',
  summary: 'Wake an idle Aurora cluster with a throwaway query, then retry only the known transient errors on a bounded backoff, so real SQL errors still fail loudly.',
  use_when: [
    'The first Data API call after idle or a rebuild fails with `HttpEndpointNotEnabledException`.',
    'A script or agent calls Aurora right after a deploy or a quiet weekend.',
  ],
  not_for: [
    'A SQL error such as `already exists` or a syntax error: fix the statement, never retry it.',
    'Access denied on the secret: check the ARN in `middleware/.env.aws` instead.',
  ],
  triggers: {
    work_item_labels: ['aurora', 'infra'],
    repos: [],
    tools: ['aurora', 'rds-data'],
    keywords: ['aurora', 'cold', 'data api', 'retry', 'idle', 'HttpEndpointNotEnabled'],
  },
  preconditions: [
    'The cluster and secret ARNs are in `$AURORA_CLUSTER_ARN` and `$AURORA_SECRET_ARN` (both in `middleware/.env.aws`).',
    'The AWS CLI is signed in to the account that owns the cluster (`aws sts get-caller-identity` prints it).',
  ],
  steps: [
    {
      do: 'Send one throwaway query to wake the Data API endpoint.',
      command: bash(
        'aws rds-data execute-statement --resource-arn "$AURORA_CLUSTER_ARN" \\',
        "  --secret-arn \"$AURORA_SECRET_ARN\" --database orgiq --sql 'SELECT 1'",
      ),
      expect: 'either one record holding `longValue: 1`, or `HttpEndpointNotEnabledException` on a cold cluster, and both are fine here.',
    },
    {
      do: 'Retry the throwaway query every 3 seconds, at most 6 times, until the cold cluster answers.',
      command: bash(
        'for i in 1 2 3 4 5 6; do',
        '  aws rds-data execute-statement --resource-arn "$AURORA_CLUSTER_ARN" --secret-arn "$AURORA_SECRET_ARN" \\',
        "    --database orgiq --sql 'SELECT 1' > /dev/null 2>&1 && { echo \"warm after $i\"; break; }",
        '  sleep 3',
        'done',
      ),
      expect: '`warm after N` within about 20 seconds.',
      why: 'A 0.5-ACU cluster resumes in seconds, and six tries three seconds apart covers it with room to spare.',
    },
    {
      do: 'Wrap the real call in the same retry, retrying only the cold-start errors the schema loader lists.',
      command: bash("grep -n -i 'transient\\|HttpEndpointNotEnabled' schema/load_schema.py"),
      expect: '`TRANSIENT_MARKERS` and the exception class names it retries, while every other error re-raises on the first attempt.',
    },
    {
      do: 'Leave every other error unretried, so it fails on the first call with its real message.',
      expect: 'a genuine SQL error such as `already exists` to surface at once, not after six retries.',
    },
  ],
  verify: [
    {
      check: 'The throwaway query answers on the first try.',
      command: bash("aws rds-data execute-statement --resource-arn \"$AURORA_CLUSTER_ARN\" --secret-arn \"$AURORA_SECRET_ARN\" --database orgiq --sql 'SELECT 1' --query 'records[0][0].longValue'"),
    },
  ],
  failure_modes: [
    { symptom: 'Still `HttpEndpointNotEnabledException` after six tries', cause: 'The Data API is switched off on the cluster, not just cold', response: 'Check `aws rds describe-db-clusters` for `HttpEndpointEnabled: true` and tell the cluster owner' },
    { symptom: '`BadRequestException` naming the secret', cause: 'A stale secret ARN after a rebuild', response: 'Regenerate `middleware/.env.aws` with `./schema/dump-stack-outputs.sh`' },
    { symptom: 'A real error was retried six times', cause: 'The retry caught every error, not just the transient ones', response: 'Retry only what `TRANSIENT_MARKERS` in `schema/load_schema.py` lists' },
  ],
  rollback: [],
  notes: 'Waking the cluster costs nothing extra: idle Aurora Serverless v2 bills its 0.5 ACU floor (about $45 a month) either way.\nThe Library skill `skill-cold-start-aurora` is the invocable form of this runbook.',
};

const fargateArm64Image: RunbookDoc = {
  title: 'Deploy a Mac-built image to Fargate without exec format errors',
  summary: 'Pin the task definition to ARM64 before deploying an image built on Apple Silicon, so the task starts instead of crash-looping with exec format error.',
  use_when: [
    'You built a container image on a Mac (Apple Silicon) and are deploying it to Fargate.',
    'A Fargate task is replaced in a loop and its log says exec format error.',
  ],
  not_for: [
    'Images built in CI on x86_64 runners, which need the X86_64 platform instead.',
    'Lambda functions, which set their architecture on the function.',
  ],
  triggers: {
    work_item_labels: ['infra', 'fargate'],
    repos: [],
    tools: ['fargate', 'ecs', 'docker'],
    keywords: ['fargate', 'arm64', 'image', 'exec format error', 'task definition', 'crash loop'],
  },
  preconditions: [
    'You know the ECS cluster, service and task family (`$CLUSTER`, `$SERVICE`, `$TASK_FAMILY`).',
    'The image is pushed to ECR as `$IMAGE_URI`.',
  ],
  steps: [
    {
      do: 'Check the architecture of the image you built.',
      command: bash("docker image inspect \"$IMAGE_URI\" --format '{{.Architecture}}'"),
      expect: '`arm64` for an Apple Silicon build.',
    },
    {
      do: 'Check which platform the task definition asks Fargate for.',
      command: bash("aws ecs describe-task-definition --task-definition \"$TASK_FAMILY\" --query 'taskDefinition.runtimePlatform'"),
      expect: '`cpuArchitecture: ARM64`, while `null` means Fargate falls back to x86_64 and the task will crash.',
    },
    {
      do: 'Pin the task definition to ARM64 in its CDK stack, then deploy the stack.',
      command: bash(
        'grep -rn "cpuArchitecture: ecs.CpuArchitecture.ARM64" infra/lib',
        'infra/scripts/deploy.sh "$STACK"',
      ),
      expect: 'the grep shows the pin in your stack, and the deploy ends with the stack in `UPDATE_COMPLETE`.',
    },
    {
      do: 'Wait for the Fargate service to settle on the new task definition.',
      command: bash(
        'aws ecs wait services-stable --cluster "$CLUSTER" --services "$SERVICE"',
        "aws ecs describe-services --cluster \"$CLUSTER\" --services \"$SERVICE\" --query 'services[0].[desiredCount,runningCount]'",
      ),
      expect: 'running equals desired (for example `[1, 1]`), and no task stopped with exec format error.',
    },
  ],
  verify: [
    {
      check: 'The service runs as many tasks as it wants.',
      command: bash("aws ecs describe-services --cluster \"$CLUSTER\" --services \"$SERVICE\" --query 'services[0].[desiredCount,runningCount]'"),
    },
    { check: "The newest task's log shows the app starting, not exec format error." },
  ],
  failure_modes: [
    { symptom: 'Task stops with `exec format error`', cause: '`runtimePlatform` missing or set to X86_64', response: 'Redo step 3' },
    { symptom: 'Stack is `UPDATE_COMPLETE` but nothing is running', cause: 'The ECR repo is empty or the tag is missing', response: 'Push the image, then redeploy; the stack completes even with no image' },
    { symptom: '`CannotPullContainerError`', cause: 'The image manifest has no linux/arm64 entry', response: 'Rebuild with `docker buildx build --platform linux/arm64` and push again' },
  ],
  rollback: [
    {
      do: 'Point the service back at the previous task definition revision if the new one fails its health checks.',
      command: bash('aws ecs update-service --cluster "$CLUSTER" --service "$SERVICE" --task-definition "$TASK_FAMILY:$PREVIOUS_REVISION"'),
    },
  ],
  notes: 'ARM64 is also the cheaper Fargate option, so pinning it costs nothing.\nThe middleware service stack (`infra/lib/middleware-service-stack.ts`) already pins ARM64 and is the example to copy.',
};

const authPrCsrfGate: RunbookDoc = {
  title: 'Get an auth-service pull request through the CSRF check',
  summary: 'Read the CSRF evaluator before you push, fix what it flags in the code, and get the required check green instead of asking for an override.',
  use_when: [
    'You are changing sign-in, session or cookie code in orgiq-auth-service.',
    'The required CSRF check failed on your pull request.',
  ],
  not_for: [
    'Changing the evaluator itself (`lib-csrf-check`), which needs two sign-offs and a Library promotion.',
    'Disabling or skipping the check, which is required by decision and is not yours to waive.',
  ],
  triggers: {
    work_item_labels: ['session', 'oidc', 'jwt', 'csrf'],
    repos: ['orgiq-auth-service'],
    tools: ['gh'],
    keywords: ['csrf', 'pull request', 'cookie', 'session', 'auth', 'check'],
  },
  preconditions: [
    'Your branch is pushed and you know its pull request number (`$PR`).',
    'You can read the Library (any orgiq role) and you have a signed-in cookie jar for the BFF (`$COOKIE_JAR`).',
  ],
  steps: [
    {
      do: 'Look up the CSRF evaluator in the Library to see which version is judging you.',
      command: bash('curl -s -b "$COOKIE_JAR" "$BFF/api/library/lib-csrf-check" | jq \'{version: .asset.version, tier: .asset.tier}\''),
      expect: 'version 5 at endpoint tier.',
    },
    {
      do: "Read the CSRF check's result on your pull request.",
      command: bash('gh pr checks "$PR" --repo connorhoehn/orgiq-auth-service'),
      expect: "the CSRF check listed as required, and on a failure its details link names the lines it judged as weakening.",
    },
    {
      do: 'Fix each flagged line in the code, then push the fix to the pull request.',
      command: bash('git push'),
      expect: 'the CSRF check starts again on the new commit.',
      why: 'The diff reaches the evaluator fenced as untrusted input, so arguing in the description or comments cannot change a verdict.',
    },
    {
      do: 'Wait until every required check, the CSRF check among them, passes on the pull request.',
      command: bash('gh pr checks "$PR" --repo connorhoehn/orgiq-auth-service --required --watch'),
      expect: 'every required check reports `pass`.',
    },
  ],
  verify: [
    {
      check: 'The CSRF check passed on the latest commit of the pull request.',
      command: bash('gh pr checks "$PR" --repo connorhoehn/orgiq-auth-service --required'),
    },
  ],
  failure_modes: [
    { symptom: 'The check fails on a change that only renames code', cause: 'An evaluator false positive', response: 'Ask the owner, Vera Green, to review the verdict, and never bypass the check' },
    { symptom: 'The check never starts', cause: 'The pipeline could not reach the evaluator endpoint', response: 'Re-run it with `gh run rerun`, then tell the owner' },
    { symptom: 'The verdict changes when you edit the description', cause: 'The diff reached the evaluator as instructions, not fenced data', response: 'Stop and report it as a security bug in `lib-csrf-check`' },
  ],
  rollback: [
    { do: 'Revert your fix commit if it broke the sign-in tests, and push the revert.', command: bash('git revert --no-edit HEAD && git push') },
  ],
  notes: 'Decision art-004: every diff touching orgiq-auth-service runs the CSRF evaluator as a required check, because an advisory-only comment once let a CSRF-weakening change merge.',
};

const ingestPiiScan: RunbookDoc = {
  title: 'Ingest a document into the knowledge base after a PII scan',
  summary: 'Scan a document for personal data before it is uploaded, hand anything flagged to a person, and only then upload it and sync the knowledge base.',
  use_when: [
    'You are adding a document to the Bedrock knowledge base.',
    'An ingestion job is about to sync a new upload.',
  ],
  not_for: [
    'Crawled websites, which go through crawl targets on the Knowledge admin page.',
    'Removing personal data from a document that is already embedded (see Roll back).',
  ],
  triggers: {
    work_item_labels: ['ingest', 'kb', 'pii'],
    repos: ['orgiq-llm-platform'],
    tools: ['bedrock'],
    keywords: ['ingest', 'document', 'knowledge base', 'pii', 'personal data', 'upload'],
  },
  preconditions: [
    'You know the knowledge base slug (`$KB_SLUG`) and its data source id (`$DATA_SOURCE_ID`).',
    'You know the id of the PII guardrail from the OrgIQ-Guardrails stack outputs (`$PII_GUARDRAIL_ID`).',
    'The document is a local file (`$DOC`).',
  ],
  steps: [
    {
      do: 'Scan the document text with the PII guardrail.',
      command: bash(
        'aws bedrock-runtime apply-guardrail --guardrail-identifier "$PII_GUARDRAIL_ID" \\',
        '  --guardrail-version DRAFT --source INPUT --query action \\',
        '  --content "[{\\"text\\":{\\"text\\":$(jq -Rs . < "$DOC")}}]"',
      ),
      expect: '`"NONE"`, while `"GUARDRAIL_INTERVENED"` means the scan found personal data.',
    },
    {
      do: 'Stop and hand a flagged document to a person, who decides what to remove.',
      expect: 'nothing is uploaded until the reviewer returns a cleaned file and step 1 prints `"NONE"` for it.',
      why: 'The scan flags and a person decides, and nothing is ever redacted automatically.',
    },
    {
      do: 'Upload the clean document to the knowledge base landing prefix.',
      command: bash(
        'curl -s -b "$COOKIE_JAR" -X POST "$BFF/api/ingest/upload" \\',
        '  -H "X-Filename: $(basename "$DOC")" -H \'Content-Type: application/pdf\' --data-binary @"$DOC"',
      ),
      expect: '`ok: true` and the S3 key under `uploads/`.',
    },
    {
      do: 'Start an ingestion job for this knowledge base and keep its id.',
      command: bash(
        'JOB_ID=$(curl -s -b "$COOKIE_JAR" -X POST "$BFF/api/ingest/start" -H \'content-type: application/json\' \\',
        '  -d "{\\"kbSlug\\":\\"$KB_SLUG\\"}" | jq -r .job.jobId); echo "$JOB_ID"',
      ),
      expect: 'a job id, while a 409 with `conflict: true` means a sync is already running and you should wait for it.',
    },
    {
      do: 'Wait for the ingestion job to finish and read its counts.',
      command: bash('curl -s -b "$COOKIE_JAR" "$BFF/api/ingest/job/$JOB_ID?dataSourceId=$DATA_SOURCE_ID" | jq \'.job | {status, documentsIndexed, documentsFailed}\''),
      expect: '`status: COMPLETE`, at least one document indexed and zero failed.',
    },
  ],
  verify: [
    { check: 'The ingestion job reports the document indexed and none failed.', command: bash('curl -s -b "$COOKIE_JAR" "$BFF/api/ingest/job/$JOB_ID?dataSourceId=$DATA_SOURCE_ID" | jq .job.documentsFailed') },
    { check: 'A search for a phrase from the document returns it from the knowledge base.' },
  ],
  failure_modes: [
    { symptom: 'The scan intervenes on a document you believe is clean', cause: 'A name or email in a footer or signature block', response: 'Send it to a reviewer anyway, since the tool never decides' },
    { symptom: 'Start returns 409 naming a missing `data_source_id`', cause: 'The knowledge base registry row was never adopted', response: 'Re-adopt it on the Knowledge admin page, then redo step 4' },
    { symptom: 'The job completes but the document is missing', cause: 'The upload landed in a prefix the data source does not sync', response: 'Check the data source prefix, then redo steps 3 to 5' },
  ],
  rollback: [
    { do: 'Delete the uploaded object from the landing bucket.', command: bash('aws s3 rm "s3://$LANDING_BUCKET/uploads/$(basename "$DOC")"') },
    { do: 'Start a new ingestion job so the knowledge base drops the document.', command: bash('curl -s -b "$COOKIE_JAR" -X POST "$BFF/api/ingest/start" -H \'content-type: application/json\' -d "{\\"kbSlug\\":\\"$KB_SLUG\\"}"') },
  ],
  notes: 'Convention art-005: scanning after ingestion was tried and rejected, because by then the document was already embedded and indexed.\nThe Library evaluator `lib-pii-scan` (owner Helen Desai) is the ingestion pipeline\'s own form of step 1.',
};

const statsdDecommission: RunbookDoc = {
  title: "Move one service's metrics off StatsD without losing an alert",
  summary: 'Dual-write StatsD and OpenTelemetry for one service until its new dashboards match, move every alert, then remove that one StatsD emitter.',
  use_when: [
    'You are retiring StatsD for one service on the OpenTelemetry everywhere epic.',
    "The service's dashboards already show OpenTelemetry metrics next to the StatsD ones.",
  ],
  not_for: [
    'Switching off the shared StatsD bridge, which waits for the last service (wi-obs-e1-s4).',
    'Services that never emitted StatsD.',
  ],
  triggers: {
    work_item_labels: ['decom', 'otel', 'metrics'],
    repos: ['orgiq-observability'],
    tools: ['cloudwatch'],
    keywords: ['statsd', 'opentelemetry', 'otel', 'decommission', 'alert', 'dashboard', 'metrics'],
  },
  preconditions: [
    'The service already emits OTLP through the collector fleet.',
    'You know the service name (`$SERVICE`) and the prefix its alarms use (`$ALARM_PREFIX`).',
  ],
  steps: [
    {
      do: 'Keep the service dual-writing to StatsD and OpenTelemetry for at least one sprint.',
      command: bash(
        'for ns in StatsD OTel; do',
        '  printf "%s " "$ns"; aws cloudwatch list-metrics --namespace "$ns" --dimensions Name=service,Value="$SERVICE" --query \'length(Metrics)\'',
        'done',
      ),
      expect: 'a non-zero metric count for both namespaces on every day of the sprint.',
    },
    {
      do: 'Compare the OpenTelemetry request count with the StatsD one for the same week.',
      command: bash(
        'for ns in StatsD OTel; do',
        '  aws cloudwatch get-metric-statistics --namespace "$ns" --metric-name requests --dimensions Name=service,Value="$SERVICE" \\',
        '    --start-time "$(date -u -v-7d +%FT%TZ)" --end-time "$(date -u +%FT%TZ)" --period 604800 --statistics Sum --query \'Datapoints[0].Sum\'',
        'done',
      ),
      expect: 'two sums within 5% of each other (repeat for errors and p99), and anything further apart blocks the move.',
      why: 'StatsD counters are flushed per interval and OTel sums are cumulative, so a mismatch is usually aggregation, not lost data.',
    },
    {
      do: "Save every alarm that still reads a StatsD metric for this service.",
      command: bash(
        "aws cloudwatch describe-alarms --alarm-name-prefix \"$ALARM_PREFIX\" \\",
        "  --query \"MetricAlarms[?Namespace=='StatsD']\" > alarms-statsd.json",
        "jq -r '.[].AlarmName' alarms-statsd.json",
      ),
      expect: 'the names of the alarms to move, and an empty list means none are left.',
    },
    {
      do: 'Point each saved StatsD alarm at the matching OpenTelemetry metric.',
      command: bash('aws cloudwatch put-metric-alarm --cli-input-json "file://alarm-otel-$ALARM_NAME.json"'),
      expect: 'step 3 run again prints an empty list.',
    },
    {
      do: 'Remove the StatsD emitter from this one service and deploy it.',
      command: bash('git grep -n -i statsd -- "services/$SERVICE"'),
      expect: 'the grep prints nothing once the emitter is gone, and the deploy passes.',
    },
  ],
  verify: [
    { check: 'No alarm for the service reads a StatsD metric.', command: bash("aws cloudwatch describe-alarms --alarm-name-prefix \"$ALARM_PREFIX\" --query \"length(MetricAlarms[?Namespace=='StatsD'])\"") },
    { check: "The service's OpenTelemetry dashboard keeps reporting for a full day after the deploy." },
  ],
  failure_modes: [
    { symptom: 'An alert went quiet after the move', cause: 'It still read the StatsD metric because step 4 missed it', response: 'Point it at the OpenTelemetry metric, then rerun step 3' },
    { symptom: 'Numbers differ by more than 5% in step 2', cause: 'Different aggregation (StatsD counters are per flush interval)', response: 'Fix the OpenTelemetry view before moving on' },
  ],
  rollback: [
    { do: 'Revert the commit that removed the emitter and redeploy the service.', command: bash('git revert --no-edit "$REMOVAL_COMMIT"') },
    {
      do: 'Restore each alarm from the definitions saved in step 3.',
      command: bash("jq -c '.[]' alarms-statsd.json | while read -r a; do aws cloudwatch put-metric-alarm --cli-input-json \"$a\"; done"),
    },
  ],
  notes: 'Draft: the alert step is new and has not been run on a second service yet.\nThe dual-write window is what gives on-call a fallback dashboard while a service moves.',
};

const ssoNewOrigin: RunbookDoc = {
  title: 'Bring SSO up on a new origin without breaking the picker',
  summary: 'Turn on single sign-on for a new web address in the one order that keeps the account picker working while HTTPS is set up.',
  use_when: [
    "A tenant's portal is moving to, or adding, a new origin and SSO must work there.",
    'Sign-in broke the moment someone set the Cognito callback on a new address.',
  ],
  not_for: [
    'Cutting a tenant over from SAML (use rb-tenant-cutover).',
    'Changing which users may sign in, which is a grants change and not an origin change.',
  ],
  triggers: {
    work_item_labels: ['sso', 'oidc', 'auth'],
    repos: ['orgiq-auth-service'],
    tools: ['cognito'],
    keywords: ['sso', 'origin', 'callback', 'picker', 'cognito', 'https', 'sign-in'],
  },
  preconditions: [
    'You can edit the middleware environment for the new origin.',
    'You know the new host name (`$NEW_HOST`).',
  ],
  steps: [
    {
      do: 'Leave the Cognito callback unset so the account picker keeps working.',
      command: bash("grep -c '^COGNITO_CALLBACK_URL=' middleware/.env.aws"),
      expect: '`0`, and the sign-in page on the new origin still shows the picker.',
      why: 'Cognito rejects a non-localhost http callback before any app code runs, so setting it early takes sign-in down.',
    },
    {
      do: 'Test SSO locally first, on a localhost callback that Cognito allows over plain http.',
      command: bash('curl -s http://localhost:5183/api/auth/config | jq .ssoEnabled'),
      expect: '`true` locally, and a hosted-UI sign-in on localhost lands back in the portal.',
    },
    {
      do: 'Put an HTTPS front door up on the new origin.',
      command: bash('curl -sI "https://$NEW_HOST/api/health" | head -1'),
      expect: 'an HTTP 200 status line over https with a valid certificate.',
    },
    {
      do: 'Set the callback for the new origin and restart the middleware.',
      command: bash('printf \'COGNITO_CALLBACK_URL=https://%s/api/auth/callback\\n\' "$NEW_HOST" >> middleware/.env.aws'),
      expect: 'the middleware restarts with no Cognito error in its log.',
    },
    {
      do: 'Confirm the new origin reports SSO as on.',
      command: bash('curl -s "https://$NEW_HOST/api/auth/config" | jq .ssoEnabled'),
      expect: '`true`.',
    },
  ],
  verify: [
    { check: 'A test user signs in through SSO on the new origin.' },
    { check: 'The picker still works on localhost.', command: bash('curl -s http://localhost:5183/api/auth/config | jq .ssoEnabled') },
  ],
  failure_modes: [
    { symptom: 'Every sign-in fails right after step 4', cause: 'The callback is http on a non-localhost origin', response: 'Roll back, finish step 3, then redo step 4' },
    { symptom: '`redirect_mismatch` from the hosted UI', cause: "The app client's callback list lacks the new origin", response: 'Add the origin to the app client, then retry step 5' },
  ],
  rollback: [
    {
      do: 'Remove the callback line and restart the middleware so the picker comes back.',
      command: bash("sed -i '' '/^COGNITO_CALLBACK_URL=/d' middleware/.env.aws"),
    },
  ],
  notes: 'The Library skill `skill-sso-origin-bringup` is the invocable form of this runbook.',
};

const tenantCutoverV1: RunbookDoc = {
  title: 'Cut one tenant over from SAML to Cognito',
  summary: "Move one customer tenant's sign-in from the legacy SAML shim to Cognito without signing anyone out, with a five-minute way back.",
  use_when: ['You are cutting over a single tenant on the Auth Migration initiative.'],
  not_for: [
    'Deleting the SAML shim, which waits until the last tenant has moved (see the d-legacy-auth decision).',
    'Choosing the order of tenants, which is still escalated (d-cognito-cutover).',
  ],
  triggers: {
    work_item_labels: ['decom', 'runbook', 'cutover'],
    repos: ['orgiq-auth-service'],
    tools: ['cognito'],
    keywords: ['tenant', 'cutover', 'saml', 'cognito', 'sign-in', 'shim'],
  },
  preconditions: [
    "The tenant's Cognito app client exists and you know its id (`$CLIENT_ID`).",
    'The SAML shim is still running behind the per-tenant flag, a parameter at `/auth/tenants/$TENANT/idp` that reads `saml`.',
    "You know the tenant's portal origin (`$ORIGIN`).",
  ],
  steps: [
    {
      do: 'Confirm sign-in works on the shim before you touch anything.',
      command: bash('curl -s "$ORIGIN/api/auth/config" | jq .ssoEnabled'),
      expect: '`false` (the tenant is still on the shim).',
    },
    {
      do: "Flip only this tenant's flag, never several tenants in one change.",
      command: bash('aws ssm put-parameter --name "/auth/tenants/$TENANT/idp" --value cognito --type String --overwrite'),
      expect: "a new parameter `Version`, and this tenant's sign-in page sends you to the Cognito hosted UI while every other tenant still sees the shim.",
      why: 'One tenant per change keeps the blast radius to one customer and the rollback to one parameter.',
    },
    {
      do: 'Sign in as a test user of this tenant and check no live session was dropped.',
      command: bash(
        'aws logs filter-log-events --log-group-name /auth/bff --start-time "$(( ($(date +%s) - 900) * 1000 ))" \\',
        '  --filter-pattern "{ $.event = \\"forced_logout\\" && $.tenant = \\"$TENANT\\" }" --query \'length(events)\'',
      ),
      expect: '`0` forced logouts in the last 15 minutes, and the test user signs in on the first try.',
    },
  ],
  verify: [
    { check: '`GET $ORIGIN/api/auth/config` reports `ssoEnabled: true`.', command: bash('curl -s "$ORIGIN/api/auth/config" | jq .ssoEnabled') },
    { check: "No `session_epoch` bump for this tenant's existing users." },
  ],
  failure_modes: [
    { symptom: 'Users signed out mid-day', cause: 'Flag flipped for more than one tenant', response: 'Roll back every tenant flipped in that change' },
    { symptom: 'The old SAML page still shows after the flip', cause: 'The flag has not reached this tenant yet', response: 'Wait one grants refresh (about 2 minutes), then redo step 3' },
  ],
  rollback: [{
    do: "Flip this tenant's flag back, and the shim answers within one grants refresh (about 2 minutes).",
    command: bash('aws ssm put-parameter --name "/auth/tenants/$TENANT/idp" --value saml --type String --overwrite'),
  }],
  notes: 'Existing sessions survive because a cutover never bumps `session_epoch`; only a tenant or role switch does, and that drops older cookies within about 120 seconds (convention art-007).\nTreat the order of tenants as a parameter: this runbook covers one tenant.',
};

const idleTeardownProposal: RunbookDoc = {
  title: 'Propose an idle-capacity teardown that gets approved',
  summary: "Attribute an idle resource's spend to the initiative that owns it, then write a teardown proposal naming the floor removed and the monthly dollars saved.",
  use_when: [
    'Idle infrastructure is billing and you want it torn down.',
    'A teardown proposal came back for being vague about cost.',
  ],
  not_for: [
    'Resizing a resource you keep, such as Aurora ACU right-sizing.',
    'Cutting cost during an incident, where you page the initiative owner instead.',
  ],
  triggers: {
    work_item_labels: ['finops', 'teardown', 'showback', 'tagging'],
    repos: ['orgiq-finops'],
    tools: ['cost-explorer'],
    keywords: ['idle', 'teardown', 'cost', 'showback', 'floor', 'proposal', 'spend'],
  },
  preconditions: [
    'You know the idle resource (`$RESOURCE_ARN`) and the initiative that owns it (`$INITIATIVE`, for example p-cost-opt).',
    'Resources carry an `initiative` cost-allocation tag.',
  ],
  steps: [
    {
      do: "Pull the owning initiative's last 30 days of cost, grouped by service, to find the idle resource's share.",
      command: bash(
        'aws ce get-cost-and-usage --time-period "Start=$(date -v-30d +%F),End=$(date +%F)" \\',
        '  --granularity MONTHLY --metrics UnblendedCost --group-by Type=DIMENSION,Key=SERVICE \\',
        '  --filter "{\\"Tags\\":{\\"Key\\":\\"initiative\\",\\"Values\\":[\\"$INITIATIVE\\"]}}"',
      ),
      expect: "a cost per service for the month, the idle resource's service among them.",
    },
    {
      do: "Tag the idle resource with the owning initiative if its spend is missing from step 1.",
      command: bash('aws resourcegroupstaggingapi tag-resources --resource-arn-list "$RESOURCE_ARN" --tags "initiative=$INITIATIVE"'),
      expect: 'an empty `FailedResourcesMap`, and the next day step 1 shows the spend under the initiative.',
    },
    {
      do: 'Write the teardown proposal naming the floor removed, the initiative billed and the monthly dollars saved.',
      expect: 'one paragraph a release manager can approve without a question, such as "Remove the idle OpenSearch collection (2 OCU floor) billed to p-cost-opt, saving about $350 a month."',
    },
    {
      do: 'Bring the dollar figure from step 1 to the review meeting and ask for the teardown decision there.',
      expect: 'an approve or reject recorded in the meeting, not a follow-up.',
    },
  ],
  verify: [
    { check: 'The proposal names one resource, one initiative id and one monthly dollar figure.' },
    { check: "The idle resource's spend shows under the initiative, not as unattributed, in the step 1 query." },
  ],
  failure_modes: [
    { symptom: 'The proposal is deferred for more data', cause: 'The figure was a guess or a shared-bucket estimate', response: 'Redo steps 1 and 2 and bring the attributed number' },
    { symptom: 'The owner says the resource is not idle', cause: 'Idle was judged on too short a window', response: 'Show 30 days of usage, not a week' },
  ],
  rollback: [
    { do: 'Remove the initiative tag if it went on the wrong resource.', command: bash('aws resourcegroupstaggingapi untag-resources --resource-arn-list "$RESOURCE_ARN" --tag-keys initiative') },
  ],
  notes: 'A per-initiative showback figure is what got the last teardown approved in one meeting.\nTear down only after the decision, and pre-drain an Aurora cluster before its stack is destroyed so the 0.5 ACU floor stops billing (`infra/scripts/destroy.sh` does this).',
};

// ─── v2 of rb-tenant-cutover: the open edit from the failed run ──────────────
// The design's example #9: run sess-auth-06 failed at the flip because the
// hosted-UI redirect still pointed at the old domain. The lesson the old
// distillation could never turn into an edit becomes a proposal: a new step 2.

const tenantCutoverV2Proposed: RunbookDoc = {
  ...tenantCutoverV1,
  preconditions: [
    ...tenantCutoverV1.preconditions,
    'You know the user pool id (`$POOL_ID`).',
  ],
  steps: [
    tenantCutoverV1.steps[0]!,
    {
      do: "Add the Cognito callback for this tenant's origin to its app client.",
      command: bash(
        'aws cognito-idp update-user-pool-client --user-pool-id "$POOL_ID" \\',
        '  --client-id "$CLIENT_ID" --callback-urls "$ORIGIN/api/auth/callback"',
      ),
      expect: "the response's `CallbackURLs` to list `$ORIGIN/api/auth/callback`.",
      why: 'The second pilot run failed at the flip because the redirect still pointed at the old domain.',
    },
    tenantCutoverV1.steps[1]!,
    tenantCutoverV1.steps[2]!,
  ],
  failure_modes: [
    { symptom: 'Sign-in bounces to the old service', cause: 'Callback list not updated (step 2 skipped)', response: 'Roll back, then redo step 2' },
    ...tenantCutoverV1.failure_modes,
  ],
};

// ─── New runbooks proposed by runs and people ────────────────────────────────

/** Proposed by run sess-llm-05: a rubric edit took an hour to land while the judge config was cached. */
const judgeRubricWeights: RunbookDoc = {
  title: "Change the canary judge's rubric weights without a redeploy",
  summary: 'Edit the judge rubric weights through the evaluations API, which writes the SSM-backed config that every canary ask reads, and check the next score uses them.',
  use_when: [
    'The canary judge weighs a rubric dimension wrongly and you want to change the weights.',
    'A rubric weight change seems not to have taken effect.',
  ],
  not_for: [
    'Changing the judge model, which is an open decision (d-eval-judge-model).',
    'Editing the subject prompt under test, which goes through Prompt Studio.',
  ],
  triggers: {
    work_item_labels: ['canary', 'evals'],
    repos: ['orgiq-llm-platform'],
    tools: ['ssm'],
    keywords: ['judge', 'rubric', 'weights', 'canary', 'evaluation', 'config'],
  },
  preconditions: [
    'You hold `ManageCanary` (sme or org-leader in orgiq) and a signed-in cookie jar (`$COOKIE_JAR`).',
  ],
  steps: [
    {
      do: 'Save the current judge config before you change it.',
      command: bash('curl -s -b "$COOKIE_JAR" "$BFF/api/observability/evaluations/config" | tee judge-config.before.json | jq \'.dimensions\''),
      expect: 'the rubric dimensions with weights that add up to 100.',
    },
    {
      do: 'Change the rubric weights in a copy, keeping their sum at 100.',
      command: bash(
        'jq \'(.dimensions[] | select(.key=="factuality") | .weight) = 40',
        '  | (.dimensions[] | select(.key=="conciseness") | .weight) = 10\' judge-config.before.json > judge-config.after.json',
        "jq '[.dimensions[].weight] | add' judge-config.after.json",
      ),
      expect: '`100`.',
    },
    {
      do: 'Save the new judge config through the evaluations API.',
      command: bash(
        'curl -s -b "$COOKIE_JAR" -X PUT "$BFF/api/observability/evaluations/config" \\',
        "  -H 'content-type: application/json' --data @judge-config.after.json | jq .ok",
      ),
      expect: '`true`.',
    },
    {
      do: 'Wait 20 seconds for the judge config cache, then read the newest judge score.',
      command: bash('sleep 20; curl -s -b "$COOKIE_JAR" "$BFF/api/observability/evaluations/recent?limit=1" | jq \'.scores[0]\''),
      expect: 'a score stamped after your change, weighted with the new rubric.',
    },
  ],
  verify: [
    { check: 'The judge config the API returns carries the new weights.', command: bash('curl -s -b "$COOKIE_JAR" "$BFF/api/observability/evaluations/config" | jq \'.dimensions\'') },
  ],
  failure_modes: [
    { symptom: 'The PUT returns 403', cause: 'Your role lacks `ManageCanary`', response: 'Ask an sme or org-leader on the initiative to make the change' },
    { symptom: 'Scores still use the old weights after a minute', cause: 'A process kept its own cached copy of the config', response: 'Report it, because the judge must read the config on every ask' },
  ],
  rollback: [
    {
      do: 'Put the saved config back.',
      command: bash("curl -s -b \"$COOKIE_JAR\" -X PUT \"$BFF/api/observability/evaluations/config\" -H 'content-type: application/json' --data @judge-config.before.json"),
    },
  ],
  notes: 'The judge config lives in SSM (`/orgiq/canary/judge_config`) and is owned by the middleware, not by the canary stack, so a redeploy is never needed to change it.',
};

/** Proposed by Eli Garcia: a near-duplicate of rb-flaky-test-rerun-diff, so the reviewer sees "Looks like…" and merges it. */
const flakyQuarantineCheck: RunbookDoc = {
  title: 'Rerun a flaky collector test before you quarantine it',
  summary: 'Rerun a collector-fleet test that failed in CI three times alone before anyone marks it flaky, so a real regression is never quarantined.',
  use_when: [
    'A collector-fleet test failed in CI and someone wants to quarantine it as flaky.',
  ],
  not_for: ['Tests that fail the same way on every run.'],
  triggers: {
    work_item_labels: ['flaky', 'ci'],
    repos: ['orgiq-observability'],
    tools: ['jest'],
    keywords: ['flaky', 'test', 'rerun', 'quarantine', 'collector', 'regression'],
  },
  preconditions: ['You know the failing test file and name (`$TEST_FILE`, `$TEST_NAME`).'],
  steps: [
    {
      do: 'Rerun the flaky test alone three times.',
      command: bash('for i in 1 2 3; do npx jest "$TEST_FILE" -t "$TEST_NAME" --runInBand; echo "run $i exit $?"; done'),
      expect: 'any zero exit code means the test is flaky, and three failures mean a regression.',
    },
    {
      do: 'Mark the test as quarantined only when at least one rerun passed.',
      expect: 'a quarantined test always has a passing rerun on record.',
    },
  ],
  verify: [{ check: 'Every quarantined collector test has a passing rerun on record.' }],
  failure_modes: [
    { symptom: 'All three reruns fail', cause: 'A real regression', response: 'Do not quarantine it, and debug the code' },
  ],
  rollback: [{ do: 'Take the test out of quarantine if it later fails alone.' }],
};

/** Every RunbookDoc in this seed, keyed `<runbook id>@<version>`. */
export const RUNBOOK_DOCS: Record<string, RunbookDoc> = {
  'rb-flaky-test-rerun-diff@1': flakyTestRerunDiff,
  'rb-aurora-cold-start-retry@1': auroraColdStartRetry,
  'rb-fargate-arm64-image@1': fargateArm64Image,
  'rb-auth-pr-csrf-gate@1': authPrCsrfGate,
  'rb-ingest-pii-scan@1': ingestPiiScan,
  'rb-statsd-decommission@1': statsdDecommission,
  'rb-sso-new-origin@1': ssoNewOrigin,
  'rb-tenant-cutover@1': tenantCutoverV1,
  'rb-idle-teardown-proposal@1': idleTeardownProposal,
};

/** The documents the open proposals carry, keyed by proposal id. */
export const PROPOSAL_DOCS: Record<string, RunbookDoc> = {
  'prop-tenant-cutover-callback': tenantCutoverV2Proposed,
  'prop-judge-rubric-weights': judgeRubricWeights,
  'prop-flaky-quarantine-check': flakyQuarantineCheck,
};

// ─── The migration record ────────────────────────────────────────────────────

/** How a source procedure's ordered facts land in the rewrite (design §5.1 rule 5). `step: null` = not a step any more. */
export interface StepMapEntry { fact_id: string; ordinal: number; step: number | null; now: string }

export interface MigrationEntry {
  artifact_id: string;
  /** The runbook it became, or null when it was not migrated. */
  runbook_id: string | null;
  /** Why it was not migrated, or what was kept and where. */
  reason: string | null;
}

/** Every artifact of the default distillation corpus, accounted for. */
export const MIGRATION_MAP: readonly MigrationEntry[] = [
  { artifact_id: 'art-001', runbook_id: 'rb-flaky-test-rerun-diff', reason: null },
  { artifact_id: 'art-002', runbook_id: 'rb-aurora-cold-start-retry', reason: null },
  { artifact_id: 'art-003', runbook_id: 'rb-fargate-arm64-image', reason: null },
  { artifact_id: 'art-004', runbook_id: 'rb-auth-pr-csrf-gate', reason: null },
  { artifact_id: 'art-005', runbook_id: 'rb-ingest-pii-scan', reason: null },
  { artifact_id: 'art-006', runbook_id: 'rb-statsd-decommission', reason: null },
  {
    artifact_id: 'art-007', runbook_id: null,
    reason: 'not a procedure: a session convention with nothing to run; kept as a note on rb-tenant-cutover and to be re-homed as a decision on p-auth-migration',
  },
  {
    artifact_id: 'art-008', runbook_id: null,
    reason: 'retired and superseded (the Aurora half by skill-cold-start-aurora); its pre-drain lesson is a note on rb-idle-teardown-proposal',
  },
  { artifact_id: 'art-009', runbook_id: 'rb-sso-new-origin', reason: null },
  { artifact_id: 'art-010', runbook_id: 'rb-tenant-cutover', reason: null },
  { artifact_id: 'art-011', runbook_id: 'rb-idle-teardown-proposal', reason: null },
];

// ─── Rows ────────────────────────────────────────────────────────────────────

export interface RunbookSeed {
  runbook: Runbook;
  versions: RunbookVersion[];
  applications: RunbookApplication[];
  /** Presentation around the stored markdown (renderRunbook's second argument). */
  header: RunbookHeader;
  migration: {
    source_artifact_ids: string[];
    /** Other artifacts (not migrated on their own) whose lesson this runbook's notes keep. */
    cites_artifact_ids: string[];
    step_map: StepMapEntry[];
  };
}

interface Spec {
  id: string;
  doc: RunbookDoc;
  scope: RunbookScope;
  scope_label: string;
  owner: PersonId;
  status: RunbookStatus;
  /** Hours ago: the source artifact's created_at, and the v1 acceptance (its review, or creation when never reviewed). */
  created_h: number;
  accepted_h: number;
  provenance: RunbookVersion['provenance'];
  cites: string[];
  step_map: StepMapEntry[];
  /** [run_ref, hours ago, outcome, failed_at_step, note] */
  runs: Array<[string, number, RunbookApplication['outcome'], number | null, string | null]>;
  story: string;
}

function specs(): Spec[] {
  return [
    {
      id: 'rb-flaky-test-rerun-diff', doc: flakyTestRerunDiff,
      scope: { kind: 'repo', ref: REPO.OBS }, scope_label: 'repo orgiq-observability', owner: 'p-004', status: 'published',
      created_h: 40, accepted_h: 9,
      provenance: { run_refs: [], session_ids: ['sess-obs-03'], lab_experience_ids: ['obs-021', 'obs-022', 'obs-023'], source_artifact_ids: ['art-001'] },
      cites: [], step_map: [],
      runs: [['sess-obs-04', 30, 'followed', null, null], ['sess-obs-05', 3, 'followed', null, 'Flaky: EADDRINUSE under parallel CI; passes alone.']],
      story: 'Rewritten from distillation artifact art-001 (a published runbook) and the three run notes of session sess-obs-03.',
    },
    {
      id: 'rb-aurora-cold-start-retry', doc: auroraColdStartRetry,
      scope: { kind: 'tool', ref: 'aurora' }, scope_label: 'tool aurora', owner: 'p-008', status: 'published',
      created_h: 40, accepted_h: 40,
      provenance: { run_refs: [], session_ids: ['sess-cost-02'], lab_experience_ids: ['obs-066', 'obs-067', 'obs-068'], source_artifact_ids: ['art-002'] },
      cites: [], step_map: [],
      runs: [['sess-cost-04', 5, 'followed', null, null]],
      story: 'Rewritten from distillation artifact art-002 (a published runbook) and the run notes of session sess-cost-02.',
    },
    {
      id: 'rb-fargate-arm64-image', doc: fargateArm64Image,
      scope: { kind: 'tool', ref: 'fargate' }, scope_label: 'tool fargate', owner: 'p-004', status: 'published',
      created_h: 40, accepted_h: 30,
      provenance: { run_refs: [], session_ids: ['sess-obs-03'], lab_experience_ids: ['obs-024', 'obs-025', 'obs-026'], source_artifact_ids: ['art-003'] },
      cites: [], step_map: [],
      runs: [['sess-obs-06', 4, 'followed', null, null]],
      story: 'Written from distillation insight art-003, which held the lesson but no steps, and the run notes of session sess-obs-03.',
    },
    {
      id: 'rb-auth-pr-csrf-gate', doc: authPrCsrfGate,
      scope: { kind: 'repo', ref: REPO.AUTH }, scope_label: 'repo orgiq-auth-service', owner: 'p-002', status: 'published',
      created_h: 70, accepted_h: 60,
      provenance: { run_refs: [], session_ids: ['sess-auth-01'], lab_experience_ids: ['obs-039', 'obs-040', 'obs-041', 'obs-042'], source_artifact_ids: ['art-004'] },
      cites: [], step_map: [],
      runs: [['sess-auth-05', 12, 'followed', null, null], [FROZEN_RUN.runRef, 3, 'followed', null, null]],
      story: 'Written from distillation decision art-004, which said what is required but not how to get through it, and the run notes of session sess-auth-01.',
    },
    {
      id: 'rb-ingest-pii-scan', doc: ingestPiiScan,
      scope: { kind: 'repo', ref: REPO.LLM }, scope_label: 'repo orgiq-llm-platform', owner: 'p-047', status: 'published',
      created_h: 70, accepted_h: 45,
      provenance: { run_refs: [], session_ids: ['sess-llm-02'], lab_experience_ids: ['obs-054', 'obs-055', 'obs-056'], source_artifact_ids: ['art-005'] },
      cites: [], step_map: [],
      runs: [],
      story: 'Written from distillation convention art-005 and the run notes of session sess-llm-02.',
    },
    {
      id: 'rb-statsd-decommission', doc: statsdDecommission,
      scope: { kind: 'repo', ref: REPO.OBS }, scope_label: 'repo orgiq-observability', owner: 'p-004', status: 'draft',
      created_h: 70, accepted_h: 70,
      provenance: { run_refs: [], session_ids: ['sess-obs-02'], lab_experience_ids: ['obs-014', 'obs-015', 'obs-016'], source_artifact_ids: ['art-006'] },
      cites: [], step_map: [],
      runs: [],
      story: 'Rewritten from distillation artifact art-006 (a draft runbook awaiting review) and the run notes of session sess-obs-02.',
    },
    {
      id: 'rb-sso-new-origin', doc: ssoNewOrigin,
      scope: { kind: 'initiative', ref: 'p-auth-migration' }, scope_label: 'Auth Migration', owner: 'p-002', status: 'published',
      created_h: 10, accepted_h: 8,
      provenance: { run_refs: [], session_ids: ['sess-auth-02'], lab_experience_ids: ['obs-033', 'obs-034', 'obs-035'], source_artifact_ids: ['art-009'] },
      cites: [],
      step_map: [
        { fact_id: 'fact-013', ordinal: 1, step: 1, now: 'Leave the Cognito callback unset' },
        { fact_id: 'fact-014', ordinal: 2, step: 2, now: 'Test SSO locally first' },
        { fact_id: 'fact-015', ordinal: 3, step: 3, now: 'Put an HTTPS front door up' },
        { fact_id: 'fact-016', ordinal: 4, step: 4, now: 'Set the callback (and step 5 confirms it)' },
      ],
      runs: [
        ['sess-auth-04', 8, 'followed', null, null], ['sess-auth-05', 5, 'followed', null, null],
        ['sess-auth-06', 2, 'followed', null, null], ['sess-auth-04', 1, 'followed', null, null],
      ],
      story: 'Rewritten from distillation procedure art-009 (steps fact-013 to fact-016) and the run notes of session sess-auth-02; its four runs carried over.',
    },
    {
      id: 'rb-tenant-cutover', doc: tenantCutoverV1,
      scope: { kind: 'initiative', ref: 'p-auth-migration' }, scope_label: 'Auth Migration', owner: 'p-002', status: 'published',
      created_h: 10, accepted_h: 10,
      provenance: { run_refs: [], session_ids: ['sess-auth-02'], lab_experience_ids: ['obs-036', 'obs-037', 'obs-038'], source_artifact_ids: ['art-010'] },
      cites: ['art-007'],
      step_map: [
        { fact_id: 'fact-018', ordinal: 1, step: 1, now: 'Confirm sign-in works on the shim (the shim stays, flagged)' },
        { fact_id: 'fact-019', ordinal: 2, step: 3, now: 'Sign in and check no live session was dropped' },
        { fact_id: 'fact-020', ordinal: 3, step: 2, now: "Flip only this tenant's flag" },
        { fact_id: 'fact-021', ordinal: 4, step: null, now: 'Roll back (flip the flag back)' },
      ],
      runs: [
        ['sess-auth-05', 6, 'followed', null, null],
        ['sess-auth-06', 1.5, 'failed', 2, 'flag flipped but the hosted-UI redirect still resolved to the old domain'],
      ],
      story: 'Rewritten from distillation procedure art-010 (steps fact-018 to fact-021) and the run notes of session sess-auth-02; its two runs carried over, the failure at the flip landing on step 2.',
    },
    {
      id: 'rb-idle-teardown-proposal', doc: idleTeardownProposal,
      scope: { kind: 'initiative', ref: 'p-cost-opt' }, scope_label: 'Cost Optimization', owner: 'p-008', status: 'published',
      created_h: 10, accepted_h: 6,
      provenance: { run_refs: [], session_ids: ['sess-cost-01'], lab_experience_ids: ['obs-057', 'obs-058', 'obs-059', 'obs-064'], source_artifact_ids: ['art-011'] },
      cites: ['art-008'],
      step_map: [
        { fact_id: 'fact-022', ordinal: 1, step: 2, now: 'Tag the resource with its initiative' },
        { fact_id: 'fact-023', ordinal: 2, step: 3, now: 'Write the proposal naming floor, initiative and dollars' },
        { fact_id: 'fact-024', ordinal: 3, step: 4, now: 'Bring the dollar figure to the meeting' },
      ],
      runs: [],
      story: 'Rewritten from distillation procedure art-011 (steps fact-022 to fact-024) and the run notes of session sess-cost-01, with the pre-drain lesson from retired art-008.',
    },
  ];
}

function header(s: Spec): RunbookHeader {
  return { id: s.id, version: 1, scope_label: s.scope_label, owner_name: PEOPLE[s.owner], provenance: s.story };
}

// ─── The one frozen brief ────────────────────────────────────────────────────
// auth-dep-watch's firing of today (mock/bots.ts `job-auth-maint-1`: done, "bumped the JWT library in the
// token verifier; the OIDC conformance suite is green", 238 s) is the one seeded run that started after the
// runbooks existed (they were accepted 45-60 h ago), so it is the run whose brief was frozen. It is a
// scheduled run, so it has no work item: the brief carries the project and the CSRF-gate runbook the
// auth-service repo scope selected. Its start is the bot run's own (clock.hoursAgo(3, keepWithinToday)).
export const FROZEN_RUN = { runRef: 'job-auth-maint-1', briefId: 'brief-job-auth-maint-1', startedHoursAgo: 3, seconds: 238 } as const;
const frozenRunStartMs = () => Date.parse(clock.hoursAgo(FROZEN_RUN.startedHoursAgo, { keepWithinToday: true }));
const frozenRunFinishedAt = () => new Date(Math.min(frozenRunStartMs() + FROZEN_RUN.seconds * 1000, Date.parse(clock.nowIso()))).toISOString();

/**
 * The briefs frozen on seeded runs: assembled when the job was claimed, a few seconds before it started.
 * R8: a brief records the org's skill library its box synced (`library`, from the seam: every
 * published runbook, tools included); without one, this module's own runbooks stand in.
 */
export function seedBriefs(library?: BriefSkillLibrary | null): SessionBrief[] {
  const lib = library ?? {
    sha256: '0'.repeat(64), dir: BOX_SKILLS_DIR,
    skills: seedRunbooks().filter((x) => x.runbook.status === 'published').map((x) => ({ name: x.runbook.id, version: x.runbook.current_version })).sort((p, q) => (p.name < q.name ? -1 : 1)),
  };
  return [assembleBrief({
    run_ref: FROZEN_RUN.runRef,
    brief_id: FROZEN_RUN.briefId,
    assembled_at: new Date(frozenRunStartMs() - 20_000).toISOString(),
    framing: 'You are running unattended as the auth-dep-watch bot. Nobody can answer a question: do the task, say what you did, and stop.',
    work_item: null,
    initiative: { id: 'p-auth-migration', name: 'Auth Migration', repo: REPO.AUTH },
    repo: REPO.AUTH,
    decisions: [],
    skill_library: lib,
  })];
}

/** One RunbookSeed per runbook, timestamps read from the clock now. */
export function seedRunbooks(): RunbookSeed[] {
  return specs().map((s) => {
    const createdAt = clock.hoursAgo(s.created_h);
    const acceptedAt = clock.hoursAgo(s.accepted_h);
    const apps: RunbookApplication[] = s.runs.map(([runRef, h, outcome, failedAt, note], k) => ({
      id: `rba-${s.id.slice(3)}-${k + 1}`,
      runbook_id: s.id, version: 1, run_ref: runRef,
      // Most seeded runs predate session briefs: nothing was frozen for them, so
      // there is no brief to name (RunbookApplication.brief_id is nullable for it).
      // The one job that ran after the runbooks existed was handed a frozen brief.
      brief_id: runRef === FROZEN_RUN.runRef ? FROZEN_RUN.briefId : null,
      outcome, failed_at_step: failedAt, note,
      at: runRef === FROZEN_RUN.runRef ? frozenRunFinishedAt() : clock.hoursAgo(h),
    }));
    return {
      runbook: {
        id: s.id, scope: s.scope, owner_person_id: s.owner, status: s.status, current_version: 1,
        created_at: createdAt, updated_at: acceptedAt,
      },
      versions: [versionOf({
        runbook_id: s.id, version: 1, doc: s.doc, author: { ...MIGRATION_AUTHOR },
        proposal_id: null, accepted_by: s.owner, accepted_at: acceptedAt, provenance: s.provenance,
      })],
      applications: apps,
      header: header(s),
      migration: { source_artifact_ids: [...s.provenance.source_artifact_ids], cites_artifact_ids: s.cites, step_map: s.step_map },
    };
  });
}

export const seedRunbookRows = (): Runbook[] => seedRunbooks().map((s) => s.runbook);
export const seedRunbookVersions = (): RunbookVersion[] => seedRunbooks().flatMap((s) => s.versions);
export const seedRunbookApplications = (): RunbookApplication[] => seedRunbooks().flatMap((s) => s.applications);

// ─── Proposals ───────────────────────────────────────────────────────────────

export function seedRunbookProposals(): RunbookProposal[] {
  const published = specs()
    .filter((s) => s.status === 'published')
    .map((s) => ({ runbook_id: s.id, scope: s.scope, doc: s.doc }));
  const proposal = (p: Omit<RunbookProposal, 'lint' | 'similar' | 'status' | 'decided_by' | 'decided_at' | 'note' | 'merged_into'>, scope: RunbookScope): RunbookProposal => ({
    ...p,
    lint: p.proposed ? lintRunbook(p.proposed) : [],
    similar: p.kind === 'new' && p.proposed ? findSimilar(p.proposed, scope, published) : [],
    status: 'open', decided_by: null, decided_at: null, note: null, merged_into: null,
  });
  return [
    proposal({
      id: 'prop-tenant-cutover-callback', kind: 'edit', runbook_id: 'rb-tenant-cutover', base_version: 1,
      proposed: tenantCutoverV2Proposed,
      rationale: 'Run sess-auth-06 followed v1 and failed at step 2: the flag flipped but the hosted-UI redirect still resolved to the old domain, because the tenant\'s origin was never on its Cognito app client\'s callback list. This adds that as a new step 2, before the flip, and a failure-mode row for the symptom.',
      source: { kind: 'run', run_ref: 'sess-auth-06', session_id: 'sess-auth-06', work_item_id: 'wi-auth-e2-s2', lab_experience_ids: [] },
      created_at: clock.hoursAgo(1),
    }, { kind: 'initiative', ref: 'p-auth-migration' }),
    proposal({
      id: 'prop-judge-rubric-weights', kind: 'new', runbook_id: null, base_version: null,
      proposed: judgeRubricWeights,
      rationale: 'Session sess-llm-05 spent an hour on a rubric-weight fix that did not seem to land while the judge config was cached. No runbook covers changing the judge rubric, so this writes down the order that worked: save, edit a copy, PUT, wait out the 20-second cache, check the next score.',
      source: { kind: 'run', run_ref: 'sess-llm-05', session_id: 'sess-llm-05', work_item_id: 'wi-llm-e1-s2', lab_experience_ids: [] },
      created_at: clock.hoursAgo(4),
    }, { kind: 'initiative', ref: 'p-llm-platform' }),
    proposal({
      id: 'prop-flaky-quarantine-check', kind: 'new', runbook_id: null, base_version: null,
      proposed: flakyQuarantineCheck,
      rationale: 'We quarantined a collector test last sprint without rerunning it. A short checklist before anyone quarantines a test would have caught it.',
      source: { kind: 'person', person_id: 'p-011', lab_experience_ids: [] },
      created_at: clock.hoursAgo(20),
    }, { kind: 'repo', ref: REPO.OBS }),
  ];
}

// ─── The whole default world, in the seam's shape ────────────────────────────

/** The five arrays the store's fixtures hold (mock/runbooks-seed-seam.ts `RunbookSeedRows`). */
export interface RunbookSeedWorld {
  runbooks: Runbook[];
  versions: RunbookVersion[];
  proposals: RunbookProposal[];
  applications: RunbookApplication[];
  /** Frozen on dispatch or claim; one seeded run (FROZEN_RUN) started after the runbooks existed. */
  briefs: SessionBrief[];
}

export function runbookSeedWorld(): RunbookSeedWorld {
  const seeds = seedRunbooks();
  return {
    runbooks: seeds.map((s) => s.runbook),
    versions: seeds.flatMap((s) => s.versions),
    proposals: seedRunbookProposals(),
    applications: seeds.flatMap((s) => s.applications),
    briefs: seedBriefs(),
  };
}
