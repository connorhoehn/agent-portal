import '../../src/app.css';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatPanel } from '@connorhoehn/ui-components/social';

function Fixture() {
  const [scenario, setScenario] = useState('empty');
  const today = new Date(); today.setHours(12, 0, 0, 0);
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
  const message = (id: string, content: string, timestamp = today.toISOString()) => ({
    id, clientId: 'fixture', userId: 'demo', displayName: 'Demo User', content, timestamp,
  });
  const messages = scenario === 'empty' ? [] : scenario === 'history'
    ? [message('old', 'Yesterday’s conversation', yesterday.toISOString()), message('one', 'Today’s first message')]
    : scenario === 'single' ? [message('one', 'First message')]
    : [message('one', 'First message'), message('two', 'A quick follow-up')];
  return <main className="p-4">
    <nav aria-label="Fixture state" className="flex gap-2 pb-4">
      {['empty', 'single', 'consecutive', 'history'].map(value => <button key={value} onClick={() => setScenario(value)}>{value}</button>)}
    </nav>
    <section data-testid="chat-spacing-frame" className="flex h-[560px] w-full max-w-[480px] flex-col border border-border bg-surface">
      <div className="border-b border-border px-4 py-2 text-sm">Current huddle</div>
      <ChatPanel key={scenario} messages={messages} currentUserId="demo" fill showHeader={false} contentAlign="start"
        threaded postRhythm="chat" composer={<></>} onSend={() => {}} onReply={() => {}}
        onToggleReaction={() => {}} onEditMessage={async () => {}} onDeleteMessage={() => {}} />
    </section>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
