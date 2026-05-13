// Wide audit: visit every observability page, screenshot, capture console
// errors, and assert minimum content renders. Failures here surface bugs
// you wouldn't catch with single-page targeted specs.

import { test, expect } from '@playwright/test';

const SHOT_DIR = 'e2e-shots/audit';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  // Masquerade as hr-admin so every observability page is reachable (some
  // are gated to hr-admin only).
  await page.evaluate(async () => {
    await fetch('/api/session/role', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ role: 'hr-admin' }),
    });
  });
  await page.request.post('/api/observability/test-fixtures/refresh-seed-timestamps').catch(() => null);
});

interface PageDef {
  path: string;
  name: string;
  // Strings expected to render somewhere on the page.
  expects: string[];
}

const PAGES: PageDef[] = [
  { path: 'oncall',                label: '', name: 'oncall',          expects: ['On-Call', /alarm|alert|signal/i.source] },
  { path: 'summary',               label: '', name: 'summary',         expects: [/invocation|24h|errors/i.source] },
  { path: 'traffic',               label: '', name: 'traffic',         expects: ['Traffic', /RPS|invocations/i.source] },
  { path: 'invocations',           label: '', name: 'recent',          expects: [/agent|recent|invocation/i.source] },
  { path: 'invocations/search',    label: '', name: 'invocation-search', expects: ['Search', /Search prompt/i.source] },
  { path: 'capability-events',     label: '', name: 'capability-events', expects: [/event|browser|code/i.source] },
  { path: 'agents',                label: '', name: 'agent-metrics',   expects: [/agent|metric|invocation/i.source] },
  { path: 'sessions',              label: '', name: 'sessions',        expects: [/session|thread/i.source] },
  { path: 'authz',                 label: '', name: 'authz',           expects: [/decision|role|action/i.source] },
  { path: 'memory',                label: '', name: 'memory',          expects: [/Memory|retrieve|write/i.source] },
  { path: 'guardrail-rules',       label: '', name: 'guardrail-rules', expects: [/Guardrail|rule/i.source] },
  { path: 'drift',                 label: '', name: 'drift',           expects: ['Drift', /rollup|outlier|template/i.source] },
  { path: 'quality',               label: '', name: 'quality',         expects: [/judge|quality|score/i.source] },
  { path: 'cost',                  label: '', name: 'cost',            expects: ['Cost', /per-agent|spend|invocation/i.source] },
  { path: 'approvals',             label: '', name: 'approvals',       expects: [/approval|pending|HITL/i.source] },
  { path: 'harness',               label: '', name: 'harness',         expects: [/Test Harness|cases|run/i.source] },
  { path: 'calibration',           label: '', name: 'calibration',     expects: [/Calibration|MAE|judge/i.source] },
  { path: 'model-compare',         label: '', name: 'model-compare',   expects: [/Compare|model|run/i.source] },
];

for (const p of PAGES) {
  test(`page: ${p.name}`, async ({ page }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => { pageErrors.push(err.message); });

    await page.goto(`/observability/${p.path}`, { waitUntil: 'domcontentloaded' });
    // Give async data a moment to land
    await page.waitForTimeout(2_500);

    // Capture
    await page.screenshot({ path: `${SHOT_DIR}/${p.name}.png`, fullPage: true });

    // Console errors should be empty (warnings ok)
    expect.soft(consoleErrors, `console errors on ${p.name}`).toEqual([]);
    expect.soft(pageErrors, `unhandled exceptions on ${p.name}`).toEqual([]);

    // At least one expected substring renders
    let found = false;
    for (const e of p.expects) {
      try {
        const re = new RegExp(e, 'i');
        const c = await page.getByText(re).count();
        if (c > 0) { found = true; break; }
      } catch {/* skip */}
    }
    expect.soft(found, `none of ${p.expects.join(', ')} visible on ${p.name}`).toBeTruthy();
  });
}

// Trace-chain bug probe: pick a known parent-linked invocation and confirm
// the InvocationDetail page renders both parent + child cleanly. If this
// fails, the trace-tree fetch / render has a bug.
test('invocation detail: trace chain renders parent when DB has one', async ({ page, request }) => {
  // Find any invocation that DOES have a parent_invocation_id set.
  // Use the search endpoint which can filter — but it may not have a
  // parent filter. Fall back: query 50 recent + pick one whose row has parent.
  const res = await request.get('/api/observability/invocations/search?limit=50');
  if (!res.ok()) test.skip();
  const body = await res.json();
  const candidates = (body.invocations ?? []).filter(
    (i: { parentInvocationId?: string | null }) => !!i.parentInvocationId,
  );
  if (candidates.length === 0) test.skip();
  const sample = candidates[0];

  await page.goto(`/observability/invocations/${sample.invocationId}`);
  await page.waitForTimeout(2_500);
  await page.screenshot({ path: `${SHOT_DIR}/invocation-with-parent.png`, fullPage: true });

  // Should NOT say "no recorded parent or child" — that's the bug.
  const empty = await page.getByText(/no recorded parent or child/i).count();
  expect(empty, 'Trace chain showed empty state despite parent in DB').toBe(0);
});
