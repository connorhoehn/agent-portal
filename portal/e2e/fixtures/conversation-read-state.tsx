import '../../src/app.css';
import { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { GatewayContext, type GatewayMessage } from '@connorhoehn/realtime-modules/client';
import { offlineGateway } from '../../src/components/OptionalGatewayProvider';
import { ChannelThread } from '../../src/components/chat/ConversationThread';
import { SessionProvider } from '../../src/lib/auth';

const channel = 'orgiq:initiative:p-observability';
const listeners = new Set<(frame: GatewayMessage) => void>();
const proof = { outbound: [] as Record<string, unknown>[] };
(window as typeof window & { __conversationReadProof: typeof proof }).__conversationReadProof = proof;
const send = (frame: Record<string, unknown>) => { proof.outbound.push(structuredClone(frame)); };
const listen = (handler: (frame: GatewayMessage) => void) => { listeners.add(handler); return () => { listeners.delete(handler); }; };
const emit = (frame: GatewayMessage) => { for (const listener of [...listeners]) listener(frame); };

function Fixture() {
  const [epoch, setEpoch] = useState(1);
  const [connected, setConnected] = useState(true);
  const gateway = useMemo(() => ({ ...offlineGateway, connectionState: connected ? 'connected' as const : 'disconnected' as const,
    sessionEpoch: epoch, send, sendMessage: send, publish: send, onMessage: listen,
    reconnect: () => { setConnected(true); setEpoch(value => value + 1); },
  }), [connected, epoch]);
  return <main className="p-6">
    <div className="flex flex-wrap gap-3">
      <button onClick={() => emit({ type: 'chat', action: 'joined', channel })}>Confirm native join</button>
      <button onClick={() => emit({ type: 'chat', action: 'history', channel, messages: [] })}>Return empty history</button>
      <button onClick={() => emit({ type: 'error', service: 'chat', channel, kind: 'subscribe', code: 'AUTHZ_CHANNEL_DENIED' })}>Deny read</button>
      <button onClick={() => emit({ type: 'chat', action: 'history', channel, messages: [{ id: 'late', clientId: 'fixture', userId: 'fixture',
        channel, message: 'Late history must stay hidden after denied access', timestamp: new Date().toISOString() }] })}>Return late history</button>
      <button onClick={() => setConnected(false)}>Disconnect fixture transport</button>
    </div>
    <GatewayContext.Provider value={gateway}>
      <section className="flex h-[560px] flex-col border border-border" data-testid="fixture-thread-frame">
        <ChannelThread channel={channel} maySend confirmHistory title="Fixture discussion" composer={{ persistDraft: false }}
          emptyState={<p data-testid="confirmed-empty">Start the conversation</p>}
          notices data-testid="fixture-thread" />
      </section>
    </GatewayContext.Provider>
  </main>;
}
createRoot(document.getElementById('root')!).render(<SessionProvider><Fixture /></SessionProvider>);
