// Persisted store of named crawl targets. Targets can be on-demand (cronExpr
// null / disabled) or scheduled (cron.validate-checked expression). Pattern
// mirrors `ingest-scheduler.ts` — JSON file persistence + in-memory list +
// node-cron task registry. When a cron fires, we kick off a crawl via
// `startCrawl({ ..., targetId, scheduleId })` and record the run on the target.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import cron from 'node-cron';
import type { CrawlTarget, CrawlSession } from './crawler-types.js';
import { startCrawl } from './crawler.js';
import { config } from '../config.js';
import { crawlTargetRows } from '../mock/ingest-crawl-targets.js';
import { mockRestartMirror } from '../mock/restart-state.js';

// `process.cwd()`, NOT `import.meta.url` — the same trap and the same fix as
// `routes/mock-control.ts::bootHandlerSha`: this module is compiled by the
// CJS ts-jest config for tests, where `import.meta` is a hard TS1343 error
// that takes the whole suite down before a single test runs. The process is
// always started from `middleware/` (`npm run dev`/`start`, or the
// container's `WORKDIR /app`), so `process.cwd()` resolves to the same place
// `dirname(fileURLToPath(import.meta.url))` two levels up from `src/lib` (or
// `dist/lib`) did.
const TARGETS_FILE = resolve(process.cwd(), 'crawl-targets.json');

const tasks = new Map<string, cron.ScheduledTask>();
let targets: CrawlTarget[] = [];

function persist(): void {
  // Mutations still land on the in-memory `targets` array under mock (a
  // demo's add/edit/delete has to show up in the next GET) — they just never
  // touch disk, so `dev:mock` never creates a `crawl-targets.json` a real
  // run would then pick up.
  if (config.mock.aurora) return;
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
  // THE SAFETY POINT (see ingest-crawl-targets.ts's header for the full
  // reasoning): under mock, no target — seeded or created live during a demo
  // — is ever allowed to register a real cron. `crawler.ts::runFetchMode`
  // does an unconditional `fetch(url)` with no mock gate at all, so a live
  // tick against ANY `mode: 'fetch'` target reaches the real internet
  // regardless of `MOCK_AGENTCORE`. Seeding only `enabled: false` rows would
  // not close that: a demo user can flip `enabled` back on, or add a new
  // fetch-mode target with a cron, through the same API a real deployment
  // uses. Gating the whole function is the only branch that is actually
  // safe.
  if (config.mock.aurora) return;
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
  if (config.mock.aurora) {
    // Copy, not the fixture's own array — mutations (add/update/remove) must
    // never write back into the registered fixture, or a demo edit would
    // survive a `POST /api/__mock/reset`. See `rehydrateMockCrawlTargets`
    // below for how the copy gets rebuilt on reset.
    targets = (mockRestartMirror('crawlTargets') as CrawlTarget[] | undefined) ?? crawlTargetRows.rows().map((t) => ({ ...t }));
    console.log(`[crawl-targets] loaded ${targets.length} mock target(s)`);
    // registerTask is a no-op under mock (see its own guard), so this loop
    // is inert — kept so the code path matches the real one rather than
    // branching around it.
    for (const t of targets) registerTask(t);
    return;
  }
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

/**
 * Put the offline crawl-target list back to its seed.
 *
 * `targets` is a plain module array hydrated from a COPY of the fixture's
 * rows (see `initCrawlTargets`), so `registry.resetAll()` cannot reach it —
 * exactly the trap `rehydrateMockFleet` (`providers/devbox-fleet-store.ts`)
 * closes for the devbox fleet. Without this, a target renamed or deleted
 * during a demo would survive `POST /api/__mock/reset`, and pinning
 * `ingest-crawl-targets` to `empty` would change the fixture while the old
 * rows stayed on screen. Called from `routes/mock-control.ts`'s full reset,
 * per-fixture reset, and both scenario routes.
 *
 * Re-reads the fixture rather than caching a copy, so a pinned scenario is
 * honoured. No-op when Aurora is real — these rows are not this plane's
 * business there.
 */
export function rehydrateMockCrawlTargets(): number {
  if (!config.mock.aurora) return 0;
  for (const id of [...tasks.keys()]) unregisterTask(id);
  targets = crawlTargetRows.rows().map((t) => ({ ...t }));
  return targets.length;
}
