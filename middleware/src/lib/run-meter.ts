// The mid-run spend meter (DE-35, docs/deployment-enhancements/DE-35-mid-run-cutoff.md).
//
// Dollars used to arrive only on the `result` event, once the money was spent.
// What arrives mid-run is token usage: every `assistant` event carries
// `message.usage`. This module prices that usage as the frames pass
// (lib/model-prices.ts `estimateUsageCost`, every bucket at its own rate) and
// holds the run to its ceiling.
//
// ── The ceiling is the DE-34 hold ────────────────────────────────────────────
// A run starts with the money `reserveSpend` held for it. At NEAR_FRACTION of
// the ceiling the meter asks for one more p75 as a `basis='topup'` hold, through
// the same `reserveSpend` (same lock order, same hard caps and brakes, nothing
// confirmed): granted raises the ceiling, refused leaves it. When the metered
// figure reaches the ceiling with no top-up pending, the run is CUT: the meter's
// AbortSignal fires and the caller stops the task (closing the invoke stream,
// which the box's own finally turns into a process-group kill), then stops the
// session after CUTOFF_GRACE_MS if no `devbox_end` arrived (the reaper's call).
//
// ── Decisions this encodes (recorded in the goal doc) ────────────────────────
// - `RUN_CUTOFF=off` turns the meter off everywhere (no top-ups, no cuts).
// - At most RUN_TOPUP_MAX (default 2) top-ups per run; a confirmed-over
//   dispatch gets the same treatment — its confirmation covered the start.
// - A run with no hold (holds off, unattributed and unbudgeted, a reply inside
//   a governed run) has no ceiling and is not metered. Local-compute runs never
//   reach this module (they cost $0).
// - A model the table cannot price per bucket is priced at its OUTPUT rate for
//   every fresh token (pessimistic); a model with no row at all is unmetered.
// - The box is also told a token ceiling (`budget.max_fresh_tokens`): the most
//   this run could ever reach (hold x (1 + RUN_TOPUP_MAX)) at the output rate,
//   a backstop for a BFF that stopped listening, never the primary meter.

import { estimateUsageCost, priceFor } from './model-prices.js';
import type { TokenUsage } from './pricing.js';

export interface RunCutoff {
  reason: 'budget';
  ceilingUsd: number;
  meteredUsd: number;
  holdIds: string[];
  at: string;
}

export interface TopUpGrant {
  holdId: string | null;
  amountUsd: number;
}

export interface RunMeterOptions {
  /** The run's hold: its amount is the starting ceiling. */
  ceilingUsd: number;
  holdIds: Array<string | null>;
  /** The model requested; a `devbox_start` announcement replaces it. */
  model: string | null;
  /** Ask for one more p75 (the n-th top-up, 1-based). Null = refused. */
  topUp?: (n: number) => Promise<TopUpGrant | null>;
  maxTopUps?: number;
  nearFraction?: number;
  /** Called once, when the run is cut. */
  onCut?: (cutoff: RunCutoff) => void;
  now?: () => Date;
}

export class RunCutoffError extends Error {
  constructor(readonly cutoff: RunCutoff) {
    super(cutoffMessage(cutoff));
    this.name = 'RunCutoffError';
  }
}

/** `RUN_CUTOFF=off` turns the meter off (no top-ups, no cuts). */
export function runCutoffEnabled(): boolean {
  return (process.env['RUN_CUTOFF'] ?? '').trim().toLowerCase() !== 'off';
}

export function runTopUpMax(): number {
  const n = Number(process.env['RUN_TOPUP_MAX'] ?? 2);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 2;
}

/** How long a cut run has to end on its own before its session is stopped. */
export function cutoffGraceMs(): number {
  const n = Number(process.env['RUN_CUTOFF_GRACE_MS'] ?? 30_000);
  return Number.isFinite(n) && n >= 0 ? n : 30_000;
}

const money = (n: number): string => `$${n.toFixed(2)}`;

/** The one sentence a cut run is recorded with (run error, job error, work-item comment). */
export function cutoffMessage(c: Pick<RunCutoff, 'ceilingUsd' | 'meteredUsd'>): string {
  return `stopped at ${money(c.meteredUsd)} of its ${money(c.ceilingUsd)} hold; raise the allocation or re-dispatch`;
}

interface Buckets { input: number; output: number; cacheWrite: number; cacheRead: number }

function num(v: unknown): number {
  const x = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(x) && x > 0 ? x : 0;
}

function bucketsOf(usage: Record<string, unknown>): Buckets {
  return {
    input: num(usage['input_tokens']),
    output: num(usage['output_tokens']),
    cacheWrite: num(usage['cache_creation_input_tokens']),
    cacheRead: num(usage['cache_read_input_tokens']),
  };
}

const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;

export class RunMeter {
  private model: string | null;
  private ceiling: number;
  private readonly holds: string[];
  private readonly byMessage = new Map<string, Buckets>();
  private anonymous: Buckets = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  private reportedUsd = 0;
  private metered = 0;
  private topUps = 0;
  private pending: Promise<void> | null = null;
  private refused = false;
  private cut: RunCutoff | null = null;
  private readonly controller = new AbortController();
  private readonly opts: RunMeterOptions;

  constructor(opts: RunMeterOptions) {
    this.opts = opts;
    this.model = opts.model;
    this.ceiling = Math.max(0, opts.ceilingUsd);
    this.holds = opts.holdIds.filter((h): h is string => typeof h === 'string' && h.length > 0);
  }

