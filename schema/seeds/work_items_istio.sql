-- proj-istio: Istio Service Mesh Migration
-- 2 epics, 4 features, 8 stories, 8 tasks, ~50 comments

INSERT INTO work_items (id, project_id, parent_id, type, title, description, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-ist-e1', 'proj-istio', NULL, 'epic', 'Sidecar Injection & mTLS Foundation', 'Establish automatic sidecar injection, configure mutual TLS across all workloads, and harden the control plane to prevent unauthorized data plane access. Includes namespace-scoped injection policies and per-namespace certificate rotation.', 'in_progress', 'critical', 'p-001', ARRAY['infrastructure','security','mvp'], NOW() - INTERVAL '90 days', NOW() - INTERVAL '5 days', NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, description, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-ist-e2', 'proj-istio', NULL, 'epic', 'Traffic Management & Observability', 'Implement VirtualService routing policies, DestinationRule traffic shaping, circuit breaker tuning, and comprehensive telemetry via Prometheus + Kiali dashboards. Enable blue-green deployments and canary rollouts.', 'open', 'high', 'p-004', ARRAY['observability','traffic-management','release-engineering'], NOW() - INTERVAL '60 days', NOW() - INTERVAL '45 days', NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-ist-f1', 'proj-istio', 'wi-ist-e1', 'feature', 'Automatic Sidecar Injection & Namespace Labels', 'done', 'critical', 'p-001', ARRAY['sidecar','injection'], NOW() - INTERVAL '85 days', NOW() - INTERVAL '15 days', NOW() - INTERVAL '15 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-ist-f2', 'proj-istio', 'wi-ist-e1', 'feature', 'mTLS Configuration & Policy Enforcement', 'in_progress', 'critical', 'p-022', ARRAY['mtls','security','policy'], NOW() - INTERVAL '75 days', NOW() - INTERVAL '3 days', NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-ist-f3', 'proj-istio', 'wi-ist-e2', 'feature', 'VirtualService & DestinationRule Rollout', 'in_review', 'high', 'p-004', ARRAY['traffic-management','routing'], NOW() - INTERVAL '50 days', NOW() - INTERVAL '2 days', NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-ist-f4', 'proj-istio', 'wi-ist-e2', 'feature', 'Kiali & Prometheus Integration', 'open', 'high', 'p-004', ARRAY['observability','monitoring'], NOW() - INTERVAL '40 days', NOW() - INTERVAL '40 days', NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, created_at, updated_at, completed_at)
VALUES ('wi-ist-s1', 'proj-istio', 'wi-ist-f1', 'story', 'Enable istio-injection label on production namespace', 'done', 'critical', 'p-001', ARRAY['label','namespace'], 5, NOW() - INTERVAL '80 days', NOW() - INTERVAL '18 days', NOW() - INTERVAL '18 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, created_at, updated_at, completed_at)
VALUES ('wi-ist-s2', 'proj-istio', 'wi-ist-f1', 'story', 'Verify sidecar injection on all existing pods', 'done', 'critical', 'p-001', ARRAY['validation','testing'], 8, NOW() - INTERVAL '72 days', NOW() - INTERVAL '12 days', NOW() - INTERVAL '12 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, created_at, updated_at, completed_at)
VALUES ('wi-ist-s3', 'proj-istio', 'wi-ist-f2', 'story', 'Configure PERMISSIVE mTLS mode cluster-wide', 'in_progress', 'critical', 'p-022', ARRAY['mtls','policy'], 8, NOW() - INTERVAL '70 days', NOW() - INTERVAL '4 days', NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, created_at, updated_at, completed_at)
VALUES ('wi-ist-s4', 'proj-istio', 'wi-ist-f2', 'story', 'Implement PeerAuthentication policies for STRICT mode', 'in_progress', 'high', 'p-022', ARRAY['mtls','policy','security'], 13, NOW() - INTERVAL '65 days', NOW() - INTERVAL '3 days', NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, created_at, updated_at, completed_at)
VALUES ('wi-ist-s5', 'proj-istio', 'wi-ist-f3', 'story', 'Migrate core services to VirtualService & DestinationRule', 'in_review', 'high', 'p-004', ARRAY['routing','migration'], 13, NOW() - INTERVAL '45 days', NOW() - INTERVAL '2 days', NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, created_at, updated_at, completed_at)
VALUES ('wi-ist-s6', 'proj-istio', 'wi-ist-f3', 'story', 'Implement circuit breaker & outlier detection', 'open', 'high', 'p-004', ARRAY['resilience','traffic-management'], 8, NOW() - INTERVAL '40 days', NOW() - INTERVAL '40 days', NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, created_at, updated_at, completed_at)
VALUES ('wi-ist-s7', 'proj-istio', 'wi-ist-f4', 'story', 'Deploy Kiali dashboard and configure RBAC', 'open', 'medium', 'p-004', ARRAY['observability','dashboard'], 8, NOW() - INTERVAL '35 days', NOW() - INTERVAL '35 days', NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, created_at, updated_at, completed_at)
VALUES ('wi-ist-s8', 'proj-istio', 'wi-ist-f4', 'story', 'Wire Prometheus scrape for Envoy metrics', 'open', 'medium', 'p-004', ARRAY['observability','prometheus'], 5, NOW() - INTERVAL '32 days', NOW() - INTERVAL '32 days', NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-ist-t1', 'proj-istio', 'wi-ist-s1', 'task', 'Update kube-system and monitoring namespace labels', 'done', 'critical', 'p-001', ARRAY['label','automation'], NOW() - INTERVAL '78 days', NOW() - INTERVAL '20 days', NOW() - INTERVAL '20 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-ist-t2', 'proj-istio', 'wi-ist-s2', 'task', 'Create pod readiness check for sidecar presence', 'done', 'critical', 'p-001', ARRAY['validation','testing'], NOW() - INTERVAL '70 days', NOW() - INTERVAL '14 days', NOW() - INTERVAL '14 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-ist-t3', 'proj-istio', 'wi-ist-s3', 'task', 'Apply PeerAuthentication with PERMISSIVE mode', 'in_progress', 'critical', 'p-022', ARRAY['mtls','config'], NOW() - INTERVAL '68 days', NOW() - INTERVAL '5 days', NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-ist-t4', 'proj-istio', 'wi-ist-s4', 'task', 'Write AuthorizationPolicy for service-to-service', 'in_progress', 'high', 'p-022', ARRAY['policy','security'], NOW() - INTERVAL '63 days', NOW() - INTERVAL '4 days', NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-ist-t5', 'proj-istio', 'wi-ist-s5', 'task', 'Refactor payment service routing with VirtualService', 'in_review', 'high', 'p-004', ARRAY['routing','payment'], NOW() - INTERVAL '42 days', NOW() - INTERVAL '1 day', NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-ist-t6', 'proj-istio', 'wi-ist-s6', 'task', 'Tune Envoy outlier detection thresholds', 'open', 'high', 'p-004', ARRAY['resilience','tuning'], NOW() - INTERVAL '38 days', NOW() - INTERVAL '38 days', NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-ist-t7', 'proj-istio', 'wi-ist-s7', 'task', 'Configure Kiali service account and ClusterRole', 'open', 'medium', 'p-004', ARRAY['rbac','security'], NOW() - INTERVAL '33 days', NOW() - INTERVAL '33 days', NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-ist-t8', 'proj-istio', 'wi-ist-s8', 'task', 'Add Prometheus ServiceMonitor for istio-proxy targets', 'open', 'medium', 'p-004', ARRAY['observability','prometheus'], NOW() - INTERVAL '30 days', NOW() - INTERVAL '30 days', NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-ist-1', 'wi-ist-e1', 'p-001', 'Kicking off the sidecar injection phase. All namespaces need the istio-injection label applied before we can move to STRICT mTLS.', FALSE, NOW() - INTERVAL '88 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-ist-2', 'wi-ist-e1', 'p-022', 'Security review: need to ensure no uninjected workloads remain. Will pair with Alex on the validation strategy.', FALSE, NOW() - INTERVAL '82 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-ist-3', 'wi-ist-e1', 'p-009', 'Starting docs for sidecar injection troubleshooting. Link: https://github.com/orgiq/istio-migration/blob/main/docs/sidecar-injection.md', FALSE, NOW() - INTERVAL '78 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-ist-4', 'wi-ist-f1', 'p-001', 'Feature complete. All production pods now have envoy sidecars injected. Ready for mTLS rollout.', FALSE, NOW() - INTERVAL '16 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-ist-5', 'wi-ist-f2', 'p-022', 'Currently applying PERMISSIVE mode cluster-wide. Will test with staging workloads before flipping to STRICT.', FALSE, NOW() - INTERVAL '64 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-ist-6', 'wi-ist-f2', 'p-001', 'Need to finalize the certificate rotation strategy. Titan is handling cert issuance, but we need automated renewal hooks in the data plane.', FALSE, NOW() - INTERVAL '58 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-ist-7', 'wi-ist-f2', 'p-022', 'AuthorizationPolicy draft is almost ready. Blocking on API server audit logs to validate deny paths. Checking with security ops.', FALSE, NOW() - INTERVAL '5 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-ist-8', 'wi-ist-s1', 'p-001', 'All production namespaces now labeled. Verified no injection-blocked deployments remain.', FALSE, NOW() - INTERVAL '19 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-ist-9', 'wi-ist-s2', 'p-001', 'Readiness check deployed to all clusters. Caught 3 init container ordering bugs in the process.', FALSE, NOW() - INTERVAL '13 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-ist-10', 'wi-ist-s3', 'p-022', 'PeerAuthentication applied to production cluster. All pod-to-pod comms now encrypted. Zero traffic drop observed.', FALSE, NOW() - INTERVAL '6 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-ist-11', 'wi-ist-s4', 'p-022', 'Draft PR for AuthorizationPolicy. Testing deny rules in staging to catch any overly restrictive policies before prod.', FALSE, NOW() - INTERVAL '3 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-ist-12', 'wi-ist-s5', 'p-004', 'Payment service migration to VirtualService complete. Blue-green traffic splitting working, canary tests passing.', FALSE, NOW() - INTERVAL '1 day')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-ist-13', 'wi-ist-s6', 'p-004', 'Outlier detection tuning in progress. Need to balance between fast failover and preventing flapping. Will run shadow mode for 2 weeks.', FALSE, NOW() - INTERVAL '7 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-ist-14', 'wi-ist-s7', 'p-004', 'Kiali RBAC complete. Dashboard now enforces view-only for developers and full access for platform team.', FALSE, NOW() - INTERVAL '8 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-ist-15', 'wi-ist-s8', 'p-004', 'Prometheus scrape config added. Envoy metrics now flowing into the telemetry stack. CPU overhead is < 1%.', FALSE, NOW() - INTERVAL '6 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-ist-16', 'wi-ist-t1', 'p-001', 'Labels applied via Helm chart automation. Easy rollback if needed.', FALSE, NOW() - INTERVAL '21 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-ist-17', 'wi-ist-t2', 'p-001', 'Readiness probe integrated into base pod spec. Catches injection failures before traffic lands.', FALSE, NOW() - INTERVAL '15 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-ist-18', 'wi-ist-t3', 'p-022', 'PeerAuthentication manifest applied. Workloads now reject any unencrypted traffic (PERMISSIVE mode allows old clients).', FALSE, NOW() - INTERVAL '4 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-ist-19', 'wi-ist-t4', 'p-022', 'AuthorizationPolicy PR up for review. Allows user→svc, svc→svc, denies admin-only endpoints. Need security sign-off.', FALSE, NOW() - INTERVAL '2 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-ist-20', 'wi-ist-t5', 'p-004', 'Payment VirtualService deployed. Subset routing to v1 & v2 working. Will merge after canary metrics settle.', FALSE, NOW() - INTERVAL '1 day')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-ist-21', 'wi-ist-t6', 'p-004', 'Started tuning Envoy outlier detection. Current settings: 5 consecutive errors over 30s triggers eject. Monitoring the impact.', FALSE, NOW() - INTERVAL '10 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-ist-22', 'wi-ist-t7', 'p-004', 'Kiali SA and ClusterRole created. Developers can now view the service mesh from the dashboard.', FALSE, NOW() - INTERVAL '9 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-ist-23', 'wi-ist-t8', 'p-004', 'ServiceMonitor for istio-proxy scraped. Envoy metrics (xds_grpc_connections, cluster_manager_cluster_added, etc.) visible in Prometheus.', FALSE, NOW() - INTERVAL '7 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-ist-24', 'wi-ist-e2', 'p-004', 'Traffic management epic underway. High priority: blue-green deployments and canary rollouts for safer releases.', FALSE, NOW() - INTERVAL '58 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-ist-25', 'wi-ist-f3', 'p-004', 'VirtualService rollout hitting some edge cases with subset selectors. Working through them in staging before merging.', FALSE, NOW() - INTERVAL '42 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-ist-26', 'wi-ist-f4', 'p-004', 'Kiali deployment in progress. RBAC is the main blocker — finalizing roles for platform vs. developer access levels.', FALSE, NOW() - INTERVAL '36 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-ist-27', 'wi-ist-f4', 'p-009', 'Adding Kiali & Prometheus docs to the runbook. Screenshots and troubleshooting guides ready.', FALSE, NOW() - INTERVAL '28 days')
ON CONFLICT (id) DO NOTHING;
