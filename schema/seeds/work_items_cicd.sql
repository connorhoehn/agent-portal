-- proj-cicd: CI/CD Pipeline Unification

INSERT INTO work_items (id, project_id, parent_id, type, title, description, status, priority, assignee_id, labels, created_at, updated_at, completed_at) VALUES ('wi-ccd-e1', 'proj-cicd', NULL, 'epic', 'GitHub Actions Migration & Standardization', 'Migrate all legacy CI systems to GitHub Actions with standardized workflows, secrets management, and branch protection. Establish org-wide CI/CD best practices and enforce approval gates across all repositories.', 'in_progress', 'critical', 'p-005', ARRAY['github-actions','migration','ci/cd'], NOW() - INTERVAL '90 days', NOW() - INTERVAL '5 days', NULL) ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, description, status, priority, assignee_id, labels, created_at, updated_at, completed_at) VALUES ('wi-ccd-e2', 'proj-cicd', NULL, 'epic', 'Container & Artifact Pipeline Optimization', 'Streamline Docker image builds, implement layer caching, optimize artifact storage in S3, and establish multi-region deployment infrastructure. Reduce build times by 50% and improve artifact lifecycle management.', 'in_progress', 'high', 'p-005', ARRAY['docker','artifacts','optimization'], NOW() - INTERVAL '85 days', NOW() - INTERVAL '3 days', NULL) ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at) VALUES ('wi-ccd-f1', 'proj-cicd', 'wi-ccd-e1', 'feature', 'Secrets & OIDC Federation Setup', 'in_progress', 'critical', 'p-022', ARRAY['security','oidc','secrets'], NOW() - INTERVAL '80 days', NOW() - INTERVAL '10 days', NULL) ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at) VALUES ('wi-ccd-f2', 'proj-cicd', 'wi-ccd-e1', 'feature', 'Branch Protection & Approval Workflows', 'done', 'high', 'p-002', ARRAY['branch-protection','workflow','governance'], NOW() - INTERVAL '75 days', NOW() - INTERVAL '1 days', NOW() - INTERVAL '1 days') ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at) VALUES ('wi-ccd-f3', 'proj-cicd', 'wi-ccd-e2', 'feature', 'Docker Layer Caching & Multi-Stage Builds', 'in_progress', 'high', 'p-003', ARRAY['docker','performance','caching'], NOW() - INTERVAL '70 days', NOW() - INTERVAL '7 days', NULL) ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at) VALUES ('wi-ccd-f4', 'proj-cicd', 'wi-ccd-e2', 'feature', 'Multi-Region Artifact Distribution', 'open', 'medium', 'p-005', ARRAY['deployment','s3','regions'], NOW() - INTERVAL '60 days', NOW() - INTERVAL '15 days', NULL) ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, created_at, updated_at, completed_at) VALUES ('wi-ccd-s1', 'proj-cicd', 'wi-ccd-f1', 'story', 'Configure AWS OIDC provider for GitHub Actions', 'in_progress', 'critical', 'p-022', ARRAY['aws','oidc','setup'], 5, NOW() - INTERVAL '78 days', NOW() - INTERVAL '2 days', NULL) ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, created_at, updated_at, completed_at) VALUES ('wi-ccd-s2', 'proj-cicd', 'wi-ccd-f1', 'story', 'Migrate secrets from GitHub to AWS Secrets Manager', 'done', 'high', 'p-022', ARRAY['secrets','migration','aws'], 8, NOW() - INTERVAL '76 days', NOW() - INTERVAL '1 days', NOW() - INTERVAL '1 days') ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, created_at, updated_at, completed_at) VALUES ('wi-ccd-s3', 'proj-cicd', 'wi-ccd-f2', 'story', 'Enforce branch protection rules on main', 'done', 'critical', 'p-002', ARRAY['branch-protection','governance'], 3, NOW() - INTERVAL '73 days', NOW() - INTERVAL '2 days', NOW() - INTERVAL '2 days') ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, created_at, updated_at, completed_at) VALUES ('wi-ccd-s4', 'proj-cicd', 'wi-ccd-f2', 'story', 'Implement required approval workflow for prod deployments', 'done', 'high', 'p-002', ARRAY['workflow','approval','prod'], 5, NOW() - INTERVAL '71 days', NOW() - INTERVAL '3 days', NOW() - INTERVAL '3 days') ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, created_at, updated_at, completed_at) VALUES ('wi-ccd-s5', 'proj-cicd', 'wi-ccd-f3', 'story', 'Build Docker image layer caching strategy', 'in_progress', 'high', 'p-003', ARRAY['docker','caching','strategy'], 5, NOW() - INTERVAL '68 days', NOW() - INTERVAL '4 days', NULL) ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, created_at, updated_at, completed_at) VALUES ('wi-ccd-s6', 'proj-cicd', 'wi-ccd-f3', 'story', 'Update Dockerfile to use multi-stage builds', 'in_review', 'high', 'p-003', ARRAY['docker','builds','refactor'], 8, NOW() - INTERVAL '65 days', NOW() - INTERVAL '1 days', NULL) ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, created_at, updated_at, completed_at) VALUES ('wi-ccd-s7', 'proj-cicd', 'wi-ccd-f4', 'story', 'Design multi-region artifact sync mechanism', 'open', 'medium', 'p-005', ARRAY['s3','deployment','design'], 5, NOW() - INTERVAL '58 days', NOW() - INTERVAL '20 days', NULL) ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, created_at, updated_at, completed_at) VALUES ('wi-ccd-s8', 'proj-cicd', 'wi-ccd-f4', 'story', 'Implement S3 cross-region replication for artifacts', 'open', 'medium', 'p-003', ARRAY['s3','replication','infra'], 8, NOW() - INTERVAL '55 days', NOW() - INTERVAL '22 days', NULL) ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at) VALUES ('wi-ccd-t1', 'proj-cicd', 'wi-ccd-s1', 'task', 'Create IAM role for GitHub OIDC', 'in_progress', 'critical', 'p-022', ARRAY['iam','aws'], NOW() - INTERVAL '76 days', NOW() - INTERVAL '1 days', NULL) ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at) VALUES ('wi-ccd-t2', 'proj-cicd', 'wi-ccd-s2', 'task', 'Audit and migrate all stored GitHub secrets', 'done', 'high', 'p-022', ARRAY['secrets','audit'], NOW() - INTERVAL '74 days', NOW() - INTERVAL '2 days', NOW() - INTERVAL '2 days') ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at) VALUES ('wi-ccd-t3', 'proj-cicd', 'wi-ccd-s3', 'task', 'Configure require_code_owner_reviews setting', 'done', 'critical', 'p-002', ARRAY['branch-protection'], NOW() - INTERVAL '71 days', NOW() - INTERVAL '3 days', NOW() - INTERVAL '3 days') ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at) VALUES ('wi-ccd-t4', 'proj-cicd', 'wi-ccd-s4', 'task', 'Create prod deployment approval action', 'done', 'high', 'p-002', ARRAY['workflow','github-actions'], NOW() - INTERVAL '69 days', NOW() - INTERVAL '4 days', NOW() - INTERVAL '4 days') ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at) VALUES ('wi-ccd-t5', 'proj-cicd', 'wi-ccd-s5', 'task', 'Document caching best practices', 'in_review', 'high', 'p-003', ARRAY['docker','docs'], NOW() - INTERVAL '66 days', NOW() - INTERVAL '2 days', NULL) ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at) VALUES ('wi-ccd-t6', 'proj-cicd', 'wi-ccd-s6', 'task', 'Refactor Dockerfile for production services', 'in_review', 'high', 'p-003', ARRAY['docker','prod'], NOW() - INTERVAL '63 days', NOW() - INTERVAL '2 days', NULL) ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at) VALUES ('wi-ccd-t7', 'proj-cicd', 'wi-ccd-s7', 'task', 'Design S3 bucket sync strategy', 'open', 'medium', 'p-005', ARRAY['s3','design'], NOW() - INTERVAL '56 days', NOW() - INTERVAL '25 days', NULL) ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at) VALUES ('wi-ccd-t8', 'proj-cicd', 'wi-ccd-s8', 'task', 'Implement CloudFront CDN for artifact distribution', 'open', 'medium', 'p-003', ARRAY['cdn','infra'], NOW() - INTERVAL '53 days', NOW() - INTERVAL '28 days', NULL) ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at) VALUES ('wic-ccd-1', 'wi-ccd-e1', 'p-005', 'Kicking off the GitHub Actions migration. We need this to be org-wide before Q3. Let''s target 80% coverage by end of June.', FALSE, NOW() - INTERVAL '88 days') ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at) VALUES ('wic-ccd-2', 'wi-ccd-e1', 'p-002', 'I''ve reviewed the migration plan. The OIDC federation part will be critical for reducing secret sprawl. Sophie''s taking point on that.', FALSE, NOW() - INTERVAL '87 days') ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at) VALUES ('wic-ccd-3', 'wi-ccd-e1', 'p-022', 'Security sign-off: we must enforce OIDC federation for all GitHub Actions workflows. No more long-lived secrets.', FALSE, NOW() - INTERVAL '85 days') ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at) VALUES ('wic-ccd-4', 'wi-ccd-e2', 'p-005', 'Container optimization is our fast-follow. Once GitHub Actions is stable, we tackle Docker build times.', FALSE, NOW() - INTERVAL '83 days') ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at) VALUES ('wic-ccd-5', 'wi-ccd-e2', 'p-003', 'Multi-stage Dockerfile will cut our build times in half. I''ve already prototyped this in the infra repo.', FALSE, NOW() - INTERVAL '82 days') ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at) VALUES ('wic-ccd-6', 'wi-ccd-f1', 'p-022', 'Starting OIDC setup. Need to create the IAM role and provider config first.', FALSE, NOW() - INTERVAL '77 days') ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at) VALUES ('wic-ccd-7', 'wi-ccd-f1', 'p-022', 'OIDC provider is live. Now migrating all GH secrets to Secrets Manager.', FALSE, NOW() - INTERVAL '70 days') ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at) VALUES ('wic-ccd-8', 'wi-ccd-f2', 'p-002', 'Branch protection rules are critical before we merge anything else. Blocking on this for main.', FALSE, NOW() - INTERVAL '72 days') ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at) VALUES ('wic-ccd-9', 'wi-ccd-f2', 'p-002', 'Rules enforced on main. Two code owner approvals required. Approval workflow added to prod gate.', FALSE, NOW() - INTERVAL '68 days') ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at) VALUES ('wic-ccd-10', 'wi-ccd-f3', 'p-003', 'Starting layer caching design. We can save ~60% build time by leveraging GitHub Actions cache action.', FALSE, NOW() - INTERVAL '66 days') ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at) VALUES ('wic-ccd-11', 'wi-ccd-f3', 'p-003', 'Drafted multi-stage Dockerfile for the core platform service. Ready for review. See PR #142.', FALSE, NOW() - INTERVAL '64 days') ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at) VALUES ('wic-ccd-12', 'wi-ccd-f4', 'p-005', 'Backlog item for now. Pushing to next sprint after docker work is done.', FALSE, NOW() - INTERVAL '59 days') ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at) VALUES ('wic-ccd-13', 'wi-ccd-s1', 'p-022', 'Created IAM role with correct trust policy for GitHub repo. Testing OIDC token exchange.', FALSE, NOW() - INTERVAL '74 days') ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at) VALUES ('wic-ccd-14', 'wi-ccd-s1', 'p-022', 'Testing OIDC token in a test workflow. Everything looks good. Story on track for completion next week.', FALSE, NOW() - INTERVAL '70 days') ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at) VALUES ('wic-ccd-15', 'wi-ccd-s2', 'p-022', 'Completed full audit of secrets. 47 secrets migrated to Secrets Manager. Removed all from GitHub.', FALSE, NOW() - INTERVAL '72 days') ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at) VALUES ('wic-ccd-16', 'wi-ccd-s3', 'p-002', 'Branch protection rules applied. Main now requires two approvals and passing status checks.', FALSE, NOW() - INTERVAL '70 days') ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at) VALUES ('wic-ccd-17', 'wi-ccd-s4', 'p-002', 'Prod approval workflow merged and deployed. Teams can now use manual environment approval step.', FALSE, NOW() - INTERVAL '68 days') ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at) VALUES ('wic-ccd-18', 'wi-ccd-s5', 'p-003', 'Drafted caching best practices doc. Uses GitHub Actions cache with dependency hash.', FALSE, NOW() - INTERVAL '65 days') ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at) VALUES ('wic-ccd-19', 'wi-ccd-s5', 'p-003', 'Doc is ready for team review. Link in PR #141. Waiting on feedback before finalizing.', FALSE, NOW() - INTERVAL '62 days') ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at) VALUES ('wic-ccd-20', 'wi-ccd-s6', 'p-003', 'Refactored Dockerfile with 3 stages: builder, runner, final. Cuts image size by 65%.', FALSE, NOW() - INTERVAL '62 days') ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at) VALUES ('wic-ccd-21', 'wi-ccd-s6', 'p-002', 'Looks solid. Verified build times on my machine: dropped from 8m to 3m 15s. Approving.', FALSE, NOW() - INTERVAL '59 days') ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at) VALUES ('wic-ccd-22', 'wi-ccd-s7', 'p-005', 'Thinking about Lambda-based sync vs. native S3 replication. Need to model cost/latency tradeoff.', FALSE, NOW() - INTERVAL '57 days') ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at) VALUES ('wic-ccd-23', 'wi-ccd-s8', 'p-003', 'Started CloudFront integration. Need to set up origin access control and cache behavior policies.', FALSE, NOW() - INTERVAL '52 days') ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at) VALUES ('wic-ccd-24', 'wi-ccd-t1', 'p-022', 'IAM role created with GitHub OIDC provider as trusted entity. Testing now.', FALSE, NOW() - INTERVAL '75 days') ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at) VALUES ('wic-ccd-25', 'wi-ccd-t2', 'p-022', 'All 47 secrets successfully migrated. GitHub Actions workflows updated to fetch from AWS Secrets Manager.', FALSE, NOW() - INTERVAL '71 days') ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at) VALUES ('wic-ccd-26', 'wi-ccd-t3', 'p-002', 'Config updated. CODEOWNERS file synced. Branch protection enforced on main.', FALSE, NOW() - INTERVAL '69 days') ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at) VALUES ('wic-ccd-27', 'wi-ccd-t4', 'p-002', 'Custom approval action deployed to prod. Requires manual trigger before deployment proceeds.', FALSE, NOW() - INTERVAL '67 days') ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at) VALUES ('wic-ccd-28', 'wi-ccd-t5', 'p-003', 'Best practices doc covers github.com/actions/cache usage, key strategies, and hit rate optimization.', FALSE, NOW() - INTERVAL '64 days') ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at) VALUES ('wic-ccd-29', 'wi-ccd-t6', 'p-003', 'Multi-stage Dockerfile complete. Base image reduced from 1.2GB to 420MB. Build parallelized across stages.', FALSE, NOW() - INTERVAL '61 days') ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at) VALUES ('wic-ccd-30', 'wi-ccd-t7', 'p-005', 'Comparing native S3 cross-region replication vs. EventBridge + Lambda sync. Native replication cheaper.', FALSE, NOW() - INTERVAL '55 days') ON CONFLICT (id) DO NOTHING;
