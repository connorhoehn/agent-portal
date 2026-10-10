// Render the actual Assessment dimension host while its chat runtime arrives
// late. Only runtime publication is simulated; the actor and capabilities are
// read through the real signed local session. No sends, commands or calls.
import '../../src/app.css';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { SessionProvider, useSession } from '../../src/lib/auth';
import { useCapabilities } from '../../src/lib/capabilities';
import type { ConversationRuntime } from '../../src/components/chat/ConversationThread';
import { DimensionMasterDetail } from '../../src/pages/assessment/dashboard/DimensionMasterDetail';
import type { Dimension } from '../../src/pages/assessment/types';

const dimension: Dimension = {
  id: '1', title: 'Continuous Integration', definition: 'Validate changes before merging.',
  na_description: '', current_level: 1, is_na: false, confidence: 'low', level_name: 'Initial',
  rubric_levels: [], next_level_criteria: [], evidence: [], follow_up_questions: [],
  criteria_progress: [], history: [],
};
const proof = { published: 0, sends: 0 };
(window as typeof window & { __dimensionDraftIdentity: typeof proof }).__dimensionDraftIdentity = proof;

function Fixture() {
  const { session, isLoading } = useSession();
  const { ready } = useCapabilities();
  const [conversation, setConversation] = useState<ConversationRuntime | null>(null);
  if (isLoading || !session || !ready) return <p>Loading signed Assessment actor…</p>;
  const publish = () => {
    proof.published++;
    setConversation({
      channel: 'assessment:team:TEAM-005', connected: true, maySend: true,
      userId: session.sub, displayName: session.name,
      chat: { messages: [], typingUsers: [], sendMessage: () => { proof.sends++; throw new Error('Fixture does not send.'); },
        setTyping: () => {}, loadHistory: async () => [] } as unknown as ConversationRuntime['chat'],
      quote: { reply: null, start: () => {}, clear: () => {} },
      commands: [], receipts: {} as ConversationRuntime['receipts'], reactions: {} as ConversationRuntime['reactions'],
      summarize: {} as ConversationRuntime['summarize'],
    });
  };
  return <main className="flex h-screen flex-col p-4" data-testid="dimension-identity-fixture">
    <header className="shrink-0 pb-3">
      <span data-testid="fixture-signed-actor">{session.sub}</span>
      <button onClick={publish}>Publish delayed chat runtime</button>
      <button disabled={!conversation} onClick={() => setConversation(previous => previous && ({ ...previous, connected: !previous.connected }))}>
        Toggle runtime connection
      </button>
    </header>
    <DimensionMasterDetail dimensions={[dimension]} selectedId="1" onSelect={() => {}}
      teamId="TEAM-005" teamName="Notifications Service" onChanged={() => {}} active conversation={conversation} />
  </main>;
}

createRoot(document.getElementById('root')!).render(<MemoryRouter><SessionProvider><Fixture /></SessionProvider></MemoryRouter>);
