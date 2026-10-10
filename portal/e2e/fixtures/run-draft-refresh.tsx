import '../../src/app.css';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { RunDraft, type RunChoice } from '../../src/pages/project-detail/RunDraft';
import { node } from '../../src/pages/project-detail/__tests__/obsFixture';
import type { Codebase } from '../../src/pages/project-detail/types';

const first = { id: 'fixture-first', repoFullName: 'fixture/first', orgProjectId: 'p-observability' };
const second = { ...first, id: 'fixture-second', repoFullName: 'fixture/second' };
function Fixture() {
  const [id, setId] = useState('fixture-item');
  const [codebases, setCodebases] = useState<Codebase[]>([]);
  const [choice, setChoice] = useState<RunChoice | null>(null);
  return <main className="p-6 max-w-3xl">
    <button onClick={() => setCodebases([first])}>Load one codebase</button>
    <button onClick={() => setCodebases([second, first])}>Refresh codebases</button>
    <button onClick={() => setCodebases([first, second])}>Reorder codebases</button>
    <button onClick={() => setCodebases([])}>Remove codebases</button>
    <button onClick={() => setId('fixture-next-item')}>Change work item</button>
    <RunDraft item={{ ...node({ id, storyPoints: null }), epicId: 'fixture-epic', epicTitle: 'Fixture epic' }} codebases={codebases}
      run={undefined} canDispatch showGrantCue={false} onEstimateSaved={() => { throw new Error('No save permitted'); }}
      onAuthorize={() => { throw new Error('No dispatch permitted'); }} onChoiceChange={setChoice} />
    <output data-testid="run-choice">{JSON.stringify(choice)}</output>
  </main>;
}
createRoot(document.getElementById('root')!).render(<MemoryRouter><Fixture /></MemoryRouter>);
