// Real SessionProvider and HTTP failure adapters. Refusal responses are
// supplied by the owned browser regression; no gateway or chat is mounted.
import '../../src/app.css';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SessionProvider, useSession } from '../../src/lib/auth';
import { useFetch } from '../../src/hooks/useFetch';
import { createRealtimeTokenSource } from '../../src/lib/realtimeToken';
import { createEmbeddedSocialClient } from '../../src/lib/embeddedSocial';

function Fixture() {
  const { session, sessionStatus, refresh } = useSession();
  const [url, setUrl] = useState<string | null>(null), [adapter, setAdapter] = useState('');
  // Two concurrent readers exercise one authoritative session revalidation.
  const one = useFetch(url), two = useFetch(url);
  const token = async () => {
    try { await createRealtimeTokenSource({ url: '/__auth-refusal/token' }).get(); }
    catch { setAdapter('token-refused'); }
  };
  const embedded = async () => {
    try { await createEmbeddedSocialClient().read(new AbortController().signal); }
    catch { setAdapter('embedded-refused'); }
  };
  return <main className="p-6" data-testid="session-authority-fixture" data-state={sessionStatus}>
    <div data-testid="fixture-session-actor">{session?.sub ?? 'none'}</div>
    <div data-testid="fixture-api-failure">{one.failure?.kind ?? 'none'} / {one.failure?.status ?? 'none'} / {two.failure?.kind ?? 'none'}</div>
    <div data-testid="fixture-custom-adapter">{adapter}</div>
    <button onClick={() => setUrl('/__auth-refusal/upstream')}>Read upstream</button>
    <button onClick={() => setUrl('/__auth-refusal/forbidden')}>Read forbidden</button>
    <button onClick={() => setUrl('/__auth-refusal/retired')}>Read retired</button>
    <button onClick={() => { setUrl(null); void refresh(); }}>Recheck session</button>
    <button onClick={() => void token()}>Fetch refused token</button>
    <button onClick={() => void embedded()}>Fetch refused embedded Social</button>
  </main>;
}
createRoot(document.getElementById('root')!).render(<SessionProvider><Fixture /></SessionProvider>);
