// Pair a machine — the door the page was missing.
//
// The empty state used to say "pair a machine from its terminal or IDE with
// the pairing flow" and offered no way to start that flow: the header menu
// that once minted a code renders nothing until a machine exists, so a
// first-time user was told about a door that was not on the page. The
// middleware has had `POST /api/local-compute/pair/start` all along.
//
// One dialog: mint a code, show the exact command to run on the machine,
// say how long the code lasts and what happens next. The page polls
// `/nodes` every 15s, so a claimed machine shows up on its own.
import { useEffect, useRef, useState } from 'react';
import {
  Banner, Button, Chip, CodeBlock, Inline, LoadingState, MetaLine, Modal, SectionLabel, Stack, useToastOptional,
} from '@connorhoehnslalom/ui-components/shared';
import { writeJson } from '../../lib/writeJson';

interface PairStatus { claimed: boolean; claimedAt: string | null; nodeId: string | null; expiresAt: string }
interface NodeLite { id: string; label: string; presence: { status: 'connected' | 'stale' | 'offline' } }

/** While the dialog is open it watches for the two things the person is
 *  waiting on — the claim, then the worker — so it can advance itself
 *  instead of sitting on a code until someone closes it by hand. */
const WATCH_MS = 2_500;

interface Pairing {
  code: string;
  expiresAt: string;
}

/** Whole minutes until the code lapses; the shared relativeTime helper only
 *  reads the past ("just now" for anything ahead of the clock). */
function minutesLeft(expiresAt: string): number {
  return Math.max(0, Math.round((Date.parse(expiresAt) - Date.now()) / 60_000));
}

/** The command the presence plugin documents (tools/local-compute-plugin/
 *  orgiq-presence.mjs). `--base` is this origin: in dev the portal proxies
 *  /api to the middleware, and in a deployment the two share a front door. */
function pairCommand(code: string): string {
  const base = typeof window === 'undefined' ? '' : window.location.origin;
  // ONE command, not two. Pairing and starting the worker were separate
  // pastes, and the gap between them is where a first run goes wrong: the
  // portal shows the machine paired but offline, and nothing on screen says
  // the second half is missing. The worker claims the code itself now.
  return `node tools/local-compute-worker.mjs --pair ${code} --base ${base}`;
}

/** The worker command, verbatim from tools/local-compute-worker.mjs's header. */
export const WORKER_COMMAND = 'node tools/local-compute-worker.mjs';

