import '../../src/app.css';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ContextComposer } from '@connorhoehnslalom/ui-components/social/rich-composer';
import { ComposerAdvisories } from '../../src/components/chat/ComposerAdvisories';
function Fixture() {
  const [visible, setVisible] = useState(true);
  return <main className="p-6">
    <button onClick={() => setVisible(false)}>Resolve notices</button>
    <div className="fixed inset-x-6 bottom-6">
      <ContextComposer className="search-composer-advisories" context={{ kind: 'search', id: 'search', title: 'Search' }}
        modeRowStart={<ComposerAdvisories notices={visible ? [
          { id: 'history', title: 'Session history unavailable', description: 'Memory is not configured. This conversation will not be saved after you leave.' },
          { id: 'fixture', title: 'Search sources updating', description: 'Some sources may be temporarily unavailable.' },
        ] : []} />} defaultMode="agent" persistDraft={false}
        onSend={() => true} label="Search composer" composerTestId="notice-composer" />
    </div>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
