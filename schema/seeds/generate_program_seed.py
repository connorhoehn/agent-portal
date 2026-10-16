#!/usr/bin/env python3
"""Generate schema/seed_program.sql — the curated program operating-model seed.

One owner runs each initiative; a small set of SMEs attach across initiatives;
a release manager (u-release) grants SMEs sprint budget envelopes; cron
maintenance bots enqueue work-queue jobs and their runs form the baseline cost
of maintaining each initiative. Work is estimated in complexity (points) and
dollars — never human hours.

The output is deterministic (fixed RNG seed) and checked in; regenerate with:

    python3 schema/seeds/generate_program_seed.py

Replaces the retired seed_work_items*.sql family, which targeted a phantom
proj-* project family that no Aurora seed ever created.
"""
from __future__ import annotations

import math
import json
import random
import uuid
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / 'seed_program.sql'
WORK_KEYS = json.loads((Path(__file__).resolve().parent / 'work_item_keys.json').read_text())['items']
RNG = random.Random(20260821)
# SMEs on an initiative's roster who are not assigned seeded work items (their work lives in other tenants):
# Rhea (Security) contributes to Auth Migration, and keeping her out of the draw keeps every item's assignee stable.
ROSTER_ONLY_SMES = {'p-rhea'}

# Who created each maintenance bot (obs-nightly-maintenance is u-tomas, the pipelines author who also holds Social:
# the Communication plane's "My pipelines" walker). middleware/src/mock/bots.ts mirrors this; bots not listed are u-rachel's.
BOT_CREATORS = {
    'obs-nightly-maintenance': 'u-tomas', 'auth-dep-watch': 'u-nora', 'llm-evals-nightly': 'u-layla',
    'inference-canary-nightly': 'u-eli', 'finops-daily-sweep': 'u-mia', 'stream-lag-watch': 'u-caleb',
    'feature-drift-nightly': 'u-theo', 'mobile-e2e-nightly': 'u-caleb', 'a11y-audit-weekly': 'u-layla',
    'api-contract-watch': 'u-theo',
}

# What each seeded maintenance firing did, per bot. middleware/src/mock/bots.ts reads
# the same file, so the dev:mock fleet and this seed tell one story.
RUN_NOTES = json.loads((Path(__file__).resolve().parent.parent.parent / 'middleware/src/mock/bot-run-notes.json').read_text())


def run_note(prefix: str, seq: int) -> dict:
    notes = RUN_NOTES.get(prefix) or []
    if not notes:
        return {'reason': 'scheduled maintenance'}
    if seq <= len(notes):
        return notes[seq - 1]
    ok = [n for n in notes if 'status' not in n]
    return ok[(seq - 1) % len(ok)]

GH = 'https://github.com/connorhoehnslalom'

# Whose name is on an initiative's monthly allocation when it is not the release
# manager's: Mia Singh (u-mia, program-owner) holds Auth Migration's money.
ALLOCATED_BY = {'p-auth-migration': 'u-mia'}

# The credential every initiative repo is linked through. All fourteen
# orgiq-* repos are PRIVATE (flipped 2026-09-29; CLAUDE.md requires it), and
# agent_projects.connection_name null means "public, no credential" — so a
# seed that left it null told the Codebases page every repo was public and
# sent clones and pushes out with no credential to a repo that refuses them.
# The name is providerNameFor('github', 'connorhoehnslalom') in
# middleware/src/providers/connected-sources.ts, the same provider the mock
# fixture (middleware/src/mock/connected-sources.ts) lists.
GH_CONNECTION = 'orgiq-github-connorhoehnslalom'

# ─── Curated cast ────────────────────────────────────────────────────────────
# owner: the one person who runs the initiative ("Run by").
# smes: cross-initiative experts; the portal's sme app_users map to p-004
# (u-nora), p-008 (u-layla), p-011 (u-eli), p-013 (u-caleb).