  get signal(): AbortSignal { return this.controller.signal; }
  get meteredUsd(): number { return round4(this.metered); }
  get ceilingUsd(): number { return round4(this.ceiling); }
  get cutoff(): RunCutoff | null { return this.cut; }
  get holdIds(): string[] { return [...this.holds]; }
  get topUpCount(): number { return this.topUps; }

  /**
   * The token ceiling the box enforces on its own (agents/devbox/main.py):
   * the most this run could reach with every top-up, at the output rate.
   * Null when the model has no price row.
   */
  boxBudget(reasonRef: string): { max_fresh_tokens: number; reason_ref: string } | null {
    const p = this.model ? priceFor(this.model) : null;
    if (!p || !(p.output > 0) || !(this.ceiling > 0)) return null;
    const maxUsd = this.ceiling * (1 + (this.opts.maxTopUps ?? runTopUpMax()));
    return { max_fresh_tokens: Math.max(1, Math.ceil((maxUsd / p.output) * 1000)), reason_ref: reasonRef };
  }

  /** Wait for an outstanding top-up decision (tests, and the caller's finally). */
  async settled(): Promise<void> {
    while (this.pending) await this.pending;
  }

  /** Feed one parsed stream event. Synchronous; a top-up runs in the background. */
  observe(ev: Record<string, unknown>): void {
    if (this.cut) return;
    const type = ev['type'];
    if (type === 'devbox_start' && typeof ev['model'] === 'string' && ev['model']) this.model = ev['model'];
    if (type === 'result') {
      const reported = num(ev['total_cost_usd']);
      if (reported > this.reportedUsd) this.reportedUsd = reported;
    } else {
      const message = ev['message'] as { id?: unknown; usage?: unknown } | undefined;
      const raw = (ev['usage'] ?? message?.usage) as Record<string, unknown> | undefined;
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        const b = bucketsOf(raw);
        const id = typeof message?.id === 'string' && message.id ? message.id : null;
        if (id) {
          // One message's usage repeats on each of its content blocks: keep the largest.
          const prev = this.byMessage.get(id);
          this.byMessage.set(id, prev ? {
            input: Math.max(prev.input, b.input), output: Math.max(prev.output, b.output),
            cacheWrite: Math.max(prev.cacheWrite, b.cacheWrite), cacheRead: Math.max(prev.cacheRead, b.cacheRead),
          } : b);
        } else {
          this.anonymous = {
            input: this.anonymous.input + b.input, output: this.anonymous.output + b.output,
            cacheWrite: this.anonymous.cacheWrite + b.cacheWrite, cacheRead: this.anonymous.cacheRead + b.cacheRead,
          };
        }
      }
    }
    this.metered = Math.max(this.priced(), this.reportedUsd);
    this.judge();
  }

  private priced(): number {
    if (!this.model) return 0;
    const t: Buckets = { ...this.anonymous };
    for (const b of this.byMessage.values()) {
      t.input += b.input; t.output += b.output; t.cacheWrite += b.cacheWrite; t.cacheRead += b.cacheRead;
    }
    const usage: TokenUsage = { inputTokens: t.input, outputTokens: t.output, cacheWriteTokens: t.cacheWrite, cacheReadTokens: t.cacheRead };
    const exact = estimateUsageCost(this.model, usage);
    if (exact !== null) return exact;
    const p = priceFor(this.model);
    if (!p || !(p.output > 0)) return 0;
    // Pessimistic: every fresh token at the output rate (cache reads excluded).
    return ((t.input + t.output + t.cacheWrite) / 1000) * p.output;
  }

  private judge(): void {
    if (this.cut || !(this.ceiling > 0)) return;
    const near = this.opts.nearFraction ?? 0.8;
    const max = this.opts.maxTopUps ?? runTopUpMax();
    if (!this.pending && !this.refused && this.opts.topUp && this.topUps < max && this.metered >= near * this.ceiling) {
      this.topUps += 1;
      const n = this.topUps;
      this.pending = this.opts.topUp(n)
        .then((grant) => {
          if (grant && grant.amountUsd > 0) {
            this.ceiling += grant.amountUsd;
            if (grant.holdId) this.holds.push(grant.holdId);
          } else {
            this.refused = true;
          }
        })
        .catch((err: unknown) => {
          console.warn(`[run-meter] top-up ${n} failed: ${(err as Error).message}`);
          this.refused = true;
        })
        .finally(() => {
          this.pending = null;
          this.judge();
        });
      return;
    }
    // A pending top-up decides before a cut: it may raise the ceiling.
    if (this.pending) return;
    if (this.metered >= this.ceiling) this.trip();
  }

  private trip(): void {
    if (this.cut) return;
    this.cut = {
      reason: 'budget',
      ceilingUsd: round4(this.ceiling),
      meteredUsd: round4(this.metered),
      holdIds: [...this.holds],
      at: (this.opts.now?.() ?? new Date()).toISOString(),
    };
    try { this.opts.onCut?.(this.cut); } catch { /* the cut stands */ }
    this.controller.abort(new RunCutoffError(this.cut));
  }
}

/** One signal that fires when any of `signals` does. */
export function anySignal(signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const live = signals.filter((s): s is AbortSignal => s !== undefined);
  if (live.length === 0) return undefined;
  if (live.length === 1) return live[0];
  const c = new AbortController();
  for (const s of live) {
    if (s.aborted) { c.abort(s.reason); break; }
    s.addEventListener('abort', () => c.abort(s.reason), { once: true });
  }
  return c.signal;
}
