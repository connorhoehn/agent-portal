// Actual shell draft provider and native editor; all call/session/frame inputs
// are explicit inert fixtures. No socket, media, call API or message send.
import '../../src/app.css';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { HuddleChatProvider, useHuddleChat } from '../../src/components/shell/HuddleChat';
import { ConversationComposer } from '../../src/lib/conversationComposer';

const fixture = {
  session: { sub: 'fixture-actor', name: 'Fixture Actor', tenant: 'orgiq', masquerading: null },
  host: { self: { userId: 'fixture-actor' }, tenant: 'orgiq', lobby: { title: 'Original fixture huddle' },
    call: { call: { callId: 'call-one' }, phase: 'live' } },
  frames: { configured: false, connectionState: 'disconnected', gateway: { onMessage: () => () => {}, sessionEpoch: 0 } },
  staleDraft: null as null | ((draft: { html: string; files: File[] }) => void),
  pendingReceipt: null as null | ((confirmed: boolean) => void),
  sends: 0,
};
(window as typeof window & { __retiredHuddleFixture: typeof fixture }).__retiredHuddleFixture = fixture;

function DraftView() {
  const chat = useHuddleChat()!;
  const [selected, setSelected] = useState('call-one');
  const active = chat.callId === selected;
  const retired = chat.retiredDrafts.find(row => row.scope.callId === selected);
  const draft = active ? chat.draft : retired?.draft ?? { html: '', files: [] };
  return <section>
    <p data-testid="fixture-current-call">{chat.callId ?? ''}</p>
    <p data-testid="fixture-retired-call-ids">{chat.retiredDrafts.map(row => row.scope.callId).join(',')}</p>
    <button onClick={() => setSelected('call-one')}>Select original fixture draft</button>
    <button onClick={() => chat.callId && setSelected(chat.callId)}>Select current fixture draft</button>
    <button onClick={() => { fixture.staleDraft = chat.setDraft; }}>Capture current draft callback</button>
    <button onClick={() => fixture.staleDraft?.({ html: '<p>Stale callback must not overwrite</p>', files: [] })}>Run stale fixture callback</button>
    <button disabled={!retired} onClick={() => chat.discardRetiredDraft(selected)}>Discard selected retired draft</button>
    <button onClick={() => fixture.pendingReceipt?.(false)}>Reject pending fixture receipt</button>
    <button onClick={() => fixture.pendingReceipt?.(true)}>Confirm pending fixture receipt</button>
    <button disabled={!active} onClick={() => chat.setDraft({ html: '<p>Newer draft survives late confirmation</p>', files: [] })}>Write newer fixture draft</button>
    <ConversationComposer key={selected} channel={null} context={{ kind: 'conversation', id: selected, title: '' }}
      identity={{ userId: fixture.session.sub, displayName: fixture.session.name }}
      capabilities={{ maySend: true, agent: { allowed: false } }}
      recipients={[{ id: `huddle:${selected}`, label: active ? 'Current fixture huddle' : 'Previous fixture huddle',
        disabled: !active, unavailableReason: active ? null : 'This huddle has ended. Recover or discard the unsent draft.',
        send: () => { fixture.sends++; return new Promise<boolean>(resolve => { fixture.pendingReceipt = resolve; }); } }]}
      recipient={`huddle:${selected}`} mode="chat" defaultMode="chat" persistDraft={false}
      draft={draft} onDraftChange={next => active ? chat.setDraft(next) : chat.updateRetiredDraft(selected, next)}
      expanded data-testid="retired-huddle-composer" />
  </section>;
}

function Fixture() {
  const [revision, setRevision] = useState(0);
  const mutate = (change: () => void) => { change(); setRevision(value => value + 1); };
  return <main className="p-5" data-revision={revision}>
    <button onClick={() => mutate(() => { fixture.host.call.phase = 'ended'; })}>End fixture call</button>
    <button onClick={() => mutate(() => { fixture.host.call.phase = 'failed'; })}>Fail fixture call</button>
    <button onClick={() => mutate(() => { fixture.host.call.phase = 'live'; fixture.host.call.call.callId = 'call-two'; fixture.host.lobby.title = 'New fixture huddle'; })}>Replace fixture call</button>
    <button onClick={() => mutate(() => { fixture.session.sub = 'fixture-other'; fixture.host.self.userId = 'fixture-other'; })}>Switch fixture actor</button>
    <button onClick={() => mutate(() => { fixture.session.tenant = 'assessment'; fixture.host.tenant = 'assessment'; })}>Switch fixture tenant</button>
    <HuddleChatProvider><DraftView /></HuddleChatProvider>
  </main>;
}
createRoot(document.getElementById('root')!).render(<MemoryRouter><Fixture /></MemoryRouter>);
