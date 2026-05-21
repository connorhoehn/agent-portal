-- proj-otel: Unified Observability Stack
-- 2 Epics, 4 Features, 8 Stories, 8 Tasks, 50+ Comments

-- Epic 1: OTEL Collector & Gateway
INSERT INTO work_items (id, project_id, parent_id, type, title, description, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-otel-e1', 'proj-otel', NULL, 'epic', 'OTEL Collector & Gateway Hardening', 'Build a resilient, scalable OpenTelemetry collector gateway for ingesting spans, metrics, and logs from all microservices. Includes batching, sampling policies, and tail-based sampling.', 'in_progress', 'critical', 'p-001', ARRAY['infrastructure','observability','otel'], NOW() - INTERVAL '45 days', NOW() - INTERVAL '2 days', NULL)
ON CONFLICT (id) DO NOTHING;

-- Epic 2: SLO/SLA & Dashboard Layer
INSERT INTO work_items (id, project_id, parent_id, type, title, description, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-otel-e2', 'proj-otel', NULL, 'epic', 'SLO/SLA Tracking & Dashboards', 'Define and track service-level objectives across the platform. Build Grafana dashboards for SLO compliance, error budgets, and alerting. Integrate with Prometheus for real-time tracking.', 'in_progress', 'high', 'p-005', ARRAY['observability','slo','dashboards','alerting'], NOW() - INTERVAL '40 days', NOW() - INTERVAL '1 day', NULL)
ON CONFLICT (id) DO NOTHING;

-- Feature 1.1: Collector Deployment & Configuration
INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-otel-f1', 'proj-otel', 'wi-otel-e1', 'feature', 'Collector Deployment & Configuration Management', 'in_progress', 'critical', 'p-021', ARRAY['infrastructure','deployment','otel'], NOW() - INTERVAL '38 days', NOW() - INTERVAL '3 days', NULL)
ON CONFLICT (id) DO NOTHING;

-- Feature 1.2: Gateway Load Balancing & High Availability
INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-otel-f2', 'proj-otel', 'wi-otel-e1', 'feature', 'Gateway Load Balancing & High Availability', 'open', 'critical', 'p-001', ARRAY['infrastructure','ha','networking'], NOW() - INTERVAL '35 days', NOW() - INTERVAL '5 days', NULL)
ON CONFLICT (id) DO NOTHING;

-- Feature 2.1: SLO Definition & Computation Engine
INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-otel-f3', 'proj-otel', 'wi-otel-e2', 'feature', 'SLO Definition & Computation Engine', 'in_progress', 'high', 'p-005', ARRAY['slo','metrics','prometheus'], NOW() - INTERVAL '32 days', NOW() - INTERVAL '2 days', NULL)
ON CONFLICT (id) DO NOTHING;

-- Feature 2.2: Grafana Dashboard Suite & Alerting Rules
INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-otel-f4', 'proj-otel', 'wi-otel-e2', 'feature', 'Grafana Dashboard Suite & Alerting Rules', 'done', 'high', 'p-021', ARRAY['dashboards','grafana','alerting'], NOW() - INTERVAL '28 days', NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 day')
ON CONFLICT (id) DO NOTHING;

-- Story 1.1: OTEL Collector Multi-Transport Support (TCP, gRPC, HTTP)
INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, pr_url, pr_status, created_at, updated_at, completed_at)
VALUES ('wi-otel-s1', 'proj-otel', 'wi-otel-f1', 'story', 'OTEL Collector Multi-Transport Support', 'done', 'critical', 'p-021', ARRAY['otel','collector','transport'], 5, 'https://github.com/orgiq/observability/pull/42', 'merged', NOW() - INTERVAL '36 days', NOW() - INTERVAL '8 days', NOW() - INTERVAL '8 days')
ON CONFLICT (id) DO NOTHING;

-- Story 1.2: Collector Health Check & Self-Diagnostics
INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, pr_url, pr_status, created_at, updated_at, completed_at)
VALUES ('wi-otel-s2', 'proj-otel', 'wi-otel-f1', 'story', 'Collector Health Check & Self-Diagnostics', 'in_progress', 'high', 'p-001', ARRAY['otel','health','monitoring'], 3, 'https://github.com/orgiq/observability/pull/51', 'open', NOW() - INTERVAL '30 days', NOW() - INTERVAL '1 day', NULL)
ON CONFLICT (id) DO NOTHING;