INITIATIVES = [
    dict(
        id='p-observability', slug='obs', repo='orgiq-observability', tier='flagship',
        owner='p-004', smes=['p-008', 'p-011'],
        sponsor='p-002',
        # The pitch the initiative header shows (projects.summary). Only this
        # initiative carries one distinct from `description`; every other
        # initiative's summary is its description, as before. The second
        # paragraph is the "Focus:" line from the v2 Overview mockup
        # (docs/design/initiative-v2-plan.md, V3): a `\n` inside the summary
        # rather than a new column, so no schema change — the header renders
        # it pre-line.
        summary='Centralize telemetry, reduce alert noise, and control retention costs.\n'
                'Focus: actionable alerts, team error budgets, and OpenTelemetry.',
        description='Unified telemetry: OpenTelemetry collection, SLO/error-budget '
                    'alerting, and cost-aware retention across every service.',
        epics=[
            ('e1', 'OpenTelemetry everywhere', 'critical', 'in_progress',
             'Every service emits OTLP through the collector fleet; legacy StatsD retired.',
             [
                ('story', 'Roll out collector fleet with gateway + agent topology', 'done', 'critical', 8, ['otel', 'infra'], 's1'),
                ('story', 'Tail-sampling policy: errors + p99 latency always kept', 'done', 'high', 5, ['otel', 'sampling'], 's1'),
                ('story', 'Span-metrics connector feeding RED dashboards', 'in_progress', 'high', 8, ['otel', 'metrics'], 's3'),
                ('story', 'Decommission the legacy StatsD bridge', 'open', 'medium', 5, ['decom'], 's3'),
                ('bug', 'Collector OOMs under burst ingest when queue is unbounded', 'in_progress', 'critical', 3, ['otel', 'stability'], 's3'),
             ]),
            ('e2', 'SLOs and error budgets', 'high', 'in_progress',
             'Every tier-1 service has an SLO, a burn-rate alert, and an owner.',
             [
                ('story', 'SLO definitions in the service catalog with owners', 'done', 'high', 5, ['slo'], 's2'),
                ('story', 'Multi-window burn-rate alerts', 'in_review', 'high', 5, ['slo', 'alerting'], 's2'),
                ('story', 'Error-budget dashboard per team', 'open', 'medium', 3, ['slo', 'dashboards'], 's3'),
                ('bug', 'Stop duplicate alerts during a dependency outage', 'open', 'high', 2, ['alerting', 'blocked'], 's3'),
             ]),
            ('e3', 'Cost-aware telemetry', 'medium', 'open',
             'Telemetry spend is budgeted like compute: cardinality and retention have owners.',
             [
                ('story', 'Metric cardinality budgets', 'open', 'medium', 5, ['finops', 'metrics'], None),
                ('story', 'Tiered log sampling', 'open', 'medium', 3, ['finops', 'logs'], None),
             ]),
        ],
        sprints=[
            ('s1', 'Sprint 9 — Ingest hardening', 'p-008', -42, -28, 'done',
             'Collector fleet stable at 2x peak ingest.'),
            ('s2', 'Sprint 10 — Burn-rate alerts', 'p-011', -28, -14, 'done',
             'Tier-1 services alert on error-budget burn, not raw error rate.'),
            ('s3', 'Sprint 11 — Span metrics + decom', 'p-008', -14, 0, 'active',
             'RED dashboards from span metrics; two services off StatsD.'),
        ],
        grants=[('s1', 'p-008', 25), ('s2', 'p-011', 20), ('s3', 'p-008', 30)],
        budget=40,
        bot=dict(name='obs-nightly-maintenance', template='bug', cron='0 6 * * *',
                 mission='Nightly maintenance for the observability stack: bump collector and '
                         'SDK dependencies, triage flaky pipeline tests, lint dashboards for '
                         'broken panels, and file anything risky as a bug with evidence.',
                 per_run=0.50, per_day=2.00, runs=10),
        decision=('d-otel-vendor', 'Self-hosted OTel collectors over vendor agents',
                  'Vendor APM agents were quoted per host at about three times the cost of running our own '
                  'collectors, and each shipped sampling we could not tune. We chose self-hosted OpenTelemetry '
                  'collectors in an agent and gateway topology, exporting OTLP to the current backend. The cost '
                  'is owning the fleet: upgrades, memory tuning and the burst OOM are ours to fix. Switching '
                  'backends stays a config change, not a re-instrumentation.', 'resolved', None, 'e1'),
    ),
    dict(
        id='p-auth-migration', slug='auth', repo='orgiq-auth-service', tier='flagship',
        owner='p-002', smes=['p-051', 'p-004', 'p-rhea'],
        sponsor='p-052',
        description='Consolidate every login path onto Cognito + BFF OIDC and retire the '
                    'legacy SAML shim, tenant by tenant, with zero forced logouts.',
        epics=[
            ('e1', 'Cognito consolidation', 'critical', 'in_progress',
             'One IdP, one session mint path, verified JWKS everywhere.',
             [
                ('story', 'BFF authorization-code + PKCE flow behind the middleware', 'done', 'critical', 8, ['oidc', 'bff'], 's1'),
                ('story', 'JWKS verification with kid-rotation handling', 'done', 'critical', 5, ['oidc', 'jwt'], 's1'),
                ('story', 'Session cookie hardening: max-age, rotation on switch', 'in_review', 'high', 5, ['session'], 's2'),
                ('bug', 'Refresh loop when a grant is revoked mid-session', 'in_progress', 'critical', 3, ['session'], 's2'),
             ]),
            ('e2', 'Legacy SSO decommission', 'high', 'open',
             'The SAML shim serves zero tenants and is deleted, not paused.',
             [
                ('story', 'Inventory every consumer still on the SAML shim', 'done', 'medium', 3, ['decom'], 's1'),
                ('story', 'Tenant-by-tenant cutover runbook with rollback', 'open', 'high', 5, ['decom', 'runbook', 'blocked'], 's2'),
                ('bug', 'Logout leaves the legacy shim cookie alive', 'open', 'medium', 2, ['session', 'decom'], 's2'),
             ]),
        ],
        sprints=[
            ('s1', 'Sprint 9 — OIDC core', 'p-051', -35, -21, 'done',
             'Code+PKCE flow live; JWKS rotation survives a key roll.'),
            ('s2', 'Sprint 10 — Session hygiene', 'p-051', -14, 0, 'active',
             'Sessions expire server-side; revoked grants bite within a minute.'),
        ],
        # p-004 (Nora DaSilva, u-nora — the seeded sme login) is an SME here
        # (see smes= above), not the owner; she gets her own envelope on the
        # active sprint alongside p-051's so the sme persona can exercise the
        # role's core loop (hold a grant, dispatch against it) without
        # displacing the steward's existing one. Regression: sme.md defect #1
        # — every seeded budget_grants row went to someone other than the one
        # seeded `sme` user, so the audit persona could not dispatch anywhere.
        grants=[('s1', 'p-051', 25), ('s2', 'p-051', 20), ('s2', 'p-004', 15)],
        budget=35,
        bot=dict(name='auth-dep-watch', template='bug', cron='0 5 * * 1-5',
                 mission='Weekday dependency and CVE watch for the auth service: bump patch '
                         'versions, flag anything with a security advisory as critical, and '
                         'keep the OIDC conformance tests green.',
                 per_run=0.40, per_day=1.50, runs=8),
        decision=('d-cognito-cutover', 'Cutover order for legacy SSO tenants',
                  'Twelve customer tenants remain on the SAML shim, and each moves with the single-tenant '
                  'cutover runbook. Smallest first keeps the blast radius low while the team learns the runbook. '
                  'Riskiest first moves the two tenants with custom SAML attribute mappings while the shim is '
                  'still warm and rollback is a route flip, but a failure there is loud and customer-visible. '
                  'The order decides who is warned and when, so it is a release call.', 'escalated', 'org-leader', 'e2',
                  # Escalated BY the owner (Vera) TO the release manager: Sienna
                  # Garcia (p-005, u-release) decides it, not the person who
                  # raised it (docs/demo-content-audit.md, Work story-breaker 4).
                  'p-005'),
    ),
    dict(
        id='p-llm-platform', slug='llm', repo='orgiq-llm-platform', tier='flagship',
        owner='p-047', smes=['p-042', 'p-013'],
        sponsor='p-049',
        description='The paved road for LLM features: managed prompts, canary evaluation, '
                    'guardrail regression, and efficient serving.',
        epics=[
            ('e1', 'Prompt management and canary', 'high', 'in_progress',
             'Prompts ship like code: drafted, canaried, judged, promoted.',
             [
                ('story', 'Prompt registry with DRAFT/live resolution at runtime', 'done', 'high', 5, ['prompts'], 's1'),
                ('story', 'LLM-as-judge canary rubric with weighted dimensions', 'in_progress', 'high', 8, ['canary', 'evals'], 's2'),
                ('bug', 'Prompt cache stampede on TTL expiry under load', 'open', 'medium', 3, ['prompts', 'perf'], 's2'),
             ]),
            ('e2', 'Evals and guardrails', 'critical', 'in_progress',
             'No model or guardrail change lands without a regression verdict.',
             [
                ('story', 'Eval harness with golden sets per agent', 'in_review', 'critical', 8, ['evals'], 's2'),
                ('story', 'Guardrail regression suite wired into CI', 'open', 'high', 5, ['guardrails', 'ci'], 's2'),
             ]),
            ('e3', 'Serving efficiency', 'medium', 'open',
             'Token spend per request trends down while quality holds.',
             [
                ('story', 'Batch inference queue for non-interactive workloads', 'open', 'medium', 8, ['serving'], None),
                ('story', 'Token budget middleware with per-tenant ceilings', 'done', 'medium', 3, ['serving', 'budgets'], 's1'),
             ]),
        ],
        sprints=[
            ('s1', 'Sprint 8 — Prompt registry', 'p-042', -30, -16, 'done',
             'Prompt edits reach the fleet without a redeploy.'),
            ('s2', 'Sprint 9 — Judge + evals', 'p-013', -14, 0, 'active',
             'Canary judge scores every ask; golden sets gate merges.'),
        ],
        grants=[('s1', 'p-042', 30), ('s2', 'p-013', 35)],
        budget=45,
        bot=dict(name='llm-evals-nightly', template='story', cron='30 4 * * *',
                 mission='Re-run the golden-set eval suite against the live prompt versions '
                         'every night; summarize score drift per agent and open a bug when '
                         'any dimension regresses beyond threshold.',
                 per_run=0.80, per_day=3.00, runs=9),
        decision=('d-eval-judge-model', 'Judge model for canary evaluation',
                  'The canary judge scores every sampled answer, so its model sets both the evaluation bill and '
                  'how far the scores can be trusted. On the 120-question pilot set Nova Pro agrees with human '
                  'labels 82 percent of the time and Nova Lite 71 percent, at about six times the cost per judged '
                  'answer. Halving the sample rate from 20 to 10 percent would fund Nova Pro at the current spend. '
                  'Open until the final rubric weights have run on both.', 'open', None, 'e1'),
    ),
    dict(
        id='p-cost-opt', slug='cost', repo='orgiq-finops', tier='flagship',
        owner='p-008', smes=['p-011', 'p-017'],
        sponsor='p-006',
        description='Idle capacity teardown and per-initiative showback: every dollar of '
                    'infra and agent spend attributable, every floor justified.',
        epics=[
            ('e1', 'Idle capacity teardown', 'high', 'in_progress',
             'Nothing bills while idle without a written justification.',
             [
                ('story', 'Aurora ACU right-sizing with scale-to-floor windows', 'done', 'high', 5, ['aurora', 'finops'], 's1'),
                ('story', 'OpenSearch OCU floor audit and collection consolidation', 'in_progress', 'high', 5, ['opensearch', 'finops'], 's2'),
                ('bug', 'Orphaned NAT gateways surviving stack teardown', 'done', 'medium', 2, ['network', 'teardown'], 's1'),
             ]),
            ('e2', 'Spend attribution', 'high', 'in_progress',
             'Showback per initiative: infra, model tokens, and bot baseline in one view.',
             [
                ('story', 'Tagging policy enforced at deploy time', 'in_review', 'high', 5, ['tagging', 'governance'], 's2'),
                ('story', 'Per-initiative showback rollup joining agent spend', 'open', 'high', 8, ['showback'], 's2'),
             ]),
        ],
        sprints=[
            ('s1', 'Sprint 9 — Floors and orphans', 'p-011', -28, -14, 'done',
             'Idle floors documented; orphan sweep automated.'),
            ('s2', 'Sprint 10 — Attribution', 'p-017', -14, 0, 'active',
             'Every running resource carries an initiative tag.'),
        ],
        grants=[('s1', 'p-011', 15), ('s2', 'p-017', 20)],
        budget=30,
        bot=dict(name='finops-daily-sweep', template='bug', cron='0 7 * * *',
                 mission='Daily spend sweep: diff yesterday\'s cost by service against the '
                         '7-day baseline, flag anomalies over 20%, and list untagged '
                         'resources created in the last day.',
                 per_run=0.30, per_day=1.00, runs=11),
        decision=None,
    ),
    # ── standard tier ────────────────────────────────────────────────────────
    dict(
        id='p-realtime-analytics', slug='rta', repo='orgiq-stream-analytics', tier='standard',
        owner='p-017', smes=['p-019', 'p-024'],
        sponsor='p-025',
        description='Exactly-once event pipeline on Flink: schema-governed ingest, '
                    'checkpointed processing, and replayable backfills.',
        epics=[
            ('e1', 'Exactly-once pipeline', 'high', 'in_progress', None,
             [
                ('story', 'Flink checkpoint tuning for sub-minute recovery', 'in_progress', 'high', 8, ['flink'], 's1'),
                ('story', 'Schema registry rollout with compatibility gates', 'done', 'high', 5, ['schema'], 's1'),
                ('bug', 'Late events dropped at the watermark boundary', 'open', 'high', 3, ['flink', 'correctness'], 's1'),
                ('story', 'Self-serve backfill tooling with replay budgets', 'open', 'medium', 5, ['backfill'], None),
             ]),
        ],
        sprints=[('s1', 'Sprint 9 — Checkpoint + schema', 'p-019', -14, 0, 'active',
                  'Recovery under 60s; producers on registry contracts.')],
        grants=[('s1', 'p-019', 15)],
        budget=20,
        bot=dict(name='stream-lag-watch', template='bug', cron='15 */6 * * *',
                 mission='Watch consumer lag and checkpoint duration; when lag trends past '
                         'threshold, profile the hot operator and file a bug with the trace.',
                 per_run=0.25, per_day=1.20, runs=6),
        decision=None,
    ),
    dict(
        id='p-data-lake', slug='lake', repo='orgiq-data-lake', tier='standard',
        owner='p-025', smes=['p-017', 'p-015'],
        sponsor='p-012',
        description='Lakehouse foundation on Iceberg: contract-governed ingest zones and '
                    'time-travel access for analytics and ML.',
        epics=[
            ('e1', 'Lakehouse foundation', 'medium', 'in_progress', None,
             [
                ('story', 'Iceberg table format evaluation against Delta', 'in_progress', 'medium', 5, ['iceberg', 'eval'], 's1'),
                ('story', 'Ingest contract spec for producer teams', 'open', 'medium', 3, ['contracts'], 's1'),
                ('story', 'Bronze/silver/gold access zone design', 'open', 'medium', 5, ['governance'], None),
             ]),
        ],
        sprints=[('s1', 'Sprint 6 — Format decision', 'p-017', -10, 4, 'active',
                  'Table format chosen with a written ADR.')],
        grants=[('s1', 'p-017', 10)],
        budget=10,
        bot=None,  # planning-stage initiative: no repo activity to maintain yet
        decision=('d-iceberg', 'Iceberg over Delta for the lakehouse table format',
                  'The lakehouse is read by Spark, Trino and Flink, so the table format had to work well in all '
                  'three. Iceberg\'s engine-neutral catalog, hidden partitioning and snapshot isolation fit that '
                  'roadmap. Delta was faster under Spark in our benchmark but weaker in the other two engines. '
                  'The consequence: compaction and snapshot expiry are a job we run, not a feature we buy.', 'resolved', None, 'e1'),
    ),
    dict(
        id='p-feature-store', slug='fs', repo='orgiq-feature-store', tier='standard',
        owner='p-042', smes=['p-019', 'p-044'],
        sponsor='p-049',
        description='Online feature serving GA: point-in-time correct training data and '
                    'freshness-SLA\'d online lookups.',
        epics=[
            ('e1', 'Online serving GA', 'high', 'in_progress', None,
             [
                ('story', 'Freshness SLAs per feature group with alerting', 'in_progress', 'high', 5, ['sla'], 's1'),
                ('story', 'Point-in-time join correctness in offline store', 'done', 'critical', 8, ['correctness'], 's1'),
                ('bug', 'TTL eviction races leave stale features served', 'open', 'high', 3, ['online-store'], 's1'),
             ]),
        ],
        sprints=[('s1', 'Sprint 8 — Freshness', 'p-019', -14, 0, 'active',
                  'Every online feature group has a freshness SLA and an owner.')],
        grants=[('s1', 'p-019', 12)],
        budget=18,
        bot=dict(name='feature-drift-nightly', template='story', cron='45 3 * * *',
                 mission='Nightly drift check across production feature groups; summarize '
                         'distribution shifts and file a story when retraining is warranted.',
                 per_run=0.35, per_day=1.20, runs=7),
        decision=None,
    ),
    dict(
        id='p-mobile-redesign', slug='mob', repo='orgiq-mobile-app', tier='standard',
        owner='p-030', smes=['p-035', 'p-026'],
        sponsor='p-036',
        description='Navigation-first redesign of the mobile app: new IA, deep-link '
                    'routing, and gesture-safe interactions.',
        epics=[
            ('e1', 'Navigation overhaul', 'high', 'in_progress', None,
             [
                ('story', 'Bottom-tab information architecture', 'done', 'high', 5, ['ia', 'ux'], 's1'),
                ('story', 'Deep-link routing map with fallback screens', 'in_review', 'high', 5, ['routing'], 's1'),
                ('bug', 'Android back gesture conflicts with drawer swipe', 'open', 'medium', 2, ['android', 'gestures'], 's1'),
             ]),
        ],
        sprints=[('s1', 'Sprint 9 — Routing', 'p-035', -14, 0, 'active',
                  'Every marketing link deep-links to a real screen.')],
        grants=[('s1', 'p-035', 12)],
        budget=15,
        bot=dict(name='mobile-e2e-nightly', template='bug', cron='0 2 * * *',
                 mission='Run the end-to-end suite on both platforms nightly; quarantine flaky '
                         'specs with a linked issue and keep the suite under 20 minutes.',
                 per_run=0.30, per_day=1.00, runs=6),
        decision=None,
    ),
    dict(
        id='p-design-v3', slug='ds', repo='orgiq-design-system', tier='standard',
        owner='p-035', smes=['p-038', 'p-034'],
        sponsor='p-036',
        description='Design System v3: semantic token pipeline from Figma to code with '
                    'accessibility gates built in.',
        epics=[
            ('e1', 'Token pipeline', 'high', 'in_progress', None,
             [
                ('story', 'Semantic color tokens with light/dark resolution', 'done', 'high', 5, ['tokens'], 's1'),
                ('story', 'Figma-to-repo token sync automation', 'in_progress', 'high', 8, ['automation'], 's1'),
                ('bug', 'Dark-mode contrast regression on disabled states', 'open', 'medium', 2, ['a11y'], 's1'),
             ]),
        ],
        sprints=[('s1', 'Sprint 8 — Token sync', 'p-038', -14, 0, 'active',
                  'A token edit in Figma lands as a PR the same day.')],
        grants=[('s1', 'p-038', 10)],
        budget=15,
        bot=dict(name='a11y-audit-weekly', template='bug', cron='0 8 * * 1',
                 mission='Weekly accessibility audit of the component library: contrast, '
                         'focus order, ARIA completeness; file one bug per component regression.',
                 per_run=0.45, per_day=1.00, runs=4),
        decision=None,
    ),
    dict(
        id='p-rag-search', slug='rag', repo='orgiq-rag-search', tier='standard',
        owner='p-048', smes=['p-047'],
        sponsor='p-006',
        description='Retrieval-augmented org search — shipped. Hybrid retrieval with '
                    'grounded citations; in maintenance.',
        epics=[
            ('e1', 'GA hardening', 'high', 'done', None,
             [
                ('story', 'Hybrid dense + keyword retrieval with fusion ranking', 'done', 'high', 8, ['retrieval'], None),
                ('story', 'Citation grounding with source-span attribution', 'done', 'high', 5, ['grounding'], None),
                ('story', 'Retrieval eval harness with labeled query set', 'done', 'medium', 5, ['evals'], None),
             ]),
        ],
        sprints=[],
        grants=[],
        budget=5,
        bot=dict(name='rag-index-health', template='bug', cron='0 9 * * *',
                 mission='Verify index freshness and citation link integrity; re-embed '
                         'documents whose sources changed.',
                 per_run=0.20, per_day=0.60, runs=5, paused='initiative completed — bot parked'),
        decision=None,
    ),
    dict(
        id='p-soc2', slug='soc2', repo='orgiq-compliance', tier='standard',
        owner='p-052', smes=['p-055', 'p-051'],
        sponsor='p-012',
        description='SOC 2 Type II readiness: controls mapped to owners, evidence '
                    'collection automated, access reviews on cadence.',
        epics=[
            ('e1', 'Evidence automation', 'high', 'in_progress', None,
             [
                ('story', 'Control-to-owner mapping in the compliance register', 'done', 'high', 5, ['controls'], 's1'),
                ('story', 'Automated evidence collectors for CM and access controls', 'in_progress', 'high', 8, ['evidence'], 's1'),
                ('bug', 'Quarterly access reviews stale for two service accounts', 'open', 'high', 3, ['access'], 's1'),
             ]),
        ],
        sprints=[('s1', 'Sprint 9 — Collectors', 'p-055', -14, 0, 'active',
                  'Change-management evidence collected without manual export.')],
        grants=[('s1', 'p-055', 12)],
        budget=18,
        bot=dict(name='compliance-evidence-cron', template='story', cron='0 6 * * 1-5',
                 mission='Weekday evidence sweep: snapshot IAM diffs, change-management '
                         'records, and backup verifications into the evidence store.',
                 per_run=0.25, per_day=0.80, runs=8),
        decision=None,
    ),
    dict(
        id='p-design-system-api', slug='dsapi', repo='orgiq-design-system-api', tier='standard',
        owner='p-038', smes=['p-035', 'p-001'],
        sponsor='p-036',
        description='Programmatic access to the design system: typed component '
                    'contracts, versioned release channels, and codemod-assisted upgrades.',
        epics=[
            ('e1', 'Component API contract', 'high', 'in_progress', None,
             [
                ('story', 'Typed prop contracts with generated codemods', 'in_progress', 'high', 8, ['api', 'codemods'], 's1'),
                ('story', 'Versioned release channels (stable/next)', 'done', 'high', 5, ['releases'], 's1'),
                ('bug', 'Breaking prop rename slipped past the semver gate', 'open', 'high', 3, ['semver'], 's1'),
             ]),
        ],
        sprints=[('s1', 'Sprint 7 — Contracts', 'p-035', -14, 0, 'active',
                  'Consumers upgrade via codemod, not by reading a changelog.')],
        grants=[('s1', 'p-035', 10)],
        budget=12,
        bot=dict(name='api-contract-watch', template='bug', cron='30 7 * * 1-5',
                 mission='Weekday contract check: diff the published component API against '
                         'consumers, flag breaking drift, and verify codemods still apply.',
                 per_run=0.25, per_day=0.80, runs=6),
        decision=None,
    ),
    dict(
        id='p-inference-platform', slug='inf', repo='orgiq-inference-platform', tier='standard',
        owner='p-049', smes=['p-013', 'p-043'],
        sponsor='p-012',
        description='Shared model serving: queue-depth autoscaling, warm pools, and '
                    'per-model canary rollout for every team shipping inference.',
        epics=[
            ('e1', 'Serving reliability', 'high', 'in_progress', None,
             [
                ('story', 'Autoscaling on queue depth instead of CPU', 'in_progress', 'high', 8, ['autoscaling'], 's1'),
                ('story', 'Warm-pool management for large model loads', 'done', 'high', 5, ['warm-pool'], 's1'),
                ('bug', 'Cold-start p99 breaches SLA after scale-to-zero', 'open', 'critical', 3, ['latency'], 's1'),
             ]),
        ],
        sprints=[('s1', 'Sprint 9 — Queue-depth scaling', 'p-013', -14, 0, 'active',
                  'Scaling reacts to demand, not to a proxy metric.')],
        grants=[('s1', 'p-013', 15)],
        budget=20,
        bot=dict(name='inference-canary-nightly', template='bug', cron='15 3 * * *',
                 mission='Nightly canary of every served model version: latency and error '
                         'deltas against the previous build, rollback recommendation on breach.',
                 per_run=0.40, per_day=1.50, runs=7),
        decision=None,
        # Open, so it draws nothing from the RNG (see the decision loop in main()).
        extra_decisions=[
            ('d-inference-warm-floor', 'Warm floor or scale-to-zero for tier-1 models',
             'Tier-1 models scale to zero after 15 minutes idle, and the next request pays a 40 to 90 second '
             'cold start against a 2.5-second p99 SLO. A warm floor of one replica per tier-1 model removes the '
             'cold start at about $380 a month per model. Baking weights into the image cuts the load to about '
             '20 seconds at no standing cost, but still breaches the SLO. Open until the teams that own the SLO '
             'agree what a breach costs them.', 'open', None, 'e1'),
        ],
    ),
    dict(
        id='p-zero-trust', slug='zt', repo='orgiq-zero-trust', tier='standard',
        owner='p-051', smes=['p-052', 'p-056'],
        sponsor='p-052',
        description='Zero-trust segmentation blueprint: service identity everywhere, '
                    'mTLS by default, policy-engine enforced.',
        epics=[
            ('e1', 'Segmentation blueprint', 'medium', 'in_progress', None,
             [
                ('story', 'Service identity inventory across environments', 'in_progress', 'medium', 5, ['identity'], 's1'),
                ('story', 'mTLS rollout plan with break-glass procedure', 'open', 'medium', 5, ['mtls'], 's1'),
                ('story', 'Policy engine selection ADR', 'open', 'medium', 3, ['adr'], None),
             ]),
        ],
        sprints=[('s1', 'Sprint 5 — Inventory', 'p-052', -7, 7, 'active',
                  'Every service maps to an identity or a documented exception.')],
        grants=[('s1', 'p-052', 8)],
        budget=10,
        bot=None,  # planning-stage initiative
        decision=None,
    ),
]

