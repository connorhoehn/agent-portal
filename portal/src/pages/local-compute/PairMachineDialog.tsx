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
import { useEffect, useState } from 'react';
import {
  Banner, Button, CodeBlock, Inline, LoadingState, MetaLine, Modal, SectionLabel, Stack,
} from '@connorhoehnslalom/ui-components/shared';
import { writeJson } from './writeJson';

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

export function PairMachineDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [minting, setMinting] = useState(false);

  const mint = async () => {
    setMinting(true);
    setError(null);
    const res = await writeJson<Pairing>('/api/local-compute/pair/start', 'POST');
    setMinting(false);
    if (res.ok && res.data) setPairing(res.data);
    else setError(res.error ?? 'Could not mint a pairing code');
  };

  // Mint on open, forget on close — a code shown again later may already
  // have expired, and a stale code in a dialog is worse than no dialog.
  useEffect(() => {
    if (open) { void mint(); } else { setPairing(null); setError(null); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Pair a machine"
      maxWidth={640}
      footer={(
        <Inline gap="sm" className="justify-end">
          <Button variant="secondary" size="sm" onClick={() => { void mint(); }} disabled={minting}>
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
        {pairing && (
          <Stack gap="sm">
            <SectionLabel as="div">Pairing code</SectionLabel>
            <CodeBlock code={pairing.code} language="text" copyButton ariaLabel="Pairing code" />
            <SectionLabel as="div">On the machine</SectionLabel>
            <CodeBlock code={pairCommand(pairing.code)} language="bash" copyButton ariaLabel="Pairing command" />
            <MetaLine
              size="xs"
              items={[
                `Code expires in ${minutesLeft(pairing.expiresAt)} min — mint a new one if it lapses`,
                'The machine appears under Your machines within 15 seconds of claiming',
              ]}
            />
          </Stack>
        )}
      </Stack>
    </Modal>
  );
}