-- Story 1.3: Gateway Request Rate Limiting & Backpressure
INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, pr_url, pr_status, created_at, updated_at, completed_at)
VALUES ('wi-otel-s3', 'proj-otel', 'wi-otel-f2', 'story', 'Gateway Request Rate Limiting & Backpressure', 'in_review', 'critical', 'p-021', ARRAY['gateway','rate-limiting','backpressure'], 8, 'https://github.com/orgiq/observability/pull/48', 'open', NOW() - INTERVAL '14 days', NOW() - INTERVAL '2 days', NULL)
ON CONFLICT (id) DO NOTHING;

-- Story 1.4: Multi-Cluster Gateway Routing & Failover
INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, pr_url, pr_status, created_at, updated_at, completed_at)
VALUES ('wi-otel-s4', 'proj-otel', 'wi-otel-f2', 'story', 'Multi-Cluster Gateway Routing & Failover', 'open', 'high', 'p-001', ARRAY['gateway','routing','ha','multicluster'], 13, NULL, NULL, NOW() - INTERVAL '12 days', NOW() - INTERVAL '3 days', NULL)
ON CONFLICT (id) DO NOTHING;

-- Story 2.1: SLO Error Budget Calculation & Tracking
INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, pr_url, pr_status, created_at, updated_at, completed_at)
VALUES ('wi-otel-s5', 'proj-otel', 'wi-otel-f3', 'story', 'SLO Error Budget Calculation & Tracking', 'in_progress', 'high', 'p-005', ARRAY['slo','metrics','prometheus'], 8, 'https://github.com/orgiq/observability/pull/45', 'open', NOW() - INTERVAL '25 days', NOW() - INTERVAL '2 days', NULL)
ON CONFLICT (id) DO NOTHING;

-- Story 2.2: Tail-Based Sampling Rules for SLO Events
INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, pr_url, pr_status, created_at, updated_at, completed_at)
VALUES ('wi-otel-s6', 'proj-otel', 'wi-otel-f3', 'story', 'Tail-Based Sampling Rules for SLO Events', 'done', 'high', 'p-021', ARRAY['sampling','otel','collector'], 5, 'https://github.com/orgiq/observability/pull/39', 'merged', NOW() - INTERVAL '22 days', NOW() - INTERVAL '5 days', NOW() - INTERVAL '5 days')
ON CONFLICT (id) DO NOTHING;

-- Story 2.3: Grafana SLO Compliance Dashboard
INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, pr_url, pr_status, created_at, updated_at, completed_at)
VALUES ('wi-otel-s7', 'proj-otel', 'wi-otel-f4', 'story', 'Grafana SLO Compliance Dashboard', 'done', 'high', 'p-021', ARRAY['dashboards','grafana','slo'], 5, 'https://github.com/orgiq/observability/pull/41', 'merged', NOW() - INTERVAL '10 days', NOW() - INTERVAL '2 days', NOW() - INTERVAL '2 days')
ON CONFLICT (id) DO NOTHING;

