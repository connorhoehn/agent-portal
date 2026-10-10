// Exercise the production download hook without starting a call or resetting data.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useDeckDownload } from '../../src/components/decks/useDeckEditorHelpers';

const fileUrl = () => '/api/__deck_download_regression/file';
function Fixture() {
  const [draft, setDraft] = useState('Keep my active document');
  const { download, downloading, error } = useDeckDownload(fileUrl, 'fixture-deck', 'saved-v3', 'presentation-v3.pptx');
  return <>
    <label>Document draft<input value={draft} onChange={event => setDraft(event.target.value)} /></label>
    <button disabled={downloading} onClick={download}>{downloading ? 'Downloading…' : 'Download .pptx'}</button>
    {error && <div role="alert">{error}</div>}
  </>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
