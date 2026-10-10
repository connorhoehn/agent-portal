import '../../src/app.css';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SessionProvider, useSession } from '../../src/lib/auth';
import { realtimeTokenSource } from '../../src/lib/realtimeToken';

function Probe() {
  const { session, sessionStatus, isLoading, enterContext, refresh } = useSession();
  const [result, setResult] = useState('not attempted');
  const [earlierRead, setEarlierRead] = useState('not attempted');
  const [, render] = useState(0);
  async function enter(role?: string) {
    setResult('pending');
    try { await enterContext('assessment', role); setResult('success'); }
    catch (error) { setResult(error instanceof Error ? error.message : String(error)); }
  }
  async function seed() {
    localStorage.setItem('iq-judge-config', 'earlier workspace data');
    localStorage.setItem('chat.session.old-workspace', 'earlier conversation pointer');
    localStorage.setItem('rmn:notifications:read', 'earlier inbox marks');
    localStorage.setItem('orgiq:preferences:v1', 'device preference');
    sessionStorage.setItem('assessment.knowledge.ownSaveTimestamps', 'earlier actor writes');
    await realtimeTokenSource.get();
    render(value => value + 1);
  }
  async function beginEarlierRead() {
    setEarlierRead('pending');
    await refresh();
    setEarlierRead('done');
  }
  return <main className="p-4">
    <button onClick={() => void seed()}>Seed fixture caches</button>
    <button onClick={() => void enter('lead-assessor')}>Choose tenant and role</button>
    <button onClick={() => void enter()}>Choose tenant only</button>
    <button onClick={() => void beginEarlierRead()}>Begin earlier session refresh</button>
    <output data-testid="session-state">{JSON.stringify({ session, sessionStatus, isLoading })}</output>
    <output data-testid="transition-result">{result}</output>
    <output data-testid="earlier-read-result">{earlierRead}</output>
    <output data-testid="cache-state">{JSON.stringify({
      judge: localStorage.getItem('iq-judge-config'), conversation: localStorage.getItem('chat.session.old-workspace'),
      inbox: localStorage.getItem('rmn:notifications:read'), ownSave: sessionStorage.getItem('assessment.knowledge.ownSaveTimestamps'),
      token: realtimeTokenSource.peek()?.token ?? null, preference: localStorage.getItem('orgiq:preferences:v1'),
    })}</output>
  </main>;
}
createRoot(document.getElementById('root')!).render(<SessionProvider><Probe /></SessionProvider>);
