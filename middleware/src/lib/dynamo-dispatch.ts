// Hold work before invoking the SDK, rather than accumulating authority reads
// inside its HTTP-agent queue. This is a dispatch queue, never a result cache.
import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import type { DynamoCommandClient } from '@connorhoehnslalom/realtime-modules/server/stores/dynamo';

type Permit = { active: boolean };
type WaitingWork = { deadline: number; start: () => void; expire: () => void };
export class DynamoDispatchQueue implements DynamoCommandClient {
  private active = 0;
  private readonly waiting = new Map<symbol, WaitingWork>();
  private draining = false;
  private readonly scope = new AsyncLocalStorage<Permit>();
  constructor(private readonly client: DynamoCommandClient, private readonly concurrency: number,
    private readonly maxWaiting = 4096, private readonly maxWaitMs = 5000) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 256
      || !Number.isSafeInteger(maxWaiting) || maxWaiting < 1
      || !Number.isSafeInteger(maxWaitMs) || maxWaitMs < 1) throw new Error('Invalid DynamoDB dispatch bounds');
  }

  send(command: any): Promise<any> {
    // A membership partition read sends its pages sequentially under one
    // permit. Released scopes inherited by detached callbacks cannot borrow.
    if (this.scope.getStore()?.active) return this.client.send(command);
    return this.dispatchMembershipRead(() => this.client.send(command));
  }

  /** Only sequential store reads run within this scope. The caller removes
   * its queued authority entry here, immediately before the SDK is invoked. */
  dispatchMembershipRead<T>(work: () => Promise<T>): Promise<T> {
    if (this.scope.getStore()?.active) return work();
    this.expireWaiting();
    if (this.active >= this.concurrency && this.waiting.size >= this.maxWaiting) return Promise.reject(new Error('DynamoDB dispatch queue is full'));
    return new Promise<T>((resolve, reject) => {
      const key = Symbol();
      const deadline = performance.now() + this.maxWaitMs;
      let queued = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expire = () => {
        if (timer) clearTimeout(timer);
        this.waiting.delete(key);
        reject(new Error('DynamoDB dispatch wait timed out'));
      };
      const start = () => {
        // Promise completions can free a slot before overdue timer callbacks
        // run. A monotonic check is the actual dispatch deadline.
        if (queued && performance.now() >= deadline) { expire(); return; }
        if (timer) clearTimeout(timer);
        this.waiting.delete(key);
        this.active++;
        const permit = { active: true };
        void this.scope.run(permit, async () => {
          try { resolve(await work()); }
          catch (error) { reject(error); }
          finally {
            permit.active = false;
            this.active--;
            this.drain();
          }
        });
      };
      if (this.active < this.concurrency) start(); else {
        queued = true;
        this.waiting.set(key, { deadline, start, expire });
        timer = setTimeout(expire, this.maxWaitMs);
        timer.unref?.();
      }
    });
  }

  private expireWaiting(): void {
    // All jobs use the same wait budget and enter in monotonic FIFO order.
    // Reclaim expired slots even when their timers have not run yet.
    const now = performance.now();
    let first = this.waiting.values().next().value;
    while (first && first.deadline <= now) {
      first.expire();
      first = this.waiting.values().next().value;
    }
  }

  private drain(): void {
    if (this.draining) return;
    this.draining = true;
    try {
      this.expireWaiting();
      while (this.active < this.concurrency && this.waiting.size) this.waiting.values().next().value!.start();
    } finally { this.draining = false; }
  }
}