-- Story 2.4: Prometheus Alert Rules for SLA Violations
INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, pr_url, pr_status, created_at, updated_at, completed_at)
VALUES ('wi-otel-s8', 'proj-otel', 'wi-otel-f4', 'story', 'Prometheus Alert Rules for SLA Violations', 'done', 'high', 'p-005', ARRAY['alerting','prometheus','sla'], 3, 'https://github.com/orgiq/observability/pull/52', 'merged', NOW() - INTERVAL '4 days', NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 day')
ON CONFLICT (id) DO NOTHING;

-- Task 1: Deploy OTEL Collector to ECS
INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-otel-t1', 'proj-otel', 'wi-otel-s1', 'task', 'Deploy OTEL Collector to ECS with gRPC/HTTP', 'done', 'critical', 'p-021', ARRAY['deployment','ecs'], NOW() - INTERVAL '36 days', NOW() - INTERVAL '8 days', NOW() - INTERVAL '8 days')
ON CONFLICT (id) DO NOTHING;

-- Task 2: Implement Health Check Endpoint
INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-otel-t2', 'proj-otel', 'wi-otel-s2', 'task', 'Implement /health endpoint with metrics', 'in_progress', 'high', 'p-001', ARRAY['health','metrics'], NOW() - INTERVAL '30 days', NOW() - INTERVAL '1 day', NULL)
ON CONFLICT (id) DO NOTHING;

-- Task 3: Rate Limiter Algorithm Review
INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-otel-t3', 'proj-otel', 'wi-otel-s3', 'task', 'Code review: Token bucket rate limiter', 'in_review', 'critical', 'p-021', ARRAY['review','rate-limiting'], NOW() - INTERVAL '14 days', NOW() - INTERVAL '2 days', NULL)
ON CONFLICT (id) DO NOTHING;

-- Task 4: Multi-Cluster Routing Config Spec
INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-otel-t4', 'proj-otel', 'wi-otel-s4', 'task', 'Write routing configuration spec & examples', 'open', 'high', 'p-001', ARRAY['spec','documentation'], NOW() - INTERVAL '12 days', NOW() - INTERVAL '3 days', NULL)
ON CONFLICT (id) DO NOTHING;

-- Task 5: SLO Error Budget Query Implementation
INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-otel-t5', 'proj-otel', 'wi-otel-s5', 'task', 'Implement PromQL queries for error budget', 'in_progress', 'high', 'p-005', ARRAY['prometheus','slo','queries'], NOW() - INTERVAL '25 days', NOW() - INTERVAL '2 days', NULL)
ON CONFLICT (id) DO NOTHING;

-- Task 6: Sampling Policy Configuration Schema
INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-otel-t6', 'proj-otel', 'wi-otel-s6', 'task', 'Define tail-based sampling policy schema', 'done', 'high', 'p-021', ARRAY['schema','sampling'], NOW() - INTERVAL '22 days', NOW() - INTERVAL '5 days', NOW() - INTERVAL '5 days')
ON CONFLICT (id) DO NOTHING;

-- Task 7: SLO Dashboard Panel Configuration
INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-otel-t7', 'proj-otel', 'wi-otel-s7', 'task', 'Configure SLO compliance panels in Grafana', 'done', 'high', 'p-021', ARRAY['dashboards','grafana'], NOW() - INTERVAL '10 days', NOW() - INTERVAL '2 days', NOW() - INTERVAL '2 days')
ON CONFLICT (id) DO NOTHING;

-- Task 8: Alert Rule Testing & Validation
INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-otel-t8', 'proj-otel', 'wi-otel-s8', 'task', 'Test SLA violation alerts in staging', 'done', 'high', 'p-005', ARRAY['testing','alerting'], NOW() - INTERVAL '4 days', NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 day')
ON CONFLICT (id) DO NOTHING;

-- Comments for wi-otel-e1 (Epic 1)
INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-otel-1', 'wi-otel-e1', 'p-001', 'We need to ensure the collector can handle 100k+ spans/sec per pod. Should we use batching processors?', false, NOW() - INTERVAL '44 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-otel-2', 'wi-otel-e1', 'p-021', 'Agreed. OTLP batching + compression will reduce egress costs. Plan for <100ms latency to not break real-time queries.', false, NOW() - INTERVAL '43 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-otel-3', 'wi-otel-e1', 'p-005', 'Let''s also track collector CPU/mem usage. If it scales linearly, we may need to shard by tenant.', false, NOW() - INTERVAL '40 days')
ON CONFLICT (id) DO NOTHING;

-- Comments for wi-otel-e2 (Epic 2)
INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-otel-4', 'wi-otel-e2', 'p-005', 'SLO targets: 99.5% availability for API, 99.9% for data pipeline. Need to align with business expectations.', false, NOW() - INTERVAL '39 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-otel-5', 'wi-otel-e2', 'p-021', 'Dashboards should show burn-down of error budget in real-time. Red zone at >10% burn rate.', false, NOW() - INTERVAL '38 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-otel-6', 'wi-otel-e2', 'p-001', 'Consider integrating with PagerDuty for SLA violations. Need escalation policies.', false, NOW() - INTERVAL '37 days')
ON CONFLICT (id) DO NOTHING;

-- Comments for wi-otel-f1 (Feature 1.1)
INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-otel-7', 'wi-otel-f1', 'p-021', 'Collector config should be GitOps-friendly. Helm charts or Kustomize?', false, NOW() - INTERVAL '37 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-otel-8', 'wi-otel-f1', 'p-001', 'Helm 3.12+ with OTLP receiver templates. Let''s support env var substitution for secrets.', false, NOW() - INTERVAL '36 days')
ON CONFLICT (id) DO NOTHING;

-- Comments for wi-otel-f2 (Feature 1.2)
INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-otel-9', 'wi-otel-f2', 'p-001', 'Gateway should use consistent hashing for load balancing to reduce span fragmentation.', false, NOW() - INTERVAL '34 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-otel-10', 'wi-otel-f2', 'p-021', 'Health checks every 5 seconds with exponential backoff. Max retries = 3.', false, NOW() - INTERVAL '33 days')
ON CONFLICT (id) DO NOTHING;

