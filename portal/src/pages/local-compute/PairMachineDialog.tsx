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
import { writeJson } from './writeJson';

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
  return `node tools/local-compute-plugin/orgiq-presence.mjs pair ${code} --base ${base}`;
}

/** The worker command, verbatim from tools/local-compute-worker.mjs's header. */
export const WORKER_COMMAND = 'node tools/local-compute-worker.mjs';

export function PairMachineDialog({ open, onClose, onPaired }: { open: boolean; onClose: () => void; onPaired?: () => void }) {
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [minting, setMinting] = useState(false);
  // Step state: minted → claimed (a machine took the code) → connected (its
  // worker announced), at which point the dialog closes itself.
  const [claimed, setClaimed] = useState<{ nodeId: string | null; label: string | null } | null>(null);
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
    if (open) { void mint(); } else { setPairing(null); setError(null); setClaimed(null); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Watch the code until a machine claims it.
  useEffect(() => {
    if (!open || !pairing || claimed) return;
    let cancelled = false;
    const tick = async () => {
      const [statusRes, nodesRes] = await Promise.all([
        fetch(`/api/local-compute/pair/${encodeURIComponent(pairing.code)}`, { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : null)).catch(() => null) as Promise<PairStatus | null>,
        fetch('/api/local-compute/nodes', { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : null)).catch(() => null) as Promise<{ nodes?: NodeLite[] } | null>,
      ]);
      if (cancelled) return;
      const nodes = nodesRes?.nodes ?? [];
      const fresh = nodes.find((n) => !knownIdsRef.current.has(n.id));
      if (statusRes?.claimed || fresh) {
        const node = (statusRes?.nodeId ? nodes.find((n) => n.id === statusRes.nodeId) : undefined) ?? fresh ?? null;
        setClaimed({ nodeId: node?.id ?? statusRes?.nodeId ?? null, label: node?.label ?? null });
        onPaired?.();
      }
    };
    void tick();
    const id = window.setInterval(() => { void tick(); }, WATCH_MS);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [open, pairing, claimed, onPaired]);

  // Then watch the machine until its worker announces — and get out of the way.
  useEffect(() => {
    if (!open || !claimed) return;
    let cancelled = false;
    const tick = async () => {
      const res = await fetch('/api/local-compute/nodes', { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : null)).catch(() => null) as { nodes?: NodeLite[] } | null;
      if (cancelled) return;
      const node = (res?.nodes ?? []).find((n) => (claimed.nodeId ? n.id === claimed.nodeId : n.label === claimed.label));
      if (node && node.presence.status === 'connected') {
        toast?.toast(`${node.label} is connected`, { type: 'success' });
        onClose();
      }
    };
    void tick();
    const id = window.setInterval(() => { void tick(); }, WATCH_MS);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [open, claimed, onClose, toast]);

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
            <SectionLabel as="div">1 · Pair it — on the machine</SectionLabel>
            <CodeBlock code={pairCommand(pairing.code)} language="bash" copyButton ariaLabel="Pairing command" />
            <MetaLine
              size="xs"
              items={[
                `Code expires in ${minutesLeft(pairing.expiresAt)} min and is single-use — mint a new one if it lapses`,
                'This dialog moves on by itself the moment a machine claims the code',
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
                'JOB_KINDS and LOCAL_MODELS env vars narrow what it advertises; switch on “Accepting work” in the row',
                'This dialog closes itself when the machine reports connected',
              ]}
            />
            <LoadingState label="Waiting for the worker to announce…" />
          </Stack>
        )}
      </Stack>
    </Modal>
  );
}