export function PairMachineDialog({ open, onClose, onPaired }: { open: boolean; onClose: () => void; onPaired?: () => void }) {
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [minting, setMinting] = useState(false);
  // Step state: minted → claimed (a machine took the code) → connected (its
  // worker announced), at which point the dialog closes itself.
  const [claimed, setClaimed] = useState<{ nodeId: string | null; label: string | null; at: number } | null>(null);
  // The presence the matched node is REPORTING while we wait. The dialog was
  // already reading it to decide whether to close, then throwing it away — so
  // a machine that had registered but was not announcing looked exactly like
  // one that had never run the command, and the wait text guessed at the
  // former when the truth was knowable.
  const [seenStatus, setSeenStatus] = useState<NodeLite['presence']['status'] | null>(null);
  // Ticks while step 2 is open so the wait is visibly alive. A worker
  // announces every 25s, so the first one can legitimately be twenty-odd
  // seconds after the claim — with a bare spinner that reads as a hang, which
  // is exactly how it was reported.
  const [waitedS, setWaitedS] = useState(0);
  const knownIdsRef = useRef<Set<string>>(new Set());
  const toast = useToastOptional();

  const mint = async () => {
    setMinting(true);
    setError(null);
    setClaimed(null);
    // Snapshot the machines already paired so a NEW id can be recognised even
    // when the code's status carries no node id (the Aurora path).
    const before = await fetch('/api/local-compute/nodes', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : { nodes: [] })).catch(() => ({ nodes: [] })) as { nodes?: NodeLite[] };
    knownIdsRef.current = new Set((before.nodes ?? []).map((n) => n.id));
    const res = await writeJson<Pairing>('/api/local-compute/pair/start', 'POST');
    setMinting(false);
    if (res.ok && res.data) setPairing(res.data);
    else setError(res.error ?? 'Could not mint a pairing code');
  };

  // Mint on open, forget on close — a code shown again later may already
  // have expired, and a stale code in a dialog is worse than no dialog.
  useEffect(() => {
    if (open) { void mint(); } else { setPairing(null); setError(null); setClaimed(null); setSeenStatus(null); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // One watcher for both steps of the flow — step 1 (waiting for a claim)
  // needs both the pair-status and the node list every tick; step 2 (waiting
  // for the worker to announce) only ever needed the node list, so folding
  // both into one interval drops a redundant `/nodes` read per tick instead
  // of running two independent 2.5s loops side by side. Stops the instant
  // the dialog closes (the `open` dependency tears the interval down), same
  // as the two loops it replaces.
  // The callbacks are held in a ref and kept OUT of the dependency array, the
  // same shape useLocalComputeStream.ts uses for its subscription.
  //
  // This is why the dialog "doesn't poll correctly and doesn't auto close".
  // The call site passes `onClose={() => setPairOpen(false)}` — a new function
  // identity on every render of the page. With it in the deps, every parent
  // render (a 15s node poll, an SSE event, a `useNow` tick) tore this effect
  // down and rebuilt it. Teardown sets `cancelled = true`, and every tick
  // checks `if (cancelled) return` AFTER its two fetches resolve — so a tick
  // whose fetches outlive one parent render is discarded before it reaches
  // the branch that calls `onClose()`. On a page that re-renders faster than
  // the round trip, that is every tick, forever.
  const onCloseRef = useRef(onClose);
  const onPairedRef = useRef(onPaired);
  useEffect(() => { onCloseRef.current = onClose; onPairedRef.current = onPaired; });

  useEffect(() => {
    if (!open || !pairing) return;
    let cancelled = false;
    const tick = async () => {
      const [statusRes, nodesRes] = await Promise.all([
        claimed
          ? Promise.resolve(null)
          : fetch(`/api/local-compute/pair/${encodeURIComponent(pairing.code)}`, { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : null)).catch(() => null) as Promise<PairStatus | null>,
        fetch('/api/local-compute/nodes', { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : null)).catch(() => null) as Promise<{ nodes?: NodeLite[] } | null>,
      ]);
      if (cancelled) return;
      const nodes = nodesRes?.nodes ?? [];

      if (!claimed) {
        const fresh = nodes.find((n) => !knownIdsRef.current.has(n.id));
        if (statusRes?.claimed || fresh) {
          const node = (statusRes?.nodeId ? nodes.find((n) => n.id === statusRes.nodeId) : undefined) ?? fresh ?? null;
          setClaimed({ nodeId: node?.id ?? statusRes?.nodeId ?? null, label: node?.label ?? null, at: Date.now() });
          onPairedRef.current?.();
        }
        return;
      }

      // Match by id when the claim gave us one, then by label, then by "a
      // machine that was not here when this dialog opened". The single
      // expression this replaced fell through to `n.label === null` whenever
      // the claim carried neither, which matches nothing — so a re-pair of a
      // machine that kept its id left this dialog waiting forever.
      const node = (claimed.nodeId ? nodes.find((n) => n.id === claimed.nodeId) : undefined)
        ?? (claimed.label ? nodes.find((n) => n.label === claimed.label) : undefined)
        ?? nodes.find((n) => !knownIdsRef.current.has(n.id));
      setSeenStatus(node ? node.presence.status : null);
      if (node && node.presence.status === 'connected') {
        toast?.toast(`${node.label} is connected`, { type: 'success' });
        onPairedRef.current?.();
        onCloseRef.current();
      }
    };
    void tick();
    const id = window.setInterval(() => { void tick(); }, WATCH_MS);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [open, pairing, claimed, toast]);

  // The wait, counted out loud. A worker announces every 25 seconds, so the
  // gap between claiming a code and the machine reporting in is legitimately
  // twenty-odd seconds — and a bare spinner through that window is
  // indistinguishable from a hang, which is how it was reported.
  useEffect(() => {
    if (!open || !claimed) { setWaitedS(0); return; }
    setWaitedS(Math.floor((Date.now() - claimed.at) / 1000));
    const id = window.setInterval(() => {
      setWaitedS(Math.floor((Date.now() - claimed.at) / 1000));
    }, 1000);
    return () => window.clearInterval(id);
  }, [open, claimed]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Pair a machine"
      maxWidth={680}
      footer={(
        <Inline gap="sm" className="justify-end">
          <Button variant="secondary" size="sm" onClick={() => { void mint(); }} disabled={minting || Boolean(claimed)}>
            New code
          </Button>
          <Button variant="primary" size="sm" onClick={onClose}>Done</Button>
        </Inline>
      )}
    >
      <Stack gap="md">
        <MetaLine
          size="sm"
          items={['Run this on the machine you want in the fleet. It claims the code with its own token; the token is written to ~/.claude-mem/orgiq-presence.json and shown nowhere else.']}
        />
        {error && <Banner variant="error">{error}</Banner>}
        {!pairing && !error && <LoadingState label="Minting a pairing code…" />}
        {pairing && !claimed && (
          <Stack gap="sm">
            <SectionLabel as="div">Pairing code</SectionLabel>
            <CodeBlock code={pairing.code} language="text" copyButton ariaLabel="Pairing code" />
            <SectionLabel as="div">Run this on the machine you want in the fleet</SectionLabel>
            <CodeBlock code={pairCommand(pairing.code)} language="bash" copyButton ariaLabel="Pairing command" />
            <MetaLine
              size="xs"
              items={[
                `Code expires in ${minutesLeft(pairing.expiresAt)} min and is single-use — mint a new one if it lapses`,
                'It pairs, then starts polling — this dialog moves on by itself the moment the machine reports in',
              ]}
            />
            {/* Pairing registers the machine and nothing more: it shows as
                offline with no runnable kinds until a worker process on it
                announces what it can run. A first-time user who stopped after
                step 1 saw exactly that and read it as a failure. */}
          </Stack>
        )}
        {pairing && claimed && (
          <Stack gap="sm" data-testid="pair-claimed">
            <Inline gap="sm" align="center">
              <Chip tone="success" size="xs">Paired</Chip>
              <MetaLine size="sm" items={[claimed.label ? `${claimed.label} claimed the code` : 'A machine claimed the code']} />
            </Inline>
            <SectionLabel as="div">2 · Start its worker — same machine, same checkout</SectionLabel>
            <CodeBlock code={WORKER_COMMAND} language="bash" copyButton ariaLabel="Worker command" />
            <MetaLine
              size="xs"
              items={[
                'The worker reads the token pairing wrote, announces the models and job kinds it can run, and heartbeats — that is what turns the row from offline to connected',
                'It announces as soon as it starts, whether or not “Accepting work” is on — being present and taking jobs are separate',
                'This dialog closes itself the moment the machine reports in; switch on “Accepting work” in the row afterwards',
                'JOB_KINDS and LOCAL_MODELS env vars narrow what it advertises',
              ]}
            />
            <LoadingState
              label={seenStatus && seenStatus !== 'connected'
                ? `The machine is registered but has not announced yet… ${waitedS}s`
                : `Waiting for the worker to announce… ${waitedS}s`}
            />
            {waitedS >= 20 && (
              <Banner variant="warning">
                <Stack gap="xs">
                  {/* Two different failures wore one sentence. `seenStatus`
                      says which: a node in the list has registered — the
                      command IS running — and the only thing missing is the
                      announce, which is a different problem with a different
                      fix from "the command never started". */}
                  <Inline as="span" gap="none" wrap>
                    {seenStatus && seenStatus !== 'connected'
                      ? `This machine has registered — so the worker is running and reachable — but it has not announced its presence in ${waitedS}s. Workers built before this was fixed only announced once "Accepting work" was switched on, which could not happen while this dialog covered the switch. Close this, flip the switch in the row, and restart the worker to pick up the fix.`
                      : `Still nothing after ${waitedS}s. A worker announces every 25 seconds, so a short wait is normal — but if this keeps counting, check that the command above is running on that machine, in this repo checkout, and that it prints no error. A middleware restart also clears pairings in dev, in which case mint a new code.`}
                  </Inline>
                  <Inline gap="sm">
                    <Button variant="secondary" size="sm" onClick={() => { void mint(); }}>New code</Button>
                    <Button variant="ghost" size="sm" onClick={onClose}>Close and watch the row</Button>
                  </Inline>
                </Stack>
              </Banner>
            )}
          </Stack>
        )}
      </Stack>
    </Modal>
  );
}
