// One BFF process holds two leased Redis routers: /ws (realtime-gateway.ts)
// and cookie /realtime (distillation-realtime.ts). Each fences on its own
// bounded renewal, and /health reports the node unready when EITHER is
// fenced. Without this link a short Redis stall could fence one router while
// the other's reply arrived inside its deadline: the node then answered 503
// forever while the surviving router kept renewing its lease and serving its
// sockets (measured 2026-10-06, capacity-latency/stall-repro-1-*). A node is
// one owner, so the first fence retires every sibling router; shutdown()
// releases the sibling's lease rather than leaving it to be renewed.

export interface LeasedOwner {
  isReady(): boolean;
  shutdown(): Promise<void>;
}

export function linkNodeOwnership(owners: readonly LeasedOwner[], opts: {
  intervalMs?: number;
  onRetire?: (error?: unknown) => void;
} = {}): () => void {
  if (owners.length < 2) return () => undefined;
  let retired = false;
  const check = () => {
    if (retired || owners.every(owner => owner.isReady())) return;
    retired = true;
    clearInterval(timer);
    console.warn('[realtime-node] a leased router fenced; retiring its sibling routers so the node holds no partial ownership');
    void Promise.all(owners.filter(owner => owner.isReady()).map(owner => owner.shutdown()))
      .then(() => opts.onRetire?.(), error => { console.warn('[realtime-node] sibling retirement failed; its lease will expire', error); opts.onRetire?.(error); });
  };
  const timer = setInterval(check, opts.intervalMs ?? 250);
  timer.unref?.();
  return () => { retired = true; clearInterval(timer); };
}
