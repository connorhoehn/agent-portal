// Provider-free shared-composer regression. The directory is authenticated by
// the browser's real cookie; sends remain in this fixture and never reach chat.
import '../../src/app.css';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ConversationOutgoing } from '@connorhoehn/ui-components/social/rich-composer';
import { ConversationComposer } from '../../src/lib/conversationComposer';

const channel = 'assessment:team:TEAM-005';
const proof = { sends: [] as ConversationOutgoing[], replyClears: 0, overrideQueries: [] as string[] };
(window as typeof window & { __composerMentions: typeof proof }).__composerMentions = proof;

function Fixture() {
  const [explicit, setExplicit] = useState(false);
  return <main className="p-6" data-testid="mention-fixture">
    <button onClick={() => setExplicit(true)}>Use explicit mention lookup</button>
    <ConversationComposer key={explicit ? 'explicit' : 'default'} channel={channel}
      context={{ kind: 'conversation', id: 'TEAM-005', title: 'Assessment team', reference: {
        id: 'fixture-team', label: 'Assessment › TEAM-005', page: { kind: 'assessment-team', id: 'TEAM-005' },
      } }} capabilities={{ maySend: true }} identity={{ userId: 'u-asha', displayName: 'Asha Nair' }}
      recipients={[{ id: 'discussion', label: 'Team discussion', channel, send: message => {
        proof.sends.push(structuredClone(message)); return true;
      } }]}
      reply={{ reply: { messageId: 'fixture-quote', author: 'Fixture sender', text: 'Earlier fixture note' },
        clear: () => { proof.replyClears++; } }}
      {...(explicit ? { onSearchPeople: (query: string) => {
        proof.overrideQueries.push(query); return [{ id: 'fixture-person', label: 'Fixture Person' }];
      } } : {})}
      defaultMode="chat" persistDraft={false} expanded allowEmoji={false}
      label="Fixture conversation message" data-testid="mention-fixture-composer" />
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