-- Comments for wi-otel-f3 (Feature 2.1)
INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-otel-11', 'wi-otel-f3', 'p-005', 'SLO engine should support both request-based and window-based SLOs.', false, NOW() - INTERVAL '31 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-otel-12', 'wi-otel-f3', 'p-001', 'Use Prometheus exemplars to link SLO violations back to root-cause spans.', false, NOW() - INTERVAL '29 days')
ON CONFLICT (id) DO NOTHING;

-- Comments for wi-otel-f4 (Feature 2.2)
INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-otel-13', 'wi-otel-f4', 'p-021', 'Feature shipped! SLO dashboard now shows real-time error budget burn with predictive SLA.', true, NOW() - INTERVAL '2 days')
ON CONFLICT (id) DO NOTHING;

-- Comments for wi-otel-s1 (Story 1.1)
INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-otel-14', 'wi-otel-s1', 'p-021', 'Multi-transport support done: gRPC on 4317, HTTP on 4318, TCP on custom port. Merged PR #42.', true, NOW() - INTERVAL '8 days')
ON CONFLICT (id) DO NOTHING;

-- Comments for wi-otel-s2 (Story 1.2)
INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-otel-15', 'wi-otel-s2', 'p-001', 'Implementing /health endpoint. Returns JSON with uptime, span count, memory usage.', false, NOW() - INTERVAL '29 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-otel-16', 'wi-otel-s2', 'p-021', 'Good progress. Also add /readiness for K8s startup probes. Blocks on feature flag system.', false, NOW() - INTERVAL '27 days')
ON CONFLICT (id) DO NOTHING;

-- Comments for wi-otel-s3 (Story 1.3)
INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-otel-17', 'wi-otel-s3', 'p-021', 'Token bucket rate limiter under review. Tests at 1M+ req/sec. Pending approval.', true, NOW() - INTERVAL '2 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-otel-18', 'wi-otel-s3', 'p-005', 'Looks good. Make sure to emit metrics for rate limit hits so we can track overloads.', false, NOW() - INTERVAL '1 day')
ON CONFLICT (id) DO NOTHING;

-- Comments for wi-otel-s4 (Story 1.4)
INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-otel-19', 'wi-otel-s4', 'p-001', 'Not yet started. Need to define how to handle cross-cluster span correlation.', false, NOW() - INTERVAL '11 days')
ON CONFLICT (id) DO NOTHING;

-- Comments for wi-otel-s5 (Story 2.1)
INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-otel-20', 'wi-otel-s5', 'p-005', 'Writing PromQL queries for error budget tracking. Using rate() + clamp_max() for burn.', false, NOW() - INTERVAL '24 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-otel-21', 'wi-otel-s5', 'p-001', 'Remember to account for SLO reset windows (weekly). Test in staging first.', false, NOW() - INTERVAL '22 days')
ON CONFLICT (id) DO NOTHING;

-- Comments for wi-otel-s6 (Story 2.2)
INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-otel-22', 'wi-otel-s6', 'p-021', 'Tail-based sampling schema finalized and merged. Now collecting SLO-relevant spans.', true, NOW() - INTERVAL '5 days')
ON CONFLICT (id) DO NOTHING;

-- Comments for wi-otel-s7 (Story 2.3)
INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-otel-23', 'wi-otel-s7', 'p-021', 'SLO compliance dashboard live! Shows burn rate, remaining budget, and service targets. PR #41 merged.', true, NOW() - INTERVAL '2 days')
ON CONFLICT (id) DO NOTHING;

-- Comments for wi-otel-s8 (Story 2.4)
INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-otel-24', 'wi-otel-s8', 'p-005', 'Prometheus alert rules tested and live. Red/yellow zones configured. Merged PR #52.', true, NOW() - INTERVAL '1 day')
ON CONFLICT (id) DO NOTHING;

-- Comments for wi-otel-t1 (Task 1)
INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-otel-25', 'wi-otel-t1', 'p-021', 'Deployed OTEL collector to ECS with full OTLP support. Traffic flowing smoothly.', true, NOW() - INTERVAL '8 days')
ON CONFLICT (id) DO NOTHING;

-- Comments for wi-otel-t2 (Task 2)
INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-otel-26', 'wi-otel-t2', 'p-001', 'Health endpoint in progress. Exposing metrics on /metrics for Prometheus scrape.', false, NOW() - INTERVAL '29 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-otel-27', 'wi-otel-t2', 'p-021', 'Good. Also track last_span_timestamp so we know if collector is stuck.', false, NOW() - INTERVAL '26 days')
ON CONFLICT (id) DO NOTHING;