# Flagship comment threads: (initiative slug, item key, author, body) — a
# handful of real exchanges, not an avatar wall.
COMMENTS = [
    ('obs', 'e1-b5', 'p-008', 'Repro: burst 40k spans/s for 90s and the gateway pod OOMs inside 4 minutes. Bounding the queue trades spans for survival — I think we take that trade.'),
    ('obs', 'e1-b5', 'p-004', 'Agreed. Cap the queue and let tail-sampling keep errors; dropped healthy spans are the cheapest loss we have.'),
    ('obs', 'e2-s2', 'p-011', 'Fast-burn window at 5m/1h and slow-burn at 6h/3d, thresholds from the SRE workbook. PR has the recording rules.'),
    ('auth', 'e1-b4', 'p-051', 'The loop is the client retrying refresh on a 403 that is actually a revocation. Server should return a terminal signal, not a retryable one.'),
    ('auth', 'e1-s3', 'p-002', 'Server-side max-age landed behind a flag; flipping it after the cutover window closes.'),
    ('llm', 'e1-s2', 'p-013', 'Rubric weights: grounding 0.4, completeness 0.3, tone 0.15, latency 0.15. Judge agreement with human labels at 0.82 on the pilot set.'),
    ('llm', 'e2-s1', 'p-042', 'Golden sets are versioned with the prompt now — an eval score means nothing if the set drifted under it.'),
    ('cost', 'e2-s2', 'p-017', 'Showback needs the bot baseline broken out separately from interactive runs — maintenance is a floor, not a choice.'),
]

