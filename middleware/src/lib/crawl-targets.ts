// Persisted store of named crawl targets. Targets can be on-demand (cronExpr
// null / disabled) or scheduled (cron.validate-checked expression). Pattern
// mirrors `ingest-scheduler.ts` — JSON file persistence + in-memory list +
// node-cron task registry. When a cron fires, we kick off a crawl via
// `startCrawl({ ..., targetId, scheduleId })` and record the run on the target.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import cron from 'node-cron';
import type { CrawlTarget, CrawlSession } from './crawler-types.js';
import { startCrawl } from './crawler.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TARGETS_FILE = resolve(__dirname, '../../crawl-targets.json');

const tasks = new Map<string, cron.ScheduledTask>();
let targets: CrawlTarget[] = [];

function persist(): void {
  try {
    writeFileSync(TARGETS_FILE, JSON.stringify(targets, null, 2), 'utf8');
  } catch (err) {
    console.warn('[crawl-targets] persist failed:', (err as Error).message);
  }
}

function unregisterTask(id: string): void {
  const existing = tasks.get(id);
  if (existing) {
    try { existing.stop(); } catch { /* best effort */ }
    tasks.delete(id);
  }
}

function registerTask(t: CrawlTarget): void {
  unregisterTask(t.id);
  if (!t.enabled || !t.cronExpr || !cron.validate(t.cronExpr)) return;
  const task = cron.schedule(t.cronExpr, async () => {
    console.log(`[crawl-targets] firing ${t.id} "${t.label}"`);
    try {
      // Pull the latest snapshot of the target — it may have been mutated since
      // the task was registered.
      const current = targets.find(x => x.id === t.id);
      if (!current || !current.enabled) return;
      const session = await startCrawl({
        startUrl: current.startUrl,
        maxPages: current.maxPages,
        mode: current.mode,
        includePattern: current.includePattern ?? undefined,
        sameOriginOnly: current.sameOriginOnly,
        label: current.label,
        targetId: current.id,
        scheduleId: current.id,
      } as Parameters<typeof startCrawl>[0]);
      recordTargetRun(current.id, session.id, session.status);
    } catch (err) {
      console.warn('[crawl-targets] cron run failed:', (err as Error).message);
    }
  }, { scheduled: true, timezone: 'UTC' });
  tasks.set(t.id, task);
}

export function initCrawlTargets(): void {
  if (existsSync(TARGETS_FILE)) {
    try {
      const parsed = JSON.parse(readFileSync(TARGETS_FILE, 'utf8')) as CrawlTarget[];
      targets = Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      console.warn('[crawl-targets] failed to parse store, starting empty:', (err as Error).message);
      targets = [];
    }
  }
  for (const t of targets) registerTask(t);
  console.log(`[crawl-targets] loaded ${targets.length} target(s)`);
}

export function listCrawlTargets(): CrawlTarget[] {
  return targets;
}

export function getCrawlTarget(id: string): CrawlTarget | null {
  return targets.find(t => t.id === id) ?? null;
}

export function addCrawlTarget(
  input: Omit<CrawlTarget, 'id' | 'createdAt' | 'lastRunId' | 'lastRunAt' | 'lastStatus' | 'nextRunAt'>,
): CrawlTarget {
  if (input.cronExpr && !cron.validate(input.cronExpr)) {
    throw new Error(`Invalid cron expression: ${input.cronExpr}`);
  }
  const t: CrawlTarget = {
    ...input,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    lastRunId: null,
    lastRunAt: null,
    lastStatus: null,
    nextRunAt: null, // cron-parser not available; UI tolerates null
  };
  targets.push(t);
  persist();
  registerTask(t);
  return t;
}

export function updateCrawlTarget(id: string, patch: Partial<CrawlTarget>): CrawlTarget | null {
  const idx = targets.findIndex(t => t.id === id);
  if (idx === -1) return null;
  const current = targets[idx]!;
  // Don't allow id / createdAt to be overwritten.
  const next: CrawlTarget = {
    ...current,
    ...patch,
    id: current.id,
    createdAt: current.createdAt,
  };
  if (next.cronExpr && !cron.validate(next.cronExpr)) {
    throw new Error(`Invalid cron expression: ${next.cronExpr}`);
  }
  targets[idx] = next;
  persist();
  registerTask(next);
  return next;
}

export function removeCrawlTarget(id: string): boolean {
  const idx = targets.findIndex(t => t.id === id);
  if (idx === -1) return false;
  unregisterTask(id);
  targets.splice(idx, 1);
  persist();
  return true;
}

export function recordTargetRun(
  id: string,
  runId: string,
  status: CrawlSession['status'],
): void {
  const t = targets.find(x => x.id === id);
  if (!t) return;
  t.lastRunId = runId;
  t.lastRunAt = new Date().toISOString();
  t.lastStatus = status;
  persist();
}
