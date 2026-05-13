// Test-fixture utilities for E2E specs.
//
// These endpoints exist solely to make Playwright specs idempotent — every
// run starts from a known state. Mounted ungated (same as harness/approvals
// since the specs run before any session is established) and gated on
// process.env.NODE_ENV !== 'production' to keep them off prod deployments.
//
// NOT a general-purpose admin surface. Each endpoint resets exactly what
// one or two specs need; the bodies are intentionally narrow.

import { Router } from 'express';
import { asyncHandler } from '../lib/async-handler.js';
import { exec } from '../providers/aurora.js';

export const testFixturesRouter = Router();

function isProd(): boolean {
  return process.env['NODE_ENV'] === 'production';
}

// POST /api/observability/test-fixtures/reset-approvals
// Returns both seeded approvals (`tx-smoke-001`, `tx-demo-002`) to PENDING
// and clears any decision audit rows. Used by the approval E2E specs.
testFixturesRouter.post('/reset-approvals', asyncHandler(async (_req, res) => {
  if (isProd()) {
    res.status(403).json({ error: 'forbidden in production' });
    return;
  }
  try {
    await exec('DELETE FROM observability.approval_decisions', []);
    await exec(
      `UPDATE observability.approvals
          SET status = 'PENDING',
              decided_at = NULL,
              decided_by = NULL,
              decided_note = NULL`,
      [],
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'reset failed', detail: (err as Error).message });
  }
}));

// POST /api/observability/test-fixtures/refresh-seed-timestamps
// Slides seed trace rows (`prompt_snippet LIKE 'seed:%'`) into the last 1h
// so drift outliers / quality endpoints with short windows have rows.
testFixturesRouter.post('/refresh-seed-timestamps', asyncHandler(async (_req, res) => {
  if (isProd()) {
    res.status(403).json({ error: 'forbidden in production' });
    return;
  }
  try {
    // Spread across 6h so the drift time-series chart has buckets to plot,
    // not just one cluster. 6h matches the 'medium' window the drift UI uses
    // by default after the WindowPicker work.
    const result = await exec(
      `UPDATE observability.invocation_traces
          SET ts = now() - (random() * INTERVAL '6 hours')
        WHERE prompt_snippet LIKE 'seed:%'`,
      [],
    );
    res.json({ ok: true, rowsAffected: result.length });
  } catch (err) {
    res.status(500).json({ error: 'refresh failed', detail: (err as Error).message });
  }
}));
