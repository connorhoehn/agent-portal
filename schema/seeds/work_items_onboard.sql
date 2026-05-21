-- proj-onboard: Developer Onboarding Improvements

INSERT INTO work_items (id, project_id, parent_id, type, title, description, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-obd-e1', 'proj-onboard', NULL, 'epic', 'Knowledge Base & Documentation Standardization', 'Establish a comprehensive, searchable knowledge base with standardized documentation formats for runbooks, architecture decisions, and common troubleshooting steps.', 'planning', 'high', 'p-005', ARRAY['documentation','knowledge-base','dxp']::TEXT[], NOW() - INTERVAL '90 days', NOW() - INTERVAL '80 days', NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, description, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-obd-e2', 'proj-onboard', NULL, 'epic', 'Developer Environment & Onboarding Workflows', 'Automate environment setup, create interactive onboarding checklists, and establish a mentorship buddy system for new hires.', 'planning', 'high', 'p-005', ARRAY['dev-environment','automation','buddy-system']::TEXT[], NOW() - INTERVAL '85 days', NOW() - INTERVAL '75 days', NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-obd-f1', 'proj-onboard', 'wi-obd-e1', 'feature', 'Runbook Repository & Search', 'open', 'high', 'p-009', ARRAY['documentation','runbooks','search']::TEXT[], NOW() - INTERVAL '75 days', NOW() - INTERVAL '70 days', NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-obd-f2', 'proj-onboard', 'wi-obd-e1', 'feature', 'Internal Glossary & Terminology Standard', 'open', 'medium', 'p-009', ARRAY['documentation','glossary','standards']::TEXT[], NOW() - INTERVAL '70 days', NOW() - INTERVAL '65 days', NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-obd-f3', 'proj-onboard', 'wi-obd-e2', 'feature', 'Automated Dev Environment Setup', 'in_progress', 'high', 'p-003', ARRAY['automation','dev-environment','scripting']::TEXT[], NOW() - INTERVAL '60 days', NOW() - INTERVAL '15 days', NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-obd-f4', 'proj-onboard', 'wi-obd-e2', 'feature', 'Interactive Onboarding Checklist & Buddy System', 'planning', 'high', 'p-005', ARRAY['onboarding','mentorship','workflow']::TEXT[], NOW() - INTERVAL '55 days', NOW() - INTERVAL '50 days', NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, created_at, updated_at, completed_at)
VALUES ('wi-obd-s1', 'proj-onboard', 'wi-obd-f1', 'story', 'Design runbook template and versioning scheme', 'done', 'high', 'p-009', ARRAY['documentation','design']::TEXT[], 5, NOW() - INTERVAL '72 days', NOW() - INTERVAL '50 days', NOW() - INTERVAL '50 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, created_at, updated_at, completed_at)
VALUES ('wi-obd-s2', 'proj-onboard', 'wi-obd-f1', 'story', 'Build runbook search index with Elasticsearch integration', 'in_review', 'high', 'p-003', ARRAY['search','backend','elasticsearch']::TEXT[], 8, NOW() - INTERVAL '65 days', NOW() - INTERVAL '8 days', NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, created_at, updated_at, completed_at)
VALUES ('wi-obd-s3', 'proj-onboard', 'wi-obd-f2', 'story', 'Compile technical acronyms and internal terminology', 'open', 'medium', 'p-009', ARRAY['documentation','glossary']::TEXT[], 3, NOW() - INTERVAL '68 days', NOW() - INTERVAL '60 days', NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, created_at, updated_at, completed_at)
VALUES ('wi-obd-s4', 'proj-onboard', 'wi-obd-f2', 'story', 'Create glossary wiki with collaborative editing', 'open', 'medium', 'p-009', ARRAY['documentation','wiki','frontend']::TEXT[], 8, NOW() - INTERVAL '62 days', NOW() - INTERVAL '60 days', NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, created_at, updated_at, completed_at)
VALUES ('wi-obd-s5', 'proj-onboard', 'wi-obd-f3', 'story', 'Create Docker compose stack for local dev environment', 'in_progress', 'high', 'p-003', ARRAY['dev-environment','docker','automation']::TEXT[], 13, NOW() - INTERVAL '58 days', NOW() - INTERVAL '10 days', NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, created_at, updated_at, completed_at)
VALUES ('wi-obd-s6', 'proj-onboard', 'wi-obd-f3', 'story', 'Write setup guide and troubleshoot common issues', 'done', 'high', 'p-009', ARRAY['documentation','troubleshooting']::TEXT[], 5, NOW() - INTERVAL '52 days', NOW() - INTERVAL '40 days', NOW() - INTERVAL '40 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, created_at, updated_at, completed_at)
VALUES ('wi-obd-s7', 'proj-onboard', 'wi-obd-f4', 'story', 'Design onboarding checklist workflow and milestone tracking', 'open', 'high', 'p-005', ARRAY['onboarding','ux','workflow']::TEXT[], 8, NOW() - INTERVAL '48 days', NOW() - INTERVAL '48 days', NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, created_at, updated_at, completed_at)
VALUES ('wi-obd-s8', 'proj-onboard', 'wi-obd-f4', 'story', 'Implement buddy pairing algorithm and mentor portal', 'open', 'high', 'p-005', ARRAY['onboarding','mentorship','backend']::TEXT[], 13, NOW() - INTERVAL '45 days', NOW() - INTERVAL '45 days', NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-obd-t1', 'proj-onboard', 'wi-obd-s1', 'task', 'Gather input from 5 senior engineers on runbook best practices', 'done', 'high', 'p-009', ARRAY['documentation','collaboration']::TEXT[], NOW() - INTERVAL '70 days', NOW() - INTERVAL '52 days', NOW() - INTERVAL '52 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-obd-t2', 'proj-onboard', 'wi-obd-s2', 'task', 'Implement Elasticsearch query parser and ranking heuristics', 'in_review', 'high', 'p-003', ARRAY['search','backend','elasticsearch']::TEXT[], NOW() - INTERVAL '62 days', NOW() - INTERVAL '12 days', NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-obd-t3', 'proj-onboard', 'wi-obd-s3', 'task', 'Audit all company docs for undefined terms and collect definitions', 'open', 'medium', 'p-009', ARRAY['documentation','glossary']::TEXT[], NOW() - INTERVAL '65 days', NOW() - INTERVAL '60 days', NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-obd-t4', 'proj-onboard', 'wi-obd-s4', 'task', 'Build wiki frontend with real-time collaborative editing using CRDTs', 'open', 'medium', 'p-009', ARRAY['frontend','wiki','realtime']::TEXT[], NOW() - INTERVAL '60 days', NOW() - INTERVAL '60 days', NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-obd-t5', 'proj-onboard', 'wi-obd-s5', 'task', 'Build docker compose with all dev dependencies (Postgres, Redis, Minio)', 'in_progress', 'high', 'p-003', ARRAY['dev-environment','docker']::TEXT[], NOW() - INTERVAL '55 days', NOW() - INTERVAL '12 days', NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-obd-t6', 'proj-onboard', 'wi-obd-s6', 'task', 'Create video walkthrough and FAQ for common setup failures', 'done', 'high', 'p-009', ARRAY['documentation','video','onboarding']::TEXT[], NOW() - INTERVAL '50 days', NOW() - INTERVAL '38 days', NOW() - INTERVAL '38 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-obd-t7', 'proj-onboard', 'wi-obd-s7', 'task', 'Design UX mockups for onboarding dashboard and milestone tracker', 'open', 'high', 'p-005', ARRAY['ux','design','onboarding']::TEXT[], NOW() - INTERVAL '46 days', NOW() - INTERVAL '46 days', NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-obd-t8', 'proj-onboard', 'wi-obd-s8', 'task', 'Implement mentor-mentee matching based on skills and timezone overlap', 'open', 'high', 'p-005', ARRAY['backend','onboarding','algorithm']::TEXT[], NOW() - INTERVAL '42 days', NOW() - INTERVAL '42 days', NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-obd-1', 'wi-obd-e1', 'p-005', 'Let''s start by understanding what documentation already exists across the org. Suggest we do an audit first to avoid duplication.', FALSE, NOW() - INTERVAL '88 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-obd-2', 'wi-obd-e1', 'p-009', 'I can lead the audit. I''ll also compile a list of markdown style recommendations based on what we''re already using.', FALSE, NOW() - INTERVAL '86 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-obd-3', 'wi-obd-e1', 'p-003', 'Good idea. We should also consider version control for runbooks — old versions might be useful as historical context.', FALSE, NOW() - INTERVAL '82 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-obd-4', 'wi-obd-e2', 'p-005', 'High priority: new onboards spend 4 days just getting their env set up. Let''s automate that down to 30 minutes.', FALSE, NOW() - INTERVAL '80 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-obd-5', 'wi-obd-e2', 'p-003', 'Agree. We also need a buddy system so devs aren''t just reading docs alone. Pair them up on day 1.', FALSE, NOW() - INTERVAL '78 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-obd-6', 'wi-obd-f1', 'p-009', 'Should we use GitHub wiki, Confluence, or something custom? Open to suggestions.', FALSE, NOW() - INTERVAL '73 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-obd-7', 'wi-obd-f1', 'p-003', 'GitHub wiki is limiting. Confluence is better for discovery, but Opensearch + custom UI gives us the most control. Let''s go that route.', FALSE, NOW() - INTERVAL '71 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-obd-8', 'wi-obd-f1', 'p-005', 'Custom UI is fine as long as onboarding is included in the main portal. I don''t want devs context-switching to a separate tool.', FALSE, NOW() - INTERVAL '68 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-obd-9', 'wi-obd-f2', 'p-009', 'The glossary should be auto-linked in runbooks. If a term is undefined, docs editors get a hint.', FALSE, NOW() - INTERVAL '66 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-obd-10', 'wi-obd-f2', 'p-005', 'Good UX. Let''s also support multiple definitions per term (e.g., "API" in different contexts) so we''re not oversimplifying.', FALSE, NOW() - INTERVAL '64 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-obd-11', 'wi-obd-f3', 'p-003', 'I''ve drafted a docker-compose.yml that includes postgres, redis, and minio. Just need to test it on a fresh M1 Mac.', FALSE, NOW() - INTERVAL '56 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-obd-12', 'wi-obd-f3', 'p-005', 'Let''s also create an optional "advanced" variant with observability stack (jaeger, prometheus) for devs who want it.', FALSE, NOW() - INTERVAL '54 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-obd-13', 'wi-obd-f3', 'p-003', 'Will do. Also adding health-check scripts so devs know when the stack is ready.', FALSE, NOW() - INTERVAL '52 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-obd-14', 'wi-obd-f4', 'p-005', 'For the buddy system, I''m thinking: seniority + skill overlap + timezone. Pair for first 30 days.', FALSE, NOW() - INTERVAL '50 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-obd-15', 'wi-obd-f4', 'p-003', 'Also need a structured feedback loop: mentee rates mentor, mentor rates mentee. Helps us improve the matching algorithm.', FALSE, NOW() - INTERVAL '48 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-obd-16', 'wi-obd-s1', 'p-009', 'Talked to Sarah, Mike, Chen, Aisha, and Priya. Consensus: runbooks should include pre-req checklist, quick start, troubleshooting tree, and rollback plan.', FALSE, NOW() - INTERVAL '68 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-obd-17', 'wi-obd-s1', 'p-005', 'Excellent. Can you draft a template by end of week?', FALSE, NOW() - INTERVAL '66 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-obd-18', 'wi-obd-s1', 'p-009', 'Done. See runbook-template-v1.md in the docs repo.', FALSE, NOW() - INTERVAL '55 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-obd-19', 'wi-obd-s2', 'p-003', 'Built the search index. Query parser handles fuzzy matching and field-specific search (title:, tag:, author:). Still testing ranking.', FALSE, NOW() - INTERVAL '58 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-obd-20', 'wi-obd-s2', 'p-009', 'Can you run this on the current runbooks and share some example queries? I want to make sure the UX is intuitive.', FALSE, NOW() - INTERVAL '55 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-obd-21', 'wi-obd-s2', 'p-003', 'Will do. Also opened PR #47 with the implementation. Feedback welcome.', FALSE, NOW() - INTERVAL '50 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-obd-22', 'wi-obd-s3', 'p-009', 'Scanning all our docs now. Found ~200 undefined terms so far. Organizing by domain.', FALSE, NOW() - INTERVAL '62 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-obd-23', 'wi-obd-s3', 'p-005', 'Great. Once you have the draft, let''s review with the architecture team so we get the deep technical terms right.', FALSE, NOW() - INTERVAL '59 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-obd-24', 'wi-obd-s4', 'p-009', 'Using Yjs for real-time collab. Will also add version history so teams can see edit trails.', FALSE, NOW() - INTERVAL '57 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-obd-25', 'wi-obd-s4', 'p-005', 'Perfect. This will encourage docs-as-code culture. Pair review on glossary entries?', FALSE, NOW() - INTERVAL '55 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-obd-26', 'wi-obd-s5', 'p-003', 'docker-compose up is now 2 minutes. All services healthy check passing. Testing on ARM64 next.', FALSE, NOW() - INTERVAL '48 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-obd-27', 'wi-obd-s5', 'p-005', 'Excellent progress. Any blockers?', FALSE, NOW() - INTERVAL '45 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-obd-28', 'wi-obd-s5', 'p-003', 'Minio is consuming too much RAM on resource-constrained machines. Investigating alternatives or documentation workarounds.', FALSE, NOW() - INTERVAL '42 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-obd-29', 'wi-obd-s6', 'p-009', 'FAQ live: covers 12 common failures (Docker daemon, port conflicts, network issues, volume perms). Video coming next week.', FALSE, NOW() - INTERVAL '45 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-obd-30', 'wi-obd-s6', 'p-005', 'Video is gold. Share it in the onboarding email and welcome channel.', FALSE, NOW() - INTERVAL '40 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-obd-31', 'wi-obd-s7', 'p-005', 'Mockups show: welcome dashboard, day-by-day checklist, milestone badges, buddy chat. Feedback?', FALSE, NOW() - INTERVAL '44 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-obd-32', 'wi-obd-s7', 'p-009', 'Love the milestone badges. I''d add a "ask question" button on each checklist item so they can tag their buddy.', FALSE, NOW() - INTERVAL '42 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-obd-33', 'wi-obd-s7', 'p-003', 'Good idea. Also link to relevant runbooks and glossary terms from within the checklist items.', FALSE, NOW() - INTERVAL '40 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-obd-34', 'wi-obd-s8', 'p-005', 'Starting the algorithm design. Factors: skill tags (backend, frontend, devops), seniority, timezone offset, previous mentoring success.', FALSE, NOW() - INTERVAL '40 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-obd-35', 'wi-obd-s8', 'p-003', 'Consider: do not pair people who sit next to each other (they can collaborate organically). Force some cross-team pairing for knowledge spread.', FALSE, NOW() - INTERVAL '38 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-obd-36', 'wi-obd-t1', 'p-009', 'Quick coffee with each of them. All agreed on the four-section template. No pushback.', FALSE, NOW() - INTERVAL '66 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-obd-37', 'wi-obd-t2', 'p-003', 'PR #47 is ready for review. BM25 ranking working well. Query latency under 200ms even on large runbook sets.', FALSE, NOW() - INTERVAL '48 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-obd-38', 'wi-obd-t2', 'p-009', 'Performance looks good. Can you add stopword filtering and synonym expansion?', FALSE, NOW() - INTERVAL '45 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-obd-39', 'wi-obd-t2', 'p-003', 'Added both. Also now handling common abbreviations (e.g., "db" -> "database", "api" -> "application programming interface").', FALSE, NOW() - INTERVAL '35 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-obd-40', 'wi-obd-t3', 'p-009', 'Sent glossary audit to backend and frontend teams. Waiting for their input on domain-specific terms.', FALSE, NOW() - INTERVAL '58 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-obd-41', 'wi-obd-t4', 'p-009', 'Yjs backend connected. Testing collaborative edits on test server. Will need to add permissions (editor, commenter, viewer).', FALSE, NOW() - INTERVAL '52 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-obd-42', 'wi-obd-t5', 'p-003', 'All services up and healthy. docker-compose.yml is in the onboarding-infra repo. Next: package as bootstrap script.', FALSE, NOW() - INTERVAL '46 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-obd-43', 'wi-obd-t6', 'p-009', 'Recorded 6-min walkthrough covering: clone repo, run docker-compose, run tests, navigate IDE. Posted to YouTube (unlisted).', FALSE, NOW() - INTERVAL '42 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-obd-44', 'wi-obd-t6', 'p-005', 'Excellent. Can you share the link in the onboarding doc template so new hires see it immediately?', FALSE, NOW() - INTERVAL '39 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-obd-45', 'wi-obd-t7', 'p-005', 'Iterated on mockups based on feedback. Key additions: buddy live chat, daily standup prompts, progress tracking.', FALSE, NOW() - INTERVAL '40 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-obd-46', 'wi-obd-t7', 'p-009', 'Love the standup prompts. Reduces cognitive load for mentees on what to ask.', FALSE, NOW() - INTERVAL '37 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-obd-47', 'wi-obd-t8', 'p-005', 'Sketched the matching algorithm. Prototype running on sample data. Need to validate with historical pairing data.', FALSE, NOW() - INTERVAL '36 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-obd-48', 'wi-obd-t8', 'p-003', 'Do you have access to onboarding feedback from last cohort? That could improve the model.', FALSE, NOW() - INTERVAL '34 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-obd-49', 'wi-obd-t8', 'p-005', 'I do. Will compile the data and send it over. Expecting it to improve match quality by 15–20%.', FALSE, NOW() - INTERVAL '32 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at)
VALUES ('wic-obd-50', 'wi-obd-e1', 'p-005', 'This epic is progressing well. Both features are on track. Let''s aim to launch the MVP runbook portal by Q2 end.', FALSE, NOW() - INTERVAL '30 days')
ON CONFLICT (id) DO NOTHING;
