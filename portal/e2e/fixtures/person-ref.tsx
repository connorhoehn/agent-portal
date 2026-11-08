// Rendering/authority-scope fixture only; no native identity or data writes.
import '../../src/app.css';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { Button, HoverCard, Inline, Stack, T } from '@connorhoehn/ui-components/shared';
import { SessionProvider, useSession } from '../../src/lib/auth';
import { PersonRef } from '../../src/pages/project-detail/PersonRef';

const people = {
  nora: { personId: 'p-004', name: 'Nora DaSilva', title: 'Senior Engineer' },
  layla: { personId: 'p-008', name: 'Layla Hassan', title: 'SRE Lead' },
  missing: { personId: 'fixture-with-no-profile', name: 'Fixture person', title: null },
};
function Fixture() {
  const { session, sessionStatus, refresh } = useSession();
  const [person, setPerson] = useState<keyof typeof people>('nora');
  const [lower, setLower] = useState(false), [tall, setTall] = useState(false);
  const [expandedDetail, setExpandedDetail] = useState(false);
  return <Stack gap="md" className="p-8 bg-surface min-h-screen">
    <T data-testid="fixture-authority">{sessionStatus} · {session?.sub} · {session?.tenant} · {session?.role}</T>
    <Inline gap="sm">
      <Button onClick={() => void refresh()}>Refresh fixture authority</Button>
      {Object.keys(people).map(value => <Button key={value} onClick={() => setPerson(value as keyof typeof people)}>Show {value}</Button>)}
      <Button onClick={() => setLower(value => !value)}>Move person to lower edge</Button>
      <Button onClick={() => setTall(value => !value)}>Show oversized detail</Button>
    </Inline>
    <div className={lower ? 'fixed bottom-8 right-4' : 'pt-8'}><PersonRef {...people[person]} /></div>
    <Button>Next control</Button>
    {tall && <div className="fixed bottom-8 left-8">
      <HoverCard label="Oversized detail" content={<Stack gap="sm">
        <Button onClick={() => setExpandedDetail(true)}>Load remaining details</Button>
        {Array.from({ length: expandedDetail ? 30 : 1 }, (_, index) => <T key={index} size="sm">Detail line {index + 1}</T>)}
        <a href="#last-detail">Last detail</a>
      </Stack>}>
        {trigger => <button {...trigger} onKeyDown={event => { if (event.key === ' ') event.preventDefault(); trigger.onKeyDown(event); }}>Open oversized detail</button>}
      </HoverCard>
    </div>}
  </Stack>;
}
createRoot(document.getElementById('root')!).render(<BrowserRouter><SessionProvider><Fixture /></SessionProvider></BrowserRouter>);
