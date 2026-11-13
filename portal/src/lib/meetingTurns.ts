// The call assistant's turns in the asker's own browser (docs/meeting-assistant-design.md, decision 5).
// The server never runs a tool. It lists the turns made for this person (`GET …/assistant/turns?mine=1`); this module
// runs each one exactly once through the voice navigator's executor (voice/runCore.ts) and posts the result back.
// A read runs when it is pending. A write runs only when the server says it is `running`, which it becomes only
// after the asker confirmed its card; a pending write is never run. Pure of React, so node:test covers it.

import type { CallToolOutcome } from './voice/runCore.ts';

export type TurnKind = 'read' | 'write' | 'private-read';

export interface AssistantTurn {
  turnId: string;
  kind: TurnKind;
  status: string;
  tool: { name: string; args: unknown };
  expiresAt: number;
}

/** The turns the server listed; a row that is not shaped like a turn is dropped. */
export function parseTurns(body: unknown): AssistantTurn[] {
  const list = body && typeof body === 'object' ? (body as Record<string, unknown>)['turns'] : null;
  if (!Array.isArray(list)) return [];
  const out: AssistantTurn[] = [];
  for (const row of list) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const tool = r['tool'] && typeof r['tool'] === 'object' ? r['tool'] as Record<string, unknown> : null;
    if (typeof r['turnId'] !== 'string' || !tool || typeof tool['name'] !== 'string' || typeof r['expiresAt'] !== 'number') continue;
    if (r['kind'] !== 'read' && r['kind'] !== 'write' && r['kind'] !== 'private-read') continue;
    out.push({ turnId: r['turnId'], kind: r['kind'], status: String(r['status'] ?? ''), tool: { name: tool['name'], args: tool['args'] }, expiresAt: r['expiresAt'] });
  }
  return out;
}

/** Turn ids this browser has taken. In memory, and in sessionStorage so a reload does not run one twice. */
export class SeenTurns {
  private readonly ids = new Set<string>();
  private readonly key: string;
  private readonly storage: () => Storage | null;
  constructor(key: string, storage: () => Storage | null = defaultStorage) {
    this.key = key; this.storage = storage;
    try {
      const raw = this.storage()?.getItem(this.key);
      const list: unknown = raw ? JSON.parse(raw) : [];
      if (Array.isArray(list)) for (const id of list) if (typeof id === 'string') this.ids.add(id);
    } catch { /* storage may be blocked: memory alone then */ }
  }
  has(id: string): boolean { return this.ids.has(id); }
  /** Marks a turn taken, before it runs. */
  add(id: string): void {
    this.ids.add(id);
    while (this.ids.size > 200) this.ids.delete(this.ids.values().next().value as string);
    try { this.storage()?.setItem(this.key, JSON.stringify([...this.ids])); } catch { /* memory alone */ }
  }
}

function defaultStorage(): Storage | null {
  try { return (globalThis as { sessionStorage?: Storage }).sessionStorage ?? null; } catch { return null; }
}

export interface TurnDeps {
  seen: SeenTurns;
  now(): number;
  /** Runs a tool with this person's own context (voice/runCore.ts runCallTool). */
  run(name: string, args: unknown, write: boolean): Promise<CallToolOutcome>;
  /** Posts the result; resolves when the server took it. */
  post(turnId: string, body: { ok: boolean; output?: unknown; error?: string }): Promise<void>;
}

/** Whether a turn may run now, and nothing else: a read is pending, a write is running (its card was confirmed), neither expired. */
export function runnable(turn: AssistantTurn, now: number): boolean {
  if (turn.expiresAt <= now) return false;
  return turn.kind === 'write' ? turn.status === 'running' : turn.status === 'pending';
}

/** Runs every turn in the list that may run and has not been taken. Serial, so two never overlap. Returns how many ran. */
export async function processTurns(turns: readonly AssistantTurn[], deps: TurnDeps): Promise<number> {
  let ran = 0;
  for (const turn of turns) {
    if (deps.seen.has(turn.turnId) || !runnable(turn, deps.now())) continue;
    deps.seen.add(turn.turnId);
    let body: { ok: boolean; output?: unknown; error?: string };
    try {
      const out = await deps.run(turn.tool.name, turn.tool.args, turn.kind === 'write');
      body = out.ok ? { ok: true, output: out.output ?? {} } : { ok: false, error: out.error ?? 'It did not work.' };
    } catch (error) {
      body = { ok: false, error: `That did not run: ${(error as Error).message}`.slice(0, 280) };
    }
    try { await deps.post(turn.turnId, body); } catch { /* the server expires the turn and says so in the chat */ }
    ran += 1;
  }
  return ran;
}
