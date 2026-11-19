// Hands-free Milo in a call's bar: the hold button (the library's HoldToTalkButton: hold, Space unless typing, a tap latches, Esc
// cancels, 30 s cap) for someone the call's rules route, and "Hugo is talking to Milo" for every viewer while someone holds the
// floor. A staff seat reads `/api/calls/<id>/assistant`, the candidate `/api/interview-invite/milo` (lib/miloFloor.ts). Renders
// nothing while the call is not hands-free.
import { useState } from 'react';
import { Chip, Inline, T } from '@connorhoehn/ui-components/shared';
import { HoldToTalkButton } from '@connorhoehn/ui-components/video';
import { useMiloFloor, type HoldAction } from '../../lib/miloFloor';
import { HOLD_LABEL, HOLD_MAX_MS, HOLD_TALKING_LABEL, busyLabel, floorWords } from '../../lib/miloFloorModel';

const REFUSAL_SHOWN_MS = 4000;

/**
 * `base`: where the floor lives (null: nothing). `on`: the call is hands-free as last read (staff: the state's `handsfree`; the
 * candidate: always, the floor read itself says). `mayHold`: staff pass the state's; the candidate's comes with the floor.
 */
export function MiloHoldControl({ base, on, mayHold, selfId }: { base: string | null; on: boolean; mayHold?: boolean; selfId: string | null }) {
  const { view, hold } = useMiloFloor(base, on);
  const [holding, setHolding] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  // A refused press resets the button (its talking state is its own): it is drawn afresh.
  const [generation, setGeneration] = useState(0);
  if (!view.handsfree) return null;
  const canHold = (mayHold ?? view.mayHold) === true;
  const send = async (action: HoldAction) => {
    if (action !== 'press') { setHolding(false); await hold(action); return; }
    setHolding(true); setRefusal(null);
    const out = await hold('press');
    if (out.ok) return;
    setHolding(false); setGeneration((g) => g + 1); setRefusal(out.words);
    setTimeout(() => setRefusal(null), REFUSAL_SHOWN_MS);
  };
  const words = holding ? 'You are talking to Milo' : floorWords(view, selfId);
  const busy = holding ? undefined : busyLabel(view, selfId);
  return <Inline gap="xs" align="center" wrap={false} className="shrink-0" data-testid="milo-hold" data-floor={view.floor?.userId ?? ''} data-holding={String(holding)}>
    {canHold && <HoldToTalkButton key={generation} size="sm" spaceToTalk maxDurationMs={HOLD_MAX_MS} label={HOLD_LABEL} talkingLabel={HOLD_TALKING_LABEL}
      {...(busy ? { busy } : {})} onStart={() => void send('press')} onEnd={() => void send('release')} onCancel={() => void send('cancel')} data-testid="milo-hold-button" />}
    {/* Who has Milo's ear, for everyone (the button's own busy label says it beside a disabled button). */}
    {words && !(canHold && busy) && <Chip size="xs" tone="info" className="whitespace-nowrap" data-testid="milo-floor">{words}</Chip>}
    {refusal && <T size="xs" tone="secondary" className="whitespace-nowrap" role="status" data-testid="milo-hold-refused">{refusal}</T>}
  </Inline>;
}
