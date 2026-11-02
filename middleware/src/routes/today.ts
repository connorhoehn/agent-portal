// GET /api/today — the footer's Today strip, read from the rows the pages read.
//
// The strip used to render five fixed "Demo" samples (portal footerTodayModel
// TODAY_SAMPLES: "2 agent drafts need your decision", "Daily budget · 20% used
// ($829)") beside pages that said otherwise — Budgets read "$10.22 spent this
// period" under a footer claiming $829 (docs/demo-content-audit.md X4). Each
// item here is a selector over the same provider the page behind it calls:
//
//   review      lab consults still pending  (Work › Inbox, providers/lab.ts listConsults)
//   automation  the agent computers this session may see (the fleet page, devbox-visibility)
//   budget      this month's spend against allocations (Budgets, providers/budgets.ts orgSummary),
//               only for the roles the Budgets read gate admits
//
// Work only for now; another tenant answers no items and the strip stays
// hidden rather than inventing a figure. Read-only, signed-in, no-store.

import { Router, type Request } from 'express';
import { asyncHandler } from '../lib/async-handler.js';
import { isAllowed, resolveSession } from '../lib/authz.js';
import { listConsults } from '../providers/lab.js';
import { listBoxes } from '../lib/devbox-fleet.js';
import { visibleBoxes } from '../lib/devbox-visibility.js';
import { orgSummary } from '../providers/budgets.js';
import { findInitiative } from '../mock/initiatives.js';
import { config } from '../config.js';

export interface TodayItem {
  category: 'review' | 'automation' | 'budget';
  label: string;
  summary: string;
  detail: string;
  action?: { label: string; href: string };
}

/** The roles the Budgets page's read gate admits without ManageBudgets (routes/budgets.ts readGate). */
const BUDGET_READ_ROLES = new Set(['admin', 'org-leader', 'hr-admin', 'program-owner']);

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const usd = (n: number): string => `$${n.toFixed(2)}`;

async function initiativeName(id: string | null): Promise<string | null> {
  if (!id) return null;
  if (config.mock.aurora) return findInitiative(id)?.name ?? null;
  return null;
}

async function reviewItem(): Promise<TodayItem> {
  const pending = await listConsults({ status: 'pending', limit: 50 });
  if (pending.length === 0) {
    return { category: 'review', label: 'Needs review', summary: 'Nothing is waiting on a person',
      detail: 'No agent run is waiting for an answer right now.' };
  }
  const first = pending[0]!;
  const where = await initiativeName(first.initiativeId);
  return {
    category: 'review', label: 'Needs review',
    summary: `${plural(pending.length, 'agent question')} waiting for an answer`,
    detail: `${where ? `${where}: ` : ''}${first.question}`,
    action: { label: 'Open question', href: `/iq/work?consult=${encodeURIComponent(first.id)}` },
  };
}

async function automationItem(req: Request): Promise<TodayItem | null> {
  const boxes = await visibleBoxes(req.session ?? null, listBoxes());
  if (boxes.length === 0) return null;
  const count = (status: string) => boxes.filter((b) => b.status === status).length;
  const running = count('running'), waiting = count('waiting'), idle = count('idle');
  return {
    category: 'automation', label: 'Automation',
    summary: `${plural(boxes.length, 'agent computer')} · ${running} running · ${waiting} waiting`,
    detail: `${plural(running, 'computer')} working, ${waiting} waiting for a person and ${idle} idle, out of the ${plural(boxes.length, 'computer')} you can see.`,
    action: { label: 'View runs', href: '/iq/work/queue' },
  };
}

async function budgetItem(): Promise<TodayItem> {
  const s = await orgSummary();
  const pct = s.totalAllocatedUsd > 0 ? Math.round((s.totalSpentThisPeriodUsd / s.totalAllocatedUsd) * 100) : null;
  return {
    category: 'budget', label: 'Budget',
    summary: `${usd(s.totalSpentThisPeriodUsd)} of ${usd(s.totalAllocatedUsd)} spent this month${pct === null ? '' : ` (${pct}%)`}`,
    detail: `Agent spend this month across every initiative, ${usd(s.totalMaintenanceUsd)} of it scheduled maintenance, against the allocations on the Budgets page.`,
    action: { label: 'View budgets', href: '/admin/budgets' },
  };
}

export const todayRouter: Router = Router();

todayRouter.get('/', asyncHandler(async (req, res) => {
  const session = resolveSession(req);
  if (!session) { res.status(401).json({ error: 'Sign in first' }); return; }
  res.set('Cache-Control', 'no-store');
  if (session.tenant !== 'orgiq') { res.json({ items: [] }); return; }
  const mayReadBudget = BUDGET_READ_ROLES.has(session.role)
    || await isAllowed({ sub: session.sub, tenant: session.tenant, role: session.role }, 'ManageBudgets');
  const [review, automation, budget] = await Promise.all([
    reviewItem().catch(() => null),
    automationItem(req).catch(() => null),
    mayReadBudget ? budgetItem().catch(() => null) : Promise.resolve(null),
  ]);
  res.json({ items: [review, automation, budget].filter((i): i is TodayItem => i !== null) });
}));