# Planning notes on wi-obs-e1-s4, with fixed ages rather than the random draw
# above — the task this fixture backs (docs/ui-components-queue.md's work-item
# criteria/comments contract) names the exact ages, so these are excluded from
# the RNG.randint(1, 12) below and carry their age as a 5th tuple element.
FIXED_AGE_COMMENTS = [
    ('obs', 'e1-s4', 'p-004', 'Start with low-risk services after the collector rollout.', 2),
    ('obs', 'e1-s4', 'p-011', 'Keep the bridge available until dashboard parity is verified.', 1),
]

# Engineers arguing on tickets (docs/demo-content-engineering-brief.md): the
# repros, profiles and review asks behind the five arcs. Fixed ages, emitted
# after the planning notes, so no RNG draw moves and wic-prog-1…10 keep their ids.
TICKET_COMMENTS = [
    ('auth', 'e1-b4', 'p-002', 'Agreed with Simone. Answer 401 with error="invalid_token" and a session_revoked reason, and the client signs out once. Every other 401 stays retryable with backoff.', 7),
    ('auth', 'e1-b4', 'p-004', 'Repro is in the PR: revoke the grant, leave the tab open, count refresh calls. Before the fix 31 calls in the first minute, after it exactly one, then the sign-in page.', 3),
    ('auth', 'e2-s2', 'p-051', 'Looking at the callback-list step now. One ask: make it fail closed. If describe-user-pool-client does not list the tenant origin under CallbackURLs, the flip does not start.', 1),
    ('obs', 'e2-b4', 'p-011', 'The dependency map is about 60 percent derivable from traces: 212 service-to-service edges seen in the last 7 days. The rest are batch jobs and queues that emit no spans, and their owners have to declare them before grouping can trust the map.', 1),
    ('inf', 'e1-b3', 'p-013', 'Profiled one cold start on the embedding model: 11 s pulling the image, 52 s loading weights from S3, 6 s warming the CUDA graphs. Baking the weights into the image removes most of the 52 s, but the image grows from 4 GB to 11 GB.', 4),
    ('inf', 'e1-b3', 'p-049', 'Even baked, a cold start is around 20 s against a 2.5 s p99. I have written the warm floor up as a decision so the standing cost is on record before anyone turns it on.', 3),
    ('llm', 'e1-b3', 'p-042', 'Seen it after every deploy: 43 replicas, 43 GetPrompt calls in the same second, 12 of them throttled. Jitter alone fixes the deploy case. Stale-while-revalidate covers the store being slow.', 5),
    ('cost', 'e1-s2', 'p-011', 'Checked the encryption keys: the three quiet collections each use their own KMS key, which is why they cannot share OCUs. Re-keying means a reindex, about 40 minutes per collection.', 2),
    ('rta', 'e1-b3', 'p-019', 'Raising allowed lateness to 5 minutes would hold window state ten times longer. A side output for late events plus an hourly correction job is cheaper and keeps the aggregates honest.', 4),
]

# Acceptance-criteria checklists. Each entry is
# (initiative slug, work-item key, [(text, done, created_days_ago, updated_days_ago), ...]).
# wi-obs-e1-s4 is the flagship example the design mockup names (its three lines
# are asserted by the criteria tests); the rest are the in-flight and blocked
# items of the five arcs in docs/demo-content-engineering-brief.md, written as
# a reviewer would check them: a number, a command or an observable state.
CRITERIA = [
    ('obs', 'e1-s4', [
        ('Route metrics through the collector', False, 5, 5),
        ('Verify dashboard and alert parity', False, 5, 5),
        ('Keep a rollback path during migration', False, 5, 5),
    ]),
    ('obs', 'e3-s1', [
        ('Every service has an active-series budget in the service catalog', True, 10, 3),
        ('CI fails a pull request that adds a label with unbounded values (user_id, request_id, raw path)', False, 10, 10),
        ('An exemption needs an owner, a reason and an expiry date', False, 10, 10),
    ]),
    ('obs', 'e3-s2', [
        ('Log levels classified into debug, info and audit tiers', True, 12, 6),
        ('Debug tier sampled at 1 in 20 at the agent collector', True, 12, 4),
        ('Audit logs bypass sampling: a replay of 10,000 audit lines arrives with 10,000 lines', False, 12, 12),
    ]),
    ('obs', 'e2-s3', [
        ('One panel per team showing budget remaining over the 30-day window', False, 4, 4),
        ('Each panel links to the burn-rate alert and the owning team', False, 4, 4),
    ]),
    ('obs', 'e1-b5', [
        ('memory_limiter is the first processor in every gateway pipeline', True, 6, 2),
        ('Exporter sending_queue bounded at 5,000 batches', True, 6, 2),
        ('40k spans/s burst replay for 90 s: zero OOM kills on the gateway pods', False, 6, 1),
        ('Error spans kept at 100 percent during the burst, measured by the tail-sampling decision counter', False, 6, 6),
    ]),
    ('obs', 'e1-s3', [
        ('Route labels templated (/users/{id}), never raw paths', True, 9, 3),
        ('RED panels for checkout and search match the StatsD dashboards within 2 percent for a week', False, 9, 9),
        ('Active series from the connector stay under 50,000', False, 9, 9),
    ]),
    ('obs', 'e2-s2', [
        ('Page at 14.4x burn over 1 hour, confirmed by a 5-minute window', True, 8, 4),
        ('Ticket at 6x burn over 6 hours, confirmed by a 30-minute window', True, 8, 4),
        ('Backtest over 30 days pages for both real incidents and nothing else', False, 8, 8),
    ]),
    # Auth Migration (the Work demo story).
    ('auth', 'e2-s2', [
        ('Rehearse the cutover on both internal tenants with zero forced logouts', False, 9, 1),
        ('Pre-flight: the tenant origin is in the Cognito app client CallbackURLs before the flip', False, 1, 1),
        ('Record the decided tenant order and the reason for it', False, 9, 9),
        ('Every tenant has a rollback that restores the shim route within two minutes', False, 9, 9),
    ]),
    ('auth', 'e1-s3', [
        ('Re-mint the session cookie on every tenant and role switch', True, 20, 6),
        ('A copy of the pre-switch cookie is refused within 120 seconds', False, 20, 20),
        ('Masquerade sessions do not bump the epoch of the impersonated user', False, 20, 20),
    ]),
    ('auth', 'e1-b4', [
        ('Refresh answers 401 with a session_revoked reason when a grant is revoked', True, 8, 3),
        ('Client signs out once on session_revoked and makes no further refresh calls', False, 8, 8),
        ('Regression test revokes a grant mid-session and asserts exactly one refresh call', False, 8, 8),
    ]),
    ('auth', 'e2-b3', [
        ('Logout redirects through the shim single-logout endpoint while the shim exists', False, 6, 6),
        ('After logout, the next visit lands on the Cognito hosted UI', False, 6, 6),
    ]),
    # LLM Application Platform.
    ('llm', 'e1-s2', [
        ('Rubric weights grounding 0.4, completeness 0.3, tone 0.15, latency 0.15 stored in config, not code', True, 14, 5),
        ('Judge agreement with human labels reported on the 120-question pilot set', True, 14, 3),
        ('Judge model chosen and recorded in the decision', False, 14, 14),
    ]),
    ('llm', 'e1-b3', [
        ('Prompt cache TTL jittered by 0 to 15 seconds per replica', False, 5, 5),
        ('Stale prompt served while one refresh runs', False, 5, 5),
        ('50 replicas restarted at once: zero throttled GetPrompt calls', False, 5, 5),
    ]),
    ('llm', 'e2-s1', [
        ('Each agent has 30 to 60 golden questions with expected facts', True, 16, 4),
        ('Baseline file records the golden-set version it was scored against', False, 16, 2),
        ('A merge fails when any rubric dimension drops more than 0.03', False, 16, 16),
    ]),
    # Cost Optimization.
    ('cost', 'e1-s2', [
        ('Every OpenSearch Serverless collection listed with its KMS key and last-7-day query count', True, 9, 2),
        ('Collections under 100 queries a week moved onto the shared key group', False, 9, 9),
        ('Old collections deleted after 7 days of zero queries', False, 9, 9),
    ]),
    ('cost', 'e2-s1', [
        ('CDK synthesis fails when a taggable resource lacks initiative and owner tags', True, 11, 3),
        ('Untagged resources created in the last day appear in the daily sweep', True, 11, 4),
        ('Every exemption names the resource type and why it cannot carry tags', False, 11, 11),
    ]),
    # Inference Platform.
    ('inf', 'e1-s1', [
        ('Router publishes in-flight requests per model every 10 seconds', True, 10, 2),
        ('Scale out at 4 in-flight per replica sustained for 30 seconds, scale in after 10 minutes', False, 10, 10),
        ('Replay of the last traffic peak keeps p99 queue wait under 500 ms', False, 10, 10),
    ]),
    ('inf', 'e1-b3', [
        ('Cold-start time broken down: image pull, weight load, warm-up', True, 7, 4),
        ('Warm-floor decision recorded with its monthly cost', False, 7, 7),
        ('p99 under 2.5 s for the first request after 30 minutes idle, measured by the canary', False, 7, 7),
    ]),
    # Real-time Analytics Pipeline.
    ('rta', 'e1-s1', [
        ('Incremental RocksDB checkpoints enabled', True, 12, 5),
        ('Checkpoint interval 30 seconds with under 10 seconds of alignment', False, 12, 12),
        ('Killing one task manager recovers in under 60 seconds with no duplicate output', False, 12, 12),
    ]),
]