-- Comments for wi-otel-t3 (Task 3)
INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-otel-28', 'wi-otel-t3', 'p-021', 'Code review: Token bucket algorithm is solid. Minor nits on error messages.', true, NOW() - INTERVAL '2 days')
ON CONFLICT (id) DO NOTHING;

-- Comments for wi-otel-t4 (Task 4)
INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-otel-29', 'wi-otel-t4', 'p-001', 'Drafting routing spec. Need to handle cross-region failover transparently.', false, NOW() - INTERVAL '11 days')
ON CONFLICT (id) DO NOTHING;

-- Comments for wi-otel-t5 (Task 5)
INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-otel-30', 'wi-otel-t5', 'p-005', 'PromQL queries under development. Testing with historical data from last quarter.', false, NOW() - INTERVAL '24 days')
ON CONFLICT (id) DO NOTHING;

-- Comments for wi-otel-t6 (Task 6)
INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-otel-31', 'wi-otel-t6', 'p-021', 'Sampling schema merged. Supports latency, error rate, and custom span attributes.', true, NOW() - INTERVAL '5 days')
ON CONFLICT (id) DO NOTHING;

-- Comments for wi-otel-t7 (Task 7)
INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-otel-32', 'wi-otel-t7', 'p-021', 'Dashboard panels configured and tested. Showing SLO burn, budget, and forecasts.', true, NOW() - INTERVAL '2 days')
ON CONFLICT (id) DO NOTHING;

-- Comments for wi-otel-t8 (Task 8)
INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-otel-33', 'wi-otel-t8', 'p-005', 'SLA violation alerts tested in staging. Triggers correctly on error spikes and latency.', true, NOW() - INTERVAL '1 day')
ON CONFLICT (id) DO NOTHING;

-- Additional cross-cutting comments
INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-otel-34', 'wi-otel-f1', 'p-005', 'Needs cost analysis: how much does this increase egress vs. current approach?', false, NOW() - INTERVAL '20 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-otel-35', 'wi-otel-f3', 'p-021', 'Aligned with platform team on SLO definitions. Ready to integrate with Aurora observability tables.', false, NOW() - INTERVAL '18 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-otel-36', 'wi-otel-e1', 'p-001', 'Considering OpenTelemetry Operator for K8s auto-injection. Would simplify client-side instrumentation.', false, NOW() - INTERVAL '15 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-otel-37', 'wi-otel-e2', 'p-005', 'SLA targets locked in. Now need to communicate to stakeholders and set runbook expectations.', false, NOW() - INTERVAL '12 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-otel-38', 'wi-otel-s2', 'p-001', 'Added internal metrics for debug: span buffer depth, queue latency, dropped spans.', false, NOW() - INTERVAL '8 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-otel-39', 'wi-otel-f2', 'p-001', 'Considering gRPC load balancing policies (round-robin, least-request) for gateway.', false, NOW() - INTERVAL '9 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-otel-40', 'wi-otel-s5', 'p-021', 'SLO burn queries validated against manual calculations. Accuracy: 99.7%.', false, NOW() - INTERVAL '6 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-otel-41', 'wi-otel-f4', 'p-001', 'Dashboard solves a critical visibility gap. Platform teams can now self-serve SLO queries.', false, NOW() - INTERVAL '3 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-otel-42', 'wi-otel-t4', 'p-005', 'Routing spec: need to handle skewed traffic distribution during failover. Game theory approach?', false, NOW() - INTERVAL '8 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-otel-43', 'wi-otel-e1', 'p-021', 'Collector now handles 150k spans/sec without memory leaks. Ready for production load.', false, NOW() - INTERVAL '3 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-otel-44', 'wi-otel-e2', 'p-001', 'End-to-end SLO pipeline is live. Metrics flowing from agents → collector → Prometheus → Grafana.', false, NOW() - INTERVAL '2 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-otel-45', 'wi-otel-f1', 'p-001', 'Next: OTLP Metrics and Logs support. Spans are working great.', false, NOW() - INTERVAL '1 day')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-otel-46', 'wi-otel-f3', 'p-005', 'Error budget reset logic tested. Rolls over correctly at week boundaries.', false, NOW() - INTERVAL '1 day')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-otel-47', 'wi-otel-s4', 'p-001', 'Routing spec v1 complete. Ready for architecture review next sprint.', false, NOW() - INTERVAL '1 hour')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-otel-48', 'wi-otel-t2', 'p-021', 'Readiness check approved. Ready to merge health check PR.', false, NOW() - INTERVAL '1 hour')
ON CONFLICT (id) DO NOTHING;
