// The ten procedural facts of docs/distillation-runbooks-design.md §1.4,
// verbatim, each placed in the RunbookDoc a migration would have produced from
// its artifact: the artifact's title and summary (captured by running the real
// mock provider: one compactNow('L1') + compactNow('L2') on the default corpus
// for art-901/903/904/906; the seed for art-008/010; the `large` generator for
// art-L1) and the fact's `statement` as the step. `expect` lists the rules the
// design's table says catch it; each must fire.
//
// R-command-real and R-secrets catch nothing among the ten (no fact carried a
// command at all — that is defect 3). Their failing fixtures are DERIVED from
// example 3: the step it should have been, given an invented route and script
// (command-real) or an inline credential (secrets). They say so.
import type { LintRuleId, RunbookDoc } from '../../types.js';

const triggers = { work_item_labels: [], repos: [], tools: [], keywords: [] };
const bare = (title: string, summary: string, steps: string[], extra: Partial<RunbookDoc> = {}): RunbookDoc => ({
  title, summary, use_when: [], not_for: [], triggers, preconditions: [],
  steps: steps.map((s) => ({ do: s })), verify: [], failure_modes: [], rollback: [], ...extra,
});

// art-901, minted by compaction (procedure).
const ART_901_TITLE = 'Canary judge config lives in SSM, edited from the portal';
const ART_901_SUMMARY = 'LLM-as-judge model, rubric weights and sample rate live in one SSM parameter read fresh on every ask, so a rubric edit takes effect immediately with no deploy. A 60-second cache means a Prompt Studio edit reaches the fleet in about a minute, with a hardcoded fallback for a Bedrock outage and the resolved prompt sha recorded on every trace. An un-paginated Bedrock ListPrompts call silently drops every prompt past the first page; looping on nextToken (capped at a max page count) is now a codebase-wide convention for any Bedrock list call.';
// art-904, minted by compaction (procedure).
const ART_904_TITLE = 'Alert on error-budget burn rate, not raw error count';
const ART_904_SUMMARY = 'Multi-window burn-rate alerts against each SLO catch both fast and slow outages, with a minimum-traffic floor so a dead service can’t look healthy. Gateway collectors buffering in front of per-host agents absorb bursts; canarying one collector for 24h catches regressions before fleet-wide rollout. Tail sampling that waits for the whole trace, with a timeout so a stuck trace still flushes, keeps every error and slow request at a fraction of head-sampling storage cost.';

export interface BadExample { n: number; source: string; fact: string; doc: RunbookDoc; expect: LintRuleId[] }