# Work-item briefs: the copy the initiative Overview and a work item's Brief
# read as DATA rather than as portal literals (docs/design/initiative-variants-
# spec.md). Keyed by work-item id; every key is optional and a missing one
# writes NULL, so the UPDATE below states the whole brief and a re-run converges
# instead of layering.
#
#   summary          one sentence — a Plan-next row's description, and the
#                    first half of the "What needs attention" callout body
#   description      "Why this matters" on the Brief
#   blocked_reason   why a `blocked`-labelled item cannot move; the second half
#                    of the attention body. Only meaningful on a blocked item.
#   next_step        the Brief's Next-step callout title
#   next_step_detail the callout's body line
#
# Emitted as UPDATEs after the inserts, not as extra INSERT columns, for two
# reasons. The inserts are ON CONFLICT DO NOTHING, so an existing cluster would
# never pick new copy up; and the titles these rows carry changed with the copy
# (the child tuples above), which only an UPDATE can land on a seeded row. No
# RNG call is made for any of this — the RNG sequence drives every assignee,
# date and cost above, and one extra draw would reshuffle the whole seed.
#
# middleware/src/mock/work-items.ts mirrors this table as SEEDED_BRIEFS.
#
# Semicolons are kept out of this copy on purpose: schema/apply-work-items.sh
# splits statements on `;` at paren depth 0 and would cut a string in two.
BRIEFS: dict[str, dict[str, str]] = {
    # ── Observability Platform ──
    'wi-obs-e2-b4': dict(
        summary='One failing dependency can trigger forty pages.',
        description='When the shared Postgres connection proxy failed last month, 41 services paged '
                    'separately within 6 minutes and the on-call engineer spent the first 20 minutes '
                    'acknowledging duplicates. Alerts should group by the failing dependency, with the '
                    'affected services listed inside one page.',
        blocked_reason='Waiting on the dependency map.',
        next_step='Confirm the dependency map with Eli Garcia.',
        next_step_detail='The team needs this before choosing how to group duplicate alerts.',
    ),
    'wi-obs-e1-s4': dict(
        summary='Move remaining service metrics to OpenTelemetry.',
        description='Nine services still push StatsD through the bridge, which drops packets under load '
                    'because it is UDP with a 64 KB receive buffer. Each service moves to OTLP through the '
                    'collector, and every alert that read a StatsD metric reads its OpenTelemetry '
                    'equivalent before the bridge is switched off.',
        next_step='Move billing and notifications first.',
        next_step_detail='Neither has a paging alert on a StatsD metric. Keep the bridge running until '
                         'dashboard parity is verified for both.',
    ),
    'wi-obs-e1-s3': dict(
        summary='Derive rate, errors and duration for every service from its spans.',
        description='The span-metrics connector turns every server span into a call counter and a duration '
                    'histogram per service and route, so dashboards cover services that never wrote a '
                    'metric. Cardinality is the risk: route labels must be templated, never raw paths.',
        next_step='Enable the connector for checkout and search behind an allow-list.',
        next_step_detail='Compare their RED panels against the StatsD dashboards for a week, then widen the list.',
    ),
    'wi-obs-e1-b5': dict(
        summary='A 90-second ingest burst kills the gateway collectors because nothing bounds the export queue.',
        description='At 40k spans/s for 90 seconds the gateway pods reach their 2 GiB limit inside 4 minutes '
                    'and are OOM-killed, dropping every span in flight, errors included. With memory_limiter '
                    'first in the pipeline and a bounded sending queue the collector refuses data under '
                    'pressure instead of dying.',
        next_step='Replay the burst against the fixed config in staging.',
        next_step_detail='Pass means no OOM kill, the exporter queue stays under capacity, and tail sampling '
                         'still keeps every error span.',
    ),
    'wi-obs-e2-s2': dict(
        summary='Alert on how fast the error budget burns, not on raw error counts.',
        description='Fast burn pages, slow burn tickets. Page when 2 percent of the 30-day budget burns in '
                    '1 hour (14.4x) and ticket at 5 percent in 6 hours (6x), each confirmed by a short '
                    'window. Thresholds come from the SLO, not from a feel for the error rate.',
        next_step='Backtest the recording rules over 30 days of checkout traffic.',
        next_step_detail='They must page for the two real incidents in that window and stay quiet otherwise.',
    ),
    'wi-obs-e2-s3': dict(
        summary="Make each team's remaining error budget visible.",
        description='One panel per team: budget remaining, burn over the window, and who owns the service. '
                    'When a budget is spent, feature work on that service waits for reliability work, and '
                    'the panel is what makes that conversation short.',
    ),
    'wi-obs-e3-s1': dict(
        summary='Define limits before new metrics increase storage costs.',
        description='One team added a user_id label and created 1.2 million active series in a day, '
                    'doubling the metrics bill for the month. Every service gets a series budget, and CI '
                    'fails a pull request that adds an unbounded label.',
    ),
    'wi-obs-e3-s2': dict(
        description='Debug logs are 70 percent of log volume and almost never read. Debug is sampled at '
                    '1 in 20, info is kept for 14 days, and audit logs bypass sampling entirely because '
                    'compliance needs every line.',
    ),
    # ── Auth Migration, the Work demo story (docs/demo-content-audit.md): the
    # runbook story is blocked on the escalated cutover-order decision, which
    # the release manager decides, not the owner who escalated it.
    'wi-auth-e2-s2': dict(
        summary='Sequence the remaining customer tenants off the SAML shim, each with a two-minute way back.',
        description='Each tenant already moves with the single-tenant cutover runbook: pre-flight the '
                    'Cognito app client, flip the IdP route, watch the login error rate for 15 minutes, and '
                    'roll back by restoring the shim route. This story writes the order the 12 remaining '
                    'customer tenants move in and the rollback for each, which waits on the escalated '
                    'decision "Cutover order for legacy SSO tenants".',
        blocked_reason='Blocked on "Cutover order for legacy SSO tenants", escalated to Sienna Garcia.',
        next_step='Sienna Garcia decides the cutover order.',
        next_step_detail='She decides once the second internal rehearsal passes. Review the proposed '
                         'callback-list step for the cutover runbook first, so the retry can run.',
    ),
    'wi-auth-e1-s1': dict(
        description='The BFF runs the authorization-code flow with PKCE (S256) against the Cognito hosted UI '
                    'and keeps the tokens server-side. The browser only holds an HttpOnly, SameSite=Lax '
                    'session cookie, so a script injected into the page cannot lift a bearer token.',
    ),
    'wi-auth-e1-s2': dict(
        description='Access tokens are verified against the cached JWKS by key id. An unknown kid triggers one '
                    'rate-limited refetch, at most once a minute, before the token is rejected, so a '
                    'signing-key rotation signs nobody out and a forged kid cannot hammer the endpoint.',
    ),
    'wi-auth-e2-s1': dict(
        description='Every consumer still on the SAML shim, each with an owner: 14 tenants (12 customer, 2 '
                    'internal), two of them with custom SAML attribute mappings, plus one internal search '
                    'callback still pointed at the shim. The cutover order needs this list to order.',
    ),
    'wi-auth-e1-s3': dict(
        summary='A switched tenant or role stops honouring the old cookie within the refresh window.',
        description='Every tenant or role switch re-mints the cookie and bumps the session epoch. A copy of '
                    'the pre-switch cookie on another device is refused at its next grants refresh, at most '
                    '120 seconds later, without adding a server-side session store.',
        next_step='Simone Chang reviews the epoch comparison in the session middleware.',
        next_step_detail='The server-side max-age is in the same pull request behind a flag, which flips '
                         'after the cutover window closes.',
    ),
    'wi-auth-e1-b4': dict(
        summary='A revoked grant must sign the session out once, not loop on refresh.',
        description='When a grant is revoked mid-session the refresh endpoint answers 403, and the client '
                    'treats every 403 as retryable, so it refreshes every 2 seconds until the tab closes. '
                    'One revoked user produced 1,800 refresh calls in an hour. Revocation must answer 401 '
                    'with a reason the client treats as terminal.',
        next_step='Return 401 with a session_revoked reason from the refresh endpoint.',
        next_step_detail='Then the client signs out once on that reason. A regression test revokes a grant '
                         'mid-session and asserts exactly one refresh call.',
    ),
    'wi-auth-e2-b3': dict(
        summary='Signing out must also clear the SAML shim cookie.',
        description='Signing out clears the BFF session but not the shim session cookie on the legacy '
                    'domain, so the next visit silently re-authenticates through the shim. Logout has to '
                    'pass through the shim single-logout endpoint until the shim is deleted.',
        next_step='Add the shim single-logout redirect to the BFF logout handler.',
        next_step_detail='Verify in a fresh browser profile that the visit after logout lands on the Cognito '
                         'hosted UI, not straight back in.',
    ),
    # ── LLM Application Platform ──
    'wi-llm-e1-s2': dict(
        summary='Score every canary answer on a weighted rubric so a prompt change is judged, not eyeballed.',
        description='The judge scores grounding, completeness, tone and latency against the retrieved '
                    'context. On the 120-question pilot set it agrees with human labels 82 percent of the '
                    'time. Which model judges is the open decision "Judge model for canary evaluation".',
        next_step='Nina Rivera decides the judge model.',
        next_step_detail='Run both candidates over the pilot set with the final weights and report agreement '
                         'and cost per 1,000 judged answers side by side.',
    ),
    'wi-llm-e1-b3': dict(
        summary='Every replica refetches its prompt in the same second when the cache expires.',
        description='Replicas cache each prompt for exactly 60 seconds from boot, so after a deploy they '
                    'expire together and the prompt store throttles at about 40 requests a second. '
                    'Jittering the TTL and serving the stale prompt while one refresh runs removes the stampede.',
        next_step='Add TTL jitter and stale-while-revalidate to the prompt cache.',
        next_step_detail='Load test with 50 replicas restarted at once: zero throttled fetches.',
    ),
    'wi-llm-e2-s1': dict(
        summary='Gate every prompt and model change on a versioned golden set per agent.',
        description='Each agent has 30 to 60 golden questions with expected facts, versioned with the prompt '
                    'they test. A change merges only when no rubric dimension drops more than 0.03 against '
                    'the current baseline.',
        next_step='Katya Petrov records the golden-set version in the baseline file.',
        next_step_detail='Without it, a score cannot be compared with the one before it.',
    ),
    'wi-llm-e2-s2': dict(
        summary='Run the guardrail regression set on every pull request that touches a prompt or a guardrail.',
        description='The set holds 200 prompts that must be blocked (prompt injection, PII exfiltration, '
                    'off-topic requests) and 200 that must pass. A regression in either direction fails the '
                    'build, because a guardrail that blocks good questions is also broken.',
    ),
    'wi-llm-e3-s1': dict(
        summary='Move nightly summarisation and re-embedding off the interactive endpoint.',
        description='Non-interactive jobs share the on-demand quota with users and cause throttling every '
                    'night around 02:00 UTC. A batch queue with its own concurrency limit takes them off the '
                    'interactive path.',
    ),
    # ── Cost Optimization ──
    'wi-cost-e1-s2': dict(
        summary='Justify or merge every OpenSearch Serverless collection holding its own capacity floor.',
        description='Collections share capacity only when they share an encryption key, so each key group '
                    'bills its own 2-OCU floor whether or not anyone queries it. Three of five collections '
                    'served fewer than 100 queries last week. Merging them onto the shared key saves about '
                    '$350 a month per group.',
        next_step='Reindex the three quiet collections onto the shared key group.',
        next_step_detail='Switch readers, then delete the old collections after 7 days of zero queries.',
    ),
    'wi-cost-e2-s1': dict(
        summary='Refuse a deploy that creates an untagged resource.',
        description='Showback is only as good as the tags. A CDK aspect fails synthesis when a taggable '
                    'resource lacks initiative and owner tags, and the daily sweep lists anything created '
                    'outside CDK without them.',
        next_step='Layla Hassan reviews the exemption list.',
        next_step_detail='Only resources that cannot carry tags are exempt, each with a reason.',
    ),
    'wi-cost-e2-s2': dict(
        summary='One view per initiative: infrastructure, model tokens and the bot baseline.',
        description='Infrastructure cost comes from tags, model spend from invocation logs and bot spend '
                    'from the run ledger. Joining the three per initiative per day shows what an initiative '
                    'actually costs, with the maintenance-bot baseline shown as a floor rather than mixed '
                    'into interactive work.',
    ),
    # ── Inference Platform ──
    'wi-inf-e1-s1': dict(
        summary='Scale replicas on in-flight requests per replica instead of CPU.',
        description='GPU-bound replicas sit at 30 percent CPU while requests queue for seconds, so CPU-based '
                    'scaling never fires. Target tracking on queue depth reacts to the load users actually '
                    'feel: 4 in flight per replica, out after 30 seconds sustained, in after 10 minutes.',
        next_step='Publish the in-flight metric from the router.',
        next_step_detail='Emit in-flight requests per model every 10 seconds, switch the staging policy over, '
                         'and replay the last traffic peak.',
    ),
    'wi-inf-e1-b3': dict(
        summary='The first request after scale-to-zero waits 40 to 90 seconds for the model to load.',
        description='Models idle for 15 minutes scale to zero, and the next request pays the container start '
                    'plus a 7 GB weight load. p99 on the embedding model reached 74 seconds against a '
                    '2.5-second SLO. The fix is a warm floor on tier-1 models or a faster load path.',
        next_step='Paolo Mancini decides the warm floor for tier-1 models.',
        next_step_detail='A warm replica costs about $380 a month per model on the current instance type. '
                         'The decision "Warm floor or scale-to-zero for tier-1 models" holds the comparison.',
    ),
    # ── Real-time Analytics Pipeline ──
    'wi-rta-e1-s1': dict(
        summary='Recover from a task failure in under 60 seconds.',
        description='Checkpoints take 3 to 4 minutes because the job snapshots 180 GB of keyed state in full '
                    'each time. Incremental RocksDB checkpoints, plus unaligned checkpoints under '
                    'backpressure, bring the interval to 30 seconds and recovery under a minute.',
    ),
    'wi-rta-e1-b3': dict(
        summary='Events arriving after the watermark are silently dropped from the hourly aggregates.',
        description='Mobile clients batch events and deliver them up to 4 minutes late, but the watermark '
                    'allows 30 seconds of lateness, so about 0.6 percent of events miss their window. Late '
                    'events should go to a side output and be merged by a correction job, not vanish.',
    ),
}
BRIEF_FIELDS = ('summary', 'description', 'blocked_reason', 'next_step', 'next_step_detail')

