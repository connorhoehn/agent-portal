-- proj-cedar: Cedar Auth Policy Migration

INSERT INTO work_items (id, project_id, parent_id, type, title, description, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-cdr-e1', 'proj-cedar', NULL, 'epic', 'Cedar Language Fundamentals & Validator', 'Establish core Cedar language support and build policy validation framework in AWS Verified Permissions', 'in_progress', 'critical', 'p-022', ARRAY['cedar','language','validator','policy-as-code'], NOW() - INTERVAL '90 days', NOW() - INTERVAL '5 days', NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, description, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-cdr-e2', 'proj-cedar', NULL, 'epic', 'RBAC/ABAC Migration & Deny-All Baseline', 'Migrate existing IAM role policies to Cedar; implement deny-all baseline with fine-grained attribute-based controls', 'open', 'critical', 'p-005', ARRAY['rbac','abac','migration','iam','deny-all'], NOW() - INTERVAL '75 days', NOW() - INTERVAL '10 days', NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-cdr-f1', 'proj-cedar', 'wi-cdr-e1', 'feature', 'Cedar Syntax Parser & AST Builder', 'done', 'high', 'p-022', ARRAY['parser','ast','cedar-lang'], NOW() - INTERVAL '80 days', NOW() - INTERVAL '3 days', NOW() - INTERVAL '3 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-cdr-f2', 'proj-cedar', 'wi-cdr-e1', 'feature', 'Policy Simulator & Evaluation Engine', 'in_progress', 'high', 'p-003', ARRAY['simulator','evaluation','bedrock'], NOW() - INTERVAL '70 days', NOW() - INTERVAL '2 days', NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-cdr-f3', 'proj-cedar', 'wi-cdr-e2', 'feature', 'IAM Role to Cedar Policy Translator', 'in_review', 'high', 'p-005', ARRAY['translation','iam','migration'], NOW() - INTERVAL '65 days', NOW() - INTERVAL '1 day', NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-cdr-f4', 'proj-cedar', 'wi-cdr-e2', 'feature', 'Deny-All Baseline & Access Control Framework', 'open', 'critical', 'p-022', ARRAY['deny-all','baseline','access-control'], NOW() - INTERVAL '60 days', NOW() - INTERVAL '7 days', NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, story_points, pr_url, pr_status, labels, created_at, updated_at, completed_at)
VALUES ('wi-cdr-s1', 'proj-cedar', 'wi-cdr-f1', 'story', 'Parse Cedar entity declarations and schemas', 'done', 'high', 'p-022', 8, 'https://github.com/orgiq/cedar-policies/pull/14', 'merged', ARRAY['parser','entity','schema'], NOW() - INTERVAL '78 days', NOW() - INTERVAL '3 days', NOW() - INTERVAL '3 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, story_points, pr_url, pr_status, labels, created_at, updated_at, completed_at)
VALUES ('wi-cdr-s2', 'proj-cedar', 'wi-cdr-f1', 'story', 'Build AST nodes for policy conditions and effects', 'done', 'high', 'p-022', 5, 'https://github.com/orgiq/cedar-policies/pull/15', 'merged', ARRAY['ast','conditions','effects'], NOW() - INTERVAL '76 days', NOW() - INTERVAL '3 days', NOW() - INTERVAL '3 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, story_points, pr_url, pr_status, labels, created_at, updated_at, completed_at)
VALUES ('wi-cdr-s3', 'proj-cedar', 'wi-cdr-f2', 'story', 'Implement request-response evaluation loop', 'in_progress', 'high', 'p-003', 8, 'https://github.com/orgiq/cedar-policies/pull/18', 'open', ARRAY['evaluation','request-response'], NOW() - INTERVAL '68 days', NOW() - INTERVAL '2 days', NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, story_points, pr_url, pr_status, labels, created_at, updated_at, completed_at)
VALUES ('wi-cdr-s4', 'proj-cedar', 'wi-cdr-f2', 'story', 'Policy simulator UI and CLI integration', 'in_progress', 'medium', 'p-003', 13, 'https://github.com/orgiq/cedar-policies/pull/19', 'draft', ARRAY['ui','cli','simulator'], NOW() - INTERVAL '66 days', NOW() - INTERVAL '2 days', NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, story_points, pr_url, pr_status, labels, created_at, updated_at, completed_at)
VALUES ('wi-cdr-s5', 'proj-cedar', 'wi-cdr-f3', 'story', 'Translate S3, EC2, IAM role permissions to Cedar', 'in_review', 'high', 'p-005', 13, 'https://github.com/orgiq/cedar-policies/pull/21', 'open', ARRAY['translation','s3','ec2','iam'], NOW() - INTERVAL '63 days', NOW() - INTERVAL '1 day', NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, story_points, pr_url, pr_status, labels, created_at, updated_at, completed_at)
VALUES ('wi-cdr-s6', 'proj-cedar', 'wi-cdr-f3', 'story', 'Build IAM-to-Cedar mapping tables and lookup service', 'in_review', 'medium', 'p-005', 8, 'https://github.com/orgiq/cedar-policies/pull/22', 'open', ARRAY['mapping','lookup','service'], NOW() - INTERVAL '61 days', NOW() - INTERVAL '1 day', NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, story_points, labels, created_at, updated_at, completed_at)
VALUES ('wi-cdr-s7', 'proj-cedar', 'wi-cdr-f4', 'story', 'Design deny-all default policy framework', 'open', 'critical', 'p-022', 5, ARRAY['design','deny-all','framework'], NOW() - INTERVAL '58 days', NOW() - INTERVAL '8 days', NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, story_points, labels, created_at, updated_at, completed_at)
VALUES ('wi-cdr-s8', 'proj-cedar', 'wi-cdr-f4', 'story', 'Implement attribute-based access control (ABAC) rules', 'open', 'high', 'p-022', 13, ARRAY['abac','attributes','access-control'], NOW() - INTERVAL '56 days', NOW() - INTERVAL '7 days', NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-cdr-t1', 'proj-cedar', 'wi-cdr-s1', 'task', 'Code review Cedar entity schema parsing', 'done', 'high', 'p-003', ARRAY['review','entity'], NOW() - INTERVAL '77 days', NOW() - INTERVAL '3 days', NOW() - INTERVAL '3 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-cdr-t2', 'proj-cedar', 'wi-cdr-s2', 'task', 'Add error recovery to AST builder', 'done', 'medium', 'p-022', ARRAY['error-handling','ast'], NOW() - INTERVAL '75 days', NOW() - INTERVAL '3 days', NOW() - INTERVAL '3 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-cdr-t3', 'proj-cedar', 'wi-cdr-s3', 'task', 'Unit test evaluation with Verified Permissions API', 'in_progress', 'high', 'p-003', ARRAY['testing','api'], NOW() - INTERVAL '67 days', NOW() - INTERVAL '2 days', NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-cdr-t4', 'proj-cedar', 'wi-cdr-s4', 'task', 'Build Web UI for policy test runner', 'in_progress', 'medium', 'p-003', ARRAY['ui','testing'], NOW() - INTERVAL '65 days', NOW() - INTERVAL '2 days', NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-cdr-t5', 'proj-cedar', 'wi-cdr-s5', 'task', 'Map IAM resource ARNs to Cedar entity references', 'in_review', 'high', 'p-005', ARRAY['mapping','iam','entities'], NOW() - INTERVAL '62 days', NOW() - INTERVAL '1 day', NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-cdr-t6', 'proj-cedar', 'wi-cdr-s6', 'task', 'Integration test IAM-to-Cedar migration batch', 'in_review', 'medium', 'p-005', ARRAY['testing','migration'], NOW() - INTERVAL '60 days', NOW() - INTERVAL '1 day', NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-cdr-t7', 'proj-cedar', 'wi-cdr-s7', 'task', 'Document deny-all policy pattern and examples', 'open', 'critical', 'p-022', ARRAY['docs','pattern'], NOW() - INTERVAL '57 days', NOW() - INTERVAL '8 days', NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-cdr-t8', 'proj-cedar', 'wi-cdr-s8', 'task', 'Implement ABAC principal and resource attribute matching', 'open', 'high', 'p-022', ARRAY['attributes','matching'], NOW() - INTERVAL '55 days', NOW() - INTERVAL '7 days', NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-cdr-1', 'wi-cdr-e1', 'p-022', 'Kicking off Cedar fundamentals epic. We need rock-solid parser and validator before we tackle the migration. Let''s target a 2-week sprint.', FALSE, NOW() - INTERVAL '89 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-cdr-2', 'wi-cdr-e1', 'p-005', 'Aligned with leadership. Cedar is the strategic policy language. This is our foundation.', FALSE, NOW() - INTERVAL '88 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-cdr-3', 'wi-cdr-e2', 'p-005', 'Epic for the deny-all baseline and ABAC layer. We can''t ship this until the fundamentals are proven in QA.', FALSE, NOW() - INTERVAL '74 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-cdr-4', 'wi-cdr-e2', 'p-022', 'Agreed. The deny-all baseline is security critical. We need reviews from security and compliance before we go live.', FALSE, NOW() - INTERVAL '73 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-cdr-5', 'wi-cdr-f1', 'p-022', 'Parser work is flowing smoothly. Cedar''s grammar is cleaner than I expected. We can reuse Rust bindings from AWS.', FALSE, NOW() - INTERVAL '77 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-cdr-6', 'wi-cdr-f1', 'p-003', 'Great. We should also add lexer tests for the entity attribute syntax to catch edge cases early.', FALSE, NOW() - INTERVAL '75 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-cdr-7', 'wi-cdr-f2', 'p-003', 'The simulator is crucial for policy validation. I''m integrating Verified Permissions API calls now. Latency is acceptable (~100ms per eval).', FALSE, NOW() - INTERVAL '68 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-cdr-8', 'wi-cdr-f2', 'p-022', 'Can we batch the requests if we have 100+ test cases? That would speed up the CLI runner.', FALSE, NOW() - INTERVAL '67 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-cdr-9', 'wi-cdr-f2', 'p-003', 'Already planned for story wi-cdr-s4. We can batch up to 10 policies per request safely.', FALSE, NOW() - INTERVAL '66 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-cdr-10', 'wi-cdr-f3', 'p-005', 'The IAM translation layer is the hardest part. Resource ARNs don''t map 1:1 to Cedar entity types. We need a mapping table and some heuristics.', FALSE, NOW() - INTERVAL '63 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-cdr-11', 'wi-cdr-f3', 'p-022', 'Have you looked at the Verified Permissions roadmap for auto-translation? Could save us weeks.', FALSE, NOW() - INTERVAL '62 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-cdr-12', 'wi-cdr-f3', 'p-005', 'It''s on the backlog, but not GA yet. We need to own the translation logic for now. The mapping table approach is solid and portable.', FALSE, NOW() - INTERVAL '61 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-cdr-13', 'wi-cdr-f4', 'p-022', 'This is the security boundary. Deny-all baseline means every access decision starts at DENY unless explicitly allowed. No exceptions.', FALSE, NOW() - INTERVAL '59 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-cdr-14', 'wi-cdr-f4', 'p-005', 'Agreed. We also need to make sure the attribute system in Cedar is flexible enough for team membership, clearance levels, and time-based constraints.', FALSE, NOW() - INTERVAL '58 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-cdr-15', 'wi-cdr-s1', 'p-022', 'Entity schema parser is ready for review. Handles nested attributes and type validation.', FALSE, NOW() - INTERVAL '77 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-cdr-16', 'wi-cdr-s1', 'p-003', 'PR looked good. Merged and deployed to dev.', FALSE, NOW() - INTERVAL '76 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-cdr-17', 'wi-cdr-s2', 'p-022', 'AST for policy conditions is complete. Added error recovery to handle malformed Cedar gracefully.', FALSE, NOW() - INTERVAL '75 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-cdr-18', 'wi-cdr-s3', 'p-003', 'Plugging in the Verified Permissions IsAuthorized API. The latency is good; we can handle production traffic.', FALSE, NOW() - INTERVAL '66 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-cdr-19', 'wi-cdr-s3', 'p-022', 'What about error handling if VP service is down?', FALSE, NOW() - INTERVAL '65 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-cdr-20', 'wi-cdr-s3', 'p-003', 'Fallback to cached policy store. Blocks new requests until service recovers. That''s covered in the fault-tolerance design doc.', FALSE, NOW() - INTERVAL '64 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-cdr-21', 'wi-cdr-s4', 'p-003', 'UI mockups are ready. Test runner can load policies from a JSON file or Verified Permissions policy store. Draft PR is up for feedback.', FALSE, NOW() - INTERVAL '65 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-cdr-22', 'wi-cdr-s4', 'p-022', 'Can the UI show a diff between the old IAM policy and the new Cedar policy for debugging migrations?', FALSE, NOW() - INTERVAL '64 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-cdr-23', 'wi-cdr-s4', 'p-003', 'Great idea. I''ll add a side-by-side viewer in the next commit. That will help with compliance audits too.', FALSE, NOW() - INTERVAL '63 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-cdr-24', 'wi-cdr-s5', 'p-005', 'IAM permission translator is mostly done. S3, EC2, and IAM policies are fully mapped. Need to test against production policies before merging.', FALSE, NOW() - INTERVAL '62 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-cdr-25', 'wi-cdr-s5', 'p-022', 'Are we handling NotAction and Condition wildcards correctly?', FALSE, NOW() - INTERVAL '61 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-cdr-26', 'wi-cdr-s5', 'p-005', 'Yes, but NotAction is tricky in Cedar. We translate it to an explicit deny list for clarity. The design doc has examples.', FALSE, NOW() - INTERVAL '60 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-cdr-27', 'wi-cdr-s6', 'p-005', 'Lookup service is in code review. Maps ARN patterns to Cedar entity schemas on the fly. Performance is O(1) with LRU cache.', FALSE, NOW() - INTERVAL '60 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-cdr-28', 'wi-cdr-s6', 'p-003', 'PR looks solid. The cache strategy is smart. Approved.', FALSE, NOW() - INTERVAL '59 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-cdr-29', 'wi-cdr-s7', 'p-022', 'Starting the deny-all framework design. This is the security-critical path. Need stakeholder review before implementation.', FALSE, NOW() - INTERVAL '57 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-cdr-30', 'wi-cdr-s7', 'p-005', 'Agreed. I''ll set up a security review meeting with the Infosec team. Timeline is tight but doable.', FALSE, NOW() - INTERVAL '56 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-cdr-31', 'wi-cdr-s8', 'p-022', 'ABAC is next. We need to model team membership, clearance levels, and time windows in Cedar.', FALSE, NOW() - INTERVAL '55 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-cdr-32', 'wi-cdr-s8', 'p-005', 'I have some attribute definitions from the security audit. Will share them in the design doc.', FALSE, NOW() - INTERVAL '54 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-cdr-33', 'wi-cdr-t1', 'p-003', 'Code review completed. Entity parsing is clean and well-tested.', FALSE, NOW() - INTERVAL '76 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-cdr-34', 'wi-cdr-t2', 'p-022', 'AST error recovery is complete. Tested against malformed Cedar policies.', FALSE, NOW() - INTERVAL '74 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-cdr-35', 'wi-cdr-t3', 'p-003', 'Testing the Verified Permissions API integration. Latency and correctness look good so far.', FALSE, NOW() - INTERVAL '66 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-cdr-36', 'wi-cdr-t4', 'p-003', 'Web UI for the policy test runner is taking shape. Added the policy diff viewer for migrations.', FALSE, NOW() - INTERVAL '64 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-cdr-37', 'wi-cdr-t5', 'p-005', 'ARN-to-entity mapping is in code review. Handles all major AWS services.', FALSE, NOW() - INTERVAL '61 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-cdr-38', 'wi-cdr-t6', 'p-005', 'Integration tests for migration batches are passing. Ready for QA.', FALSE, NOW() - INTERVAL '59 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-cdr-39', 'wi-cdr-t7', 'p-022', 'Starting deny-all documentation. Will include patterns, examples, and anti-patterns.', FALSE, NOW() - INTERVAL '56 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-cdr-40', 'wi-cdr-t8', 'p-022', 'ABAC attribute matching is starting. First pass will handle team membership and clearance levels.', FALSE, NOW() - INTERVAL '54 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-cdr-41', 'wi-cdr-e1', 'p-022', 'Feature 1 and 2 are complete. The parser and simulator are solid. Ready to unblock the migration work.', FALSE, NOW() - INTERVAL '4 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-cdr-42', 'wi-cdr-e2', 'p-005', 'Feature 3 is in final review. Feature 4 starts next week. We''re on track for Q2 release.', FALSE, NOW() - INTERVAL '3 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-cdr-43', 'wi-cdr-f1', 'p-022', 'Parser work wrapped. Both stories are done. We can start canary testing with real org policies.', FALSE, NOW() - INTERVAL '3 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-cdr-44', 'wi-cdr-s1', 'p-022', 'Deployed to production. Entity parsing is now live in the Verified Permissions policy editor.', FALSE, NOW() - INTERVAL '3 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-cdr-45', 'wi-cdr-s2', 'p-022', 'AST builder is also in production. Error messages are now clearer for policy authors.', FALSE, NOW() - INTERVAL '3 days')
ON CONFLICT (id) DO NOTHING;