export const BAD_EXAMPLES: BadExample[] = [
  {
    n: 1, source: 'art-901 step 1', fact: 'fact-901',
    doc: bare(ART_901_TITLE, ART_901_SUMMARY, ['Agents read their system prompt from Prompt Management on every invocation']),
    expect: ['R-imperative', 'R-single-subject', 'R-length'],
  },
  {
    n: 2, source: 'art-901 step 5', fact: 'fact-905',
    doc: bare(ART_901_TITLE, ART_901_SUMMARY, ['Any Bedrock list API in this codebase must be paginated by convention, not by memory']),
    expect: ['R-imperative', 'R-single-subject'],
  },
  {
    n: 3, source: 'art-901 step 7', fact: 'fact-907',
    doc: bare(ART_901_TITLE, ART_901_SUMMARY, ['Online evaluation needs both enableEval and enableOnlineEvalConfig context flags']),
    expect: ['R-commandless'],
  },
  {
    n: 4, source: 'art-904 step 1', fact: 'fact-913',
    doc: bare(ART_904_TITLE, ART_904_SUMMARY, ['Gateway+agent OTel topology handles peak ingest at 2x headroom']),
    expect: ['R-imperative', 'R-verify', 'R-single-subject', 'R-length'],
  },
  {
    n: 5, source: 'art-904 step 5', fact: 'fact-917',
    doc: bare(ART_904_TITLE, ART_904_SUMMARY, ['Sampling decision waits for the whole trace, not the first span']),
    expect: ['R-imperative', 'R-verify', 'R-single-subject'],
  },
  {
    n: 6, source: 'art-903 (runbook) claim', fact: 'fact-912',
    doc: bare(
      'Cognito + BFF OIDC replaces the hosted-UI redirect (+1 more)',
      'Per-tenant Cognito app clients keep each tenant’s callback allowlist short; A per-tenant Cognito client also isolates a misconfigured redirect to one tenant',
      [],
      { notes: '- Per-tenant Cognito app clients keep each tenant’s callback allowlist short (+1 more): Per-tenant Cognito app clients keep each tenant’s callback allowlist short; A per-tenant Cognito client also isolates a misconfigured redirect to one tenant' },
    ),
    expect: ['R-joined', 'R-generated'],
  },
  {
    n: 7, source: 'art-906 (decision) claim', fact: 'fact-932',
    doc: bare(
      'Tag every ad-hoc Bedrock eval run with the initiative footing the bill',
      'Tag every ad-hoc Bedrock eval run with the initiative footing the bill; Cap eval-run concurrency per initiative so one team can’t starve the shared budget alarm',
      [],
      { notes: '- Tag every ad-hoc Bedrock eval run with the initiative footing the bill (+1 more): Tag every ad-hoc Bedrock eval run with the initiative footing the bill; Cap eval-run concurrency per initiative so one team can’t starve the shared budget alarm' },
    ),
    expect: ['R-joined', 'R-generated'],
  },
  {
    n: 8, source: 'art-008 (retired insight)', fact: 'fact-012',
    doc: bare(
      'OpenSearch Serverless and Aurora Serverless v2 both bill a floor at zero traffic',
      'Neither service scales to zero: OpenSearch bills a 2 OCU minimum and Aurora Serverless v2 bills a 0.5 ACU minimum (~$45/mo), continuously, regardless of load.',
      ['Aurora Serverless v2 never scales below its 0.5 ACU floor, billing roughly $45/month even idle.'],
    ),
    expect: ['R-imperative'],
  },
  {
    n: 9, source: 'art-010 (seeded procedure) steps', fact: 'fact-018..fact-021',
    doc: bare(
      'Cut one tenant over from SAML to Cognito',
      'One tenant at a time, behind a per-tenant flag that keeps the SAML shim reachable, with zero forced logouts as the hard requirement and a flip back as the rollback.',
      [
        'Flag the tenant’s SAML shim instead of deleting it',
        'Confirm no active session is forced out by the flip',
        'Flip the tenant on its own schedule, never in one flag-day cutover',
        'Flip back to SAML if login misbehaves',
      ],
    ),
    expect: ['R-verify', 'R-rollback'],
  },
  {
    n: 10, source: 'art-L1 (`large` generator)', fact: 'fact-L01',
    doc: bare(
      'Load-corpus artifact 1: what the fleet learned about orgiq-auth-service',
      'Distilled from 2 generated clusters — present so the artifact list, its filters and the lineage graph have volume to render.',
      ['Load-corpus fact 1: the generated cluster it cites is evidenced by its own observations.'],
    ),
    expect: ['R-generated'],
  },
];

/** Derived from example 3: the step it should have been, with an invented route and script. */
export const DERIVED_COMMAND_REAL: RunbookDoc = {
  ...bare('Turn on online evaluation for the canary', 'Enable online evaluation so canary asks are judged as they happen.', []),
  steps: [{
    do: 'Enable online evaluation through the BFF.',
    command: { lang: 'bash', text: 'curl -X POST "$BFF/api/canary/online-eval/enable"\n./scripts/enable-online-eval.sh' },
    expect: '`{"enabled": true}`.',
  }],
  verify: [{ check: 'The next canary ask records a judge score.' }],
  rollback: [{ do: 'Disable online evaluation again.' }],
};

/** Derived from example 3: the right command, with a credential pasted into it. */
export const DERIVED_SECRETS: RunbookDoc = {
  ...bare('Turn on online evaluation for the canary', 'Enable online evaluation so canary asks are judged as they happen.', []),
  steps: [{
    do: 'Deploy the gateway stack with both evaluation flags.',
    command: { lang: 'bash', text: 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE cdk deploy OrgIQ-AgentCoreGateway --context enableEval=true --context enableOnlineEvalConfig=true' },
    expect: 'the stack reaches UPDATE_COMPLETE.',
  }],
  verify: [{ check: 'The next canary ask records a judge score.' }],
  rollback: [{ do: 'Redeploy the stack without the two flags.' }],
};