# Every child's title as emitted, filled while the inserts are written, so a
# brief's UPDATE restates the same title the INSERT carries.
TITLES: dict[str, str] = {}


def q(s: str) -> str:
    return s.replace("'", "''")


def lit(s: str) -> str:
    """A SQL string literal for `s`, quotes included.

    A value with a line break is written as an escape string (E'..\\n..')
    rather than with a raw newline inside the quotes: schema/apply-work-items.sh
    flattens each statement onto one line before sending it, which would turn
    a raw newline into a space and silently change the value."""
    if '\n' not in s:
        return f"'{q(s)}'"
    return "E'" + q(s.replace('\\', '\\\\')).replace('\n', '\\n') + "'"


def days(n: int) -> str:
    """TIMESTAMPTZ expression n days in the past (n >= 0)."""
    return f"NOW() - INTERVAL '{n} days'"


def date_expr(offset: int) -> str:
    """DATE expression offset days from today (negative = past)."""
    if offset < 0:
        return f"(NOW() - INTERVAL '{-offset} days')::date"
    return f"(NOW() + INTERVAL '{offset} days')::date"


def cost_for(points: int) -> float:
    """Complexity → dollars through the calibrated curve (never hours)."""
    return round(points * RNG.uniform(0.85, 1.35), 2)


def stable_uuid(*parts: str) -> str:
    """Deterministic UUID from the initiative id (stable across list edits)."""
    return str(uuid.uuid5(uuid.NAMESPACE_URL, 'orgiq-program-seed/' + '/'.join(parts)))


def bot_uuid(pid: str) -> str:
    return stable_uuid('bot', pid)


def run_uuid(pid: str, j: int) -> str:
    return stable_uuid('bot-run', pid, str(j))


L: list[str] = []


def emit(sql: str) -> None:
    L.append(sql + ';')


