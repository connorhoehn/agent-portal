import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import cron from 'node-cron';
import { startIngestionJob } from '../providers/knowledge-base.js';
import { config } from '../config.js';
import { ingestScheduleRows } from '../mock/ingest-schedules.js';

// `process.cwd()`, NOT `import.meta.url` — see crawl-targets.ts's identical
// comment for why (the same trap `routes/mock-control.ts::bootHandlerSha`
// names for itself).
const SCHEDULES_FILE = resolve(process.cwd(), 'ingest-schedules.json');

export interface IngestSchedule {
  id: string;
  dataSourceId: string;
  dataSourceName: string;
  cronExpr: string;
  label: string;
  enabled: boolean;
  createdAt: string;
  lastRunAt: string | null;
  lastJobId: string | null;
  lastStatus: string | null;
}

const tasks = new Map<string, cron.ScheduledTask>();
let schedules: IngestSchedule[] = [];

function persist(): void {
  // Same reasoning as crawl-targets.ts::persist — mutations still land on
  // the in-memory `schedules` array under mock, they just never touch disk.
  if (config.mock.aurora) return;
  writeFileSync(SCHEDULES_FILE, JSON.stringify(schedules, null, 2), 'utf8');
}

function registerTask(s: IngestSchedule): void {
  // Never register a live cron under mock. `startIngestionJob` already has
  // its own `config.mock.agentcore` branch that stays entirely in-process
  // (`mockStartJob`), so unlike the crawl-target cron this one cannot reach
  // AWS — but a `dev:mock` process should hold no live timers at all, so a
  // demo or a test run never has a background cron ticking against seeded
  // rows behind the operator's back. See ingest-schedules.ts's header.
  if (config.mock.aurora) return;
  if (!s.enabled || !cron.validate(s.cronExpr)) return;
  tasks.get(s.id)?.stop();
  const task = cron.schedule(s.cronExpr, async () => {
    console.log(`[scheduler] firing ${s.id} "${s.label}"`);
    const result = await startIngestionJob(s.dataSourceId, `Scheduled: ${s.label}`);
    const entry = schedules.find(x => x.id === s.id);
    if (entry) {
      entry.lastRunAt = new Date().toISOString();
      entry.lastJobId = result.ok ? result.jobId : null;
      // A schedule that fires while a manual sync is still running is not a
      // failed schedule — Bedrock runs one job per data source, so the corpus
      // is being indexed either way. Recording SKIPPED keeps the operator from
      // chasing a red row in the schedule list that describes nothing wrong;
      // every other failure still records FAILED, and the reason is logged.
      if (result.ok) entry.lastStatus = result.status;
      else if (result.conflict) entry.lastStatus = 'SKIPPED';
      else entry.lastStatus = 'FAILED';
      if (!result.ok) console.warn(`[scheduler] ${s.id}: ${result.error}`);
      persist();
    }
  }, { scheduled: true, timezone: 'UTC' });
  tasks.set(s.id, task);
}

export function initScheduler(): void {
  if (config.mock.aurora) {
    // Copy, not the fixture's own array — see rehydrateMockSchedules below.
    schedules = ingestScheduleRows.rows().map((s) => ({ ...s }));
    console.log(`[scheduler] loaded ${schedules.length} mock schedule(s)`);
    for (const s of schedules) registerTask(s); // no-op under mock; kept for path parity.
    return;
  }
  if (existsSync(SCHEDULES_FILE)) {
    try {
      schedules = JSON.parse(readFileSync(SCHEDULES_FILE, 'utf8')) as IngestSchedule[];
    } catch {
      schedules = [];
    }
  }
  for (const s of schedules) registerTask(s);
  console.log(`[scheduler] loaded ${schedules.length} schedule(s)`);
}

export function listSchedules(): IngestSchedule[] {
  return schedules;
}

export function addSchedule(
  input: Omit<IngestSchedule, 'id' | 'createdAt' | 'lastRunAt' | 'lastJobId' | 'lastStatus'>,
): IngestSchedule {
  if (!cron.validate(input.cronExpr)) throw new Error(`Invalid cron expression: ${input.cronExpr}`);
  const s: IngestSchedule = {
    ...input,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    lastRunAt: null,
    lastJobId: null,
    lastStatus: null,
  };
  schedules.push(s);
  persist();
  registerTask(s);
  return s;
}

export function removeSchedule(id: string): boolean {
  const idx = schedules.findIndex(s => s.id === id);
  if (idx === -1) return false;
  tasks.get(id)?.stop();
  tasks.delete(id);
  schedules.splice(idx, 1);
  persist();
  return true;
}

export function toggleSchedule(id: string, enabled: boolean): IngestSchedule | null {
  const s = schedules.find(x => x.id === id);
  if (!s) return null;
  s.enabled = enabled;
  if (enabled) {
    registerTask(s);
  } else {
    tasks.get(id)?.stop();
    tasks.delete(id);
  }
  persist();
  return s;
}

export function validateCronExpr(expr: string): boolean {
  return cron.validate(expr);
}

/**
 * Put the offline ingestion-schedule list back to its seed.
 *
 * `schedules` is a plain module array hydrated from a copy of the fixture's
 * rows (see `initScheduler`), so `registry.resetAll()` cannot reach it — the
 * same trap `rehydrateMockFleet` (`providers/devbox-fleet-store.ts`) closes
 * for the devbox fleet. Called from `routes/mock-control.ts`'s full reset,
 * per-fixture reset, and both scenario routes. No-op when Aurora is real.
 */
export function rehydrateMockSchedules(): number {
  if (!config.mock.aurora) return 0;
  for (const id of [...tasks.keys()]) { tasks.get(id)?.stop(); tasks.delete(id); }
  schedules = ingestScheduleRows.rows().map((s) => ({ ...s }));
  return schedules.length;
}
