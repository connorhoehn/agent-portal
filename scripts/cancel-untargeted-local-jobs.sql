-- Cancel legacy local:* jobs that name no machine.
--
-- Since the local-compute targeting fix (docs/next-steps.md section 8,
-- package 6) both enqueue routes refuse a `local:*` job without a nodeId the
-- caller owns, and the worker claim query (providers/agent-jobs.ts
-- `claimNextJobForWorker`) hands out only jobs whose payload.nodeId names the
-- asking machine. A row queued before that names no machine, so nothing will
-- ever claim it: it sits in `queued` looking like pending work. This cancels
-- those rows, the same write `cancelJob` makes. Claimed and running rows are
-- left alone; they are already on a machine and finish or get reaped.
--
-- Safe to re-run: it touches only queued, untargeted local rows. Look first:
--
--   SELECT id, kind, title, created_by, created_at FROM agent_jobs
--    WHERE kind LIKE 'local:%' AND status = 'queued'
--      AND COALESCE(payload->>'nodeId', '') = '';
--
-- Apply with psql (psql -f scripts/cancel-untargeted-local-jobs.sql) or the
-- RDS Data API (aws rds-data execute-statement ... --sql "$(cat <this file>)").

UPDATE agent_jobs
   SET status = 'cancelled', finished_at = NOW(), updated_at = NOW()
 WHERE kind LIKE 'local:%'
   AND status = 'queued'
   AND COALESCE(payload->>'nodeId', '') = ''
RETURNING id, kind, title;
