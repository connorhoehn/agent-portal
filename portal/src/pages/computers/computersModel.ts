// The Computers page's rows: a paired machine and a lab machine in one shape.
//
// Two reads feed it (GET /api/local-compute/nodes with the runs beside it, and the lab's fleet
// from the app's one ComputeProvider); nothing here is a new backend. No React, so node:test
// runs it.

export type ComputerKind = 'local' | 'lab';

export type ComputerTone = 'success' | 'accent' | 'warning' | 'neutral' | 'danger';

/** The plain words the page prints for a kind. */
export const KIND_LABEL: Record<ComputerKind, string> = { local: 'Your machine', lab: 'Lab machine' };

export interface ComputerRow {
  /** `local:<node id>` for a paired machine, the lab id for a lab machine: the page's one selection key. */
  key: string;
  kind: ComputerKind;
  name: string;
  state: string;
  tone: ComputerTone;
  /** True while the state pulses (work in flight). */
  live: boolean;
  /** What it is running now, in a few words. */
  running: string;
  lastSeen: string | null;
  /** Paired machine: its node id. */
  nodeId?: string;
  /** Lab machine: the session the stop route addresses. */
  sessionId?: string;
  /** Paired machine only: whether it is taking work. */
  accepting?: boolean;
  /** Lab machine only: it can still be stopped. */
  stoppable?: boolean;
}

export const LOCAL_KEY_PREFIX = 'local:';

export interface NodeInput {
  id: string;
  label: string;
  acceptJobs: boolean;
  presence: { status: 'connected' | 'stale' | 'offline'; lastSeenAt: string | null };
}

export interface RunInput {
  nodeId: string | null;
  status: string;
  title: string;
}

export interface LabInput {
  id: string;
  label: string;
  sessionId: string;
  status?: 'provisioning' | 'idle' | 'running' | 'waiting' | 'stopped' | 'error';
  lastActivityAt?: string;
  currentTask?: string;
  kind?: 'microvm' | 'local';
}

export function localRow(node: NodeInput, runs: readonly RunInput[]): ComputerRow {
  const mine = runs.filter((r) => r.nodeId === node.id);
  const current = mine.find((r) => r.status === 'running') ?? mine.find((r) => r.status === 'claimed');
  const queued = mine.filter((r) => r.status === 'queued').length;
  let state: string;
  let tone: ComputerTone;
  if (node.presence.status === 'offline') { state = 'Offline'; tone = 'neutral'; }
  else if (node.presence.status === 'stale') { state = 'Away'; tone = 'warning'; }
  else if (!node.acceptJobs) { state = 'Paused'; tone = 'warning'; }
  else if (current) { state = 'Working'; tone = 'accent'; }
  else { state = 'Ready'; tone = 'success'; }
  const running = current
    ? current.title
    : node.presence.status === 'offline' ? 'Not reachable'
      : !node.acceptJobs ? 'Paused, not taking work'
        : queued > 0 ? `${queued} queued` : 'Waiting for work';
  return {
    key: `${LOCAL_KEY_PREFIX}${node.id}`,
    kind: 'local',
    name: node.label,
    state,
    tone,
    live: state === 'Working',
    running,
    lastSeen: node.presence.lastSeenAt,
    nodeId: node.id,
    accepting: node.acceptJobs,
  };
}

const LAB_STATE: Record<NonNullable<LabInput['status']>, { state: string; tone: ComputerTone }> = {
  provisioning: { state: 'Starting', tone: 'warning' },
  idle: { state: 'Ready', tone: 'success' },
  running: { state: 'Working', tone: 'accent' },
  waiting: { state: 'Waiting', tone: 'warning' },
  stopped: { state: 'Stopped', tone: 'neutral' },
  error: { state: 'Error', tone: 'danger' },
};

export function labRow(c: LabInput): ComputerRow {
  const s = LAB_STATE[c.status ?? 'idle'];
  return {
    key: c.id,
    kind: 'lab',
    name: c.label,
    state: s.state,
    tone: s.tone,
    live: c.status === 'running' || c.status === 'provisioning',
    running: c.currentTask?.trim() || (c.status === 'stopped' ? 'Stopped' : 'Nothing running'),
    lastSeen: c.lastActivityAt ?? null,
    sessionId: c.sessionId,
    stoppable: c.status !== 'stopped',
  };
}

/** Both kinds, newest signs of life first within a kind; paired machines lead. */
export function computerRows(nodes: readonly NodeInput[], runs: readonly RunInput[], lab: readonly LabInput[]): ComputerRow[] {
  const mine = nodes.map((n) => localRow(n, runs));
  // The lab's own fleet also carries the paired machines (components/compute/localMachines.ts); they are listed once, from the node read.
  const boxes = lab.filter((c) => c.kind !== 'local').map(labRow);
  return [...mine, ...boxes];
}

export type KindFilter = '' | ComputerKind;

export function filterComputers(rows: readonly ComputerRow[], opts: { query: string; kind: KindFilter }): ComputerRow[] {
  const terms = opts.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter((r) => {
    if (opts.kind && r.kind !== opts.kind) return false;
    if (terms.length === 0) return true;
    const hay = `${r.name} ${KIND_LABEL[r.kind]} ${r.state} ${r.running}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}

/**
 * Where an old Computers-adjacent URL lands. `machine` (Local compute) and `box` (Computer Lab)
 * become the one `computer` selection; `view=runs` goes to the Runs list for paired machines.
 */
export function computersRedirect(search: string): string {
  const p = new URLSearchParams(search);
  if (p.get('view') === 'runs') return '/iq/runs?executor=local';
  const next = new URLSearchParams();
  const machine = p.get('machine');
  const box = p.get('box');
  const computer = p.get('computer');
  if (computer) next.set('computer', computer);
  else if (machine) next.set('computer', `${LOCAL_KEY_PREFIX}${machine}`);
  else if (box) next.set('computer', box);
  const run = p.get('run');
  if (run) next.set('run', run);
  const q = next.toString();
  return q ? `/iq/computers?${q}` : '/iq/computers';
}
