import '../../src/app.css';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SearchResults } from '../../src/pages/search/SearchResults';
import { presentSearchPerson, type SearchPeoplePresentation } from '../../src/pages/search/peopleSearchModel';
import { publicSearchResult } from '../../src/pages/search/publicSearchRecord';
import type { SearchRecord } from '../../src/pages/search/searchTypes';

const records: SearchRecord[] = [
  { type: 'person', id: 'p-008', title: 'Layla Hassan', href: '#layla', subtitle: 'Engineer · Platform', description: 'Private inferred text' },
  { type: 'person', id: 'unknown', title: 'Another Person', href: '#other', subtitle: 'Engineer · Design', description: 'Private inferred text' },
];

function Fixture() {
  const [mode, setMode] = useState('online');
  const source: SearchPeoplePresentation = {
    avatars: [{ id: 'p-008', name: mode === 'wrong-name' ? 'Another Layla' : 'Layla Hassan', avatarUrl: mode === 'broken' ? '/broken-avatar.jpg' : '/avatars/photos/p-008.jpg' }],
    users: [{ personId: 'p-008', userId: 'u-layla' }],
    present: ['online', 'away', 'disconnected', 'wrong-name', 'broken'].includes(mode) ? [{ id: 'u-layla', idle: mode === 'away' }] : [],
    presenceReady: mode !== 'disconnected',
  };
  return <main className="p-6" data-testid="people-search-fixture">
    <div className="flex gap-3">{['online', 'away', 'offline', 'unknown', 'disconnected', 'wrong-name', 'broken'].map(state =>
      <button key={state} onClick={() => setMode(state)}>{state}</button>)}</div>
    <SearchResults groups={[{ id: 'people', label: 'People', count: records.length,
      records: records.map(record => publicSearchResult(presentSearchPerson(record, source), false)),
    }]} selectedKeys={[]} onToggleSelect={() => {}} onOpen={() => {}} />
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
