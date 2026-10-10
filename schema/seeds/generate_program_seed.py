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

GH = 'https://github.com/connorhoehnslalom'

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
            ('s1', 'Sprint 96 — Ingest hardening', 'p-008', -42, -28, 'done',
             'Collector fleet stable at 2x peak ingest.'),
            ('s2', 'Sprint 97 — Burn-rate alerts', 'p-011', -28, -14, 'done',
             'Tier-1 services alert on error-budget burn, not raw error rate.'),
            ('s3', 'Sprint 98 — Span metrics + decom', 'p-008', -14, 0, 'active',
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
                  'Vendor agents priced per-host at 3x our infra cost; the collector fleet is '
                  'ours to tune and the escape hatch stays open.', 'resolved', None, 'e1'),
    ),
    dict(
        id='p-auth-migration', slug='auth', repo='orgiq-auth-service', tier='flagship',
        owner='p-002', smes=['p-051', 'p-004'],
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
            ('s1', 'Sprint 41 — OIDC core', 'p-051', -35, -21, 'done',
             'Code+PKCE flow live; JWKS rotation survives a key roll.'),
            ('s2', 'Sprint 42 — Session hygiene', 'p-051', -14, 0, 'active',
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
                  'Smallest tenant first vs. riskiest first. Riskiest-first surfaces unknowns '
                  'while rollback is cheap, but a failed first cutover is loud.', 'escalated', 'org-leader', 'e2'),
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
            ('s1', 'Sprint 7 — Prompt registry', 'p-042', -30, -16, 'done',
             'Prompt edits reach the fleet without a redeploy.'),
            ('s2', 'Sprint 8 — Judge + evals', 'p-013', -14, 0, 'active',
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
                  'Nova Pro judges cost ~6x Nova Lite but agree with human labels 11 points '
                  'more often on the current rubric. Sample-rate tuning could fund the gap.', 'open', None, 'e1'),
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
            ('s1', 'Sprint 23 — Floors and orphans', 'p-011', -28, -14, 'done',
             'Idle floors documented; orphan sweep automated.'),
            ('s2', 'Sprint 24 — Attribution', 'p-017', -14, 0, 'active',
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
        sprints=[('s1', 'Sprint 15 — Checkpoint + schema', 'p-019', -14, 0, 'active',
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
        sprints=[('s1', 'Sprint 3 — Format decision', 'p-017', -10, 4, 'active',
                  'Table format chosen with a written ADR.')],
        grants=[('s1', 'p-017', 10)],
        budget=10,
        bot=None,  # planning-stage initiative: no repo activity to maintain yet
        decision=('d-iceberg', 'Iceberg over Delta for the lakehouse table format',
                  'Engine-neutral catalog support and snapshot isolation fit the multi-engine '
                  'roadmap; Delta\'s tighter Spark coupling was the deciding cost.', 'resolved', None, 'e1'),
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
        sprints=[('s1', 'Sprint 11 — Freshness', 'p-019', -14, 0, 'active',
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
        sprints=[('s1', 'Sprint 31 — Routing', 'p-035', -14, 0, 'active',
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
        sprints=[('s1', 'Sprint 19 — Token sync', 'p-038', -14, 0, 'active',
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
        sprints=[('s1', 'Sprint 6 — Contracts', 'p-035', -14, 0, 'active',
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
        sprints=[('s1', 'Sprint 14 — Queue-depth scaling', 'p-013', -14, 0, 'active',
                  'Scaling reacts to demand, not to a proxy metric.')],
        grants=[('s1', 'p-013', 15)],
        budget=20,
        bot=dict(name='inference-canary-nightly', template='bug', cron='15 3 * * *',
                 mission='Nightly canary of every served model version: latency and error '
                         'deltas against the previous build, rollback recommendation on breach.',
                 per_run=0.40, per_day=1.50, runs=7),
        decision=None,
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
        sprints=[('s1', 'Sprint 2 — Inventory', 'p-052', -7, 7, 'active',
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

# Acceptance-criteria checklists. Each entry is
# (initiative slug, work-item key, [(text, done, created_days_ago, updated_days_ago), ...]).
# wi-obs-e1-s4 is the flagship example the design mockup names; the other three
# are open Observability stories seeded so the initiative's board is not a
# one-item demo.
CRITERIA = [
    ('obs', 'e1-s4', [
        ('Route metrics through the collector', False, 5, 5),
        ('Verify dashboard and alert parity', False, 5, 5),
        ('Keep a rollback path during migration', False, 5, 5),
    ]),
    ('obs', 'e3-s1', [
        ('Define per-service label cardinality budgets', True, 10, 3),
        ('Add a CI check that fails a PR exceeding budget', False, 10, 10),
        ('Document the exemption process for legitimate spikes', False, 10, 10),
    ]),
    ('obs', 'e3-s2', [
        ('Classify log levels into debug/info/audit tiers', True, 12, 6),
        ('Configure the sampling rate for the debug tier', True, 12, 4),
        ('Confirm audit logs bypass sampling entirely', False, 12, 12),
    ]),
    ('obs', 'e2-s3', [
        ('Wire one dashboard panel per team', False, 4, 4),
        ('Add drill-down to the underlying SLO burn', False, 4, 4),
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
# Semicolons are kept out of this copy on purpose: schema/apply-work-items.sh
# splits statements on `;` at paren depth 0 and would cut a string in two.
BRIEFS: dict[str, dict[str, str]] = {
    'wi-obs-e2-b4': dict(
        summary='One failing dependency can trigger forty pages.',
        description='When one shared dependency fails, it can trigger forty separate pages. '
                    'Fixing this should help the on-call engineer identify the root problem '
                    'without sorting through duplicate alerts.',
        blocked_reason='Waiting on the dependency map.',
        next_step='Confirm the dependency map with Eli Garcia.',
        next_step_detail='The team needs this before choosing how to group duplicate alerts.',
    ),
    'wi-obs-e1-s4': dict(
        summary='Move remaining service metrics to OpenTelemetry.',
    ),
    'wi-obs-e2-s3': dict(
        summary="Make each team's remaining error budget visible.",
        description='One panel per team: budget remaining, burn over the window, and who owns the service.',
    ),
    'wi-obs-e3-s1': dict(
        summary='Define limits before new metrics increase storage costs.',
    ),
    'wi-obs-e2-s2': dict(
        description='Fast burn pages, slow burn tickets. Thresholds derived from the SLO, not hand-picked.',
    ),
    'wi-obs-e3-s2': dict(),
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
            f"VALUES ('{pid}', {allocation}, 'monthly', 'u-release') "
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
                assignee = RNG.choice([ini['owner']] + ini['smes'])
                labels_sql = "ARRAY[" + ','.join(f"'{lb}'" for lb in labels) + "]" if labels else 'NULL'
                sprint_sql = f"'{sprint_ids[skey]}'" if skey and skey in sprint_ids else 'NULL'
                est = cost_for(pts)
                created = RNG.randint(20, item_age)
                if cstatus == 'done':
                    completed = days(RNG.randint(3, 18))
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
        if ini['decision']:
            (did, topic, summary, status, req_role, dec_ekey) = ini['decision']
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
                f"VALUES ('{ini['owner']}', '{did}', 'decider') ON CONFLICT DO NOTHING"
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
            creator = 'u-tomas' if bot['name'] == 'obs-nightly-maintenance' else 'u-rachel'
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
                emit(
                    "INSERT INTO agent_jobs (id, kind, title, payload, status, priority, attempts, max_attempts, result, created_by, created_at, finished_at, bot_id) "
                    f"VALUES ('{jid}', 'devbox:task', '{q(bot['name'])}', "
                    f"'{{\"prompt\": \"{q(bot['mission'])[:120]}\", \"requiresReview\": true, \"botId\": \"{bid}\", \"model\": \"us.amazon.nova-lite-v1:0\"}}'::jsonb, "
                    f"'done', 100, 1, 1, '{{\"summary\": \"Maintenance pass complete\", \"costUsd\": {cost}}}'::jsonb, "
                    f"'scheduler', {days(age)}, {days(age)}, '{bid}') "
                    "ON CONFLICT (id) DO NOTHING"
                )
                emit(
                    "INSERT INTO bot_runs (id, bot_id, trigger, job_id, status, cost_usd, started_at, finished_at, outcome) "
                    f"VALUES ('{run_uuid(pid, j + 1)}', '{bid}', 'cron', '{jid}', 'done', {cost}, "
                    f"{days(age)}, {days(age)}, '{{\"reason\": \"scheduled maintenance\"}}'::jsonb) "
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

    # Acceptance-criteria checklists.
    L.append('')
    L.append('-- Acceptance-criteria checklists on select Observability items.')
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