def main() -> None:
    L.append('-- Generated by schema/seeds/generate_program_seed.py — do not hand-edit.')
    L.append('-- Curated program operating-model seed for the 12 canonical initiatives.')
    L.append('')

    ids = ', '.join(f"'{i['id']}'" for i in INITIATIVES)

    L.append('-- One owner runs each initiative; a few SMEs attach across initiatives.')
    L.append('-- The old randomized 10-person contribution walls are replaced wholesale.')
    emit(f'DELETE FROM project_contributions WHERE project_id IN ({ids})')

    for idx, ini in enumerate(INITIATIVES, start=1):
        pid, slug = ini['id'], ini['slug']
        L.append('')
        L.append(f"-- ─── {ini['id']} ────────────────────────────────────────────────")

        emit(
            f"UPDATE projects SET description = '{q(ini['description'])}', "
            f"summary = {lit(ini.get('summary', ini['description']))}, "
            f"github_url = '{GH}/{ini['repo']}', owner_id = '{ini['owner']}', "
            f"sponsor_person_id = '{ini['sponsor']}' "
            f"WHERE id = '{pid}'"
        )
        emit(
            "INSERT INTO project_contributions (person_id, project_id, role, weight) "
            f"VALUES ('{ini['owner']}', '{pid}', 'owner', 1.0) ON CONFLICT DO NOTHING"
        )
        for sme in ini['smes']:
            emit(
                "INSERT INTO project_contributions (person_id, project_id, role, weight) "
                f"VALUES ('{sme}', '{pid}', 'sme', 0.8) ON CONFLICT DO NOTHING"
            )

        # Repo link the initiative's code will live in (user provisions the repo,
        # private, reached through GH_CONNECTION).
        # DO UPDATE, not DO NOTHING — see the note on the bots insert below:
        # seed.sql deletes projects on every run and this FK is ON DELETE SET
        # NULL, so a re-run silently detaches the repo from its initiative. The
        # connection is re-asserted on conflict too, so a cluster seeded before
        # the repos went private stops reading them as public.
        emit(
            "INSERT INTO agent_projects (id, repo_full_name, default_branch, org_project_id, connection_name, added_by) "
            f"VALUES ('{stable_uuid('repo', pid)}', 'connorhoehnslalom/{ini['repo']}', 'main', '{pid}', "
            f"'{GH_CONNECTION}', 'seed') "
            f"ON CONFLICT (repo_full_name) DO UPDATE SET org_project_id = '{pid}', "
            f"connection_name = '{GH_CONNECTION}'"
        )

        # Sprints + grants
        sprint_ids: dict[str, str] = {}
        for (skey, name, steward, start, end, status, goal) in ini['sprints']:
            sid = f'spr-{slug}-{skey}'
            sprint_ids[skey] = sid
            emit(
                "INSERT INTO sprints (id, org_project_id, name, goal, steward_person_id, starts_on, ends_on, status) "
                f"VALUES ('{sid}', '{pid}', '{q(name)}', '{q(goal)}', '{steward}', "
                f"{date_expr(start)}, {date_expr(end)}, '{status}') ON CONFLICT (id) DO NOTHING"
            )
        for gi, (skey, grantee, usd) in enumerate(ini['grants'], start=1):
            emit(
                "INSERT INTO budget_grants (id, org_project_id, sprint_id, grantee_person_id, allocated_usd, granted_by, note) "
                f"VALUES ('bg-{slug}-{gi}', '{pid}', '{sprint_ids[skey]}', '{grantee}', {usd}, 'u-release', "
                f"'Sprint envelope granted by the release manager') ON CONFLICT (id) DO NOTHING"
            )

        # Monthly allocation for the program-manager ledger.
        #
        # Derived, not hand-set, so the ledger cannot contradict itself: a
        # month holds roughly two of these sprints, so the allocation must
        # cover the grants for sprints landing inside it (plus headroom for
        # unplanned work). Hand-setting both produced initiatives whose sprint
        # envelopes summed to more than the month that was supposed to fund
        # them. The configured figure acts as a floor.
        in_month = sum(usd for (skey, _g, usd) in ini['grants']
                       if any(s[0] == skey and s[4] >= -30 for s in ini['sprints']))
        derived = 5 * math.ceil(in_month * 1.25 / 5)
        allocation = max(ini['budget'], derived)
        emit(
            "INSERT INTO initiative_budgets (org_project_id, allocated_usd, period, updated_by) "
            f"VALUES ('{pid}', {allocation}, 'monthly', '{ALLOCATED_BY.get(pid, 'u-release')}') "
            "ON CONFLICT (org_project_id) DO NOTHING"
        )

        # Epics → stories/bugs with complexity + dollar estimates.
        pr_counter = RNG.randint(20, 60)
        item_age = 75
        for (ekey, etitle, epri, estatus, edesc, children) in ini['epics']:
            eid = f'wi-{slug}-{ekey}'
            desc_sql = f"'{q(edesc)}'" if edesc else 'NULL'
            done_at = days(8) if estatus == 'done' else 'NULL'
            emit(
                "INSERT INTO work_items (id, work_item_key, project_id, parent_id, type, title, description, status, priority, assignee_id, labels, created_at, updated_at, completed_at) "
                f"VALUES ('{eid}', '{WORK_KEYS[eid]['key']}', '{pid}', NULL, 'epic', '{q(etitle)}', {desc_sql}, '{estatus}', '{epri}', "
                f"'{ini['owner']}', NULL, {days(item_age)}, {days(RNG.randint(1, 6))}, {done_at}) "
                "ON CONFLICT (id) DO NOTHING"
            )
            for ci, (ctype, ctitle, cstatus, cpri, pts, labels, skey) in enumerate(children, start=1):
                cid = f'wi-{slug}-{ekey}-{"b" if ctype == "bug" else "s"}{ci}'
                TITLES[cid] = ctitle
                assignee = RNG.choice([ini['owner']] + [m for m in ini['smes'] if m not in ROSTER_ONLY_SMES])
                labels_sql = "ARRAY[" + ','.join(f"'{lb}'" for lb in labels) + "]" if labels else 'NULL'
                sprint_sql = f"'{sprint_ids[skey]}'" if skey and skey in sprint_ids else 'NULL'
                est = cost_for(pts)
                created = RNG.randint(20, item_age)
                if cstatus == 'done':
                    drawn = RNG.randint(3, 18)  # always drawn, so the RNG stream is unchanged
                    # A done item finished inside its sprint's window: the draw is mapped
                    # into [window start, min(window end, yesterday)] rather than trusted.
                    win = next((sp for sp in ini['sprints'] if sp[0] == skey), None)
                    if win is not None:
                        newest = max(1, -win[4])          # days ago the window closes (or yesterday)
                        oldest = max(newest, -win[3])     # days ago it opened
                        drawn = newest + (drawn - 3) % (oldest - newest + 1)
                        created = max(created, drawn + 3)
                    completed = days(drawn)
                    pr_counter += RNG.randint(1, 7)
                    pr_sql = f"'{GH}/{ini['repo']}/pull/{pr_counter}', 'merged'"
                elif cstatus == 'in_review':
                    completed = 'NULL'
                    pr_counter += RNG.randint(1, 7)
                    pr_sql = f"'{GH}/{ini['repo']}/pull/{pr_counter}', 'open'"
                else:
                    completed = 'NULL'
                    pr_sql = 'NULL, NULL'
                emit(
                    "INSERT INTO work_items (id, work_item_key, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, estimated_cost_usd, sprint_id, pr_url, pr_status, created_at, updated_at, completed_at) "
                    f"VALUES ('{cid}', '{WORK_KEYS[cid]['key']}', '{pid}', '{eid}', '{ctype}', '{q(ctitle)}', '{cstatus}', '{cpri}', "
                    f"'{assignee}', {labels_sql}, {pts}, {est}, {sprint_sql}, {pr_sql}, "
                    f"{days(created)}, {days(RNG.randint(0, 5))}, {completed}) "
                    "ON CONFLICT (id) DO NOTHING"
                )

        # The decision this initiative raised, when it has one.
        #
        # Same table and same column list as schema/seed.sql's org-graph
        # decisions — see the comment on `decisions` in schema/orgiq_schema.sql.
        # These rows used to fill only half of it (no decided_at, no
        # work_item_id, no participants) while seed.sql filled the other half
        # (no status, no project_id), so `GET /api/graph/decisions` and an
        # initiative's Decisions tab described two different worlds out of one
        # table. Whatever is added here must be added there too.
        #
        # work_item_id can only be written from THIS file: the epic it names is
        # emitted a few lines above, and does not exist when seed.sql runs.
        # The decisions this initiative raised: its headline `decision`, then any
        # `extra_decisions`. An extra one is `open` (no RNG draw), so adding it
        # never reshuffles the dates and costs drawn after it.
        for dec in ([ini['decision']] if ini['decision'] else []) + ini.get('extra_decisions', []):
            (did, topic, summary, status, req_role, dec_ekey, *rest) = dec
            # An escalated decision names who decides it; the owner who raised
            # it is then a contributor, never the decider of their own escalation.
            decider = rest[0] if rest else ini['owner']
            resolved = days(RNG.randint(5, 20)) if status == 'resolved' else 'NULL'
            escalated = days(RNG.randint(1, 5)) if status == 'escalated' else 'NULL'
            # A decision has a decided_at exactly when it has been decided. The
            # graph's decision list orders on it, so leaving it NULL on a
            # resolved row put a settled call in with the undecided ones.
            decided = f'({resolved})::date' if status == 'resolved' else 'NULL'
            role_sql = f"'{req_role}'" if req_role else 'NULL'
            emit(
                "INSERT INTO decisions (id, topic, summary, status, project_id, required_role, decided_at, escalated_at, resolved_at, work_item_id) "
                f"VALUES ('{did}', '{q(topic)}', '{q(summary)}', '{status}', '{pid}', {role_sql}, {decided}, {escalated}, {resolved}, "
                f"'wi-{slug}-{dec_ekey}') "
                "ON CONFLICT (id) DO NOTHING"
            )
            # Who was in the room. Every decision in seed.sql carries this;
            # these carried none, so the same rows that the initiative page
            # showed read "0 participants" on the graph's decision list.
            emit(
                "INSERT INTO decision_participants (person_id, decision_id, role) "
                f"VALUES ('{decider}', '{did}', 'decider') ON CONFLICT DO NOTHING"
            )
            if decider != ini['owner']:
                emit(
                    "INSERT INTO decision_participants (person_id, decision_id, role) "
                    f"VALUES ('{ini['owner']}', '{did}', 'contributor') ON CONFLICT DO NOTHING"
                )
            for sme in ini['smes']:
                emit(
                    "INSERT INTO decision_participants (person_id, decision_id, role) "
                    f"VALUES ('{sme}', '{did}', 'contributor') ON CONFLICT DO NOTHING"
                )

        # The maintenance bot and its baseline: cron firing → queue job → run.
        bot = ini['bot']
        if bot:
            bid = bot_uuid(pid)
            # Seeded bots are parked, deliberately. The repositories they name
            # are not provisioned yet, and initBotScheduler registers every
            # enabled cron bot at boot — so an enabled seed bot would fire on
            # schedule against a repo that does not exist, burning real money
            # to fail at clone. Provision the repo, then un-pause the bot from
            # its page: that is the activation step, and it is one click.
            paused = (f"'{q(bot['paused'])}'" if bot.get('paused')
                      else "'awaiting repo provisioning — un-pause once the repository exists'")
            enabled = 'FALSE'
            # obs-nightly-maintenance is created by u-tomas (pipelines author who
            # also holds Social): the Communication plane's "My pipelines" walker.
            # The other maintenance bots are set up by the people who work on their initiative, so a
            # peer sees ten different owners on the definitions list rather than one person on all of them.
            creator = BOT_CREATORS.get(bot['name'], 'u-rachel')
            emit(
                "INSERT INTO bots (id, name, template, prompt_template, org_project_id, model, trigger, cron_expr, enabled, budget_per_run_usd, budget_per_day_usd, max_runs_per_day, requires_review, created_by, created_at, last_run_at, paused_reason) "
                f"VALUES ('{bid}', '{q(bot['name'])}', '{bot['template']}', '{q(bot['mission'])}', "
                f"'{pid}', 'us.amazon.nova-lite-v1:0', 'cron', '{bot['cron']}', {enabled}, "
                f"{bot['per_run']}, {bot['per_day']}, 4, TRUE, '{creator}', {days(45)}, {days(1)}, {paused}) "
                # DO UPDATE is load-bearing, not defensive. seed.sql opens with
                # DELETE FROM projects, and bots.org_project_id is ON DELETE SET
                # NULL — so the second time this seed runs, every bot loses its
                # initiative link. Spend attribution keys on exactly that column,
                # so the Budgets page then showed $16.39 spent org-wide with
                # $0.00 against all 14 initiatives, and nothing anywhere said why.
                # DO NOTHING cannot repair it; the row already exists.
                f"ON CONFLICT (id) DO UPDATE SET org_project_id = '{pid}', enabled = {enabled}, paused_reason = {paused}"
            )
            # The payload's requiresReview must agree with the bot's own
            # requires_review column three lines up, which is TRUE for every
            # seeded bot. It said false, so a seeded job claimed no review was
            # needed while the bot that minted it said one was — one seed
            # contradicting itself, which no fixture should be adjusted to match.
            for j in range(bot['runs']):
                age = j * max(1, 30 // bot['runs']) + 1
                cost = round(bot['per_run'] * RNG.uniform(0.25, 0.85), 4)
                jid = f'job-{slug}-maint-{j + 1}'
                note = run_note(f'{slug}-maint', j + 1)
                status = note.get('status')  # None (finished), 'failed' or 'skipped'
                seconds = int(note.get('seconds', 240))
                reason = note['reason']
                end = f"{days(age)} + INTERVAL '{seconds} seconds'"
                if status == 'skipped':
                    # A skipped firing never dispatched: no job, no spend.
                    emit(
                        "INSERT INTO bot_runs (id, bot_id, trigger, job_id, status, cost_usd, started_at, finished_at, outcome) "
                        f"VALUES ('{run_uuid(pid, j + 1)}', '{bid}', 'cron', NULL, 'skipped', 0, "
                        f"{days(age)}, {end}, '{{\"reason\": \"{q(reason)}\"}}'::jsonb) "
                        "ON CONFLICT (id) DO NOTHING"
                    )
                    continue
                job_status = 'failed' if status == 'failed' else 'done'
                result = ('NULL' if status == 'failed'
                          else f"'{{\"summary\": \"{q(reason[0].upper() + reason[1:])}.\", \"costUsd\": {cost}}}'::jsonb")
                job_error = f"'{q(reason)}'" if status == 'failed' else 'NULL'
                emit(
                    "INSERT INTO agent_jobs (id, kind, title, payload, status, priority, attempts, max_attempts, result, error, created_by, created_at, finished_at, bot_id) "
                    f"VALUES ('{jid}', 'devbox:task', '{q(bot['name'])}', "
                    f"'{{\"prompt\": \"{q(bot['mission'])[:120]}\", \"requiresReview\": true, \"botId\": \"{bid}\", \"model\": \"us.amazon.nova-lite-v1:0\"}}'::jsonb, "
                    f"'{job_status}', 100, 1, 1, {result}, {job_error}, "
                    f"'scheduler', {days(age)}, {end}, '{bid}') "
                    "ON CONFLICT (id) DO NOTHING"
                )
                outcome = f'{{\"reason\": \"{q(reason)}\"' + (f', \"error\": \"{q(reason)}\"' if status == 'failed' else '') + '}'
                emit(
                    "INSERT INTO bot_runs (id, bot_id, trigger, job_id, status, cost_usd, started_at, finished_at, outcome) "
                    f"VALUES ('{run_uuid(pid, j + 1)}', '{bid}', 'cron', '{jid}', '{job_status}', {cost}, "
                    f"{days(age)}, {end}, '{outcome}'::jsonb) "
                    "ON CONFLICT (id) DO NOTHING"
                )
            # No 'queued' rows are seeded. The job dispatcher claims any queued
            # job as soon as a devbox box is idle, so a seeded queued row would
            # not sit in the queue illustrating the loop — it would execute,
            # against a repository that does not exist. The completed history
            # above is what shows the loop and the maintenance baseline; the
            # queue fills for real once a bot is un-paused.

    # Work-item briefs and the titles that changed with them (see BRIEFS).
    L.append('')
    L.append('-- Work-item briefs: title, summary, why-this-matters, blocked reason, next step.')
    for wid, brief in BRIEFS.items():
        unknown = set(brief) - set(BRIEF_FIELDS)
        if unknown:
            raise SystemExit(f'BRIEFS[{wid!r}] has unknown fields: {sorted(unknown)}')
        if wid not in TITLES:
            raise SystemExit(f'BRIEFS names {wid!r}, which no initiative seeds')
        sets = [f"title = '{q(TITLES[wid])}'"] + [
            f"{field} = '{q(brief[field])}'" if brief.get(field) else f'{field} = NULL'
            for field in BRIEF_FIELDS
        ]
        emit(f"UPDATE work_items SET {', '.join(sets)} WHERE id = '{wid}'")

    # Link logins to their org-graph personas.
    #
    # identity_schema.sql resolves app_users.person_id with a subquery against
    # `people`, but it loads BEFORE seed.sql creates those rows — so every
    # person_id lands NULL and stays NULL. A login with no persona cannot
    # resolve "my initiatives", and an SME who masquerades in sees nobody's
    # work. This seed runs after both, which makes it the right place to close
    # the link; matching on email keeps it exact rather than name-guessing.
    L.append('')
    L.append('-- Backfill app_users.person_id (identity_schema loads before the people rows exist).')
    emit(
        "UPDATE app_users u SET person_id = p.id FROM people p "
        "WHERE u.person_id IS NULL AND lower(p.email) = lower(u.email)"
    )

    # Flagship comment threads.
    L.append('')
    L.append('-- Curated comment threads on flagship items.')
    for ci, (slug, key, author, body) in enumerate(COMMENTS, start=1):
        emit(
            "INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at) "
            f"VALUES ('wic-prog-{ci}', 'wi-{slug}-{key}', '{author}', '{q(body)}', FALSE, {days(RNG.randint(1, 12))}) "
            "ON CONFLICT (id) DO NOTHING"
        )

    # Planning notes with a fixed age (not the random draw above).
    L.append('')
    L.append('-- Planning notes on wi-obs-e1-s4 (fixed ages).')
    base = len(COMMENTS)
    for fi, (slug, key, author, body, age) in enumerate(FIXED_AGE_COMMENTS, start=1):
        emit(
            "INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at) "
            f"VALUES ('wic-prog-{base + fi}', 'wi-{slug}-{key}', '{author}', '{q(body)}', FALSE, {days(age)}) "
            "ON CONFLICT (id) DO NOTHING"
        )

    # Ticket threads on the five arcs (fixed ages, no RNG draw).
    L.append('')
    L.append('-- Ticket threads on the five engineering arcs (fixed ages).')
    base = len(COMMENTS) + len(FIXED_AGE_COMMENTS)
    for ti, (slug, key, author, body, age) in enumerate(TICKET_COMMENTS, start=1):
        emit(
            "INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at) "
            f"VALUES ('wic-prog-{base + ti}', 'wi-{slug}-{key}', '{author}', '{q(body)}', FALSE, {days(age)}) "
            "ON CONFLICT (id) DO NOTHING"
        )

    # Acceptance-criteria checklists.
    L.append('')
    L.append('-- Acceptance-criteria checklists on the in-flight items of the engineering arcs.')
    for slug, key, items in CRITERIA:
        for i, (text, done, created_age, updated_age) in enumerate(items):
            cid = f'wicr-{slug}-{key}-{i + 1}'
            emit(
                "INSERT INTO work_item_criteria (id, work_item_id, text, done, position, created_at, updated_at) "
                f"VALUES ('{cid}', 'wi-{slug}-{key}', '{q(text)}', {'TRUE' if done else 'FALSE'}, {i}, "
                f"{days(created_age)}, {days(updated_age)}) "
                "ON CONFLICT (id) DO NOTHING"
            )

    OUT.write_text('\n'.join(L) + '\n', encoding='utf-8')
    stmt_count = sum(1 for line in L if line.endswith(';'))
    print(f'wrote {OUT} ({stmt_count} statements)')


if __name__ == '__main__':
    main()
