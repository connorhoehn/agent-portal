import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import cron from 'node-cron';
import { startIngestionJob } from '../providers/knowledge-base.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEDULES_FILE = resolve(__dirname, '../../ingest-schedules.json');

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
  writeFileSync(SCHEDULES_FILE, JSON.stringify(schedules, null, 2), 'utf8');
}

function registerTask(s: IngestSchedule): void {
  if (!s.enabled || !cron.validate(s.cronExpr)) return;
  tasks.get(s.id)?.stop();
  const task = cron.schedule(s.cronExpr, async () => {
    console.log(`[scheduler] firing ${s.id} "${s.label}"`);
    const result = await startIngestionJob(s.dataSourceId, `Scheduled: ${s.label}`);
    const entry = schedules.find(x => x.id === s.id);
    if (entry) {
      entry.lastRunAt = new Date().toISOString();
      entry.lastJobId = result?.jobId ?? null;
      entry.lastStatus = result ? result.status : 'FAILED';
      persist();
    }
  }, { scheduled: true, timezone: 'UTC' });
  tasks.set(s.id, task);
}

export function initScheduler(): void {
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
